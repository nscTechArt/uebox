/**
 * 删除 Actor 工具（v2.0 统一 Selector）
 * 通过 actor.destroy，支持 names/paths/filter 选择器，兼容旧 name/path 与 destroy_batch 入参
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { worldFields, describeWorld, type WorldScopedResponse } from '../../worldScope'
import { describeToolError } from '../../engineErrors'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import {
  describeUnmatchedTargets,
  unmatchedTargetFields,
  type UnmatchedTargetsResponse
} from '../../unmatchedTargets'
import { withPartialHeadline, describeFailures, type PartialFailure } from '../../partialResult'
/**
 * 系统关键 Actor 类名列表（用于删除后检测是否误删）
 * 这些 Actor 通常不应被普通删除操作删除
 */
const SYSTEM_CRITICAL_CLASSES = [
  'DirectionalLight',
  'SkyLight',
  'SkyAtmosphere',
  'VolumetricCloud',
  'ExponentialHeightFog',
  'DefaultPhysicsVolume',
  'WorldSettings',
  'GameModeBase',
  'PlayerStart',
  'AbstractNavData',
  'NavigationData',
  'RecastNavMesh',
  'GameplayDebuggerPlayerManager',
  'Brush', // 通常是默认地形 Brush
  'InstancedFoliageActor'
]

/**
 * 系统关键 Actor 名称列表（精确匹配）
 */
const SYSTEM_CRITICAL_NAMES = ['Floor', 'SM_SkySphere', 'DefaultPhysicsVolume']

const FilterSchema = z.object({
  class: z.string().optional().describe('类名包含匹配（模糊，忽略大小写）'),
  name_pattern: z.string().optional().describe('名称通配符匹配（Wildcard）'),
  exclude_classes: z.array(z.string()).optional().describe('排除的类名数组（忽略大小写）')
})

const TargetsSchema = z
  .object({
    selection: z.boolean().optional().describe('true = 用户此刻在视口/大纲里选中的 Actor'),
    names: z.array(z.string()).optional().describe('按名称/Label 选择'),
    paths: z.array(z.string()).optional().describe('按对象路径选择'),
    filter: FilterSchema.optional().describe('按类名/名称模式筛选')
  })
  .refine(
    (t) =>
      Boolean(
        t.selection || (t.names && t.names.length) || (t.paths && t.paths.length) || t.filter
      ),
    'targets 需至少包含 selection/names/paths/filter 之一'
  )

const BatchItemSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional()
})

/** BatchItemSchema 的推断类型 */
type BatchItemType = z.infer<typeof BatchItemSchema>

const BatchInputSchema = z.union([z.array(BatchItemSchema), z.string()]).optional()

const DestroyActorParamsSchema = z
  .object({
    targets: z.unknown().optional(),
    name: z.string().optional().describe('兼容字段：单个名称'),
    path: z.string().optional().describe('兼容字段：单个路径'),
    batch: BatchInputSchema.describe('兼容 destroy_batch: {name|path} 列表；可为数组或 JSON 字符串')
  })
  .refine(
    (data) =>
      data.targets !== undefined ||
      data.name !== undefined ||
      data.path !== undefined ||
      (data.batch && data.batch.length > 0),
    '请提供 targets，或 name/path，或 batch'
  )

export type DestroyActorParams = z.infer<typeof DestroyActorParamsSchema>

export interface DestroyActorPayload {
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
}

interface DestroyActorResponse extends WorldScopedResponse, UnmatchedTargetsResponse {
  ok?: boolean
  success?: boolean
  message?: string
  error?: string
  count?: number
  target_count?: number
  deleted_actors?: Array<{ name?: string; path?: string; class?: string } | string>
  /** 找到了但引擎没删掉的（新插件才有）。老插件只能从 count < target_count 看出来 */
  failed_count?: number
  failed?: Array<{ name?: string; path?: string; class?: string; reason?: string }>
}

/**
 * 解析 targets 输入，支持字符串或对象
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
 * 规范化 batch 输入
 */
function normalizeBatchInput(batch: DestroyActorParams['batch']): BatchItemType[] | undefined {
  if (batch === undefined) return undefined

  let parsed: unknown = batch
  if (typeof batch === 'string') {
    try {
      parsed = JSON.parse(batch)
    } catch (e) {
      throw new Error(`batch 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error('batch 必须是数组（或可解析为数组的 JSON 字符串）')
  }

  const result: BatchItemType[] = []
  parsed.forEach((item, idx) => {
    if (typeof item === 'string') {
      result.push({ name: item })
    } else if (item && typeof item === 'object') {
      const obj = item as { name?: unknown; path?: unknown }
      const name = typeof obj.name === 'string' ? obj.name : undefined
      const path = typeof obj.path === 'string' ? obj.path : undefined
      if (!name && !path) {
        throw new Error(`batch[${idx}] 需包含 name 或 path`)
      }
      result.push({ name, path })
    } else {
      throw new Error(`batch[${idx}] 类型不支持`)
    }
  })

  return result
}

export function normalizeDestroyTargets(input: DestroyActorParams): DestroyActorPayload {
  const names = new Set<string>()
  const paths = new Set<string>()
  let filter: DestroyActorPayload['targets']['filter'] | undefined
  let selection = false

  // 处理 targets 对象/字符串
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

  // 兼容单体 name/path
  if (input.name) names.add(input.name)
  if (input.path) paths.add(input.path)

  // 兼容 destroy_batch 的 batch 列表
  const batchItems = normalizeBatchInput(input.batch)
  if (batchItems && batchItems.length > 0) {
    batchItems.forEach((item) => {
      if (item?.path) {
        paths.add(item.path)
      } else if (item?.name) {
        names.add(item.name)
      }
    })
  }

  const hasTargets = selection || names.size > 0 || paths.size > 0 || filter
  if (!hasTargets) {
    throw new Error('必须提供至少一个 targets 选择条件（selection/names/paths/filter 或兼容字段）')
  }

  const payload: DestroyActorPayload = {
    targets: {}
  }

  if (selection) payload.targets.selection = true
  if (names.size > 0) payload.targets.names = Array.from(names)
  if (paths.size > 0) payload.targets.paths = Array.from(paths)
  if (filter) payload.targets.filter = filter

  return payload
}

export function createDestroyActorTool(): V2Tool {
  return defineV2Tool({
    description: `删除 Actor（v2.0 统一 Selector）。使用 targets { selection | names | paths | filter } 选择要删除的对象，兼容旧 name/path 以及 destroy_batch 的 batch。
selection: true 表示删掉用户此刻在视口/大纲里选中的那些 —— 用户说"把我选中的删了"时用它。`,
    inputSchema: DestroyActorParamsSchema,
    execute: async (input) => {
      console.log('[DestroyActorTool] 收到请求:', input)

      let payload: DestroyActorPayload
      try {
        payload = normalizeDestroyTargets(input)
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

        console.log('[DestroyActorTool] 发送 actor.destroy 请求:', payload)

        const response = await wsService.callRequest<DestroyActorResponse>(
          'actor.destroy',
          payload,
          getTargetConnectionId(),
          60000
        )

        console.log('[DestroyActorTool] 收到响应:', response)

        const count = response?.count ?? 0
        const targetCount = response?.target_count
        const deletedActors = response?.deleted_actors
        const isSuccess = response?.ok === true || response?.success === true || count > 0

        // 安全检查：检测是否误删了系统关键 Actor
        const criticalDeleted: Array<{ name?: string; class?: string; path?: string }> = []
        if (deletedActors && Array.isArray(deletedActors)) {
          for (const actor of deletedActors) {
            if (typeof actor === 'object' && actor !== null) {
              const actorClass = actor.class || ''
              const actorName = actor.name || ''

              const isClassCritical = SYSTEM_CRITICAL_CLASSES.some((c) =>
                actorClass.toLowerCase().includes(c.toLowerCase())
              )
              const isNameCritical = SYSTEM_CRITICAL_NAMES.some(
                (n) => actorName.toLowerCase() === n.toLowerCase()
              )

              if (isClassCritical || isNameCritical) {
                criticalDeleted.push(actor)
              }
            }
          }
        }

        if (criticalDeleted.length > 0) {
          console.warn('[DestroyActorTool] ⚠️ 警告：检测到系统关键 Actor 被删除！', criticalDeleted)
          console.warn(
            '[DestroyActorTool] 这可能是 UE 插件的 Bug，请检查 actor.destroy 的名称匹配逻辑是否正确。'
          )
        }

        /*
         * 找到了却没删掉的。新插件逐个给 failed[]；老插件只回 count 和 target_count，
         * 差值就是没删掉的个数，只是说不出是谁。
         */
        const failures: PartialFailure[] = (response?.failed ?? []).map((f) => ({
          item: f.name || f.path || '(未命名)',
          reason: f.reason
        }))
        const failedCount = Math.max(
          response?.failed_count ?? failures.length,
          targetCount !== undefined ? targetCount - count : 0,
          0
        )
        const unmatched = unmatchedTargetFields(response).unmatched_count ?? 0

        // 回了 count 就按 count 说话：「ok 但删了 0 个」是失败。
        // 没回 count 的极老插件只能信它的 ok
        const deletedSome = count > 0 || (isSuccess && response?.count === undefined)

        if (isSuccess && deletedSome) {
          const body =
            `已删除 ${count} 个 Actor` +
            // 点名删 7 个只删掉 6 个时，第 7 个的名字必须出现在这句话里。
            // 删除不可逆：静默少删一个，用户是照着「删完了」往下干的
            describeUnmatchedTargets(response) +
            describeWorld(response)
          // 老插件只给了差值没给名单时，也得有一条说明，不能只剩一个数字
          const listed =
            failures.length === 0 && failedCount > 0
              ? [{ item: `${failedCount} 个 Actor`, reason: '引擎没删掉，插件没说是哪几个' }]
              : failures
          return {
            // 有没删掉的就先说部分完成，不能先说「成功删除 6 / 7」（AGENTS.md §5 第 14 条）
            message: withPartialHeadline(
              body,
              { succeeded: count, failed: failedCount, skipped: unmatched, unit: '个 Actor' },
              listed
            ),
            success: true,
            count,
            target_count: targetCount,
            ...(failedCount > 0 ? { failed_count: failedCount, failed: response?.failed } : {}),
            deleted_actors: deletedActors,
            warning:
              criticalDeleted.length > 0
                ? `⚠️ 检测到 ${criticalDeleted.length} 个系统关键 Actor 被误删（可能是 UE 插件 Bug）: ${criticalDeleted.map((a) => a.name || a.path).join(', ')}`
                : undefined,
            ...unmatchedTargetFields(response),
            ...worldFields(response),
            _aiInstruction: 'Actor 删除完成。如果所有任务已完成，请调用 done 工具汇报结果。'
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (response as any)?.__rpc?.code ?? (response as any)?.code
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const details = (response as any)?.details
        const failureList = describeFailures(failures, '没删掉的')
        return {
          success: false,
          deleted_actors: deletedActors,
          error:
            (response?.error || response?.message || '删除 Actor 失败，未收到成功确认') +
            (failureList ? `\n${failureList}` : ''),
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[DestroyActorTool] 执行失败:', error)
        // 超时要单独留码 —— 「删了没删」和「明确没删」是两回事
        return describeToolError(error)
      }
    }
  })
}
