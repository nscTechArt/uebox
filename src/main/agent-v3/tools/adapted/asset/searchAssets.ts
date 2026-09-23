/**
 * 资产搜索原子工具
 * 封装 AssetSearcher 的能力供 Agent 使用
 *
 * ## 两种模式
 *
 * - **有关键词**：每个库按相关度取前 offset+limit 个（models/assetRankedSearch.ts），
 *   全部库按同一个排序键归并，再取这一页。最相关的那个在哪个库都能排到第一页。
 * - **没有关键词**（浏览 / 只按条件筛）：没有相关度可比，照旧当前库在前、首尾相接。
 *
 * 原来关键词也是首尾相接的，于是**当前库永远占满前几页**。真机上用户站在 AIGC 库
 * （155 个 AI 图）里搜 horse / grass / SM_Env，8 次里 7 次首页全是 AIGC 的图和 mp3，
 * FPS 库里 3562 个真命中一个都没露面，模型只能换词重搜、一页页翻。
 * 在 5k~500k 资产的库上实测，这个排法下精确命中的名次随库变大线性变差（第 119 → 第 4018 名），
 * 而按相关度归并始终排第一。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import {
  attachTagNames,
  buildSearchCriteria,
  searchAssets
} from '../../../../agent/tools/app-control/asset-manager/AssetSearcher'
import { formatAssets } from '../../../../agent/tools/app-control/asset-manager/AssetFormatter'
import type { AssetSearchParams } from '../../../../agent/tools/app-control/asset-manager/types'
import { getPublicDatabase, getVaultDatabase } from '../../../../sqliteDataBase'
import { getDeletedAssetData } from '../../../../sqliteDataBase/models/assetData'
import {
  compareScores,
  getAssetRowsByIds,
  rankedSearchVault,
  semanticOnlyIds
} from '../../../../sqliteDataBase/models/assetRankedSearch'
import { isAssetVectorEnabled } from '../../../../sqliteDataBase/models/assetVectorIndex'
import { buildFtsTerms } from '../../../../sqliteDataBase/models/ftsText'
import { ensureAssetSearchIndexWarm } from '../../../../sqliteDataBase/services/assetSearchIndexService'
import { getTagByName } from '../../../../sqliteDataBase/models/tag'
import {
  embedSearchQuery,
  semanticRecall
} from '../../../../sqliteDataBase/services/assetSemanticService'
import type { VaultInfo } from '../../../../sqliteDataBase/VaultManager'
import { resolveFolder } from './folderLookup'
import { runAcrossVaults, VAULT_SCOPE_DESCRIPTION, type VaultRun } from './vaultScope'

/**
 * 中文关键词落空时，**工具自己把库里有什么捞出来**，而不是只丢一句提示。
 *
 * 真机上量到的问题：虚幻资产名基本都是英文（SM_Chair_Wood、T_Wood_Diffuse），
 * 而用户用中文提问。实测「椅子」0 条 /「chair」2 条，「木头」0 条 /「wood」4 条，
 * 「贴图」0 条 /「texture」2 条。
 *
 * 这里**不塞中英词表** —— 那种表永远补不完。但只回一句「请换英文词再搜」也不够：
 * 那等于把这条知识摊派给每一次对话（skill 里为此专门写了一节加一张实测表），
 * 而调用方拿到的仍然是零信息，只能凭空猜一个英文词，猜不中就再猜。
 *
 * 现在的做法是零结果时**自动去掉关键词再查一次**，把库里真实存在的名字回给调用方。
 * 它看着真名挑，比猜词准得多，也不需要任何词表。这和类型/格式过滤落空时
 * 自动放宽是同一个套路 —— 连同那条铁律一起继承：**放宽了必须说出来。**
 */
const SAMPLE_LIMIT = 20

const KEYWORD_MISS_HINT =
  '中文关键词没有命中任何资产 —— 库里的名字基本是英文（SM_Chair_Wood、T_Wood_Diffuse）。' +
  '下面 library_sample 是库里真实存在的资产，照着它挑一个英文词再搜，不要凭空猜。' +
  '想先看清楚库里有哪些类型、哪些文件夹、哪些标签，用 library_overview —— ' +
  '它回的是全量分布，比这 20 个样本有代表性得多。' +
  '注意：中文**标签**是搜得到的，只有名字是英文。'

/** 库里一个开了语义的都没有时才提示去开 —— 已经开了还这么说，模型会去叫用户做一件已经做过的事 */
const ENABLE_SEMANTIC_HINT =
  '另外：资产库设置里可以打开**语义搜索**，打开之后中文查询能直接对上英文资产名。'

/**
 * 分页窗口：offset + limit 最多到这里。
 *
 * 关键词这条路取前 1 万个只要 150ms 左右（50 万资产的库），这个上限保护的是浏览和
 * 带筛选的那几条路 —— 在那里翻到第 25 万个要 5 秒多。翻到 1 万之后还没找到的东西，
 * 靠继续翻也找不到，应该收窄条件；数量分布用 library_overview。
 */
const MAX_RESULT_WINDOW = 10000

/** 纯语义命中最多列几个。它们没有字面依据，列多了只会把模型带偏 */
const SEMANTIC_MATCH_LIMIT = 10

const hasChinese = (value: unknown): boolean => typeof value === 'string' && /[一-龥]/.test(value)

/** 日期两端的兜底。底层 dateRange 要求两端都有值，缺一端整条筛选会被忽略 */
const DATE_MIN = '0001-01-01 00:00:00'
const DATE_MAX = '9999-12-31 23:59:59'

const dayStart = (value: string): string => `${value.trim().slice(0, 10)} 00:00:00`
const dayEnd = (value: string): string => `${value.trim().slice(0, 10)} 23:59:59`

/**
 * 真正让出主进程。
 *
 * SQLite 调用是同步的，而 `await` 一个已完成的 Promise 只让出微任务 —— 几个大库连着搜，
 * 同步耗时会累加起来一次性卡住界面。库与库之间让一下宏任务，界面和 IPC 才插得进来。
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const isAigcVault = (vault: VaultInfo): boolean =>
  vault.systemKey === 'aigc' || vault.id === 'system_vault_aigc'

interface SearchOutcome {
  success?: boolean
  count?: number
  error?: string
  assets?: Array<Record<string, unknown>>
}

/**
 * 这一页里有哪些引擎版本 —— 只在真有 .uasset 版本记录时才说一句。
 *
 * `.uasset` 只能导进**同版本或更高版本**的工程，所以这一栏是「能不能进我这个工程」
 * 的唯一判据。它一度既不在结果里、也没人提过，而 `engineVersion` 过滤参数早就存在：
 * 实测批量导入时，失败里绝大多数都是同一句
 * 「资产引擎版本 (UE 5.7) 高于目标项目版本 (UE 5.5)」，事后重搜替代件又花了 7 次往返。
 *
 * 放在返回里而不是工具描述里：描述是每一轮、每个用户都要付的前缀，
 * 而这件事只有真的搜到东西时才用得上。
 */
function describeEngineVersionSpread(assets: Array<Record<string, unknown>>): string {
  const counts = new Map<string, number>()
  for (const asset of assets) {
    const version = asset.engineVersion
    if (typeof version === 'string' && version.trim()) {
      counts.set(version, (counts.get(version) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return ''

  const spread = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([version, n]) => `${version} ${n} 个`)
    .join('、')

  return (
    `这一页的引擎版本：${spread}。` +
    '.uasset **只能导进同版本或更高版本的工程**（5.7 的资产进不了 5.5 的工程），' +
    '给某个工程挑素材时用 engineVersion 参数先筛一遍，别等导入失败了才发现。'
  )
}

/** 公共库（标签名在那边）。拿不到就当没有标签文本 —— 为它把整次搜索搞失败不值当 */
function safePublicDb(): ReturnType<typeof getPublicDatabase> | undefined {
  try {
    return getPublicDatabase()
  } catch {
    return undefined
  }
}

/**
 * 索引没追平就推一把后台补齐。
 *
 * 原来每次关键词搜索走 AssetSearcher，它发现待索引队列不空会顺手推一把；排名这一路
 * 接手之后没人推了 —— 会话中途导入一大包，队列就一直躺着，搜索一直漏掉那些资产、
 * 一直叫模型「过一会儿再搜」。已经在跑或已经追平时这是空操作。
 * 只推得动当前库：别的库连接用完就关，循环第一步就会自己停。
 */
function kickIndexWarm(db: Parameters<typeof ensureAssetSearchIndexWarm>[0]): void {
  try {
    ensureAssetSearchIndexWarm(db, { publicDb: safePublicDb() })
  } catch (error) {
    // 推不动不影响这次搜索：结果里已经如实报了还有多少没进索引
    console.warn('[资产搜索] 推后台索引补齐失败:', error)
  }
}

/** 标签名换 id。查不到的原样回给调用方，绝不静默丢掉 */
function resolveTagIds(names: string[]): { ids: number[]; unknown: string[] } {
  const ids: number[] = []
  const unknown: string[] = []
  if (names.length === 0) return { ids, unknown }

  const db = getPublicDatabase()
  for (const raw of names) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    const tag = getTagByName(db, name)
    if (tag && typeof tag.id === 'number') ids.push(tag.id)
    else unknown.push(name)
  }
  return { ids, unknown }
}

/** 一页里的一项，还没回库取整行 */
interface PageItem {
  vaultId: string
  order: number
  tier: 0 | 1
  score: number
  id: number
  /** 没有全文索引的老库走的是老路，那边已经格式化好了 */
  preformatted?: Record<string, unknown>
}

function compareItems(a: PageItem, b: PageItem): number {
  return b.tier - a.tier || compareScores(a.score, b.score) || a.order - b.order || a.id - b.id
}

/** 一次跨库搜索的原始结果（放宽前后各跑一次） */
interface Pass {
  runs: VaultRun<void>[]
  scopeError?: string
  total: number
  lowerBound: boolean
  perVault: Record<string, number>
  folderLabel?: string
  /** 哪些库没认出这个文件夹、为什么。「找不到」和「有好几个同名的」是两回事，不能混成一句 */
  folderMisses: Array<{ vault: string; reason: string }>
  /** 关键词模式：所有库的候选，未排序 */
  items: PageItem[]
  /** 浏览模式：已经按首尾相接取好的这一页 */
  browsePage: Array<Record<string, unknown>>
  semantic: Array<{ vaultId: string; order: number; rank: number; id: number }>
  semanticEnabled: boolean
  indexPending: Record<string, number>
}

/**
 * 创建资产搜索工具
 * @returns 资产搜索工具实例
 */
export function createSearchAssetsTool(): V2Tool {
  return defineV2Tool({
    description: `搜索或浏览**盒子素材库**里的资产（跨工程的素材仓库，不是某个 UE 工程）。

【使用场景】用户要找素材、问「库里有什么」、要整理资产时使用。
【搜的是素材库，不是工程】要找**当前打开的工程里已有的**资产（/Game/... 那些），
  用 ue_content_search；要找关卡里摆着的实例，用 ue_get_actor。
【「我库里有什么」不要用这个工具】那个问题用 library_overview —— 它回的是全量精确分布，
  几百字就说完。这里一页最多 500 个，几十万个资产的库靠翻页是数不完的，
  拿前一页去总结全库会得出错误结论，而且看不出错。
【排序】有关键词时所有库的结果按相关度统一排：查询词在名字/标签/文件夹/类型里**全中**的排最前。
  所以第一页就是全部库里最相关的，不用翻页去别的库里找。
【浏览】不带任何条件调用 = 按名字列出整个库，只在需要具体资产清单时用。
【翻页】一次最多回 500 个，默认 100，最多翻到第 ${MAX_RESULT_WINDOW} 个。
  count 是符合条件的**总数**（count_is_lower_bound 为 true 时是「至少这么多」），
  hasMore 为 true 说明后面还有 —— 同样的条件加上 nextOffset 再调一次。
  翻了几页还没有，说明该换条件，不是该继续翻。
【按文件夹】folder 填文件夹名（角色）、完整路径（/ALL/角色）或 folderKey 都行，
  默认连子文件夹一起搜。「Trees 文件夹里有什么」用它，别去全库翻。
  保管库的名字不是文件夹 —— 只搜某个库用 vault。
【按标签】tags 填标签名（中文标签也行）。tagsMatch: "all" 要求全都有，默认任意一个命中。
  标签名库里不存在会直接报错并把名字列出来 —— 不会假装筛过了。
【收藏 / 时间】favorite: true 只看收藏；changedAfter / changedBefore 按**最近一次变动**
  的时间筛（格式 2026-08-31）—— 注意那是改动时间，不等于「导入时间」，
  给资产写过备注、打过标签都会刷新它。
【回收站】deleted: true 列出回收站里的资产（配合 restore_assets 恢复）。
  这个模式只支持翻页，不能和其他筛选一起用。
【默认搜遍所有保管库】用户的资产分散在多个库里（默认保管库、AIGC 资产库、
  他自己建的、网络协作库），**不是一个库**。这个工具默认全搜，结果里的 vault
  字段说明每条来自哪个库，by_vault 说明各库各有多少。
  「没搜到」之前先确认你没有把范围收窄到某一个库 —— 只在用户明确说
  「只看某个库」时才填 vault。
【AI 生成的素材也在里面】AI 出的图/视频/模型/音乐在「AIGC 资产库」。
  用户说「刚才生成的那张图」「之前 AI 出的模型」就用这个工具找。
  **它们要导进虚幻工程，用 ue_content_import，把 real_path 填进 files** ——
  是 png / mp4 / glb 这类外部文件，不是 .uasset，走不了 project_manage。
【名字是英文】虚幻资产名几乎都是英文（SM_Chair_Wood、T_Wood_Diffuse）。
  中文关键词搜不到时**不用自己猜英文词**：这个工具会自动去掉关键词再查一次，
  在 library_sample 里把库里真实存在的资产回给你，照着挑就行。
  中文**标签**是搜得到的 —— 只有名字是英文。
【semantic_matches】开了语义搜索的库里「意思相近、但字面上没命中」的资产单独列在这里，
  不算进 count。它们可能不相关，用之前先看名字和类型核对。
【index_pending】某个库刚导入了一大批、还没建完索引时会出现：那些资产这次没搜到，过一会儿再搜。
【与其他搜索的区别】
- 这个搜的是**盒子的素材库**（用户自己收集整理的，带标签和备注）
- 虚幻工程里的资产用 ue_content_search
- 磁盘上的散装文件用 find_local_files`,
    inputSchema: z.object({
      query: z.string().optional().describe('搜索关键词（英文资产名效果最好）。留空则浏览全库。'),
      vault: z.string().optional().describe(VAULT_SCOPE_DESCRIPTION),
      fileFormat: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('文件格式。支持扩展名（png, fbx）或别名（"模型"、"贴图"、"材质"）'),
      assetType: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('虚幻引擎资产类型，如 StaticMesh、SkeletalMesh、Texture2D 等。'),
      fileSize: z
        .object({
          min: z.number().optional().describe('最小文件大小（字节）'),
          max: z.number().optional().describe('最大文件大小（字节）')
        })
        .optional()
        .describe('文件大小范围'),
      engineVersion: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('引擎版本，如 5.3.0、5.4'),
      folder: z
        .string()
        .optional()
        .describe('只搜这个文件夹：文件夹名（角色）、完整路径（/ALL/角色）或 folderKey。'),
      includeSubfolders: z
        .boolean()
        .optional()
        .describe('搜文件夹时是否连子文件夹一起搜，默认 true'),
      tags: z.array(z.string()).optional().describe('必须带这些标签（标签名）。'),
      tagsMatch: z
        .enum(['any', 'all'])
        .optional()
        .describe('tags 的匹配方式：any = 命中任意一个（默认），all = 必须全都有'),
      excludeTags: z.array(z.string()).optional().describe('排除带这些标签的资产。'),
      favorite: z.boolean().optional().describe('true = 只看收藏的，false = 只看没收藏的'),
      changedAfter: z.string().optional().describe('最近变动时间不早于这天，格式 2026-08-31'),
      changedBefore: z.string().optional().describe('最近变动时间不晚于这天，格式 2026-08-31'),
      deleted: z
        .boolean()
        .optional()
        .describe('true = 列出回收站里已删除的资产。只支持翻页，不能和其他筛选一起用。'),
      hasNoTags: z.boolean().optional().describe('是否只搜索无标签的资产'),
      limit: z.number().optional().describe('这一页要几个，默认 100，最多 500'),
      offset: z.number().optional().describe('跳过前几个。翻页时填上一次返回的 nextOffset')
    }),
    execute: async (input) => {
      const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 100)), 500)
      const offset = Math.max(0, Math.floor(input.offset ?? 0))

      // ── 回收站：走另一条查询（普通搜索的 SQL 写死了 isDelete = 0）──────────
      if (input.deleted === true) {
        const otherFilters = (
          [
            'query',
            'fileFormat',
            'assetType',
            'fileSize',
            'engineVersion',
            'folder',
            'tags',
            'excludeTags',
            'favorite',
            'changedAfter',
            'changedBefore',
            'hasNoTags',
            // 回收站只查当前保管库。显式给了 vault 却被悄悄忽略，
            // 调用方会把主库的回收站当成 AIGC 库的回收站念给用户听。
            'vault'
          ] as const
        ).filter((key) => input[key] !== undefined)

        if (otherFilters.length > 0) {
          return {
            success: false,
            error:
              `回收站列表只支持翻页（limit / offset），不能和 ${otherFilters.join('、')} 一起用。` +
              '先把回收站列出来，再自己在结果里挑。'
          }
        }

        const page = Math.floor(offset / limit) + 1
        const { list, total } = getDeletedAssetData(getVaultDatabase(), page, limit)
        const nextOffset = offset + list.length
        return {
          success: true,
          count: total,
          returnedCount: list.length,
          offset,
          limit,
          hasMore: nextOffset < total,
          ...(nextOffset < total ? { nextOffset } : {}),
          // 删除时间是这个列表里唯一有意义的时间，单独带上（老库里可能是空的）
          assets: formatAssets(list).map((asset, index) => ({
            ...asset,
            deletedAt: list[index]?.deletedAt ?? list[index]?.updated_at
          })),
          message:
            `回收站里有 ${total} 个已删除的资产（按删除时间倒序）。` +
            '它们还能用 restore_assets 恢复；在界面里「清空回收站」之后就彻底没了。' +
            '删掉的**文件夹**不在这个列表里，用 restore_folders 不带参数列。'
        }
      }

      if (offset + limit > MAX_RESULT_WINDOW) {
        return {
          success: false,
          error:
            `最多只能翻到第 ${MAX_RESULT_WINDOW} 个（这次要的是第 ${offset + 1}~${offset + limit} 个）。` +
            '翻到这么深还没找到，说明该收窄条件（关键词、folder、assetType、tags）；' +
            '想知道各类各有多少，用 library_overview。'
        }
      }

      const params: AssetSearchParams = {
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.fileFormat !== undefined ? { fileFormat: input.fileFormat } : {}),
        ...(input.assetType !== undefined ? { assetType: input.assetType } : {}),
        ...(input.fileSize !== undefined ? { fileSize: input.fileSize } : {}),
        ...(input.engineVersion !== undefined ? { engineVersion: input.engineVersion } : {}),
        ...(input.hasNoTags !== undefined ? { hasNoTags: input.hasNoTags } : {}),
        // 放宽由这一层在「所有库都落空」时统一做，库内不许各自放宽
        relax: false,
        limit,
        offset
      }

      // ── 标签：名字换 id。含标签名不存在时**必须报错** ────────────────────
      // 不报的话筛选条件会变成空数组、被底层当成「没筛」，于是整个库原样回来 ——
      // 调用方会把全库当成「带这个标签的资产」念给用户听。
      const include = resolveTagIds(input.tags ?? [])
      const exclude = resolveTagIds(input.excludeTags ?? [])
      if (include.unknown.length > 0) {
        return {
          success: false,
          error:
            `库里没有这些标签：${include.unknown.join('、')}。` +
            '标签名要和库里的完全一致；不确定就把它当关键词放进 query 搜一次（中文标签是搜得到的）。'
        }
      }
      if (include.ids.length > 0 || exclude.ids.length > 0) {
        params.tagFilter = {
          ...(include.ids.length ? { includeTagIds: include.ids } : {}),
          ...(exclude.ids.length ? { excludeTagIds: exclude.ids } : {}),
          matchMode: input.tagsMatch ?? 'any'
        }
      }

      if (input.favorite !== undefined) {
        params.favoriteStatus = input.favorite ? 'favorite' : 'unfavorite'
      }

      if (input.changedAfter || input.changedBefore) {
        params.dateRange = {
          start: input.changedAfter ? dayStart(input.changedAfter) : DATE_MIN,
          end: input.changedBefore ? dayEnd(input.changedBefore) : DATE_MAX
        }
      }

      // 有能搜的字符才走相关度；全是标点之类的，当浏览处理（和原来一样）
      const rankedQuery =
        input.query && buildFtsTerms(input.query).length > 0 ? input.query : undefined
      const need = offset + limit

      // 查询向量整次调用只算一次：第一个开了语义的库用到时才算，之后的库复用
      let embeddingPromise: Promise<number[] | null> | null = null
      const getEmbedding = (): Promise<number[] | null> =>
        (embeddingPromise ??= embedSearchQuery(rankedQuery ?? '').catch((error) => {
          // 语义是加分项，失败了照常出关键词结果 —— 但要留痕，否则「语义悄悄没生效」查不出来
          console.warn('[资产语义索引] 查询向量化失败，这次只走关键词:', error)
          return null
        }))

      // ── 每个保管库跑一趟 ──────────────────────────────────────────────────
      const runPass = async (passParams: AssetSearchParams): Promise<Pass> => {
        // 浏览模式的首尾相接分页：skip / remaining 在回调里逐库递减（runAcrossVaults 顺序执行）
        let skip = offset
        let remaining = limit
        const pass: Pass = {
          runs: [],
          total: 0,
          lowerBound: false,
          perVault: {},
          folderMisses: [],
          items: [],
          browsePage: [],
          semantic: [],
          semanticEnabled: false,
          indexPending: {}
        }
        let order = 0

        const { runs, error } = await runAcrossVaults<void>(input.vault, async (db, vault) => {
          await yieldToEventLoop()
          const vaultOrder = order++
          const scoped: AssetSearchParams = { ...passParams }

          // 文件夹：用户说的是名字，底层认的是 folderKey。
          // folderKey 是**每个库各一套**的，所以必须逐库解析，不能跨库复用。
          if (input.folder) {
            const resolved = resolveFolder(db, input.folder)
            if (resolved.error || !resolved.folderKey) {
              pass.folderMisses.push({
                vault: vault.name,
                reason: resolved.error ?? '文件夹解析失败'
              })
              pass.perVault[vault.name] = 0
              return
            }
            scoped.folderKey = resolved.folderKey
            scoped.includeSubfolders = input.includeSubfolders !== false
            pass.folderLabel ??=
              resolved.folder?.fullPath || resolved.folder?.folderName || resolved.folderKey
          }

          if (rankedQuery) {
            const filter = buildSearchCriteria(scoped)
            const ranked = rankedSearchVault(db, {
              query: rankedQuery,
              need,
              filter,
              publicDb: safePublicDb()
            })
            if (ranked) kickIndexWarm(db)
            if (ranked) {
              pass.total += ranked.total
              pass.lowerBound ||= ranked.totalIsLowerBound
              pass.perVault[vault.name] = ranked.total
              if (ranked.indexPending > 0) pass.indexPending[vault.name] = ranked.indexPending
              for (const hit of ranked.hits) {
                pass.items.push({ vaultId: vault.id, order: vaultOrder, ...hit })
              }
            } else {
              // 这个库还没有全文索引表（老库第一次打开前）：走老路，排在有分数的结果后面
              // 底层一页最多 500，而 need 最大到 1 万：按页取到 need 为止，否则深翻页会漏掉这个库
              const legacy: Array<Record<string, unknown>> = []
              let count = 0
              for (let from = 0; from < need; from += 500) {
                const size = Math.min(500, need - from)
                const outcome = (await searchAssets(
                  { ...scoped, limit: size, offset: from },
                  db,
                  vault.path
                )) as unknown as SearchOutcome
                if (outcome.success === false) throw new Error(outcome.error ?? '搜索失败')
                count = outcome.count ?? 0
                legacy.push(...(outcome.assets ?? []))
                if ((outcome.assets ?? []).length < size || legacy.length >= count) break
              }
              pass.total += count
              pass.perVault[vault.name] = count
              legacy.forEach((asset, index) => {
                pass.items.push({
                  vaultId: vault.id,
                  order: vaultOrder,
                  tier: 0,
                  score: Number.POSITIVE_INFINITY,
                  id: index,
                  preformatted: { ...asset, vault: vault.name }
                })
              })
            }

            // 语义那一路：只收「全文没命中」的，单独列出、不计数
            if (isAssetVectorEnabled(db)) {
              pass.semanticEnabled = true
              const recalled = await semanticRecall(db, rankedQuery, undefined, getEmbedding)
              semanticOnlyIds(db, recalled, rankedQuery, filter)
                .slice(0, SEMANTIC_MATCH_LIMIT)
                .forEach((id, rank) =>
                  pass.semantic.push({ vaultId: vault.id, order: vaultOrder, rank, id })
                )
            }
            return
          }

          // ── 浏览：首尾相接 ────────────────────────────────────────────────
          // vault.path 一定要跟着 db 一起传：备份库里资产的 filePath 是相对
          // 保管库的，不给库根目录就会按**当前活跃库**去拼
          const outcome = (await searchAssets(
            // 这一页占满了也照跑：不跑的话 count 会漏掉后面几个库，
            // hasMore / nextOffset 跟着算错，翻页就永远翻不到它们
            { ...scoped, limit: Math.max(1, remaining), offset: skip },
            db,
            vault.path
          )) as unknown as SearchOutcome
          // 这一个库炸了就只算它自己失败（helper 会接住），别的库照常出结果
          if (outcome.success === false) throw new Error(outcome.error ?? '搜索失败')

          const count = outcome.count ?? 0
          pass.total += count
          pass.perVault[vault.name] = count
          if (remaining > 0) {
            const taken = (outcome.assets ?? [])
              .slice(0, remaining)
              .map((asset) => ({ ...asset, vault: vault.name }))
            remaining -= taken.length
            pass.browsePage.push(...taken)
          }
          skip = Math.max(0, skip - count)
        })

        pass.runs = runs
        pass.scopeError = error
        return pass
      }

      let pass = await runPass(params)
      if (pass.scopeError) return { success: false, error: pass.scopeError }

      // 一个库都认不出这个文件夹才算失败 —— 只在其中一个库里存在是正常的
      if (input.folder && !pass.folderLabel) {
        const asVault = pass.runs.find(
          (run) => run.vault.name.toLowerCase() === input.folder!.trim().toLowerCase()
        )
        // 同名文件夹不止一个 —— 那是「认不准」，不是「没有」，原因必须原样带上
        const ambiguous = pass.folderMisses.filter((miss) => !miss.reason.startsWith('找不到'))
        if (ambiguous.length > 0) {
          return {
            success: false,
            error: `文件夹「${input.folder}」认不准：${ambiguous
              .map((miss) => `${miss.vault}：${miss.reason}`)
              .join('；')}`
          }
        }
        return {
          success: false,
          error:
            `所有保管库里都没有文件夹「${input.folder}」（查过：${pass.folderMisses.map((miss) => miss.vault).join('、')}）。` +
            (asVault
              ? `「${asVault.vault.name}」是一个**保管库**的名字，不是文件夹 —— 只搜这个库用 vault: "${asVault.vault.name}"。`
              : '文件夹名要和库里的一致；不确定有哪些文件夹，用 library_overview 看。')
        }
      }

      const failedOf = (p: Pass): VaultRun<void>[] => p.runs.filter((run) => run.error)
      const searchedOf = (p: Pass): string[] =>
        p.runs.filter((run) => !run.error).map((run) => run.vault.name)

      // 一个库都没搜成 = 这次搜索失败，不是「库里没有」。
      // 报成 0 结果的话，调用方会告诉用户「你库里没这东西」—— 而真相是压根没查。
      if (pass.runs.length > 0 && searchedOf(pass).length === 0) {
        return {
          success: false,
          error: `所有保管库都没能搜到：${failedOf(pass)
            .map((r) => `${r.vault.name}：${r.error}`)
            .join('；')}`
        }
      }

      // ── 放宽：所有库合计为 0 才做，而且只做一次 ─────────────────────────
      // 逐库放宽的话，一个库有真命中、另一个库落空放宽，不相干的资产就混进来了
      let relaxed = false
      if (pass.total === 0 && (params.assetType !== undefined || params.fileFormat !== undefined)) {
        const loose = { ...params }
        delete loose.assetType
        delete loose.fileFormat
        const second = await runPass(loose)
        if (second.total > 0) {
          pass = second
          relaxed = true
        }
      }

      const failed = failedOf(pass)
      const searched = searchedOf(pass)
      const extras: Record<string, unknown> = {
        ...(pass.folderLabel ? { searched_folder: pass.folderLabel } : {}),
        searched_vaults: searched,
        ...(Object.keys(pass.perVault).length > 1 ? { by_vault: pass.perVault } : {}),
        ...(failed.length > 0
          ? {
              // 哪个库没搜成必须说出来。不说的话「没找到」和「没搜」长得一模一样
              unsearched_vaults: failed.map((run) => `${run.vault.name}：${run.error}`)
            }
          : {}),
        ...(Object.keys(pass.indexPending).length > 0 ? { index_pending: pass.indexPending } : {}),
        ...(pass.folderMisses.some((miss) => !miss.reason.startsWith('找不到'))
          ? {
              // 有的库里同名文件夹不止一个，那几个库这次没搜 —— 不说的话「没找到」和「没搜」长得一样
              folder_unresolved: pass.folderMisses
                .filter((miss) => !miss.reason.startsWith('找不到'))
                .map((miss) => `${miss.vault}：${miss.reason}`)
            }
          : {}),
        ...(exclude.unknown.length > 0
          ? {
              ignored_exclude_tags: exclude.unknown,
              hint: `排除标签里有库里不存在的名字（${exclude.unknown.join('、')}），这几个没起作用。`
            }
          : {})
      }

      // ── 取这一页 ────────────────────────────────────────────────────────
      let assets: Array<Record<string, unknown>>
      let semanticMatches: Array<Record<string, unknown>> = []
      let pageHasAigc = false
      const vaultById = new Map(pass.runs.map((run) => [run.vault.id, run.vault]))

      if (rankedQuery) {
        const page = [...pass.items].sort(compareItems).slice(offset, offset + limit)
        const semantic = [...pass.semantic]
          .sort((a, b) => a.rank - b.rank || a.order - b.order)
          .slice(0, SEMANTIC_MATCH_LIMIT)

        // 只对这一页（和语义那几个）回库取整行
        const wanted = new Map<string, Set<number>>()
        for (const item of [...page.filter((p) => !p.preformatted), ...semantic]) {
          if (!wanted.has(item.vaultId)) wanted.set(item.vaultId, new Set())
          wanted.get(item.vaultId)!.add(item.id)
        }
        const formatted = new Map<string, Record<string, unknown>>()
        if (wanted.size > 0) {
          await runAcrossVaults<void>(input.vault, async (db, vault) => {
            const ids = wanted.get(vault.id)
            if (!ids) return
            await yieldToEventLoop()
            const rows = getAssetRowsByIds(db, [...ids])
            attachTagNames(rows)
            const out = formatAssets(rows, { vaultPath: vault.path })
            rows.forEach((row, index) => {
              formatted.set(`${vault.id}:${(row as { id?: number }).id}`, {
                ...out[index],
                vault: vault.name
              })
            })
          })
        }

        assets = page
          .map((item) => item.preformatted ?? formatted.get(`${item.vaultId}:${item.id}`))
          .filter((asset): asset is Record<string, unknown> => !!asset)
        pageHasAigc = page.some((item) => {
          const vault = vaultById.get(item.vaultId)
          return !!vault && isAigcVault(vault)
        })
        semanticMatches = semantic
          .map((item) => formatted.get(`${item.vaultId}:${item.id}`))
          .filter((asset): asset is Record<string, unknown> => !!asset)
          .map((asset) => ({
            name: asset.name,
            type: asset.type,
            assetKey: asset.assetKey,
            vault: asset.vault,
            ...(asset.real_path ? { real_path: asset.real_path } : {})
          }))
      } else {
        assets = pass.browsePage
        const aigcNames = new Set(
          pass.runs.filter((run) => isAigcVault(run.vault)).map((run) => run.vault.name)
        )
        pageHasAigc = assets.some((asset) => aigcNames.has(String(asset.vault)))
      }

      // 字面结果已经填满一页时不带语义那几个：召回没有距离门槛，总有 10 个「最近的」，
      // 真机数据上它们在 pine tree（65 个字面命中）这种查询里全是 AI 图，只会白占上下文。
      // 字面结果不够一页时（horse、马 这种）才是语义该出场的时候。
      const semanticExtras =
        semanticMatches.length > 0 && pass.total < limit
          ? {
              semantic_matches: semanticMatches,
              semantic_note:
                'semantic_matches 是开了语义搜索的库里「意思相近、但字面上没命中」的资产，不算进 count。' +
                '它们可能完全不相关，用之前核对名字和类型。'
            }
          : {}

      const total = pass.total
      const nextOffset = offset + assets.length
      // 这一页一个都没拿到就不说「后面还有」：总数是全文索引表数出来的，可能比回得了表的
      // 多（旧的孤儿行、超出扫描上限的待索引行）。那样会让模型拿同一个 offset 一直重调
      const hasMore =
        assets.length > 0 && (nextOffset < total || (pass.lowerBound && assets.length === limit))

      if (total > 0) {
        const pendingNote =
          Object.keys(pass.indexPending).length > 0
            ? `注意：${Object.entries(pass.indexPending)
                .map(([name, n]) => `「${name}」有 ${n} 个`)
                .join('、')}资产刚导入、还没建完索引，这次没搜到它们，过一会儿再搜一次。`
            : ''
        return {
          success: true,
          count: total,
          ...(pass.lowerBound ? { count_is_lower_bound: true } : {}),
          returnedCount: assets.length,
          offset,
          limit,
          assets,
          ...(hasMore ? { hasMore, nextOffset } : {}),
          ...(relaxed ? { relaxed: true } : {}),
          ...extras,
          ...semanticExtras,
          message:
            (relaxed
              ? '没有资产符合指定的类型/格式条件，已去掉这两个条件重搜 —— **下面这些不是你要的那个类型**，向用户汇报时要说明这一点。'
              : '') +
            `共 ${total}${pass.lowerBound ? '+' : ''} 个` +
            (Object.keys(pass.perVault).length > 1
              ? `（${Object.entries(pass.perVault)
                  .filter(([, n]) => n > 0)
                  .map(([name, n]) => `${name} ${n} 个`)
                  .join('，')}）`
              : '') +
            (assets.length > 0
              ? `，这是第 ${offset + 1}~${nextOffset} 个`
              : `，从第 ${offset + 1} 个往后已经没有了`) +
            (rankedQuery ? '（所有库按相关度统一排序）' : '') +
            '。' +
            (hasMore
              ? nextOffset < MAX_RESULT_WINDOW
                ? `要看后面的，用同样的条件加 offset=${nextOffset} 再调一次。`
                : `已经到第 ${MAX_RESULT_WINDOW} 个的翻页上限，要找的还没出现就收窄条件。`
              : '') +
            pendingNote +
            (pageHasAigc
              ? '「AIGC 资产库」里的是 AI 生成的图/视频/模型，要导进虚幻工程走 ue_content_import（把 real_path 填进 files），不是 project_manage。'
              : '') +
            // 版本这一句放在**返回里**而不是工具描述里：描述是每一轮都要付的前缀，
            // 而这件事只有真的搜到 .uasset 时才用得上。
            // 不说的话，挑素材那一步完全是盲的 —— 真机上 51 个导进 5.5 工程，
            // 16 个因为是 5.7 存的被整条挡回来，而事前没有任何入口看得见
            describeEngineVersionSpread(assets)
        }
      }

      // ── 一个都没搜到 ──────────────────────────────────────────────────────
      const emptyMessage =
        `${searched.join('、')} 里都没有符合条件的资产。` +
        (failed.length > 0 ? '注意上面 unsearched_vaults 里的库这次没能搜到。' : '') +
        (Object.keys(pass.indexPending).length > 0
          ? '有的库还没建完索引（见 index_pending），过一会儿再搜一次可能就有了。'
          : '')

      // 中文关键词一无所获：去掉关键词再查一次，把库里真有的名字捞给调用方。
      //
      // 这一次也要**照样搜遍所有库**，而且**轮流从各库取** —— 只从排在前面的库取的话，
      // 样本就全是当前库的（用户站在 AIGC 库里，看到的样本全是 AI 图）。
      if (hasChinese(input.query)) {
        const rest: AssetSearchParams = { ...params }
        delete rest.query
        delete rest.folderKey
        delete rest.includeSubfolders
        delete rest.limit
        delete rest.offset
        // 样本的作用是给出库里真实存在的名字，类型落空时放宽正合适 —— 不放宽的话样本是空的，提示就成了空话
        delete rest.relax

        let sampleTotal = 0
        const perVaultSample: Array<Array<{ name?: unknown; assetType?: unknown; vault: string }>> =
          []
        await runAcrossVaults(input.vault, async (db, vault) => {
          await yieldToEventLoop()
          const one = (await searchAssets(
            { ...rest, limit: SAMPLE_LIMIT },
            db,
            vault.path
          )) as unknown as SearchOutcome
          sampleTotal += one.count ?? 0
          perVaultSample.push(
            (one.assets ?? []).slice(0, SAMPLE_LIMIT).map((asset) => ({
              name: asset.name,
              assetType: asset.assetType,
              vault: vault.name
            }))
          )
        })
        const sample: Array<{ name?: unknown; assetType?: unknown; vault: string }> = []
        for (let i = 0; sample.length < SAMPLE_LIMIT; i++) {
          const round = perVaultSample.map((list) => list[i]).filter(Boolean)
          if (round.length === 0) break
          sample.push(...round.slice(0, SAMPLE_LIMIT - sample.length))
        }

        return {
          success: true,
          count: 0,
          assets: [],
          ...extras,
          ...semanticExtras,
          hint: KEYWORD_MISS_HINT + (pass.semanticEnabled ? '' : ENABLE_SEMANTIC_HINT),
          dropped_query: input.query,
          library_sample: sample,
          library_total: sampleTotal
        }
      }

      return {
        success: true,
        count: 0,
        assets: [],
        ...extras,
        ...semanticExtras,
        message: emptyMessage
      }
    }
  })
}
