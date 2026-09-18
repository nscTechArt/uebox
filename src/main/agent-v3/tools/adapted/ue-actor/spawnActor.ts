/**
 * 创建 Actor 工具（v2.0 全能生成）
 * 通过 WebSocket 向虚幻引擎插件发送 actor.spawn 命令，单体/批量统一入口
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { worldFields, describeWorld, type WorldScopedResponse } from '../../worldScope'
import { CM_FIELD_NOTE, UE_UNIT_NOTE, describePlacementScale } from '../../ueUnits'
import { UE_ROTATION_NOTE, describeOrientations } from '../../ueOrientation'
import { describeToolError } from '../../engineErrors'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
const BUILTIN_PRESET_SET = new Set([
  'cube',
  'sphere',
  'cylinder',
  'cone',
  'plane',
  'point_light',
  'spot_light',
  'directional_light',
  'rect_light',
  'camera'
])

/**
 * 位置和缩放**不能共用一个 schema**。
 *
 * 它们的字段名一样（x/y/z），量纲完全不同：位置是厘米，缩放是倍数。
 * 共用一份 `.describe()` 就只能写成「X 坐标」这种不带量纲的话，而位置漏标单位
 * 正是 100 倍缩放事故的起点（原委见 `tools/ueUnits.ts` 文件头）。
 */
const LocationSchema = z.object({
  x: z.number().default(0).describe(`X 坐标，${CM_FIELD_NOTE}`),
  y: z.number().default(0).describe(`Y 坐标，${CM_FIELD_NOTE}`),
  z: z.number().default(0).describe(`Z 坐标，${CM_FIELD_NOTE}`)
})

/**
 * 缩放的默认值是 **1**，不是 0。
 *
 * zod 的 `.default()` 在解析时**会补齐缺失的键**：默认值写 0 的话，
 * `scale: { x: 2 }`（「把它 X 方向拉长两倍」）解析出来是 `{ x: 2, y: 0, z: 0 }`，
 * 插件照着 `SetActorScale3D(2, 0, 0)` 一执行，物体当场被压成一张纸。
 * 整个 scale 省略时不受影响（`mergeTransform` 不会带上它，插件那侧默认 1,1,1），
 * 所以这个坑只在**只写一两个轴**的时候踩得到 —— 而那正是最自然的写法。
 *
 * 位置和旋转的 0 是对的（原点、不转），倍率的 0 不是「没给」，是「压扁」。
 * 2026-09-11 由盒子自己的 agent 读 schema 时发现。
 */
const ScaleSchema = z.object({
  x: z.number().default(1).describe('X 缩放倍数（1 = 原始大小），不是长度'),
  y: z.number().default(1).describe('Y 缩放倍数（1 = 原始大小），不是长度'),
  z: z.number().default(1).describe('Z 缩放倍数（1 = 原始大小），不是长度')
})

const RotatorSchema = z.object({
  pitch: z.number().default(0).describe('俯仰角（绕 Y 轴），单位度'),
  yaw: z.number().default(0).describe('偏航角（绕 Z 轴），单位度'),
  roll: z.number().default(0).describe('翻滚角（绕 X 轴），单位度')
})

const TransformSchema = z.object({
  location: LocationSchema.optional().describe(`生成位置，${CM_FIELD_NOTE}`),
  rotation: RotatorSchema.optional().describe('生成旋转，单位度'),
  scale: ScaleSchema.optional().describe('缩放倍数，不是长度')
})

export const SpawnActorInstanceSchema = z
  .object({
    asset_id: z.string().trim().min(1).optional().describe('推荐字段，支持别名/路径/类名'),
    preset: z.string().trim().min(1).optional().describe('兼容字段：旧别名'),
    class: z.string().trim().min(1).optional().describe('兼容字段：旧类路径或类名'),
    name: z.string().trim().optional().describe('可选，强制命名'),
    mesh: z.string().trim().optional().describe('覆盖静态网格路径'),
    transform: TransformSchema.optional().describe(`位置（${CM_FIELD_NOTE}）/旋转/缩放倍数`),
    // 兼容旧输入：顶层位置/旋转/缩放
    location: LocationSchema.optional().describe(CM_FIELD_NOTE),
    rotation: RotatorSchema.optional(),
    scale: ScaleSchema.optional()
  })
  .refine(
    (data) => Boolean(data.asset_id || data.preset || data.class),
    'asset_id / preset / class 至少提供一个'
  )

export type SpawnActorInstanceInput = z.infer<typeof SpawnActorInstanceSchema>

/**
 * 一次最多建几个。
 *
 * 这个数**必须和插件的 `ual.MaxBatchCreate` 默认值一致**（50，见
 * `plugin/.../UAL_CommandUtils.cpp` 的 `CVarUALMaxBatchCreate`）。schema 写 100、
 * 服务端认 50 的那段时间里，发 53 个会被整批 413 顶回来 —— 模型照着 schema
 * 组了一个合法请求，却撞上一个它无从知道的墙，只能拆成两次重发。
 *
 * 用户在编辑器控制台把 cvar 调高了的话，这里会比服务端窄一点。那是可以接受的：
 * 调高是个显式动作，而「按文档写却被拒绝」每一次都要多花一轮。
 */
const MAX_BATCH_SPAWN = 50

export const SpawnActorParamsSchema = z
  .object({
    ver: z.string().trim().optional(),
    instances: z
      .array(SpawnActorInstanceSchema)
      .min(1)
      .max(MAX_BATCH_SPAWN)
      .optional()
      .describe(`待创建实例列表（最多 ${MAX_BATCH_SPAWN} 个）`),
    batch: z
      .array(SpawnActorInstanceSchema)
      .min(1)
      .max(MAX_BATCH_SPAWN)
      .optional()
      .describe('兼容字段：等价于 instances'),
    // 兼容旧版单体参数
    asset_id: z.string().trim().min(1).optional(),
    preset: z.string().trim().min(1).optional(),
    class: z.string().trim().min(1).optional(),
    name: z.string().trim().optional(),
    mesh: z.string().trim().optional(),
    transform: TransformSchema.optional(),
    location: LocationSchema.optional().describe(CM_FIELD_NOTE),
    rotation: RotatorSchema.optional(),
    scale: ScaleSchema.optional()
  })
  .refine(
    (data) =>
      (data.instances && data.instances.length > 0) ||
      (data.batch && data.batch.length > 0) ||
      data.asset_id ||
      data.preset ||
      data.class,
    '请提供 instances/batch，或单体参数 asset_id/preset/class'
  )

export type SpawnActorParams = z.infer<typeof SpawnActorParamsSchema>

export interface SpawnActorNormalizedInstance {
  asset_id?: string
  preset?: string
  class?: string
  name?: string
  mesh?: string
  transform?: {
    location?: { x?: number; y?: number; z?: number }
    rotation?: { pitch?: number; yaw?: number; roll?: number }
    scale?: { x?: number; y?: number; z?: number }
  }
}

export interface ActorSpawnPayload {
  ver: string
  instances: SpawnActorNormalizedInstance[]
}

interface SpawnActorV2Response extends WorldScopedResponse {
  ok?: boolean
  success?: boolean
  message?: string
  error?: string
  count?: number
  created?:
    | (SpawnActorNormalizedInstance & {
        path?: string
        type?: string
        asset_id?: string
      })[]
    | null
}

/**
 * 尝试修复常见的 JSON 格式问题
 * @param jsonStr 可能有问题的 JSON 字符串
 * @returns 修复后的字符串
 *
 * 处理的问题：
 * 1. 缺少闭合的 } 或 ]
 * 2. 数组元素缺少闭合 }（如 AI 模型截断输出）
 * 3. 尾部多余的逗号
 * 4. 对象内缺少闭合 }
 */
function repairJson(jsonStr: string): string {
  if (!jsonStr || typeof jsonStr !== 'string') {
    return jsonStr
  }

  let repaired = jsonStr.trim()

  // 移除尾部多余的逗号
  repaired = repaired.replace(/,\s*([\]}])/g, '$1')

  // 统计括号
  let openBraces = 0 // {
  let closeBraces = 0 // }
  let openBrackets = 0 // [
  let closeBrackets = 0 // ]
  let inString = false
  let escapeNext = false

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (char === '\\') {
      escapeNext = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') openBraces++
    else if (char === '}') closeBraces++
    else if (char === '[') openBrackets++
    else if (char === ']') closeBrackets++
  }

  // 计算缺失的括号数量
  const missingBraces = openBraces - closeBraces
  const missingBrackets = openBrackets - closeBrackets

  if (missingBraces > 0 || missingBrackets > 0) {
    console.log(`[repairJson] 检测到缺失括号: { 缺 ${missingBraces} 个, [ 缺 ${missingBrackets} 个`)

    // 移除尾部不完整的内容（如果在逗号后截断）
    repaired = repaired.replace(/,\s*$/, '')

    // 补充缺失的 }
    for (let i = 0; i < missingBraces; i++) {
      repaired += '}'
    }

    // 补充缺失的 ]
    for (let i = 0; i < missingBrackets; i++) {
      repaired += ']'
    }

    console.log('[repairJson] 已修复 JSON，补充了缺失的括号')
  }

  return repaired
}

/**
 * 尝试解析 JSON，失败时自动修复并重试
 * @param jsonStr JSON 字符串
 * @returns 解析后的数组，或 undefined（若修复后仍失败）
 */
function parseJsonArrayWithRepair(jsonStr: string): unknown[] | undefined {
  if (!jsonStr || typeof jsonStr !== 'string') {
    return undefined
  }

  // 第一次尝试：直接解析
  try {
    const parsed = JSON.parse(jsonStr)
    if (Array.isArray(parsed)) {
      return parsed
    }
    console.warn('[parseJsonArrayWithRepair] 解析成功但不是数组')
    return undefined
  } catch {
    console.log('[parseJsonArrayWithRepair] 首次解析失败，尝试修复...')
  }

  // 第二次尝试：修复后解析
  try {
    const repaired = repairJson(jsonStr)
    const parsed = JSON.parse(repaired)
    if (Array.isArray(parsed)) {
      console.log(`[parseJsonArrayWithRepair] 修复成功！解析出 ${parsed.length} 个元素`)
      return parsed
    }
    console.warn('[parseJsonArrayWithRepair] 修复后解析成功但不是数组')
    return undefined
  } catch (secondError) {
    console.error('[parseJsonArrayWithRepair] 修复后仍无法解析:', secondError)
    return undefined
  }
}

/**
 * 尝试解析可能是 JSON 字符串的对象
 * @param value 原始值（可能是对象或 JSON 字符串）
 * @returns 解析后的对象，或 undefined（如果解析失败）
 */
function parseJsonIfString<T>(value: T | string | undefined): T | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return undefined
    }
  }
  return value as T
}

/**
 * 合并 transform 参数（支持嵌套 transform 对象和顶层 location/rotation/scale）
 * @param raw 包含 transform、location、rotation、scale 的输入
 * @returns 合并后的 transform 对象
 */
function mergeTransform(
  raw: Pick<SpawnActorInstanceInput, 'transform' | 'location' | 'rotation' | 'scale'>
): SpawnActorNormalizedInstance['transform'] {
  // 防御性解析：这些字段可能是 JSON 字符串
  const parsedTransform = parseJsonIfString(raw.transform)
  const location = parseJsonIfString(parsedTransform?.location) ?? parseJsonIfString(raw.location)
  const rotation = parseJsonIfString(parsedTransform?.rotation) ?? parseJsonIfString(raw.rotation)
  const scale = parseJsonIfString(parsedTransform?.scale) ?? parseJsonIfString(raw.scale)

  if (!location && !rotation && !scale) {
    return undefined
  }

  return {
    ...(location ? { location } : {}),
    ...(rotation ? { rotation } : {}),
    ...(scale ? { scale } : {})
  }
}

/**
 * 规范化单个实例输入，只保留有效的非空值
 * @param raw 原始实例输入
 * @returns 规范化后的实例对象（只包含有值的字段）
 */
function normalizeInstance(raw: SpawnActorInstanceInput): SpawnActorNormalizedInstance {
  const normalizedAssetId =
    raw.asset_id?.trim() || raw.preset?.trim() || raw.class?.trim() || undefined

  // preset 字段在使用别名时自动补齐，保持兼容
  const lowerAssetId = normalizedAssetId?.toLowerCase()
  const preset =
    raw.preset?.trim() ||
    (lowerAssetId && BUILTIN_PRESET_SET.has(lowerAssetId) ? lowerAssetId : undefined)

  const finalAssetId =
    lowerAssetId && BUILTIN_PRESET_SET.has(lowerAssetId) ? lowerAssetId : normalizedAssetId

  // 只添加有值的字段，避免 undefined 值干扰序列化和过滤
  const instance: SpawnActorNormalizedInstance = {}

  if (finalAssetId) {
    instance.asset_id = finalAssetId
  }
  if (preset) {
    instance.preset = preset
  }
  if (raw.class?.trim()) {
    instance.class = raw.class.trim()
  }
  if (raw.name?.trim()) {
    instance.name = raw.name.trim()
  }
  if (raw.mesh?.trim()) {
    instance.mesh = raw.mesh.trim()
  }

  const transform = mergeTransform(raw)
  if (transform) {
    instance.transform = transform
  }

  return instance
}

/**
 * 构建发送到 UE 的 Spawn 请求 payload
 * @param input 输入参数
 * @returns 规范化后的 payload
 */
export function buildSpawnPayload(input: SpawnActorParams): ActorSpawnPayload {
  const ver = input.ver?.trim() || '2.0'

  // 防御性解析：AI 模型可能将数组作为 JSON 字符串传递
  let rawInstances = input.instances
  let rawBatch = input.batch

  // 如果 instances 是字符串，使用修复解析（处理 AI 生成的不完整 JSON）
  if (typeof rawInstances === 'string') {
    const parsed = parseJsonArrayWithRepair(rawInstances)
    if (parsed) {
      rawInstances = parsed as SpawnActorInstanceInput[]
      console.log('[buildSpawnPayload] instances 解析成功，长度:', rawInstances.length)
    } else {
      console.warn('[buildSpawnPayload] instances 字符串解析失败')
      rawInstances = undefined
    }
  }

  // 如果 batch 是字符串，使用修复解析（处理 AI 生成的不完整 JSON）
  if (typeof rawBatch === 'string') {
    const parsed = parseJsonArrayWithRepair(rawBatch)
    if (parsed) {
      rawBatch = parsed as SpawnActorInstanceInput[]
      console.log('[buildSpawnPayload] batch 解析成功，长度:', rawBatch.length)
    } else {
      console.warn('[buildSpawnPayload] batch 字符串解析失败')
      rawBatch = undefined
    }
  }

  const directInstances =
    (Array.isArray(rawInstances) ? rawInstances : undefined) ??
    (Array.isArray(rawBatch) ? rawBatch : undefined) ??
    []

  const singleCandidate =
    directInstances.length === 0
      ? {
          asset_id: input.asset_id,
          preset: input.preset,
          class: input.class,
          name: input.name,
          mesh: input.mesh,
          transform: input.transform,
          location: input.location,
          rotation: input.rotation,
          scale: input.scale
        }
      : null

  const sourceInstances: SpawnActorInstanceInput[] =
    directInstances.length > 0
      ? directInstances
      : singleCandidate &&
          (singleCandidate.asset_id || singleCandidate.preset || singleCandidate.class)
        ? [singleCandidate as SpawnActorInstanceInput]
        : []

  const normalizedInstances = sourceInstances
    .map(normalizeInstance)
    // 过滤空实例，保证输出干净
    .filter((item) => Object.keys(item).length > 0)

  if (normalizedInstances.length === 0) {
    throw new Error('至少提供一个有效的实例（instances/batch 或单体参数）')
  }

  return {
    ver,
    instances: normalizedInstances
  }
}

export function createSpawnActorTool(): V2Tool {
  return defineV2Tool({
    description: `在虚幻引擎场景中创建 Actor（单体/批量统一入口），对应插件接口 actor.spawn v2.0。

【核心能力】
- 支持传入 instances 数组批量创建（一批最多 ${MAX_BATCH_SPAWN} 个，超了整批拒绝），也支持单体参数
- asset_id 推荐字段：支持别名 / 资源路径 / 类名，自动回落解析
- 兼容旧字段：preset（别名）、class（类路径），旧 batch 自动转为 instances
- 可直接覆盖静态网格（mesh），附带 transform 或顶层 location/rotation/scale

${UE_UNIT_NOTE}

【别名一览】
- 几何体: cube | sphere | cylinder | cone | plane
- 灯光: point_light | spot_light | directional_light | rect_light
- 其他: camera

【响应】
- count: 成功创建数量
- created: 与输入顺序一致，失败项为 null，包含 name/path/class/asset_id/type/preset
- message 末尾会把这一批的**位置跨度按米**报出来。摆完先看那一句：
  跨度和你想要的场景尺寸差两个数量级，就是米/厘米搞混了，不要接着挪物体
- 给了 rotation 的灯光/相机，message 还会说它照向哪；方向光 pitch 为正会标 ⚠️（那是仰照）。
  方向光更省事的做法：先生成，再用 ue_set_transform 的 sun: { elevation, azimuth } 定太阳位置

${UE_ROTATION_NOTE}`,

    inputSchema: SpawnActorParamsSchema,
    execute: async (input) => {
      console.log('[SpawnActorTool] 收到请求:', input)

      let payload: ActorSpawnPayload
      try {
        payload = buildSpawnPayload(input)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        console.log('[SpawnActorTool] 发送 actor.spawn v2 请求:', JSON.stringify(payload, null, 2))
        console.log(`[SpawnActorTool] instances 数量: ${payload.instances.length}`)

        const response = await wsService.callRequest<SpawnActorV2Response>(
          'actor.spawn',
          payload,
          getTargetConnectionId(),
          60000
        )

        console.log('[SpawnActorTool] 收到响应:', response)

        const created = response?.created ?? []
        const countFromCreated =
          Array.isArray(created) && created.length > 0
            ? created.filter((item) => item !== null && item !== undefined).length
            : undefined

        /**
         * 引擎回了几个就算几个，**不拿「我请求了几个」兜底**。
         *
         * 这里原来的兜底是 `?? payload.instances.length` —— 插件什么数据都没回
         * （老版本、字段名改了、响应被截断）时，它按请求数当成功数，于是 AI 会说
         * 「成功创建 5 个 Actor」，而场景里一个都没有。用户照着这句话往下干，
         * 错误要到很久以后才暴露，那时已经分不清是哪一步出的问题。
         *
         * 不回读不许报 success：数不出来就说没确认上，让模型自己去查。
         *
         * 反过来也一样不许：**回读数出来了就是成功**，哪怕插件没回 ok/success 标志。
         * 有些版本只回 `{count, created}`，卡在「必须有标志」上的话，Actor 明明建出来了
         * 却报失败，模型照着这句失败再建一遍 —— 场景里凭空多一份重复。
         * 判据是回读，标志只用来否决（明说 false 才算失败）。
         */
        const count = response?.count ?? countFromCreated
        const confirmed = typeof count === 'number' && count > 0
        const claimedOk = response?.success === true || response?.ok === true
        const deniedOk = response?.success === false || response?.ok === false
        const isSuccess = confirmed && !deniedOk

        if (!isSuccess && claimedOk) {
          return {
            success: false,
            unconfirmed: true,
            message:
              '引擎回了「成功」，但没有回创建了哪些 Actor，所以这一步没有确认上。' +
              '用 ue_get_actors 查一下关卡里到底有没有它们，再决定要不要重试 —— 不要直接当成功。',
            requested: payload.instances.length
          }
        }

        if (isSuccess) {
          /**
           * 用**发出去的** location 算尺度，不用回读的。
           *
           * 这一句要拦的是「按米算的数字填进了厘米的槽」，错在入参那一刻就已经
           * 铸成，回读只会原样确认它 —— 拿回读去算等于让错误自己给自己签字。
           * 插件也不保证在 `created` 里回 transform。
           */
          const placement = describePlacementScale(
            payload.instances
              .map((item) => item.transform?.location)
              .filter((loc): loc is NonNullable<typeof loc> => Boolean(loc))
          )

          /**
           * 朝向也按**发出去的** rotation 说，理由同上：插件不保证回 transform。
           * 类名优先用引擎回的 `created[i].class`，没有就拿 asset_id 猜 ——
           * "directional_light" / "DirectionalLight" 都含关键字，够用。
           */
          const orientation = describeOrientations(
            payload.instances.map((item, index) => {
              const made = Array.isArray(created) ? created[index] : undefined
              return {
                name: made?.name ?? item.asset_id,
                class: made?.class ?? item.asset_id,
                rotation: item.transform?.rotation
              }
            })
          )

          return {
            success: true,
            count,
            created,
            ...worldFields(response),
            message:
              (response?.message || `成功创建 ${count} 个 Actor`) +
              describeWorld(response) +
              placement +
              orientation,
            _aiInstruction: 'Actor 创建完成。如果所有任务已完成，请调用 done 工具汇报结果。'
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (response as any)?.__rpc?.code ?? (response as any)?.code
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const details = (response as any)?.details
        return {
          success: false,
          created,
          error: response?.error || response?.message || '创建 Actor 失败，未收到成功确认',
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[SpawnActorTool] 执行失败:', error)
        // 超时要单独留码：这条路径下 Actor 可能已经生成了，报成「明确失败」
        // 会让调用方重试，于是多出第二个（见 tools/engineErrors.ts）
        return describeToolError(error)
      }
    }
  })
}
