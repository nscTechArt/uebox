/**
 * 资产筛选 / 搜索的 SQL 拼装与执行 —— **纯模块**。
 *
 * 只依赖 better-sqlite3 和同目录的纯函数，不碰 electron、不碰全局数据库单例：
 * 资产库的列表查询要放到 worker 线程里跑（见 workers/assetQueryWorker.ts），
 * 而 worker 里没有主进程那套初始化。主进程的调用方走 ./assetSearch，
 * 那里把公共库连接补上再转进来。
 */
import Database from 'better-sqlite3'
import type { AssetData } from './assetData'
import { searchTags } from './tag'
import { BM25_EXPR, FTS_TABLE } from './assetSearchIndex'

/** 查询要用到的外部连接。标签名在公共库里，关键词要顺带匹配标签名 */
export interface AssetQueryEnv {
  publicDb?: Database.Database | null
}

export interface AssetSearchCriteria {
  folderKey?: string
  includeSubfolders?: boolean
  keyword?: string
  /**
   * FTS5 的 MATCH 表达式（由 buildFtsMatchQuery 生成）。给了它就走全文索引，
   * `keyword` 的 LIKE 全表扫描不再执行 —— 两条路只走一条，否则等于白扫一遍。
   *
   * 调用方**必须先确认索引是新鲜的**（isAssetSearchIndexReady），
   * 否则搜出来的东西是不全的，而且看不出来。
   */
  ftsMatch?: string
  /**
   * 语义召回的资产 id（assetData.id），**按相关度从高到低排好**。
   *
   * 和 ftsMatch 是并集关系，最终名次由 RRF 融合决定。给了它就说明用户开了
   * 资产库的语义搜索 —— 这一路能把「椅子」和 SM_Chair_Wood 对上，
   * 而关键词那一路对不上。
   */
  semanticIds?: number[]
  tagFilter?: {
    includeTagIds?: number[]
    excludeTagIds?: number[]
    matchMode?: 'any' | 'all'
  }
  hasNoTags?: boolean
  assetTypes?: string[]
  classNameCnFilters?: string[]
  fileExtensions?: string[]
  /**
   * 「扩展名 **或** 资产类型」命中即可的一组条件。
   *
   * 别名（如「模型」）同时含扩展名和类型名：fbx / obj 是扩展名，
   * StaticMesh / SkeletalMesh 是类型。这两半必须 **OR** ——
   * 库里的静态网格既可能是 .fbx（外部导入），也可能是 .uasset（引擎内资产），
   * 用 AND 的话两种都命中不了。
   *
   * `assetTypes` / `fileExtensions` 仍是各自独立的 AND 条件，
   * 供调用方显式指定时使用。
   */
  formatMatch?: { extensions?: string[]; assetTypes?: string[] }
  sizeRange?: { min?: number; max?: number }
  engineVersions?: string[]
  dateRange?: { start?: string; end?: string }
  favoriteStatus?: 'all' | 'favorite' | 'unfavorite'
  /**
   * 显不显示导入时自动带进来的依赖资产（isDependency = 1）。缺省或 true = 都显示。
   *
   * 浏览那条路（getAssetDataByFolderKey）一直有这个条件，搜索这条路没有。
   * 结果是「只看主资产」一旦生效就让 hasActiveFilters 变真，列表转去走搜索，
   * 而搜索不认识这个条件 —— 筛选看着开了，一行都没少。
   */
  showDependencies?: boolean
  /**
   * 只看回收站里的（isDelete = 1）。缺省 / false = 只看没删的。
   *
   * 「最近删除」原来走的是自己那条 getDeleted 接口，不认识任何筛选条件 ——
   * 于是在回收站里改格式、改类型、改标签，列表一行都不会变，筛选栏纯粹在骗人。
   * 有了这个条件，回收站和普通文件夹走同一套查询，筛选 / 排序 / 关键字全都认。
   */
  deletedOnly?: boolean
  /**
   * 回收站视图专用：跟着文件夹一起被删掉的资产不单独列出来。
   *
   * 删一个文件夹会把里面的资产全部标成删除。全铺出来的话，删一个包会在回收站里
   * 炸出几百个条目，而它们本来就跟着文件夹一起回来 —— 界面上列的是**文件夹**那一条，
   * 和系统回收站的行为一致。单独删掉的资产（所在文件夹还活着）照常列。
   */
  excludeInsideDeletedFolders?: boolean
  userId?: number | null
  vaultId?: string | null
  /** 'relevance' 只在给了 ftsMatch 时有意义 —— 没有索引就没有相关度可排 */
  sortBy?:
    | 'assetName'
    | 'created_at'
    | 'updated_at'
    | 'fileSize'
    | 'size'
    | 'modifiedTime'
    | 'assetType'
    | 'deletedAt'
    | 'relevance'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
  /**
   * 只给「取前几条就够」的交互式召回用（目前只有 Spotlight）。
   *
   * 给了就在 FTS 召回那一层按 bm25 截断到这么多条。**默认必须是不截断**：
   * 召回结果是通过 `JOIN recall` 接进主查询的，那是个 INNER JOIN，也就是一道过滤 ——
   * 在它上面截断，等于在所有 WHERE 条件、COUNT 和 LIMIT/OFFSET 之前先把行扔掉。
   * 之前把它按 limit 自动推导，结果是：数总数的那次调用把 limit 删了于是截到 200，
   * 按目录筛的搜索因为全局 top-N 全在别的目录而返回 0 条，翻页过了 limit*20 就空。
   * 想提速请在调用点自己传，别让它悄悄对所有人生效。
   */
  recallDepth?: number
}

/**
 * 一次筛选拆出来的 SQL 零件。
 *
 * 抽出来是因为**同一组筛选条件有三种用法**：取一页资产、数总数、做分组统计。
 * 原来只有「取一页」这一条路，于是数总数的写法是「把 limit 去掉再查一次，
 * 然后取数组的 length」—— 几十万条的库上，那等于每次搜索都把整张表读进
 * JS 内存，只为了得到一个整数。统计更是压根没法做。
 */
export interface AssetQueryParts {
  withClause: string
  joinSql: string
  whereSql: string
  params: (string | number | null)[]
  /** 这次走了召回索引（全文 / 语义），`recall.score` 可用于按相关度排序 */
  usedRecall: boolean
  /**
   * 条件里有「规划器估不出命中多少行、又可能只命中几行」的：文件夹子树、关键词、收藏、
   * 标签、大小、日期、引擎版本、类型（LIKE）、召回。排序那边据此决定能不能让规划器
   * 沿排序列的索引走，见 searchAssetsByCriteria。
   */
  narrowUnindexed: boolean
}

export function buildAssetQueryParts(
  db: Database.Database,
  criteria: AssetSearchCriteria,
  env: AssetQueryEnv = {}
): AssetQueryParts {
  const whereClauses: string[] = []
  const joins: string[] = []

  /**
   * 占位符参数按**它在最终 SQL 文本里出现的位置**绑定，不是按代码里 push 的顺序。
   * 所以 WITH / JOIN / WHERE 三段的参数必须分开攒，最后按这个顺序拼起来。
   *
   * 原来只有一个 `params` 数组，代码里谁先跑谁先 push —— 于是
   * 「指定文件夹（不含子文件夹）+ 只看收藏」这一种组合会错位：
   * `ad.folderKey = ?` 是 WHERE，代码里先 push；收藏的 JOIN 后 push，
   * 但 JOIN 在 SQL 文本里排在 WHERE 前面。结果 folderKey 被绑到了
   * 收藏表的 userId 上，搜出来的东西和用户要的毫无关系，而且不会报错。
   */
  const withParams: (string | number | null)[] = []
  const joinParams: (string | number | null)[] = []
  const whereParams: (string | number | null)[] = []

  // 见 AssetQueryParts.narrowUnindexed；下面每加一个这类条件就置上
  let narrowUnindexed = false

  // 默认仅返回未被软删除的资产；回收站视图反过来，只要删掉的那些
  whereClauses.push(criteria.deletedOnly ? 'ad.isDelete = 1' : 'ad.isDelete = 0')

  // 跟着文件夹一起进回收站的资产不单独列（界面上列的是文件夹那一条）
  if (criteria.deletedOnly && criteria.excludeInsideDeletedFolders) {
    whereClauses.push(`NOT EXISTS (
      SELECT 1 FROM assetFolder af_del
      WHERE af_del.folderKey = ad.folderKey AND af_del.isDelete = 1
    )`)
  }

  // 「只看主资产」：把导入时自动带进来的依赖挡掉。和浏览那条路
  // （models/assetData.ts 的 dependencyCondition）用同一个判据，两条路才筛得出同样的结果
  if (criteria.showDependencies === false) {
    whereClauses.push('COALESCE(ad.isDependency, 0) = 0')
  }

  /**
   * CTE 片段。多个 CTE 用逗号连起来挂在同一个 `WITH RECURSIVE` 下面 ——
   * 文件夹递归要一个，混合召回要两个，各自独立但共用一个 WITH。
   */
  const withParts: string[] = []
  // 'ALL' 是前端虚拟根文件夹，不存在于 assetFolder 表中
  // 当 folderKey 为 'ALL' 时，跳过文件夹约束，搜索所有文件夹中的资产
  if (criteria.folderKey && criteria.folderKey !== 'ALL') {
    if (criteria.includeSubfolders) {
      // 🔍 调试：检查文件夹是否存在于 assetFolder 表中
      const folderCheck = db
        .prepare(
          'SELECT folderKey, folderName, fatherKey, fullPath, isDelete FROM assetFolder WHERE folderKey = ?'
        )
        .get(criteria.folderKey) as
        | { folderKey: string; fullPath?: string; isDelete: number }
        | undefined

      console.log('[资产搜索] 检查文件夹是否存在:', criteria.folderKey, '结果:', folderCheck)

      if (!folderCheck) {
        console.warn('[资产搜索] ⚠️ 文件夹不存在于 assetFolder 表中，递归查询将返回空！')
      } else if (folderCheck.isDelete === 1) {
        console.warn('[资产搜索] ⚠️ 文件夹已被标记删除，递归查询将返回空！')
      }

      // 🚀 性能优化：优先使用 fullPath 前缀匹配（利用 B-Tree 索引）
      // 当 fullPath 存在时，使用 LIKE 'path%' 查询，性能远超 CTE 递归
      if (folderCheck?.fullPath) {
        // 使用 fullPath 前缀匹配：利用 idx_assetFolder_fullPath 索引
        // 注意：需要转义 fullPath 中的特殊字符（% 和 _）
        const escapedPath = folderCheck.fullPath.replace(/%/g, '\\%').replace(/_/g, '\\_')
        joins.push(`
          JOIN assetFolder af ON ad.folderKey = af.folderKey
          AND (af.fullPath = ? OR af.fullPath LIKE ? ESCAPE '\\')
          AND af.isDelete = 0
        `)
        // 精确匹配当前文件夹 + 前缀匹配所有子文件夹
        joinParams.push(folderCheck.fullPath, `${escapedPath}/%`)
        narrowUnindexed = true
        console.log('[资产搜索] 使用 fullPath 前缀匹配:', folderCheck.fullPath)
      } else {
        // 回退方案：fullPath 为空时使用 CTE 递归（兼容旧数据）
        console.warn('[资产搜索] fullPath 为空，回退到 CTE 递归查询')
        withParts.push(`
          folder_tree AS (
            SELECT folderKey FROM assetFolder WHERE folderKey = ? AND isDelete = 0
            UNION ALL
            SELECT af.folderKey FROM assetFolder af
            JOIN folder_tree ft ON af.fatherKey = ft.folderKey
            WHERE af.isDelete = 0
          )
        `)
        joins.push('JOIN folder_tree ft ON ad.folderKey = ft.folderKey')
        withParams.push(criteria.folderKey)
        narrowUnindexed = true
      }
    } else {
      whereClauses.push('ad.folderKey = ?')
      whereParams.push(criteria.folderKey)
    }
  }

  const userId = criteria.userId ?? null
  const vaultId = criteria.vaultId ?? null
  if (criteria.favoriteStatus && criteria.favoriteStatus !== 'all') {
    // 没给 userId / vaultId = 不按它筛。界面收藏时写的是 userId=1 + 当前库 id，
    // 调用方（比如 agent 的 search_assets）不带这两个时，原来的 `IS NULL` 会把它们全挡掉 ——
    // 概况里数得出 3 个收藏，筛选却一个也搜不到。用 EXISTS 也顺带避免多条收藏记录把资产连成多行
    const favExists = `EXISTS (
      SELECT 1 FROM asset_favorites afav
      WHERE afav.assetKey = ad.assetKey
        AND (? IS NULL OR afav.userId IS ? OR afav.userId IS NULL)
        AND (? IS NULL OR afav.vaultId IS ? OR afav.vaultId IS NULL)
    )`
    whereClauses.push(criteria.favoriteStatus === 'favorite' ? favExists : `NOT ${favExists}`)
    whereParams.push(userId, userId, vaultId, vaultId)
    // 「未收藏」几乎是全库，沿排序索引走很快就凑满一页
    if (criteria.favoriteStatus === 'favorite') narrowUnindexed = true
  }

  // ── 关键词：有全文索引走 FTS5，没有才退回 LIKE ─────────────────────────
  //
  // 两条路是互斥的。FTS 走倒排索引并且带 bm25 相关度，LIKE 是全表扫描且只能
  // 按名字字母序排 —— 后者在几十万条的库上既慢又答不准，只作为索引还没建好
  // 时的兜底存在。
  const ftsMatch = (criteria.ftsMatch || '').trim()
  const semanticIds = (criteria.semanticIds ?? []).filter((id) => Number.isFinite(id))
  const usedRecall = ftsMatch.length > 0 || semanticIds.length > 0

  if (usedRecall) {
    narrowUnindexed = true
    /**
     * 两路召回用 RRF（Reciprocal Rank Fusion）合并：**只看名次，不看分数**。
     *
     * 必须这样，因为 bm25 和向量距离根本不是同一个量纲 —— bm25 是负数、
     * 量级随词频飘，余弦距离在 0~2 之间。直接加权相加的话，权重要随库、
     * 随查询重新调，调不好就是一路完全压住另一路。名次没有这个问题：
     * 两边各自的第 1 名贡献一样多。60 是 RRF 论文里的常数，作用是压住
     * 尾部长尾 —— 排到第 500 名的命中不该和第 5 名差着 100 倍。
     */
    const recallParts: string[] = []

    if (ftsMatch) {
      // 召回深度只在调用方显式要求时才封顶，理由见 AssetSearchCriteria.recallDepth：
      // recall 是 INNER JOIN 进来的，在这一层截断就是在所有筛选、COUNT、分页之前丢行。
      // 封顶时内层先按分数取前 N 条（SQLite 对 ORDER BY + LIMIT 用的是有界堆，
      // 不是全量排序），再在这 N 条上编名次给 RRF 用。
      const rawDepth = Number(criteria.recallDepth)
      const recallDepth =
        Number.isFinite(rawDepth) && rawDepth > 0 ? Math.floor(Math.min(rawDepth, 100000)) : 0
      withParts.push(
        recallDepth
          ? `
        fts_hits AS (
          SELECT assetId, ROW_NUMBER() OVER (ORDER BY bm25Score) AS rnk
          FROM (
            SELECT rowid AS assetId, ${BM25_EXPR} AS bm25Score
            FROM ${FTS_TABLE}
            WHERE ${FTS_TABLE} MATCH ?
            ORDER BY bm25Score
            LIMIT ${recallDepth}
          )
        )
      `
          : `
        fts_hits AS (
          SELECT rowid AS assetId,
                 ROW_NUMBER() OVER (ORDER BY ${BM25_EXPR}) AS rnk
          FROM ${FTS_TABLE}
          WHERE ${FTS_TABLE} MATCH ?
        )
      `
      )
      withParams.push(ftsMatch)
      recallParts.push('SELECT assetId, 1.0 / (60 + rnk) AS score FROM fts_hits')
    }

    if (semanticIds.length > 0) {
      // 语义那一路的名次由调用方按相关度排好后传进来，这里只负责换算成分数
      const values = semanticIds.map(() => '(?, ?)').join(', ')
      withParts.push(`semantic_hits(assetId, rnk) AS (VALUES ${values})`)
      semanticIds.forEach((id, index) => withParams.push(id, index + 1))
      recallParts.push('SELECT assetId, 1.0 / (60 + rnk) AS score FROM semantic_hits')
    }

    withParts.push(`
      recall AS (
        SELECT assetId, SUM(score) AS score
        FROM (${recallParts.join(' UNION ALL ')})
        GROUP BY assetId
      )
    `)

    joins.push('JOIN recall ON recall.assetId = ad.id')
  }

  const keyword = usedRecall ? '' : (criteria.keyword || '').trim()
  // 如果关键词是 "*" 或空字符串，跳过关键词过滤（匹配所有）
  if (keyword && keyword !== '*') {
    // 模糊搜索：支持多关键词（空格分隔），同时搜索名称、类型、路径和标签
    const keywords = keyword.split(/\s+/).filter((k) => k && k !== '*')
    if (keywords.length > 0) {
      // 先查询 public 数据库，获取所有匹配关键词的标签ID
      let matchingTagIds: number[] = []
      try {
        const publicDb = env.publicDb
        if (!publicDb) throw new Error('没有公共库连接')
        const allMatchingTags: Set<number> = new Set()
        keywords.forEach((k) => {
          // searchTags 函数内部已经添加了 % 通配符，所以直接传入关键词
          const tags = searchTags(publicDb, k)
          tags.forEach((tag) => {
            if (tag.id) {
              allMatchingTags.add(tag.id)
            }
          })
        })
        matchingTagIds = Array.from(allMatchingTags)
      } catch (error) {
        console.warn('查询标签失败，跳过标签搜索:', error)
      }

      const keywordConditions = keywords.map(() => {
        // 路径即标签：搜索时同时匹配 assetName、classNameCn、assetType、folderName 和 softPath
        // softPath 包含 UE 资产的完整路径信息，如 /Game/Characters/Hero/Textures/T_Hero_D
        // 用户搜索 "Hero" 时可以直接匹配到路径中对应目录的资产
        return `(
          ad.assetName LIKE ? COLLATE NOCASE OR
          ad.classNameCn LIKE ? COLLATE NOCASE OR
          ad.assetType LIKE ? COLLATE NOCASE OR
          ad.folderName LIKE ? COLLATE NOCASE OR
          ad.softPath LIKE ? COLLATE NOCASE
        )`
      })

      // 如果有匹配的标签，添加标签搜索条件
      if (matchingTagIds.length > 0) {
        const tagPlaceholders = matchingTagIds.map(() => '?').join(',')
        keywordConditions.push(`(
          ad.assetKey IN (
            SELECT assetKey FROM asset_tags
            WHERE tagId IN (${tagPlaceholders})
          )
        )`)
      }

      whereClauses.push(`(${keywordConditions.join(' OR ')})`)
      narrowUnindexed = true

      // 为每个关键词添加 5 个参数（对应 5 个字段：assetName, classNameCn, assetType, folderName, softPath）
      keywords.forEach((k) => {
        const likePattern = `%${k}%`
        whereParams.push(likePattern, likePattern, likePattern, likePattern, likePattern)
      })

      // 如果有匹配的标签，添加标签ID参数
      if (matchingTagIds.length > 0) {
        whereParams.push(...matchingTagIds)
      }
    }
  }

  const includeTagIds = (criteria.tagFilter?.includeTagIds || []).filter((n) => Number.isFinite(n))
  const excludeTagIds = (criteria.tagFilter?.excludeTagIds || []).filter((n) => Number.isFinite(n))
  const matchMode = criteria.tagFilter?.matchMode || 'any'
  if (includeTagIds.length) {
    narrowUnindexed = true
    const placeholders = includeTagIds.map(() => '?').join(',')
    if (matchMode === 'all') {
      whereClauses.push(`ad.assetKey IN (
        SELECT assetKey FROM asset_tags
        WHERE tagId IN (${placeholders})
        GROUP BY assetKey
        HAVING COUNT(DISTINCT tagId) = ?
      )`)
      whereParams.push(...includeTagIds, includeTagIds.length)
    } else {
      whereClauses.push(`ad.assetKey IN (
        SELECT assetKey FROM asset_tags
        WHERE tagId IN (${placeholders})
      )`)
      whereParams.push(...includeTagIds)
    }
  }
  if (excludeTagIds.length) {
    const placeholders = excludeTagIds.map(() => '?').join(',')
    whereClauses.push(`ad.assetKey NOT IN (
      SELECT assetKey FROM asset_tags
      WHERE tagId IN (${placeholders})
    )`)
    whereParams.push(...excludeTagIds)
  }

  // 无标签过滤：搜索没有任何标签的资产
  if (criteria.hasNoTags === true) {
    whereClauses.push(`ad.assetKey NOT IN (
      SELECT DISTINCT assetKey FROM asset_tags
    )`)
  }

  // assetType 字段可能存成逗号分隔（如 "Blueprint, BlueprintGeneratedClass"），
  // 所以用 LIKE 匹配完整类型名而不是子串，避免 "Material" 命中 "MaterialInstance"
  const buildTypeCondition = (types: string[]): string => {
    const conditions = types.map(() => {
      return `(
        ad.assetType = ? OR
        ad.assetType LIKE ? OR
        ad.assetType LIKE ? OR
        ad.assetType LIKE ?
      )`
    })
    types.forEach((type) => {
      whereParams.push(type, `${type},%`, `%, ${type},%`, `%, ${type}`)
    })
    return `(${conditions.join(' OR ')})`
  }

  /**
   * 两列各有一个索引（idx_assetData_fileExtension / idx_assetData_ext），
   * SQLite 才能对这个 OR 两边分别走索引再取并集。以前 ext 没有单独的索引，
   * OR 的一边走不了索引，整个条件就退化成全表扫 —— 52 万行的库上一点「音频」就卡死。
   *
   * 本机导入写的是小写、不带点（导入时 toLowerCase）；但旧 asset-server-standalone 扫描入库的
   * 是 path.extname 的结果，**带点**（'.wav'）。现在同步入口（SyncClient）写之前就去点，
   * 老行由 normalizeStoredExtensions 一次性迁掉；这里两种写法都放进 IN 只是兜底 ——
   * 迁移跑完之前（大库要几秒）、或者迁移出错没跑完时，「音频」照样筛得出来。
   * 仍是等值匹配，索引照走，多几个 IN 值几乎不要钱。
   */
  const buildExtensionCondition = (extensions: string[]): string => {
    const bare = extensions.map((ext) => String(ext).trim().replace(/^\./, '').toLowerCase())
    const normalized = [...new Set(bare.flatMap((ext) => [ext, `.${ext}`]))]
    const placeholders = normalized.map(() => '?').join(',')
    whereParams.push(...normalized, ...normalized)
    return `(ad.fileExtension IN (${placeholders}) OR ad.ext IN (${placeholders}))`
  }

  // 类型条件是一串 LIKE，用不上类型索引，规划器同样估不出
  if (criteria.assetTypes && criteria.assetTypes.length) {
    whereClauses.push(buildTypeCondition(criteria.assetTypes))
    narrowUnindexed = true
  }

  // 别名展开出来的「扩展名 or 类型」：任意一半命中即可
  if (criteria.formatMatch) {
    const parts: string[] = []
    const exts = criteria.formatMatch.extensions ?? []
    const types = criteria.formatMatch.assetTypes ?? []
    if (exts.length) parts.push(buildExtensionCondition(exts))
    if (types.length) parts.push(buildTypeCondition(types))
    if (parts.length) whereClauses.push(`(${parts.join(' OR ')})`)
    if (types.length) narrowUnindexed = true
  }

  if (criteria.classNameCnFilters && criteria.classNameCnFilters.length) {
    const placeholders = criteria.classNameCnFilters.map(() => '?').join(',')
    whereClauses.push(`ad.classNameCn IN (${placeholders})`)
    whereParams.push(...criteria.classNameCnFilters)
  }

  if (criteria.fileExtensions && criteria.fileExtensions.length) {
    whereClauses.push(buildExtensionCondition(criteria.fileExtensions))
  }

  const minSize = criteria.sizeRange?.min
  const maxSize = criteria.sizeRange?.max
  if (typeof minSize === 'number') {
    whereClauses.push('(ad.size >= ? OR ad.fileSize >= ?)')
    whereParams.push(minSize, minSize)
    narrowUnindexed = true
  }
  if (typeof maxSize === 'number') {
    whereClauses.push('(ad.size <= ? OR ad.fileSize <= ?)')
    whereParams.push(maxSize, maxSize)
    narrowUnindexed = true
  }

  if (criteria.engineVersions && criteria.engineVersions.length) {
    // 使用 LIKE 查询支持版本模糊匹配
    // 例如：5.3 可以匹配 5.3, 5.3.0, 5.3.1 等
    const versionConditions: string[] = []

    criteria.engineVersions.forEach((version) => {
      const trimmedVersion = (version || '').trim()
      if (!trimmedVersion) return

      // 如果版本号以点结尾（如 "5.3."），移除末尾的点
      const normalizedVersion = trimmedVersion.endsWith('.')
        ? trimmedVersion.slice(0, -1)
        : trimmedVersion

      // 构建匹配条件：
      // 1. 精确匹配（如 "5.3" 匹配 "5.3"）
      // 2. 前缀匹配（如 "5.3" 匹配 "5.3.0", "5.3.1" 等，但不匹配 "5.30"）
      // 确保 engineVersion 不为 NULL
      // 注意：使用 ESCAPE '\\' 来转义特殊字符，但 LIKE 模式中的 % 和 _ 需要正确转义
      versionConditions.push(
        `(ad.engineVersion IS NOT NULL AND (ad.engineVersion = ? OR ad.engineVersion LIKE ?))`
      )

      // 精确匹配参数
      whereParams.push(normalizedVersion)
      // LIKE 匹配参数：version.% 匹配 version.0, version.1, version.0.0 等
      // 例如：5.3 -> 5.3.%，5 -> 5.%
      const likePattern = `${normalizedVersion}.%`
      whereParams.push(likePattern)
    })

    if (versionConditions.length > 0) {
      whereClauses.push(`(${versionConditions.join(' OR ')})`)
      narrowUnindexed = true
    }
  }

  const start = (criteria.dateRange?.start || '').trim()
  const end = (criteria.dateRange?.end || '').trim()
  if (start && end) {
    whereClauses.push(`(
      CASE
        WHEN ad.updated_at IS NOT NULL THEN ad.updated_at
        WHEN ad.modifiedTime IS NOT NULL THEN ad.modifiedTime
        ELSE ad.created_at
      END
    ) BETWEEN ? AND ?`)
    whereParams.push(start, end)
    narrowUnindexed = true
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : ''
  const joinSql = joins.join('\n')

  const withClause = withParts.length > 0 ? `WITH RECURSIVE ${withParts.join(',\n')}` : ''

  return {
    withClause,
    joinSql,
    whereSql,
    params: [...withParams, ...joinParams, ...whereParams],
    usedRecall,
    narrowUnindexed
  }
}

/**
 * 数符合条件的资产有多少个 —— 用 SQL 数，不把行读出来。
 *
 * 这是「我库里有多少个 X」和分页里 hasMore 的唯一正确算法。几十万条的库上
 * 它是索引扫描，返回一个整数；把行捞出来数 length 是全表物化，两者差几个数量级。
 */
export function countAssetsByCriteria(
  db: Database.Database,
  criteria: AssetSearchCriteria,
  env: AssetQueryEnv = {}
): number {
  const { withClause, joinSql, whereSql, params } = buildAssetQueryParts(db, criteria, env)
  const sql = `
    ${withClause}
    SELECT COUNT(*) AS total
    FROM assetData ad
    ${joinSql}
    ${whereSql}
  `
  const row = db.prepare(sql).get(...params) as { total?: number } | undefined
  return Number(row?.total ?? 0)
}

/**
 * 引擎版本分面：符合条件的资产里各引擎版本有几个，给资产库筛选栏的版本下拉用。
 *
 * 按「主.次」归并（5.3.2 记到 5.3 里）：筛选那边 5.3 本来就前缀匹配 5.3.x，
 * 分开列的话勾一项命中的数和旁边写的数对不上。没标版本的不列 —— 筛不出来。
 * 自身的版本条件不参与：勾了 5.3 之后下拉里别的版本也得照样有数。
 */
export function countAssetsByEngineVersion(
  db: Database.Database,
  criteria: AssetSearchCriteria,
  env: AssetQueryEnv = {}
): Array<{ value: string; n: number }> {
  const { withClause, joinSql, whereSql, params } = buildAssetQueryParts(
    db,
    { ...criteria, engineVersions: [], limit: undefined, offset: undefined },
    env
  )
  const rows = db
    .prepare(
      `
    ${withClause}
    SELECT TRIM(ad.engineVersion) AS version, COUNT(*) AS n
    FROM assetData ad
    ${joinSql}
    ${whereSql ? `${whereSql} AND` : 'WHERE'} TRIM(COALESCE(ad.engineVersion, '')) <> ''
    GROUP BY version
  `
    )
    .all(...params) as Array<{ version: string; n: number }>

  const merged = new Map<string, number>()
  for (const { version, n } of rows) {
    const key = /^(\d+\.\d+)/.exec(version)?.[1] ?? version
    merged.set(key, (merged.get(key) ?? 0) + Number(n))
  }
  // 新版本在前；不是数字版本号的排最后
  const numeric = (value: string): number => (/^\d/.test(value) ? 0 : 1)
  return [...merged]
    .map(([value, n]) => ({ value, n }))
    .sort(
      (a, b) =>
        numeric(a.value) - numeric(b.value) ||
        b.value.localeCompare(a.value, undefined, { numeric: true })
    )
}

/** 先排 id 再取整行的分页上限；更大的「一页」照旧一步查完（IN 列表有参数个数上限） */
const LATE_MATERIALIZE_MAX_LIMIT = 5000

export function searchAssetsByCriteria(
  db: Database.Database,
  criteria: AssetSearchCriteria,
  env: AssetQueryEnv = {}
): AssetData[] {
  const { withClause, joinSql, whereSql, params, usedRecall, narrowUnindexed } =
    buildAssetQueryParts(db, criteria, env)

  const sortBy = criteria.sortBy || (usedRecall ? 'relevance' : 'assetName')
  const sortOrder = (criteria.sortOrder || 'asc').toUpperCase()
  const allowedCols = new Set([
    'assetName',
    'created_at',
    'updated_at',
    'fileSize',
    'size',
    'modifiedTime',
    'assetType',
    'deletedAt'
  ])

  /**
   * 有关键词时**默认按相关度排**，而不是按名字字母序。
   *
   * 这是「答得准不准」的分水岭：库里两千个资产命中「chair」，按名字排的话
   * 调用方看到的前 20 个是 `A_...` 开头的那些，真正叫 SM_Chair 的排在几百位
   * 之后 —— 它翻不到，只能拿手上这 20 个作答。recall.score 是 RRF 融合分，越大越相关。
   */
  /**
   * 「按删除时间排」要退回 updated_at：deletedAt 是后加的列，老库里在那之前
   * 删掉的行全是 NULL，直排的话它们会整片堆在一头，看着像回收站丢了东西。
   * 再补一个名字做次序键 —— 同一次文件夹删除盖的是同一个时间戳，没有次序键的话
   * 分页翻到第二页可能重复或漏掉。
   */
  /**
   * 名字一律按 NOCASE 排，两个原因：
   *
   * - 和浏览那条路（models/assetData.ts 的 getAssetDataByFolderKey）一致。原来这里是
   *   二进制序，大写全排在小写前面 —— 开一个筛选，列表从 a/B/c 变成 B/a/c，看着像乱了。
   * - 名称索引（idx_assetData_assetName、idx_assetData_folderKey_isDelete_assetName）
   *   都是 NOCASE 建的。二进制序对不上它们，52 万行的库每一页都是全表读出来再临时排序
   *   （实测 1.3–2.2 s）；对上了，不带筛选的一页是沿索引取前 N 条，零点几毫秒。
   *
   * 但沿排序列的索引走，等于「按顺序把整张表过一遍，边走边筛」。条件宽（不筛选、只看主资产、
   * 关键词几乎都中）时这正是最快的：走几十条就凑满一页，54 万行的库上 0 ms。条件窄时就是
   * 最慢的：一个只有几十个资产的文件夹、30 个收藏、一个没人用的大小区间，要把 54 万条索引
   * 连同逐行回表走完才凑得出一页 —— 比整表读一遍再排还慢 2~3 倍（实测文件夹 0.6 ms → 3 s）。
   * 规划器分不出这两种：这些条件（narrowUnindexed）它估不出命中多少行，一律按「宽」处理。
   *
   * 所以有这类条件时给排序列套一个一元 `+`：值和排序规则不变，只是它不再对得上任何索引，
   * 规划器只能先按条件取行再排 —— 最坏也就是整表读一遍（54 万行约 0.1~0.3 s，在查询 worker
   * 里）。没有这类条件时让规划器沿索引走。
   *
   * 按扩展名、中文类名筛**不算**：这两样有索引，有统计信息时（编译带 STAT4）规划器自己估得出
   * 「按扩展名取行再排」还是「沿排序索引走」哪个快；算进来反而把「UE 资产」这种几乎覆盖
   * 全库的宽筛选也逼成整表读一遍再排序，一页从 0.1 ms 变成上百毫秒。
   */
  const noIndex = narrowUnindexed ? '+' : ''
  const sortCol = allowedCols.has(sortBy) ? sortBy : 'assetName'
  /**
   * 「按时间 / 按大小」和浏览那条路（getAssetDataByFolderKey）取同一个值、同一个次序键。
   *
   * 界面一开筛选就从浏览切到这里。原来这里直排 modifiedTime / fileSize，浏览排的是
   * updated_at / COALESCE(fileSize, 0)：默认视图就是「按时间倒序」，勾一个筛选，
   * 列表顺序整个换掉，空值还会整片堆到一头。
   *
   * 次序键两边都补了名字：updated_at 只到秒，一次导入几百个资产盖的是同一秒，
   * 没有次序键的话同一秒内谁先谁后看规划器心情，分页还可能重复或漏掉。
   * 这两个值都没有索引，本来就是临时排序，多一个键不改变计划。
   */
  const tiedSorts: Record<string, string> = {
    modifiedTime: 'ad.updated_at',
    fileSize: 'COALESCE(ad.fileSize, 0)'
  }
  const orderBy =
    sortBy === 'relevance' && usedRecall
      ? 'ORDER BY recall.score DESC, ad.assetName COLLATE NOCASE ASC'
      : sortBy === 'deletedAt'
        ? `ORDER BY COALESCE(ad.deletedAt, ad.updated_at) ${sortOrder}, ad.assetName COLLATE NOCASE ASC`
        : sortCol === 'assetName'
          ? `ORDER BY (${noIndex}ad.assetName) COLLATE NOCASE ${sortOrder}`
          : tiedSorts[sortCol]
            ? `ORDER BY ${noIndex}${tiedSorts[sortCol]} ${sortOrder}, ad.assetName COLLATE NOCASE ASC`
            : `ORDER BY ${noIndex}ad.${sortCol} ${sortOrder}`

  const limitParts: string[] = []
  // 强制转换 limit 和 offset 类型，防止前端传递字符串导致 SQL 执行错误
  // 注意：这里需要处理 0 的情况，不能简单使用 || 或 ? :
  let limit: number | undefined
  if (criteria.limit !== undefined && criteria.limit !== null) {
    const parsed = Number(criteria.limit)
    if (!Number.isNaN(parsed)) {
      limit = parsed
    }
  }

  let offset: number | undefined
  if (criteria.offset !== undefined && criteria.offset !== null) {
    const parsed = Number(criteria.offset)
    if (!Number.isNaN(parsed)) {
      offset = parsed
    }
  }

  if (limit !== undefined) {
    limitParts.push('LIMIT ?')
    params.push(limit)
    if (offset !== undefined) {
      limitParts.push('OFFSET ?')
      params.push(offset)
    }
  }

  // 顺带把标签 id 带出来。
  //
  // 标签关联在 asset_tags 里，`SELECT ad.*` 一个都带不出来 —— 于是
  // 「写得进去读不出来」：给资产打了标签，下次搜索却看不见，既答不了
  // 「这个资产标了什么」，也会重复打同一个标签。
  //
  // 这里只取 id：**标签名在另一个数据库**（tags 表在公共库，
  // asset_tags 在保管库），跨库 JOIN 会直接报 no such table，
  // 名字由调用方拿 id 去公共库换。
  const tagIdListColumn = `(SELECT GROUP_CONCAT(at2.tagId)
         FROM asset_tags at2
        WHERE at2.assetKey = ad.assetKey) AS tagIdList`

  /**
   * 分页查询分两步：先只排 id 取出这一页，再按 id 把整行取回来。
   *
   * 一步到位的写法里，排序器要把每一条命中的**整行**（ad.* 有几十列，imports、
   * assetConfig 这些 JSON 动辄上 KB）连同每行一次的标签子查询都算出来、搬进临时
   * B 树，排完再扔掉绝大部分只留 50 条。命中几十万行时那就是几百 MB 的搬运。
   * 先排 id 时排序器里只有 id 和排序键，整行和标签只为最后那一页算。
   *
   * 不分页（或一页大得离谱）的调用照旧一步查完：IN 列表有参数个数上限。
   */
  const pagedById = limit !== undefined && limit > 0 && limit <= LATE_MATERIALIZE_MAX_LIMIT
  const sql = pagedById
    ? `
    ${withClause}
    SELECT ad.id AS id
    FROM assetData ad
    ${joinSql}
    ${whereSql}
    ${orderBy}
    ${limitParts.join(' ')}
  `
    : `
    ${withClause}
    SELECT ad.*,
      ${tagIdListColumn}
    FROM assetData ad
    ${joinSql}
    ${whereSql}
    ${orderBy}
    ${limitParts.join(' ')}
  `

  // 调试日志默认关掉。Spotlight 现在也走这个函数，而它是每敲一个键查一次的：
  // 无条件打印等于把完整 FTS 语句和用户输入的原文，按键落进主进程日志，
  // 还要在本该提速的同步路径上付一次字符串拼接和 I/O。
  // 需要排查时设环境变量 UEBOX_DEBUG_ASSET_SEARCH=1。
  const debugSearch = process.env.UEBOX_DEBUG_ASSET_SEARCH === '1'
  if (debugSearch) {
    console.log('[资产搜索] SQL:', sql.replace(/\s+/g, ' ').trim())
    console.log('[资产搜索] 参数:', params)
  }

  let rows: AssetData[]
  if (pagedById) {
    // 两步放在同一个读事务里：查询在 worker 的连接上跑，主进程同时在写；两步之间要是有行
    // 被删掉或换了 id，这一页就会少几行，界面以为到底了就不再往下翻
    rows = db.transaction((): AssetData[] => {
      const ids = (db.prepare(sql).all(...params) as { id: number }[]).map((row) => row.id)
      if (ids.length === 0) return []
      const fetched = db
        .prepare(
          `SELECT ad.*, ${tagIdListColumn}
           FROM assetData ad
           WHERE ad.id IN (${ids.map(() => '?').join(',')})`
        )
        .all(...ids) as AssetData[]
      const byId = new Map(fetched.map((row) => [(row as { id: number }).id, row]))
      return ids.map((id) => byId.get(id)).filter((row): row is AssetData => row !== undefined)
    })()
  } else {
    rows = db.prepare(sql).all(...params) as AssetData[]
  }

  if (debugSearch) console.log('[资产搜索] 结果数量:', rows.length)

  return rows
}
