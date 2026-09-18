/**
 * 素材库概览 —— 回答「我库里有什么」的工具。
 *
 * 为什么不能用 search_assets 回答这个问题：
 *
 * search_assets 回的是**资产行**。库里 40 万个资产，一页 100 个，要看完得翻
 * 4000 次；不翻的话，调用方手上就只有按名字排在最前的那 100 个 ——
 * 它会拿这 100 个去总结「你的库里主要是……」，而那个总结几乎必然是错的，
 * 并且**错得看不出来**：返回值里没有任何东西提示「这 100 个不代表全库」。
 *
 * 这个工具回的是**数字**：总数、总体积、按类型/文件夹/标签/格式的分布。
 * 库里是 8 个资产还是 80 万个，返回值都是几百 token，而且每个数字都是
 * SQL 精确算出来的，不是从样本推的。
 *
 * 它同时也是**导航**：先看顶层分布，再带上 folder 往下钻一层，
 * 最后用 search_assets 在收窄之后的范围里取具体资产。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { getPublicDatabase } from '../../../../sqliteDataBase'
import {
  getAssetLibraryOverview,
  type AssetFacet,
  type AssetLibraryOverview
} from '../../../../sqliteDataBase/models/assetStats'
import { resolveKeywordCriteria } from '../../../../sqliteDataBase/models/assetSearchIndex'
import type { AssetSearchCriteria } from '../../../../sqliteDataBase/models/assetSearch'
import { getTagByName } from '../../../../sqliteDataBase/models/tag'
import { humanBytes } from '../ue-content-browser/formatBytes'
import { resolveFolder } from './folderLookup'
import { runAcrossVaults, VAULT_SCOPE_DESCRIPTION } from './vaultScope'

/** 每组分布最多列几个。列太多是纯粹的 token 浪费，列太少看不出结构 */
const FACET_LIMIT = 12

/**
 * 跨库统计时，**每个库先多取一些桶再合并**。
 *
 * 直接按 12 个取会算错：某个类型在 A 库排第 15（落进 A 的「其余」里）、
 * 在 B 库排第 1，合起来本该进前 12，但 A 那部分已经没法按 key 找回来了 ——
 * 于是这个类型的数字比真实值小，而且**看不出来小了**。
 * 每库先取 200 个，落到「其余」里的必然是长尾，合并后的前 12 就是准的。
 */
const MERGE_FACET_LIMIT = 200

/** 把若干个库的同一组分布合成一组。总数精确，桶按合并后的量重新排序截断 */
function mergeFacets(facets: AssetFacet[], limit: number): AssetFacet {
  const byKey = new Map<string, { count: number; size: number }>()
  let otherCount = 0
  let otherKinds = 0

  for (const facet of facets) {
    for (const bucket of facet.buckets) {
      const acc = byKey.get(bucket.key) ?? { count: 0, size: 0 }
      acc.count += bucket.count
      acc.size += bucket.size
      byKey.set(bucket.key, acc)
    }
    otherCount += facet.otherCount
    otherKinds += facet.otherKinds
  }

  const sorted = [...byKey.entries()].sort((a, b) => b[1].count - a[1].count)
  const dropped = sorted.slice(limit)

  return {
    buckets: sorted.slice(0, limit).map(([key, v]) => ({ key, count: v.count, size: v.size })),
    otherCount: otherCount + dropped.reduce((sum, [, v]) => sum + v.count, 0),
    otherKinds: otherKinds + dropped.length
  }
}

/** 把若干个库的概览合成一份。总数 / 体积 / 收藏 / 无标签都是精确相加 */
function mergeOverviews(parts: AssetLibraryOverview[], largestLimit: number): AssetLibraryOverview {
  const pick = (get: (o: AssetLibraryOverview) => AssetFacet): AssetFacet =>
    mergeFacets(parts.map(get), FACET_LIMIT)

  const times = (get: (o: AssetLibraryOverview) => string | undefined): string[] =>
    parts.map(get).filter((v): v is string => Boolean(v))

  const earliest = times((o) => o.earliest).sort()[0]
  const latest = times((o) => o.latest)
    .sort()
    .at(-1)

  return {
    total: parts.reduce((s, o) => s + o.total, 0),
    totalSize: parts.reduce((s, o) => s + o.totalSize, 0),
    byType: pick((o) => o.byType),
    byExtension: pick((o) => o.byExtension),
    byFolder: pick((o) => o.byFolder),
    byEngineVersion: pick((o) => o.byEngineVersion),
    byTag: pick((o) => o.byTag),
    untaggedCount: parts.reduce((s, o) => s + o.untaggedCount, 0),
    favoriteCount: parts.reduce((s, o) => s + o.favoriteCount, 0),
    largest: parts
      .flatMap((o) => o.largest)
      .sort((a, b) => b.size - a.size)
      .slice(0, largestLimit),
    ...(earliest ? { earliest } : {}),
    ...(latest ? { latest } : {})
  }
}

interface FlatFacet {
  [key: string]: string
}

/**
 * 分布压扁成 `{ 取值: "个数（体积）" }`。
 *
 * 用对象而不是对象数组，是因为后者每个桶要重复一遍 key 名
 * （`{"type":"StaticMesh","count":12,"size":"1 GB"}`），十几个桶下来光是
 * 字段名就占掉一半 token，而它们不携带任何信息。
 */
function flatten(facet: AssetFacet, withSize = true): FlatFacet {
  const out: FlatFacet = {}
  for (const bucket of facet.buckets) {
    out[bucket.key] = withSize
      ? `${bucket.count} 个 / ${humanBytes(bucket.size)}`
      : `${bucket.count} 个`
  }
  // 没进前 N 的必须说出来，否则调用方会把「前 12 类」当成「一共 12 类」
  if (facet.otherCount > 0) {
    out['（其余 ' + facet.otherKinds + ' 类合计）'] = `${facet.otherCount} 个`
  }
  return out
}

export function createLibraryOverviewTool(): V2Tool {
  return defineV2Tool({
    description: `看素材库里有什么 —— 回的是分布统计，不是资产清单。

【什么时候用】用户问「我库里有什么」「素材库多大」「都有哪些类型/标签」
  「哪些东西最占地方」「这个文件夹里都是些什么」时，**先用这个**，
  不要用 search_assets 去翻页凑。
【为什么】search_assets 一页只回 100 个资产，几十万个资产的库靠它是数不完的；
  拿前 100 个去总结全库会得出错误的结论，而且看不出错。这个工具回的是
  SQL 精确算出来的总数和分布，库多大它都只有几百字。
【怎么往下钻】先不带参数看整体 → 挑一个文件夹/标签，带上 folder 或 tags 再调一次
  → 范围收窄到几十个之后，再用 search_assets 取具体资产。
【默认统计所有保管库】用户的资产分散在多个库里（默认保管库、AIGC 资产库、
  他自己建的、网络协作库）。这个工具默认全统计，by_vault 里是各库各有多少。
  **汇报时要说清楚数字是所有库合起来的**，别说成某一个库的；
  unsearched_vaults 非空说明有库这次没数到，也要说出来。
【注意】返回的分布只列前 ${FACET_LIMIT} 个取值，剩下的会以「（其余 N 类合计）」
  的形式给出总数 —— 汇报时别把列出来的当成全部类别。`,
    inputSchema: z.object({
      vault: z.string().optional().describe(VAULT_SCOPE_DESCRIPTION),
      folder: z
        .string()
        .optional()
        .describe('只统计这个文件夹（含子文件夹）：文件夹名、完整路径（/ALL/角色）或 folderKey'),
      query: z.string().optional().describe('只统计名字/路径/标签/备注命中这个关键词的资产'),
      tags: z.array(z.string()).optional().describe('只统计带这些标签的资产（标签名）'),
      assetType: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('只统计这些虚幻资产类型，如 StaticMesh、Texture2D'),
      largest: z
        .number()
        .optional()
        .describe('「最占地方的」列几个，默认 5，填 0 不列。想知道什么在吃硬盘时调大它')
    }),
    execute: async (input) => {
      const criteria: AssetSearchCriteria = {}
      const scope: string[] = []

      // ── 标签：名字换 id。有一个不存在就报错。 ───────────────────────────
      //
      // 不报的话筛选条件会变成空数组、被底层当成「没筛」，于是整个库的统计
      // 原样回来 —— 调用方会把全库的分布当成「这个标签下的分布」念给用户听。
      if (input.tags && input.tags.length > 0) {
        const publicDb = getPublicDatabase()
        const ids: number[] = []
        const unknown: string[] = []
        for (const raw of input.tags) {
          const name = String(raw ?? '').trim()
          if (!name) continue
          const tag = getTagByName(publicDb, name)
          if (tag && typeof tag.id === 'number') ids.push(tag.id)
          else unknown.push(name)
        }
        if (unknown.length > 0) {
          return {
            success: false,
            error:
              `库里没有这些标签：${unknown.join('、')}。` +
              '标签名要和库里的完全一致，不确定就先用 list_tags 看一眼。'
          }
        }
        criteria.tagFilter = { includeTagIds: ids, matchMode: 'all' }
        scope.push(`标签 ${input.tags.join(' + ')}`)
      }

      if (input.assetType) {
        const types = Array.isArray(input.assetType) ? input.assetType : [input.assetType]
        criteria.assetTypes = types
        scope.push(`类型 ${types.join('、')}`)
      }

      if (input.query) scope.push(`关键词「${input.query}」`)

      // 标签名在公共库。读不出来时统计照常出，标签那一组退化成「标签#id」
      let publicDb: Database.Database | undefined
      try {
        publicDb = getPublicDatabase()
      } catch {
        publicDb = undefined
      }

      const largestLimit = Math.max(0, Math.floor(input.largest ?? 5))

      // ── 每个保管库统计一遍 ────────────────────────────────────────────────
      //
      // 只统计当前活跃库曾经让这个工具给出过**真的但错的**答案：用户站在
      // AIGC 库里问「我库里有什么」，它如实回「共 59 个资产」—— 而他的 776 个
      // 素材在默认保管库里。数字精确，结论完全错，且看不出错。
      const perVault: Record<string, string> = {}
      const folderMisses: string[] = []
      let folderScope: string | undefined

      const { runs, error: scopeError } = await runAcrossVaults<AssetLibraryOverview | null>(
        input.vault,
        (db, vault) => {
          const scoped: AssetSearchCriteria = { ...criteria }
          let scopePath = ''

          // 文件夹：用户说名字，底层认 folderKey。folderKey 每个库各一套，
          // 必须逐库解析 —— 跨库复用会统计到另一个库里同 key 的文件夹上
          if (input.folder) {
            const resolved = resolveFolder(db, input.folder)
            if (resolved.error || !resolved.folderKey) {
              folderMisses.push(`${vault.name}：${resolved.error ?? '文件夹解析失败'}`)
              return null
            }
            scoped.folderKey = resolved.folderKey
            scoped.includeSubfolders = true
            scopePath = resolved.folder?.fullPath ?? ''
            folderScope ??= scopePath || resolved.folder?.folderName || resolved.folderKey
          }

          // 关键词走全文索引还是 LIKE，和 search_assets 用同一段判断。
          // 索引是每个库自己的，所以这一步也得逐库来
          const resolvedKeyword = resolveKeywordCriteria(db, input.query)
          if (resolvedKeyword.ftsMatch) scoped.ftsMatch = resolvedKeyword.ftsMatch
          if (resolvedKeyword.keyword) scoped.keyword = resolvedKeyword.keyword

          const one = getAssetLibraryOverview(db, scoped, {
            // 多个库要合并时每库多取一些桶，否则合并后的前 12 会算小
            facetLimit: MERGE_FACET_LIMIT,
            largestLimit,
            scopePath,
            publicDb
          })
          perVault[vault.name] = `${one.total} 个 / ${humanBytes(one.totalSize)}`
          return one
        }
      )

      if (scopeError) return { success: false, error: scopeError }

      if (input.folder && !folderScope) {
        return {
          success: false,
          error: `所有保管库里都没有文件夹「${input.folder}」：${folderMisses.join('；')}`
        }
      }
      if (folderScope) scope.push(`文件夹 ${folderScope}`)

      const failed = runs.filter((run) => run.error)
      const searched = runs.filter((run) => !run.error).map((run) => run.vault.name)

      // 一个库都没统计成 = 这次失败，不是「库里是空的」。
      // 报成 0 的话，调用方会告诉用户「你素材库是空的」—— 而真相是压根没数。
      if (runs.length > 0 && searched.length === 0) {
        return {
          success: false,
          error: `所有保管库都没能统计：${failed.map((r) => `${r.vault.name}：${r.error}`).join('；')}`
        }
      }

      const parts = runs
        .map((run) => run.value)
        .filter((value): value is AssetLibraryOverview => Boolean(value))

      const overview = mergeOverviews(parts, largestLimit)
      const scopeLabel = scope.length > 0 ? scope.join(' + ') : '全部保管库'
      const multi = Object.keys(perVault).length > 1

      // 哪个库没统计到必须说出来。不说的话「库里就这么多」和「有一个库没数到」
      // 长得一模一样，而后者会让用户以为自己的素材丢了
      const vaultNotes: Record<string, unknown> = {
        searched_vaults: searched,
        ...(multi ? { by_vault: perVault } : {}),
        ...(failed.length > 0
          ? { unsearched_vaults: failed.map((run) => `${run.vault.name}：${run.error}`) }
          : {})
      }

      if (overview.total === 0) {
        return {
          success: true,
          scope: scopeLabel,
          total: 0,
          ...vaultNotes,
          message: `${searched.join('、')} 里，${scopeLabel}一个资产也没有。`
        }
      }

      return {
        success: true,
        scope: scopeLabel,
        total: overview.total,
        total_size: humanBytes(overview.totalSize),
        ...vaultNotes,
        by_type: flatten(overview.byType),
        by_folder: flatten(overview.byFolder),
        by_format: flatten(overview.byExtension, false),
        by_tag: flatten(overview.byTag, false),
        by_engine_version: flatten(overview.byEngineVersion, false),
        untagged: overview.untaggedCount,
        favorite: overview.favoriteCount,
        ...(overview.largest.length > 0
          ? {
              largest: overview.largest.map(
                (item) =>
                  `${item.name}（${humanBytes(item.size)}${item.folder ? `，在 ${item.folder}` : ''}）`
              )
            }
          : {}),
        ...(overview.earliest ? { earliest: overview.earliest } : {}),
        ...(overview.latest ? { latest: overview.latest } : {}),
        message:
          `${scopeLabel}：共 ${overview.total} 个资产，${humanBytes(overview.totalSize)}` +
          (multi
            ? `，分布在 ${Object.keys(perVault).length} 个保管库里（明细见 by_vault）` +
              '。**汇报时要说清楚这是所有保管库合起来的**，不要说成某一个库的。'
            : '。') +
          `上面的分布是**全量精确统计**，不是抽样 —— 可以直接照着回答用户。` +
          `要看具体是哪些资产，用 search_assets；` +
          `要往下钻一层，带上 folder 再调一次这个工具。`
      }
    }
  })
}
