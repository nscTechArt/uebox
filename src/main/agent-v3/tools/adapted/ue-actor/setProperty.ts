/**
 * 设置 Actor 属性工具 (v1.0)
 * 通过 WebSocket 向虚幻引擎插件发送 actor.set_property 命令
 * 支持修改 Actor 的各种属性（如灯光强度、颜色、Mobility 等）
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import {
  describeUnmatchedTargets,
  unmatchedTargetFields,
  type UnmatchedTargetsResponse
} from '../../unmatchedTargets'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * Filter Schema - 场景扫描筛选条件
 */
const FilterSchema = z.object({
  class: z.string().optional().describe('类名包含匹配（模糊，忽略大小写）'),
  name_pattern: z.string().optional().describe('名称通配符匹配（Wildcard）'),
  exclude_classes: z.array(z.string()).optional().describe('排除的类名数组')
})

/**
 * Targets Schema - 统一选择器
 */
const TargetsSchema = z
  .object({
    selection: z.boolean().optional().describe('true = 用户此刻在视口/大纲里选中的 Actor'),
    names: z.array(z.string()).optional().describe('按名称/Label 精准查找'),
    paths: z.array(z.string()).optional().describe('按对象路径查找'),
    filter: FilterSchema.optional().describe('场景扫描筛选条件')
  })
  .refine(
    (t) =>
      Boolean(
        t.selection || (t.names && t.names.length) || (t.paths && t.paths.length) || t.filter
      ),
    'targets 需至少包含 selection/names/paths/filter 之一'
  )

/**
 * Set Property 请求参数
 */
const SetPropertyParamsSchema = z
  .object({
    targets: z.unknown().optional().describe('统一选择器：{ names?, paths?, filter? }'),
    properties: z
      .unknown()
      .describe(
        '要设置的属性键值对，如 { "Intensity": 10000.0, "LightColor": { "r": 255, "g": 0, "b": 0 } }'
      ),
    // 兼容旧参数
    name: z.string().optional().describe('兼容字段：单个 Actor 名称'),
    path: z.string().optional().describe('兼容字段：单个 Actor 路径')
  })
  .refine(
    (data) => data.targets !== undefined || data.name !== undefined || data.path !== undefined,
    '请提供 targets 选择器，或兼容的 name/path 参数'
  )

// ============================================================================
// 类型定义
// ============================================================================

/** Set Property 请求 Payload */
export interface SetPropertyPayload {
  targets: {
    selection?: boolean
    names?: string[]
    paths?: string[]
    filter?: {
      class?: string
      name_pattern?: string
      exclude_classes?: string[]
    }
  }
  properties: Record<string, unknown>
}

/** 单个属性错误信息 */
interface PropertyError {
  property: string
  error: string
  suggestions?: string[]
  expected_type?: string
  current_value?: unknown
}

/** 单个 Actor 结果 */
interface ActorPropertyResult {
  name: string
  class: string
  path: string
  updated?: Record<string, unknown>
  errors?: PropertyError[]
}

/** Set Property 响应数据 */
interface SetPropertyResponse extends UnmatchedTargetsResponse {
  count: number
  actors: ActorPropertyResult[]
  error?: string
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 解析 targets 输入（支持字符串或对象）
 */
function parseTargetsInput(rawTargets: unknown): unknown {
  if (typeof rawTargets === 'string') {
    try {
      return JSON.parse(rawTargets)
    } catch (e) {
      throw new Error(`targets 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return rawTargets
}

/**
 * 解析 properties 输入（支持字符串或对象）
 */
function parsePropertiesInput(rawProperties: unknown): Record<string, unknown> {
  if (typeof rawProperties === 'string') {
    try {
      const parsed = JSON.parse(rawProperties)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('properties 必须是对象')
      }
      return parsed as Record<string, unknown>
    } catch (e) {
      throw new Error(`properties 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (typeof rawProperties !== 'object' || rawProperties === null || Array.isArray(rawProperties)) {
    throw new Error('properties 必须是对象')
  }
  return rawProperties as Record<string, unknown>
}

type SetPropertyInput = z.infer<typeof SetPropertyParamsSchema>

/**
 * 规范化输入参数
 */
function normalizeSetPropertyParams(input: SetPropertyInput): SetPropertyPayload {
  const names = new Set<string>()
  const paths = new Set<string>()
  let filter: SetPropertyPayload['targets']['filter'] | undefined
  let selection = false

  // 处理 targets
  if (input.targets !== undefined) {
    const parsed = parseTargetsInput(input.targets)
    if (parsed && typeof parsed === 'object') {
      const result = TargetsSchema.safeParse(parsed)
      if (!result.success) {
        throw new Error(`targets 校验失败: ${result.error.message}`)
      }
      const t = result.data
      if (t.selection) selection = true
      t.names?.forEach((n) => names.add(n))
      t.paths?.forEach((p) => paths.add(p))
      if (t.filter) {
        filter = t.filter
      }
    } else {
      throw new Error('targets 必须是对象或可解析的 JSON 字符串')
    }
  }

  // 兼容旧参数
  if (input.name) names.add(input.name)
  if (input.path) paths.add(input.path)

  const hasTargets = selection || names.size > 0 || paths.size > 0 || filter
  if (!hasTargets) {
    throw new Error('必须提供至少一个 targets 选择条件')
  }

  // 解析 properties
  const properties = parsePropertiesInput(input.properties)
  if (Object.keys(properties).length === 0) {
    throw new Error('properties 不能为空')
  }

  const payload: SetPropertyPayload = {
    targets: {},
    properties
  }

  if (selection) payload.targets.selection = true
  if (names.size > 0) payload.targets.names = Array.from(names)
  if (paths.size > 0) payload.targets.paths = Array.from(paths)
  if (filter) payload.targets.filter = filter

  return payload
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建 Set Property 工具
 * @returns Set Property 工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSetPropertyTool() {
  return defineV2Tool({
    description: `修改虚幻引擎场景中 Actor 的属性（v1.0 通用属性修改）。

【核心功能】：
- 修改 Actor 或其组件的属性（如灯光强度、颜色、Mobility 等）
- 自动递归查找属性（Actor → RootComponent → 其他组件）
- 智能提示：属性不存在时返回建议，类型不匹配时返回期望类型

【纯粹整理大纲用 level_organize_actors】本工具也能设 FolderPath（属性名就叫它），
顺手改别的属性时一起改掉是对的。但**只是把一批 Actor 归进文件夹**那件事用那个：
它在 PIE 跑着时会拒绝，而本工具不会 —— 大纲文件夹是编辑器世界的东西，
PIE 里设了只是改一份跑完就没的副本。

【参数详解】：
- targets: 统一选择器 { selection?, names?, paths?, filter? }
  - selection: true —— 用户说"把我选中的这个改成…"时直接用，不用先查名字
- properties: 属性键值对，如 { "Intensity": 10000.0 }

【支持的属性类型】：
- 数字（整型/浮点）、布尔、字符串/Name/Text
- FVector: { x, y, z }
- FRotator: { pitch, yaw, roll }
- FLinearColor/FColor: { r, g, b, a }

【常用属性示例】：
- 灯光强度: { "Intensity": 10000.0 }
- 灯光颜色: { "LightColor": { "r": 255, "g": 0, "b": 0 } }
- 隐藏: { "bHidden": true }（游戏里隐藏）、{ "bHiddenInEditor": true }（只在编辑器里藏）
- 移动性: { "Mobility": "Movable" }

【几个特殊属性 —— 引擎侧专门处理过，名字必须照着写】：
- 改名（大纲里显示的那个名字）: { "ActorLabel": "BP_Door_Main" }
  这是重命名 Actor 的唯一途径，没有单独的改名工具
- 放进大纲文件夹: { "FolderPath": "场景/道具" }
  只挪一两个用它；整批归类用 level_organize_actors
- 物理模拟: { "SimulatePhysics": true }
- 标签（Actor Tags，蓝图里按 tag 找东西靠它）：
  - 整体覆盖: { "Tags": ["Interactable", "Door"] }
  - 只增删不动其它: { "Tags": { "add": ["Interactable"], "remove": ["Debug"] } }`,

    inputSchema: SetPropertyParamsSchema,

    execute: async (input) => {
      console.log('[SetPropertyTool] 收到请求:', input)

      // 规范化参数
      let payload: SetPropertyPayload
      try {
        payload = normalizeSetPropertyParams(input)
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

        console.log('[SetPropertyTool] 发送 actor.set_property 请求:', payload)

        const response = await wsService.callRequest<SetPropertyResponse>(
          'actor.set_property',
          payload,
          getTargetConnectionId(),
          30000
        )

        console.log('[SetPropertyTool] 收到响应:', response)

        if (response) {
          // 若为 RPC 错误响应（code>=400），插件侧通常只返回 message/details
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          const hasActors = Array.isArray((response as unknown as { actors?: unknown }).actors)
          if ((rpcOk === false || rpcSuccess === false) && !hasActors) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '属性修改失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = (response as any)?.details
            return { success: false, error: `属性修改失败：${msg}`, code, details, raw: response }
          }

          const actors = response.actors ?? []

          // 收集所有错误
          const allErrors: string[] = []
          actors.forEach((actor) => {
            if (actor.errors && actor.errors.length > 0) {
              actor.errors.forEach((err) => {
                let errMsg = `${actor.name}.${err.property}: ${err.error}`
                if (err.suggestions && err.suggestions.length > 0) {
                  errMsg += ` (建议: ${err.suggestions.slice(0, 3).join(', ')})`
                }
                allErrors.push(errMsg)
              })
            }
          })

          // 构建摘要
          const updatedCount = actors.filter(
            (a) => a.updated && Object.keys(a.updated).length > 0
          ).length
          let summary = `成功修改 ${updatedCount} 个 Actor 的属性`
          if (allErrors.length > 0) {
            summary += `，${allErrors.length} 个属性设置失败`
          }

          return {
            success: updatedCount > 0,
            count: updatedCount,
            actors,
            errors: allErrors.length > 0 ? allErrors : undefined,
            ...unmatchedTargetFields(response),
            message: summary + describeUnmatchedTargets(response),
            _aiInstruction:
              updatedCount > 0
                ? '属性修改完成。如果所有任务已完成，请调用 done 工具汇报结果。'
                : undefined
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[SetPropertyTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
