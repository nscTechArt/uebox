// 资产搜索器
import {
  countAssetsByCriteria,
  searchAssetsByCriteria,
  type AssetSearchCriteria
} from '../../../../sqliteDataBase/models/assetSearch'
import { resolveKeywordCriteria } from '../../../../sqliteDataBase/models/assetSearchIndex'
import { ensureAssetSearchIndexWarm } from '../../../../sqliteDataBase/services/assetSearchIndexService'
import { semanticRecall } from '../../../../sqliteDataBase/services/assetSemanticService'
import { getPublicDatabase, getVaultDatabase } from '../../../../sqliteDataBase'
import { formatAssets } from './AssetFormatter'
import type { AssetSearchParams, AssetSearchResult, FormattedAsset } from './types'
import { ASSET_TYPE_MAP, FORMAT_ALIAS_MAP } from './types'
import type Database from 'better-sqlite3'

/**
 * 执行资产搜索逻辑
 */
/**
 * 把 tagIdList（保管库里查出来的 id 串）换成标签名，写回资产对象。
 *
 * 失败一律静默跳过 —— 标签只是锦上添花，为它把整次搜索搞失败不值当。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachTagNames(assets: any[]): void {
  if (!Array.isArray(assets) || assets.length === 0) return

  const allIds = new Set<number>()
  for (const asset of assets) {
    const raw = asset?.tagIdList
    if (typeof raw !== 'string' || !raw) continue
    for (const part of raw.split(',')) {
      const id = Number(part.trim())
      if (Number.isFinite(id)) allIds.add(id)
    }
  }
  if (allIds.size === 0) return

  try {
    const publicDb = getPublicDatabase()
    const ids = [...allIds]
    const rows = publicDb
      .prepare(`SELECT id, name FROM tags WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: number; name: string }>
    const nameById = new Map(rows.map((r) => [r.id, r.name]))

    for (const asset of assets) {
      const raw = asset?.tagIdList
      if (typeof raw !== 'string' || !raw) continue
      const names = raw
        .split(',')
        .map((p) => nameById.get(Number(p.trim())))
        .filter(Boolean)
      if (names.length) asset.tagNames = names.join(', ')
    }
  } catch (error) {
    console.warn('解析标签名失败，跳过:', error)
  }
}

/**
 * 公共库连接。拿不到就返回 undefined —— 它只用来把标签 id 换成名字，
 * 为它把整次搜索或整次索引搞失败不值当。
 */
function safePublicDb(): Database.Database | undefined {
  try {
    return getPublicDatabase()
  } catch {
    return undefined
  }
}

/**
 * 一页最多返回多少个资产。
 *
 * 原来这里写死 50，而且**不对外暴露** —— 调用方连「我知道结果被截断了，
 * 给我下一页」都说不出口，只能换个更窄的关键词重搜，赌下一次的前 50 个
 * 里有它要的东西。库里超过 50 个资产时，「我素材库里有什么」这个问题
 * 就永远答不全。
 *
 * 上限 500 是防手滑（`limit: 999999` 之类），不是省 token 的口径。
 */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function clampLimit(raw: unknown): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(parsed), MAX_LIMIT)
}

/**
 * 工具参数 → 底层筛选条件（不含关键词和分页）。
 *
 * 抽出来是因为跨库的相关度检索（models/assetRankedSearch.ts）要用**完全相同**的筛选口径 ——
 * 两处各写一份的话，别名展开、类型名匹配这些坑迟早只修了一边。
 */
export function buildSearchCriteria(params: AssetSearchParams): AssetSearchCriteria {
  const { assetType, fileSize, fileFormat, engineVersion, hasNoTags } = params
  const criteria: AssetSearchCriteria = {}

  // 无标签过滤
  if (hasNoTags === true) {
    criteria.hasNoTags = true
  }

  // 文件夹 / 标签 / 收藏 / 时间：底层早就实现，这里只是把参数递下去。
  // includeSubfolders 缺省为真 —— 「角色文件夹里有什么」问的是这一支，不是这一层。
  if (params.folderKey && params.folderKey !== 'ALL') {
    criteria.folderKey = params.folderKey
    criteria.includeSubfolders = params.includeSubfolders !== false
  }
  const includeTagIds = params.tagFilter?.includeTagIds ?? []
  const excludeTagIds = params.tagFilter?.excludeTagIds ?? []
  if (includeTagIds.length > 0 || excludeTagIds.length > 0) {
    criteria.tagFilter = {
      ...(includeTagIds.length ? { includeTagIds } : {}),
      ...(excludeTagIds.length ? { excludeTagIds } : {}),
      matchMode: params.tagFilter?.matchMode ?? 'any'
    }
  }
  if (params.favoriteStatus && params.favoriteStatus !== 'all') {
    criteria.favoriteStatus = params.favoriteStatus
  }
  // 底层要求两端都有值，缺一端就整条失效 —— 补边界由调用方负责，这里只做透传
  if (params.dateRange?.start && params.dateRange?.end) {
    criteria.dateRange = { start: params.dateRange.start, end: params.dateRange.end }
  }

  // 处理 fileFormat：支持 | 分隔符和中文别名映射
  let expandedFormats: string[] = []
  if (fileFormat) {
    const formats = Array.isArray(fileFormat) ? fileFormat : [fileFormat]

    formats.forEach((fmt) => {
      // 支持 | 分隔符（OR 查询）
      const parts = fmt
        .split('|')
        .map((p) => p.trim())
        .filter(Boolean)

      parts.forEach((part) => {
        // 检查是否是格式别名（如"模型"、"贴图"等）
        if (FORMAT_ALIAS_MAP[part]) {
          // 展开别名为具体格式
          expandedFormats.push(...FORMAT_ALIAS_MAP[part])
        } else {
          // 直接使用原始格式
          expandedFormats.push(part)
        }
      })
    })

    // 去重
    expandedFormats = Array.from(new Set(expandedFormats))
  }

  // 把别名展开的结果分成「扩展名」和「资产类型」两半。
  //
  // 判据是**原始大小写**：虚幻类型名一律是 PascalCase（StaticMesh、
  // Texture2D、Material），文件扩展名一律小写（fbx、png、uasset）。
  //
  // 原来这里拿 `fmt.toLowerCase()` 去测 `^\.?[a-z0-9]+$` —— 小写之后
  // `Material` 变成 `material`，**必然匹配**，于是所有类型名都被当成
  // 扩展名塞进 fileExtensions，再拿去和 `ad.fileExtension` 比，永远比不中。
  // 后果：凡是别名里只有类型名的（材质 / 蓝图 / 特效 / 动画），
  // 筛选结果恒为空，然后被自动放宽兜回整个库 —— 真机上问「有哪些材质」，
  // 8 个资产一个不少地全回来了，调用方会把贴图和动画当成材质报给用户。
  const fileExtensions: string[] = []
  const aliasAssetTypes: string[] = []

  expandedFormats.forEach((fmt) => {
    if (/^\.?[a-z0-9]+$/.test(fmt)) {
      fileExtensions.push(fmt.startsWith('.') ? fmt.slice(1) : fmt)
    } else {
      aliasAssetTypes.push(fmt)
    }
  })

  // 别名的两半是 **或** 的关系：静态网格可能是外部导入的 .fbx，
  // 也可能是引擎里的 .uasset，用 AND 一个都命中不了
  if (fileExtensions.length > 0 || aliasAssetTypes.length > 0) {
    criteria.formatMatch = {
      ...(fileExtensions.length ? { extensions: Array.from(new Set(fileExtensions)) } : {}),
      ...(aliasAssetTypes.length ? { assetTypes: Array.from(new Set(aliasAssetTypes)) } : {})
    }
  }

  // 显式传的 assetType 独立生效。
  //
  // 原来它被 `isUassetFormat` 挡着 —— 不带 fileFormat 单独用时整个被
  // **静默丢弃**，搜索退化成「返回全库」而没有任何提示。真机验证：
  // 库里 3 个 StaticMesh，`assetType: 'StaticMesh'` 回了全部 8 个。
  if (assetType) {
    const inputAssetTypes = Array.isArray(assetType) ? assetType : [assetType]
    const mapped = inputAssetTypes.flatMap((t) => ASSET_TYPE_MAP[t] || [t])
    if (mapped.length > 0) {
      criteria.assetTypes = Array.from(new Set(mapped))
    }
  }

  // 文件大小过滤
  if (fileSize) {
    criteria.sizeRange = {
      min: fileSize.min,
      max: fileSize.max
    }
  }

  // 引擎版本过滤
  if (engineVersion) {
    criteria.engineVersions = Array.isArray(engineVersion) ? engineVersion : [engineVersion]
  }

  return criteria
}

/**
 * @param db 在哪个保管库里搜。不给就是用户当前的那个。
 *
 * 之所以能指定：AIGC 生成的图/视频/模型存在**另一个保管库**里
 * （system_vault_aigc，有自己的 vault-data.db），当前库根本查不到它们。
 * 不开这个口子，agent 就只能在生成的那一轮里靠返回值里的路径用图 ——
 * 换一个会话之后，用户在界面上看得见的 AI 素材，对 agent 是不存在的。
 *
 * @param vaultPath 这个库的根目录。**给了 db 就要一起给它**：备份类型的库
 * 数据库里存的是相对保管库的路径，不知道库在哪就拼不出真路径，
 * 会退而按当前活跃库去拼 —— 那正是跨库搜索里最容易错的一步。
 */
export async function searchAssets(
  params: AssetSearchParams,
  db?: Database.Database,
  vaultPath?: string
): Promise<AssetSearchResult> {
  const { query, assetType, fileSize, fileFormat, engineVersion, hasNoTags } = params
  const relax = params.relax !== false

  const limit = clampLimit(params.limit)
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0))

  const criteria: AssetSearchCriteria = {
    ...buildSearchCriteria(params),
    keyword: query,
    limit,
    offset
  }

  try {
    const database = db ?? getVaultDatabase()

    // ── 关键词走全文索引，索引没追上就退回 LIKE ───────────────────────────
    //
    // 判据是「待索引队列空不空」，不是「索引里有没有东西」：队列里还剩东西
    // 就说明有资产还没进索引，这时候用索引搜会**安静地漏掉**它们。
    // 宁可慢一点全扫一遍，也不能给出一个看不出缺口的答案。
    const resolved = resolveKeywordCriteria(database, query)
    if (resolved.ftsMatch) criteria.ftsMatch = resolved.ftsMatch
    if (resolved.keyword !== undefined) criteria.keyword = resolved.keyword
    const indexPending = resolved.indexReady ? 0 : 1
    if (!resolved.indexReady) {
      // 顺手推一把后台补齐 —— 下一次搜索大概率就能走索引了
      ensureAssetSearchIndexWarm(database, { publicDb: safePublicDb() })
    }

    // ── 语义那一路（用户开了才有）────────────────────────────────────────
    //
    // 只在关键词那一路走索引时才加进来。退回 LIKE 的时候不加：底层看到
    // 召回集就不再执行 LIKE 条件了，那样等于把字面匹配整个丢掉，
    // 用户搜一个确切的资产名反而搜不到 —— 语义是加分项，不能减分。
    if (criteria.ftsMatch && query) {
      const semanticIds = await semanticRecall(database, query)
      if (semanticIds.length > 0) criteria.semanticIds = semanticIds
    }

    // 总数用 COUNT(*) 数。
    //
    // 原来的写法是「把 limit 去掉再查一次，然后取 .length」—— 那等于每次搜索
    // 都把符合条件的资产**全部读进 JS 内存**只为得到一个整数。库小的时候看不出来，
    // 几十万条时它就是页面卡死的那一下。
    const countCriteria: AssetSearchCriteria = { ...criteria }
    delete countCriteria.limit
    delete countCriteria.offset
    const totalMatchCount = countAssetsByCriteria(database, countCriteria)

    // 再按原始条件取这一页
    let assets = searchAssetsByCriteria(database, criteria)

    // 判断是否使用了资产类型或文件格式过滤（用于后续自动回退）
    const hadTypeOrFormatFilter =
      !!(criteria.assetTypes && criteria.assetTypes.length) ||
      !!(criteria.fileExtensions && criteria.fileExtensions.length) ||
      !!criteria.formatMatch

    // 类型/格式过滤没结果时自动放宽再搜一次，让非 uasset（fbx/obj 等）
    // 也有机会被命中。
    //
    // **放宽了必须说出来。** 不说的话调用方拿到的是「你要的类型有 N 个」，
    // 而实际返回的是整个库 —— 真机上问「有哪些材质」，8 个资产原样返回，
    // 调用方会把贴图和动画当成材质报给用户。
    let relaxedTotalMatchCount = 0
    let didRelax = false
    if (relax && Array.isArray(assets) && assets.length === 0 && hadTypeOrFormatFilter) {
      didRelax = true
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { assetTypes, fileExtensions, formatMatch, ...rest } = criteria
      const relaxedCriteria: AssetSearchCriteria = {
        ...rest
      }

      // 查询放宽条件的总数
      const relaxedCountCriteria = { ...relaxedCriteria }
      delete relaxedCountCriteria.limit
      delete relaxedCountCriteria.offset
      relaxedTotalMatchCount = countAssetsByCriteria(database, relaxedCountCriteria)

      assets = searchAssetsByCriteria(database, relaxedCriteria)
    }

    // 使用实际的总匹配数（如果回退了，使用回退后的总数）
    const finalTotalCount = relaxedTotalMatchCount > 0 ? relaxedTotalMatchCount : totalMatchCount

    if (Array.isArray(assets)) {
      // 格式化结果
      // 标签名在公共库、关联在保管库，跨库 JOIN 不行，所以在这里合。
      // 只对当前这一页结果做一次查询，不是每条一次。
      attachTagNames(assets)

      const formattedResults: FormattedAsset[] = formatAssets(assets, { vaultPath })

      // 没有找到任何资产
      if (formattedResults.length === 0) {
        // 构建未找到的提示消息（使用原始搜索条件，方便告诉用户这次是按什么条件搜的）
        const conditions: string[] = []

        if (engineVersion) {
          conditions.push(
            `引擎版本=${Array.isArray(engineVersion) ? engineVersion.join(', ') : engineVersion}`
          )
        }

        if (assetType) conditions.push(`资产类型=${assetType}`)

        if (fileFormat) {
          conditions.push(
            `文件格式=${Array.isArray(fileFormat) ? fileFormat.join(', ') : fileFormat}`
          )
        }

        if (fileSize) {
          const sizeDesc: string[] = []
          if (fileSize.min) sizeDesc.push(`≥${fileSize.min}字节`)
          if (fileSize.max) sizeDesc.push(`≤${fileSize.max}字节`)
          if (sizeDesc.length > 0) conditions.push(`文件大小=${sizeDesc.join(', ')}`)
        }

        if (query && query !== '*') conditions.push(`关键词=${query}`)

        if (hasNoTags === true) conditions.push('无标签')

        const conditionText = conditions.length > 0 ? conditions.join(', ') : '无特定条件'

        return {
          success: true,
          count: 0,
          assets: [] as FormattedAsset[],
          message: `执行成功，但在数据库中未找到任何符合"${conditionText}"的资产。请问是否需要放宽搜索条件？`
        }
      }

      const returnedCount = formattedResults.length

      const result: AssetSearchResult = {
        success: true,
        count: finalTotalCount, // 数据库中符合条件的总数
        returnedCount, // 这一页实际返回的数量
        offset,
        limit,
        assets: formattedResults
      }

      // 放宽过了就必须说清楚，否则调用方会把整个库当成筛选结果汇报
      if (didRelax) {
        result.relaxed = true
        result.message =
          `没有资产符合指定的类型/格式条件，已自动放宽后返回库里的其它资产。` +
          `**下面这些不是你要的那个类型**，向用户汇报时要说明这一点。` +
          (result.message ? ` ${result.message}` : '')
      }

      // 还有下一页时，把**怎么翻**直接说出来。
      //
      // 原来这里写的是「请使用更精确的搜索条件缩小范围」—— 那是没有分页参数
      // 时唯一能说的话，但它把「我想看完整个库」这件事变成了不可能：
      // 换关键词只会换一批前 50 个，永远走不到第 51 个。
      const nextOffset = offset + returnedCount
      if (nextOffset < finalTotalCount) {
        result.hasMore = true
        result.nextOffset = nextOffset
        result.message =
          `共 ${finalTotalCount} 个符合条件的资产，这是第 ${offset + 1}~${nextOffset} 个。` +
          `要看后面的，用同样的条件加 offset=${nextOffset} 再调一次。` +
          (result.message ? ` ${result.message}` : '')

        // 结果没截断的时候不用说这个；一旦截断了，**这一页是怎么挑出来的**就成了
        // 关键信息：走索引时前几个是最相关的，退回 LIKE 时只是按名字排在最前的。
        // 不说明的话，调用方会把「A 开头的前 100 个」当成「最匹配的 100 个」。
        if (indexPending > 0) {
          result.message +=
            ' 注意：全文索引还在后台补齐，这次是按**资产名字母序**取的前几个，不是按相关度。' +
            '要找的东西没出现在这一页里的话，翻页或者换更具体的词，别据此下结论。'
        }
      }

      return result
    } else {
      return {
        success: false,
        error: '搜索失败',
        count: 0,
        assets: [] as FormattedAsset[]
      }
    }
  } catch (error) {
    console.error('搜索资产失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      count: 0,
      assets: [] as FormattedAsset[]
    }
  }
}
