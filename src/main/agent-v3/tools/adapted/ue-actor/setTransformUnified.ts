/**
 * 统一 Actor 变换工具
 * 适配新的 actor.set_transform 接口
 * 支持 targets（选择器） + operation（操作）结构
 *
 * targets 字段：
 *   - names: 字符串数组，指定 Actor 名称
 *   - paths: 字符串数组，指定 Actor 路径
 *   - filter: 筛选器对象，支持 class (包含匹配), name_pattern (通配符), exclude_classes (排除类名数组)
 *
 * operation 字段：
 *   - space: "World" (默认) 或 "Local"
 *   - snap_to_floor: true (执行贴地)
 *   - set: 绝对值设置 (location, rotation, scale)
 *   - add: 增量设置 (location, rotation, scale)，支持负数
 *   - multiply: 倍乘设置 (location, rotation, scale)
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { worldFields, describeWorld, type WorldScopedResponse } from '../../worldScope'
import { UE_UNIT_NOTE, describePlacementScale } from '../../ueUnits'
import {
  UE_ROTATION_NOTE,
  describeOrientations,
  directionToRotator,
  sunToRotator,
  type SunInput
} from '../../ueOrientation'
import { describeToolError } from '../../engineErrors'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import {
  describeUnmatchedTargets,
  unmatchedTargetFields,
  type UnmatchedTargetsResponse
} from '../../unmatchedTargets'

/** UE 侧失败响应的字段。历史原因不统一，四种都可能出现 */
type RpcFailureShape =
  | {
      ok?: boolean
      success?: boolean
      __rpc?: { code?: string | number }
      code?: string | number
      error?: string
      message?: string
      details?: unknown
    }
  | null
  | undefined

/**
 * 统一变换请求参数
 * 注意：某些 AI 模型可能将嵌套对象序列化为 JSON 字符串传入，
 * 因此使用 z.unknown() 接受任意输入，在 execute 中手动解析和验证
 */
const SetTransformUnifiedParamsSchema = z.object({
  targets: z.unknown().describe('选择器：指定要操作的 Actor (对象或 JSON 字符串)'),
  operation: z.unknown().describe('操作：要执行的变换操作 (对象或 JSON 字符串)')
})

type ParsedTargets = {
  selection?: boolean
  names?: string[]
  paths?: string[]
  filter?: {
    class?: string
    name_pattern?: string
    exclude_classes?: string[]
  }
}

type RotatorInput = { pitch?: number; yaw?: number; roll?: number }
type Vec3Input = { x?: number; y?: number; z?: number }

type TransformSet = {
  location?: Vec3Input
  rotation?: RotatorInput
  scale?: Vec3Input
  /** 方向光专用：太阳在哪，工具算成 rotation */
  sun?: SunInput
  /** 让 +X 指向这个世界方向向量，工具算成 rotation（roll 归零） */
  face_direction?: Vec3Input
}

type ParsedOperation = {
  space?: 'World' | 'Local'
  snap_to_floor?: boolean
  set?: TransformSet
  add?: { location?: Vec3Input; rotation?: RotatorInput; scale?: Vec3Input }
  multiply?: { location?: Vec3Input; rotation?: RotatorInput; scale?: Vec3Input }
  /** 也接受写在 operation 顶层，等价于 set.sun */
  sun?: SunInput
  /** 也接受写在 operation 顶层，等价于 set.face_direction */
  face_direction?: Vec3Input
}

/**
 * 把 sun / face_direction 换成 set.rotation，并从发给插件的 payload 里摘掉。
 *
 * 这两个字段存在的理由只有一个：方向光的 pitch 正负号是真机上反复出错的那一步
 * （`Pitch=+30` 是仰照，太阳在天上要写 -30）。让调用方说「太阳在哪」，正负号由代码来背。
 * 插件不认识这两个键，所以必须在这里消化掉，不能透传。
 *
 * 和 rotation 同时给是矛盾的，直接拒绝 —— 二选一比「谁覆盖谁」的规则好记。
 */
function resolveSemanticRotation(
  operation: ParsedOperation
): { operation: ParsedOperation; usedSemantic: boolean } | { error: string } {
  const sun = operation.sun ?? operation.set?.sun
  const face = operation.face_direction ?? operation.set?.face_direction
  if (!sun && !face) return { operation, usedSemantic: false }
  if (sun && face)
    return { error: 'sun 和 face_direction 只能给一个：方向光用 sun，其他东西用 face_direction' }
  if (operation.set?.rotation) {
    return {
      error: `set.rotation 和 ${sun ? 'sun' : 'face_direction'} 只能给一个，不然不知道听谁的`
    }
  }

  let rotation: RotatorInput
  if (sun) {
    if (typeof sun.elevation !== 'number' || !Number.isFinite(sun.elevation)) {
      return { error: 'sun.elevation 必填：太阳离地平线多高（度），黄昏 5～15，正午 60～90' }
    }
    if (sun.elevation <= 0) {
      return {
        error: `sun.elevation=${sun.elevation} 意味着太阳在地平线以下，光会从地底往上照。要的是黄昏就给 5～15`
      }
    }
    rotation = sunToRotator(sun)
  } else {
    const r = directionToRotator(face!)
    if (!r)
      return {
        error:
          'face_direction 是零向量，没有方向。给一个世界方向，比如「朝向相机」= 相机位置 - 自己位置'
      }
    rotation = r
  }

  const restOp: ParsedOperation = { ...operation }
  delete restOp.sun
  delete restOp.face_direction
  const restSet: TransformSet = { ...(operation.set ?? {}) }
  delete restSet.sun
  delete restSet.face_direction
  return {
    operation: { ...restOp, set: { ...restSet, rotation } },
    usedSemantic: true
  }
}

/**
 * 贴地到底贴上了没有 —— 必须说，而且必须说在正文里。
 *
 * 贴地是「命中了才有效」的操作：正下方没有碰撞体就一动不动。插件以前用一条
 * 不存在的 Exec 命令做这件事，于是每次都是「报 success、位置没变」，调用方
 * 只能靠反复回读位置才能发现（只能靠反复回读才能发现）。
 * 现在插件如实回 `snap.hit`，这里把它翻成人话 —— 没命中要连「下一步试什么」
 * 一起给，不然模型拿到 false 也只会再调一次。
 */
function describeSnap(response: SetTransformUnifiedResponse): string {
  const actors = response.actors ?? []
  const snaps = actors.map((a) => a.snap).filter((s): s is NonNullable<typeof s> => Boolean(s))
  if (snaps.length === 0) return ''

  const hit = snaps.filter((s) => s.hit)
  const missed = snaps.length - hit.length

  const parts: string[] = []
  if (hit.length > 0) {
    const first = hit[0]
    const surface = typeof first.surface_z === 'number' ? `${first.surface_z.toFixed(1)}` : '?'
    const dz = typeof first.moved_dz === 'number' ? first.moved_dz.toFixed(1) : '?'
    parts.push(
      `\n贴地：${hit.length} 个落到了地面上` +
        `（第一个落在 z=${surface}，挪动 ${dz} 厘米，打到 ${first.hit_actor || '未知物体'}` +
        `，走 ${first.channel} 碰撞通道）`
    )
  }
  if (missed > 0) {
    parts.push(
      `\n⚠️ 贴地：${missed} 个正下方没有碰撞体，**位置没有变**。` +
        `地面网格可能没做碰撞 —— 先确认那块地有碰撞，或者读一个明显已经落地的道具的 bounds_min.z 当地面高度直接摆。`
    )
  }
  return parts.join('')
}

/** 这次操作动了旋转没有 —— 动了才值得在回读里说朝向，光挪位置就不刷屏 */
function touchesRotation(operation: ParsedOperation): boolean {
  return Boolean(operation.set?.rotation || operation.add?.rotation || operation.multiply?.rotation)
}

/**
 * Actor 结果结构
 */
interface ActorResult {
  name?: string
  path?: string
  class?: string
  location?: { x: number; y: number; z: number }
  rotation?: { pitch: number; yaw: number; roll: number }
  scale?: { x: number; y: number; z: number }
  /** 只有请求了 snap_to_floor 才有：贴地这一步的实际结果 */
  snap?: {
    hit?: boolean
    channel?: string
    surface_z?: number
    moved_dz?: number
    bottom_offset?: number
    hit_actor?: string
    reason?: string
  }
}

/**
 * 统一变换响应数据
 * 注意：插件端返回的 JSON-RPC 响应中，result 对象包含这些字段
 * 插件端不会显式返回 ok/success 字段，需要通过 count 来判断成功
 */
interface SetTransformUnifiedResponse extends WorldScopedResponse, UnmatchedTargetsResponse {
  ok?: boolean
  success?: boolean
  count?: number
  reported?: number
  report_limit?: number
  actors?: ActorResult[]
  error?: string
}

/**
 * 创建统一变换工具
 * @returns 统一变换工具实例
 */
export function createSetTransformUnifiedTool(): V2Tool {
  return defineV2Tool({
    description: `【推荐】统一变换工具 - 设置虚幻引擎场景中 Actor 的变换（位置、旋转、缩放）。

支持多种选择方式：
- 按当前选中： targets: { selection: true } —— 用户说"把我选中的这个挪一下"时直接用
- 按名称： targets: { names: ["MyCube", "MySphere"] }
- 按路径： targets: { paths: ["/Game/.../Actor1"] }
- 按过滤器： targets: { filter: { class: "Light" } }

支持多种变换操作：
- 绝对设置： operation: { set: { location: { z: 200 } } }      —— 200 厘米 = 2 米
- 增量变换： operation: { add: { location: { z: 500 } } }      —— 上移 5 米，支持负数
- 倍乘缩放： operation: { multiply: { scale: { x: 2, y: 2, z: 2 } } }  —— 倍数，不是长度

支持附加选项：
- 坐标空间： operation: { space: "Local" }
- 贴地操作： operation: { snap_to_floor: true } 可单独给

不用自己算旋转的两种写法（和 set.rotation 互斥）：
- 方向光/太阳： operation: { set: { sun: { elevation: 8, azimuth: 300 } } }
  elevation = 太阳离地平线多高（黄昏 5～15，正午 60～90）；azimuth = 太阳在哪个方位（0 = +X，90 = +Y）
- 让正面(+X)指向某个方向： operation: { set: { face_direction: { x: -1, y: 0, z: 0 } } }
  例如让雾卡片正对相机：face_direction = 相机位置 - 卡片位置

${UE_UNIT_NOTE}

${UE_ROTATION_NOTE}

【使用示例】：
1. 将 MyCube 抬到 2 米高：
   targets: { names: ["MyCube"] }
   operation: { set: { location: { z: 200 } } }

2. 所有灯光上移 5 米（局部坐标系）：
   targets: { filter: { class: "Light" } }
   operation: { space: "Local", add: { location: { z: 500 } } }

3. Cube_1 和 Sphere_2 放大 2 倍：
   targets: { names: ["Cube_1", "Sphere_2"] }
   operation: { multiply: { scale: { x: 2, y: 2, z: 2 } } }

4. 除了灯光之外的所有物体放大一倍：
   targets: { filter: { exclude_classes: ["PointLight", "SpotLight", "DirectionalLight"] } }
   operation: { multiply: { scale: { x: 2, y: 2, z: 2 } } }

5. 整个场景是按米算的、摆完发现缩小了 100 倍，把所有位置 ×100：
   targets: { filter: {} }
   operation: { multiply: { location: { x: 100, y: 100, z: 100 } } }
`,

    inputSchema: SetTransformUnifiedParamsSchema,
    // 注意：不使用 strict 模式，因为 z.union 与 strict 不兼容
    execute: async (input) => {
      console.log('[SetTransformUnifiedTool] 收到请求:', JSON.stringify(input, null, 2))

      // 容错处理：某些 AI 模型可能将嵌套对象作为 JSON 字符串传入
      // 如果 targets 或 operation 是字符串，尝试解析为对象
      let targets: ParsedTargets = input.targets as ParsedTargets
      let operation: ParsedOperation = input.operation as ParsedOperation

      if (typeof input.targets === 'string') {
        try {
          console.log('[SetTransformUnifiedTool] targets 是字符串，尝试解析...')
          targets = JSON.parse(input.targets) as ParsedTargets
        } catch (e) {
          return {
            success: false,
            error: `targets 参数解析失败: ${e instanceof Error ? e.message : String(e)}`
          }
        }
      }

      if (typeof input.operation === 'string') {
        try {
          console.log('[SetTransformUnifiedTool] operation 是字符串，尝试解析...')
          operation = JSON.parse(input.operation) as ParsedOperation
        } catch (e) {
          return {
            success: false,
            error: `operation 参数解析失败: ${e instanceof Error ? e.message : String(e)}`
          }
        }
      }

      console.log('[SetTransformUnifiedTool] 解析后的 targets:', JSON.stringify(targets, null, 2))
      console.log(
        '[SetTransformUnifiedTool] 解析后的 operation:',
        JSON.stringify(operation, null, 2)
      )

      // 参数验证：targets 至少需要有一种选择方式
      const hasTargets =
        targets.selection || targets.names?.length || targets.paths?.length || targets.filter
      if (!hasTargets) {
        return {
          success: false,
          error: '必须在 targets 中提供 selection、names、paths 或 filter 之一来选择 Actor'
        }
      }

      // sun / face_direction 在这里换成 rotation，插件只认 rotation
      const resolved = resolveSemanticRotation(operation)
      if ('error' in resolved) {
        return { success: false, error: resolved.error }
      }
      operation = resolved.operation
      if (resolved.usedSemantic) {
        console.log(
          '[SetTransformUnifiedTool] 语义旋转已换算为 rotation:',
          JSON.stringify(operation.set?.rotation)
        )
      }

      // 参数验证：operation 至少需要有一种操作
      const hasOperation =
        operation.set || operation.add || operation.multiply || operation.snap_to_floor
      if (!hasOperation) {
        return {
          success: false,
          error: '必须在 operation 中提供 set、add、multiply 或 snap_to_floor 之一'
        }
      }

      try {
        // 获取 WebSocket 服务
        const wsService = serviceManager.getWebSocketService()

        // 检查是否有可用连接
        const connectionCount = wsService.getConnectionCount()
        if (connectionCount === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 构建请求 payload（直接透传新结构）
        const payload = {
          targets,
          operation
        }

        console.log(
          '[SetTransformUnifiedTool] 发送 actor.set_transform 请求:',
          JSON.stringify(payload, null, 2)
        )

        // 发送请求到 UE 插件
        const response = await wsService.callRequest<SetTransformUnifiedResponse>(
          'actor.set_transform',
          payload,
          getTargetConnectionId(),
          120000 // 2 分钟超时（批量操作可能较慢）
        )

        console.log('[SetTransformUnifiedTool] 收到响应:', JSON.stringify(response, null, 2))

        // 判断成功的逻辑：
        // 1. 插件端返回 code=200 时，WebSocket 服务会直接返回 result 对象
        // 2. 插件端的 result 对象包含 count 字段表示成功处理的 Actor 数量
        // 3. 兼容旧版本可能返回的 ok/success 字段
        const affectedCount = response?.count ?? response?.actors?.length ?? 0
        const isSuccess = response?.ok === true || response?.success === true || affectedCount > 0

        console.log(
          '[SetTransformUnifiedTool] 成功判断:',
          isSuccess,
          '| ok:',
          response?.ok,
          '| success:',
          response?.success,
          '| count:',
          response?.count
        )

        if (isSuccess) {
          const count = affectedCount

          // 构建结果摘要
          let summary = `成功变换 ${count} 个 Actor`
          if (response.actors && response.actors.length > 0) {
            const actorNames = response.actors
              .slice(0, 5)
              .map((a) => a.name)
              .join(', ')
            if (response.actors.length > 5) {
              summary += `：${actorNames} 等`
            } else if (actorNames) {
              summary += `：${actorNames}`
            }
          }

          /**
           * 明细被截断了要说。
           *
           * 插件对 `actors` 明细有条数上限（`report_limit`），实际改了多少在
           * `count` 里，明细里只有 `reported` 条。这两个字段原来被工具层丢掉，
           * 于是「改了 500 个，明细只给 100 条」和「改了 100 个」在调用方眼里
           * 长得一模一样 —— 它会拿明细去核对，然后以为另外 400 个失败了。
           *
           * 这和 message_log / compile_all 是同一类，那两个都如实报了截断，
           * 只有这里漏了。
           */
          const reported = response.reported ?? response.actors?.length ?? 0
          const truncated = reported > 0 && reported < count
          if (truncated) {
            summary += `（明细只列出 ${reported} 个，上限 ${response.report_limit ?? reported}）`
          }

          /**
           * 变换完的位置按米报一句。
           *
           * 这里用的是引擎回读的 `actors[].location`，和 `ue_spawn_actor` 那边
           * 刻意相反 —— spawn 拦的是「入参量纲写错」，这里报的是「改完之后
           * 场景实际有多大」，后者只有回读值说了算。
           */
          const placement = describePlacementScale(
            (response.actors ?? [])
              .map((actor) => actor.location)
              .filter((loc): loc is NonNullable<typeof loc> => Boolean(loc))
          )

          /**
           * 动了旋转就把朝向翻成人话。
           *
           * 用的是引擎回读的 `actors[].rotation`，不是入参 —— 入参的正负号就是
           * 出事的地方，拿它来算等于让错误给自己签字。方向光 pitch 为正会在这里
           * 直接标 ⚠️，这是那类错误唯一能被自动看见的地方（原委见 `tools/ueOrientation.ts`）。
           */
          const orientation = touchesRotation(operation)
            ? describeOrientations(response.actors ?? [])
            : ''

          const snap = operation.snap_to_floor ? describeSnap(response) : ''

          return {
            success: true,
            count,
            actors: response.actors,
            ...(truncated
              ? { reported, report_limit: response.report_limit, actors_truncated: true }
              : {}),
            ...(resolved.usedSemantic ? { resolved_rotation: operation.set?.rotation } : {}),
            ...unmatchedTargetFields(response),
            ...worldFields(response),
            message:
              summary +
              describeUnmatchedTargets(response) +
              describeWorld(response) +
              placement +
              orientation +
              snap,
            _aiInstruction: '变换操作完成。如果所有任务已完成，请调用 done 工具汇报结果。'
          }
        } else {
          const msg =
            (response as RpcFailureShape)?.error ||
            (response as RpcFailureShape)?.message ||
            '变换失败，未收到有效响应'

          const code =
            (response as RpcFailureShape)?.__rpc?.code ?? (response as RpcFailureShape)?.code

          const details = (response as RpcFailureShape)?.details
          return {
            success: false,
            error: `变换失败：${msg}`,
            code,
            details,
            raw: response
          }
        }
      } catch (error) {
        console.error('[SetTransformUnifiedTool] 执行失败:', error)
        // 超时要单独留码，别让调用方拿一个它以为确定的结论去重试
        return describeToolError(error)
      }
    }
  })
}
