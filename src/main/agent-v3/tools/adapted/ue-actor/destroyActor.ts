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
    batch: BatchInputSchema.describe(
      '兼容 destroy_batch: {name|path} 列表；可为数组或 JSON 字符串'
    ),
    force: z
      .boolean()
      .optional()
      .describe('被关卡蓝图或其它 Actor 引用也照删（引用会变 None）。只在用户确认后用')
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
  /** 有引用也删。不传 = 插件把被引用的那几个按住不删，列在 blocked 里 */
  force?: boolean
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

/** 插件回的一条引用方：关卡蓝图（带节点标题）或另一个 Actor 的某个属性 */
interface ActorReferencer {
  /** level_blueprint | actor */
  kind?: string
  referencer?: string
  referencer_path?: string
  /** kind=actor：引用方身上的属性路径，如 TriggerComp.TargetDoor */
  property?: string
  /** kind=level_blueprint：引用它的节点（最多点名 5 个） */
  nodes?: string
  node_count?: number
}

interface ReferencedActorEntry {
  name?: string
  path?: string
  class?: string
  referencers?: ActorReferencer[]
  referencer_count?: number
}

interface DestroyActorResponse extends WorldScopedResponse, UnmatchedTargetsResponse {
  ok?: boolean
  success?: boolean
  message?: string
  error?: string
  count?: number
  target_count?: number
  /** force 删掉的条目会带 referencers：这些引用此刻已经变成 None */
  deleted_actors?: Array<ReferencedActorEntry | string>
  /** 找到了但引擎没删掉的（新插件才有）。老插件只能从 count < target_count 看出来 */
  failed_count?: number
  failed?: Array<{ name?: string; path?: string; class?: string; reason?: string }>
  /** 还被引用、没加 force，所以没删的（新插件才有）。它们原样留在关卡里 */
  blocked_count?: number
  blocked?: ReferencedActorEntry[]
  /** false = 这次没查引用（PIE 世界里删的是副本） */
  references_checked?: boolean
}

/** 一条引用方写成人话：「关卡蓝图（2 个节点：EventGraph: Door_1）」「Trigger_1 的 TargetDoor」 */
function describeReferencer(ref: ActorReferencer): string {
  if (ref.kind === 'level_blueprint') {
    const count = ref.node_count ? `${ref.node_count} 个节点` : '节点'
    return `关卡蓝图（${count}${ref.nodes ? `：${ref.nodes}` : ''}）`
  }
  const who = ref.referencer || ref.referencer_path || '某个 Actor'
  return ref.property ? `${who} 的 ${ref.property}` : who
}

/** 列几个 Actor 的引用方。超出插件上限（每个 20 条）的只说还有几条 */
function describeReferencedActors(entries: readonly ReferencedActorEntry[]): string {
  return entries
    .map((e) => {
      const refs = e.referencers ?? []
      const rest = Math.max((e.referencer_count ?? refs.length) - refs.length, 0)
      const list = refs.map(describeReferencer).join('、') || '（插件没列出引用方）'
      return `- ${e.name || e.path || '(未命名)'}：${list}${rest > 0 ? ` 等，还有 ${rest} 处` : ''}`
    })
    .join('\n')
}

/**
 * 被拦下没删的那段话。用户在大纲里手动删时编辑器会弹框问「它被关卡蓝图引用了，确定？」，
 * 我们这条路不能弹框，所以插件按住不删，这里把同样的问题交给模型去问用户。
 * 不能写成「换个办法删」：绕开的结果就是门和触发器的连线无声断掉。
 */
function describeBlocked(blocked: readonly ReferencedActorEntry[]): string {
  if (blocked.length === 0) return ''
  return (
    `因为还被引用，以下 ${blocked.length} 个 Actor 没删（原样留在关卡里）：\n` +
    describeReferencedActors(blocked) +
    '\n下一步：先把这些引用告诉用户。用户确认仍要删，再带 force: true 重调，这些引用会变成 None；' +
    '否则先改掉引用方（关卡蓝图节点 / 属性）再删。'
  )
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
  if (input.force === true) payload.force = true

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
        const blocked = response?.blocked ?? []
        const blockedCount = Math.max(response?.blocked_count ?? 0, blocked.length)
        // 被拦下的也在 target_count - count 这个差值里，不能再算一遍成「失败」
        const failedCount = Math.max(
          response?.failed_count ?? failures.length,
          targetCount !== undefined ? targetCount - count - blockedCount : 0,
          0
        )
        const unmatched = unmatchedTargetFields(response).unmatched_count ?? 0
        const blockedText = describeBlocked(blocked)
        // force 删掉的：引用此刻已经变成 None，要点名让模型告诉用户去哪儿补
        const broken = (deletedActors ?? []).filter(
          (a): a is ReferencedActorEntry =>
            typeof a === 'object' && a !== null && (a.referencers?.length ?? 0) > 0
        )
        const brokenText =
          broken.length > 0
            ? `以下引用已随删除变成 None，需要用户去补：\n${describeReferencedActors(broken)}`
            : ''

        // 回了 count 就按 count 说话：「ok 但删了 0 个」是失败。
        // 没回 count 的极老插件只能信它的 ok
        const deletedSome = count > 0 || (isSuccess && response?.count === undefined)

        if (isSuccess && deletedSome) {
          const body =
            `已删除 ${count} 个 Actor` +
            // 点名删 7 个只删掉 6 个时，第 7 个的名字必须出现在这句话里。
            // 删除不可逆：静默少删一个，用户是照着「删完了」往下干的
            describeUnmatchedTargets(response) +
            describeWorld(response) +
            (brokenText ? `\n${brokenText}` : '')
          // 老插件只给了差值没给名单时，也得有一条说明，不能只剩一个数字
          const listed =
            failures.length === 0 && failedCount > 0
              ? [{ item: `${failedCount} 个 Actor`, reason: '引擎没删掉，插件没说是哪几个' }]
              : failures
          const headed = withPartialHeadline(
            body,
            // 被引用按住的算「跳过」：没尝试删，原样还在
            {
              succeeded: count,
              failed: failedCount,
              skipped: unmatched + blockedCount,
              unit: '个 Actor'
            },
            listed
          )
          return {
            // 有没删掉的就先说部分完成，不能先说「成功删除 6 / 7」（AGENTS.md §5 第 14 条）
            message: blockedText ? `${headed}\n${blockedText}` : headed,
            success: true,
            count,
            target_count: targetCount,
            ...(failedCount > 0 ? { failed_count: failedCount, failed: response?.failed } : {}),
            ...(blockedCount > 0 ? { blocked_count: blockedCount, blocked } : {}),
            deleted_actors: deletedActors,
            warning:
              criticalDeleted.length > 0
                ? `⚠️ 检测到 ${criticalDeleted.length} 个系统关键 Actor 被误删（可能是 UE 插件 Bug）: ${criticalDeleted.map((a) => a.name || a.path).join(', ')}`
                : undefined,
            ...unmatchedTargetFields(response),
            ...worldFields(response),
            _aiInstruction:
              blockedCount > 0
                ? '有 Actor 因为还被引用没删，先按 message 里的清单问用户，别直接加 force。'
                : 'Actor 删除完成。如果所有任务已完成，请调用 done 工具汇报结果。'
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
            // 全被引用按住时，插件那句英文只是概要；给模型的是逐个列出的引用方和下一步
            blockedText && failures.length === 0
              ? blockedText
              : (response?.error || response?.message || '删除 Actor 失败，未收到成功确认') +
                (failureList ? `\n${failureList}` : '') +
                (blockedText ? `\n${blockedText}` : ''),
          ...(blockedCount > 0 ? { blocked_count: blockedCount, blocked } : {}),
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
