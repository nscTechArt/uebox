/**
 * `blueprint_find_usages` —— 全项目「哪些蓝图用了它」。
 *
 * ## 为什么需要它
 *
 * 改 C++ 的 UFUNCTION / UPROPERTY（改名、改签名、删掉），或者改一个被别的蓝图调用的
 * 蓝图变量 / 函数之前，行家先问「哪些蓝图在用」。编辑器的答法是「在所有蓝图中查找」
 * （Find in Blueprints，FiB）：不加载蓝图，靠保存时写进资产注册表的 FiB 数据全项目搜。
 * 以前技能只能说「没工具，改完全量编译蓝图看谁报错」——那是事后，这个是事前。
 *
 * `ue_content_dependencies` 回答的是**资产级**的「谁引用了这个资产」，粒度到资产；
 * 这个回答的是**成员级**的「谁的图里出现了这个名字」，C++ 成员根本不是资产，只能靠它。
 *
 * ## 薄封装
 *
 * 插件命令 `blueprint.find_in_blueprints` 直接驱动引擎自己的 `FStreamSearch`，
 * 匹配规则和索引都是引擎那份（见 `UAL_BlueprintSearchCommands.cpp`）。
 * `docs/UE项目索引设计-2026-10-14.md` 的「蓝图内容档」以后解 FiBData 建档时复用这条，
 * 不另起一套索引。
 *
 * ## 结果可能不全，必须说出来
 *
 * 没有 FiB 数据的蓝图（老资产、从没在带 FiB 的版本里存过）**根本没被搜**。
 * 「0 个蓝图用到」和「有 37 个蓝图没被搜」放在一起才是真话 —— 所以只要覆盖不全，
 * 摘要里就单独一行写明，而不是藏进 coverage 对象里等模型自己去看。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

/** 插件超时 60 秒后会交出部分结果；这边多留余量，别抢在插件前面超时 */
const FIND_TIMEOUT_MS = 90_000

export const FindBlueprintUsagesSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      '要找的名字：C++ 函数 / 属性名、蓝图变量 / 函数 / 事件名、节点标题。' +
        '按子串匹配，多个词要同时出现，加英文引号按整串匹配'
    ),
  limit: z.number().int().min(1).max(500).optional().describe('最多列几个蓝图，默认 50，上限 500'),
  index_unindexed: z
    .boolean()
    .optional()
    .describe(
      '有蓝图没索引时，请编辑器弹出它自己的「Index All」确认框（用户点了才加载这些蓝图建索引，' +
        '大工程会卡一阵）。默认 false。只在上一次结果说不全、而且用户同意时用'
    )
})

export type FindBlueprintUsagesInput = z.infer<typeof FindBlueprintUsagesSchema>

export interface FiBMatch {
  /** 命中项的显示文字：节点标题、变量名、引脚名、图表名 */
  text: string
  /** 引擎给的类别：Function Call / Event / Variable / Pin / Graph……（编辑器语言） */
  category?: string
  /** 在哪：图表 > 节点 */
  context?: string
}

export interface FiBBlueprint {
  /** 包路径，/Game/A/BP_X */
  path: string
  object_path?: string
  match_count: number
  matches: FiBMatch[]
  matches_truncated?: boolean
}

export type IndexAllStatus =
  | 'confirm_dialog_shown'
  | 'already_running'
  | 'nothing_to_index'
  | 'disabled_by_settings'

export interface FindInBlueprintsResponse {
  ok: boolean
  query: string
  blueprint_count: number
  match_count: number
  blueprints: FiBBlueprint[]
  truncated?: boolean
  timed_out: boolean
  elapsed_ms?: number
  coverage: {
    unindexed: number
    out_of_date: number
    failed_to_index: number
    indexing_in_progress: boolean
    asset_discovery_in_progress: boolean
    complete: boolean
  }
  index_all?: { status: IndexAllStatus | string }
}

/** schema → 插件参数。没给的不发，插件用自己的默认值 */
export function buildFindUsagesParams(input: FindBlueprintUsagesInput): Record<string, unknown> {
  const params: Record<string, unknown> = { query: input.query.trim() }
  if (input.limit !== undefined) params.limit = input.limit
  if (input.index_unindexed) params.index_unindexed = true
  return params
}

/** 覆盖不全的那一行；全覆盖时返回 undefined */
export function describeIncompleteness(response: FindInBlueprintsResponse): string | undefined {
  const c = response.coverage
  const parts: string[] = []
  if (c.unindexed > 0) parts.push(`${c.unindexed} 个蓝图没有索引、根本没被搜`)
  if (c.out_of_date > 0) parts.push(`${c.out_of_date} 个索引格式过旧、可能漏项`)
  if (c.failed_to_index > 0) parts.push(`${c.failed_to_index} 个建索引失败`)
  if (response.timed_out) parts.push('搜索超时，只交了已搜到的部分')
  if (c.asset_discovery_in_progress) parts.push('资产注册表还在扫描')
  if (parts.length === 0) return undefined

  let next: string
  switch (response.index_all?.status) {
    case 'confirm_dialog_shown':
      next = '已请编辑器弹出它的「Index All」确认框：等用户确认、右下角索引进度走完后再搜一次。'
      break
    case 'already_running':
      next = '编辑器正在建索引，等右下角进度走完再搜一次。'
      break
    case 'disabled_by_settings':
      next =
        '本项目在 Blueprint Editor Settings 里禁用了 Index All（AllowIndexAllBlueprints），' +
        '没索引的蓝图只能打开另存后才搜得到；改完仍要全量编译蓝图兜底。'
      break
    default:
      next = response.timed_out
        ? '稍后再搜一次（编辑器启动后的第一次搜索要等引擎建完推迟的索引）。'
        : c.unindexed > 0
          ? '要补全：征得用户同意后带 index_unindexed: true 再调一次（编辑器会弹确认框并加载这些蓝图），' +
            '或请用户在「在所有蓝图中查找」窗口点 Index All。'
          : // 只有「过旧」：这些蓝图其实搜过了，只是可能漏项。新工程里它们几乎全是引擎和插件自带的
            // 蓝图（实测 5.5 空工程 55 个），为它们弹框重建索引是让用户等一件和他无关的事
            '这些已经搜过，只是可能漏项；改完仍要编译受影响的蓝图兜底。'
  }
  return `结果可能不全：${parts.join('，')}。${next}`
}

/** 项目自己的蓝图（/Game 下）。其余是引擎和插件自带的，用户改 C++ 时动不了它们 */
export function isProjectBlueprint(path: string): boolean {
  return path.startsWith('/Game/')
}

export function summarizeFindUsages(response: FindInBlueprintsResponse): string {
  const lines: string[] = []
  const quoted = `「${response.query}」`
  if (response.blueprint_count === 0) {
    lines.push(`没有蓝图匹配${quoted}`)
  } else {
    // 项目的排前面：搜引擎函数名时，结果里常混着引擎、插件自带的蓝图，那些不是要改的
    const ordered = [
      ...response.blueprints.filter((bp) => isProjectBlueprint(bp.path)),
      ...response.blueprints.filter((bp) => !isProjectBlueprint(bp.path))
    ]
    const outside = ordered.length - ordered.filter((bp) => isProjectBlueprint(bp.path)).length
    lines.push(
      `${response.blueprint_count} 个蓝图匹配${quoted}（共 ${response.match_count} 处）` +
        (response.truncated ? `，只列了前 ${response.blueprints.length} 个` : '') +
        (outside > 0 ? `；列出的里有 ${outside} 个是引擎或插件自带的（不在 /Game 下）` : '')
    )
    for (const bp of ordered) {
      const first = bp.matches
        .slice(0, 3)
        .map((m) => (m.context ? `${m.context} > ${m.text}` : m.text))
        .join('；')
      const tag = isProjectBlueprint(bp.path) ? '' : '［引擎/插件自带］'
      lines.push(`- ${tag}${bp.path}（${bp.match_count} 处）${first ? `：${first}` : ''}`)
    }
  }
  const incomplete = describeIncompleteness(response)
  if (incomplete) lines.push(incomplete)
  else if (response.blueprint_count === 0)
    lines.push(
      '全部蓝图都已索引；名字是驼峰写法时，节点标题可能是带空格的显示名（如 "My Var"），' +
        '可换那种写法再搜一次。'
    )
  return lines.join('\n')
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createFindBlueprintUsagesTool() {
  return defineV2Tool({
    description: `全项目搜「哪些蓝图用了这个名字」—— 编辑器「在所有蓝图中查找」（Find in Blueprints）。

改名、改签名、删除 C++ 的 UFUNCTION / UPROPERTY，或别的蓝图在调的变量 / 函数 / 事件之前用它，
把波及的蓝图列给用户。不加载蓝图，读的是引擎存在资产注册表里的索引。

- 按子串匹配节点标题、调用的函数名、变量、引脚、图表名。驼峰名搜不到时换显示名（"My Var"）再搜。
- 是名字匹配，不是引用分析：同名的不同成员也会命中，按 context（图表 > 节点）甄别。
- 资产级的「谁引用了这个资产」用 ue_content_dependencies；这个管成员级。
- 回包说「结果可能不全」时，那些蓝图没被搜到，转告用户。查过也不免编译：改完仍要编译受影响的蓝图。`,

    inputSchema: FindBlueprintUsagesSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return { success: false, error: UE_NOT_CONNECTED_MESSAGE }
        }

        const response = await wsService.callRequest<FindInBlueprintsResponse>(
          'blueprint.find_in_blueprints',
          buildFindUsagesParams(input),
          getTargetConnectionId(),
          FIND_TIMEOUT_MS
        )

        // 插件 code>=400 时 callRequest 归一成 { ok:false, error }，没有 blueprints 数组 ——
        // 不拦的话下面会把一次失败报成「没有蓝图匹配」（同 compileAllBlueprints.ts 的坑）
        if (!response || !Array.isArray(response.blueprints) || !response.coverage) {
          const raw = (response ?? {}) as unknown as Record<string, unknown>
          return {
            success: false,
            error:
              (typeof raw.error === 'string' ? raw.error : '') ||
              (typeof raw.message === 'string' ? raw.message : '') ||
              '插件没有返回搜索结果（blueprint.find_in_blueprints）。插件版本过旧时需要先更新插件'
          }
        }

        return {
          success: true,
          summary: summarizeFindUsages(response),
          blueprint_count: response.blueprint_count,
          match_count: response.match_count,
          blueprints: response.blueprints.map((bp) => ({
            path: bp.path,
            match_count: bp.match_count,
            matches: bp.matches,
            ...(bp.matches_truncated ? { matches_truncated: true } : {})
          })),
          ...(response.truncated ? { truncated: true } : {}),
          coverage: response.coverage,
          ...(response.timed_out ? { timed_out: true } : {}),
          ...(response.index_all ? { index_all: response.index_all } : {})
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
