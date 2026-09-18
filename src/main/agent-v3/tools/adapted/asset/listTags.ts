/**
 * 列出素材库里已有的标签体系。
 *
 * ## 为什么需要它
 *
 * `annotate_asset` 打标签时**标签名不存在就自动新建**，而 agent 一直看不见
 * 库里已经有哪些标签 —— 于是同一个概念被打成「树」「树木」「Tree」三个标签，
 * 用户的分类体系被越搅越碎。而且新建的标签一律落在「未分组」，
 * 和用户在界面里精心分好的标签组对不上。
 *
 * 现在 `search_assets` 也支持按标签筛了，标签名写错就直接报错 ——
 * 那更需要一个地方看「合法的名字有哪些」。
 *
 * ## 为什么带用量
 *
 * 光有名字看不出哪个是主力分类、哪个是当初随手打的孤儿标签。
 * 挑标签复用时要的正是这个判断。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { getPublicDatabase, getVaultDatabase } from '../../../../sqliteDataBase'
import { getAssetCountsByTag } from '../../../../sqliteDataBase/models/assetTag'
import { getAllTags } from '../../../../sqliteDataBase/models/tag'
import { getAllTagGroups } from '../../../../sqliteDataBase/models/tagGroup'

/** 一次最多回多少个标签。标签几百个的库不少见，全倒出来只会挤爆上下文 */
const DEFAULT_LIMIT = 200

interface TagLine {
  name: string
  /** 挂了几个资产（已删除的不算） */
  assets: number
  /** 所属标签组；用户没分组时是「未分组」 */
  group?: string
}

export function createListTagsTool(): V2Tool {
  return defineV2Tool({
    description: `列出素材库里已有的标签（含每个标签挂了多少资产、属于哪个标签组）。

【什么时候用】
- 给资产打标签**之前**：先看有没有现成的，复用它，别造出「树 / 树木 / Tree」这种近义标签。
- 用 search_assets 按标签筛之前：标签名必须和库里完全一致，从这里抄。
- 用户问「我都用了哪些标签」「标签体系乱不乱」。
【怎么读】assets 是这个标签下的资产数：数字大的是主力分类，只有 1 个的多半是
  当初随手打的，整理时可以提议合并。
【新建标签的代价】annotate_asset 遇到不存在的标签名会**直接新建**，而且落在「未分组」。
  所以决定新建之前，先在这份清单里找一遍。`,

    inputSchema: z.object({
      query: z.string().optional().describe('只看名字里含这个词的标签。留空 = 全部。'),
      limit: z.number().optional().describe(`最多回几个，默认 ${DEFAULT_LIMIT}`)
    }),

    execute: async (input) => {
      const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)), 500)
      const keyword = String(input.query ?? '')
        .trim()
        .toLowerCase()

      const publicDb = getPublicDatabase()
      const tags = getAllTags(publicDb)
      const groupNameById = new Map(
        getAllTagGroups(publicDb)
          .filter((g) => typeof g.id === 'number')
          .map((g) => [g.id as number, g.name])
      )

      const countByTagId = new Map(
        getAssetCountsByTag(getVaultDatabase()).map((row) => [row.tagId, row.count])
      )

      const matched = tags.filter((tag) =>
        keyword
          ? String(tag.name ?? '')
              .toLowerCase()
              .includes(keyword)
          : true
      )

      // 用量高的排前面 —— 挑标签复用时先看到的应该是主力分类
      const lines: TagLine[] = matched
        .map((tag) => ({
          name: tag.name,
          assets: (typeof tag.id === 'number' ? countByTagId.get(tag.id) : 0) ?? 0,
          ...(tag.group_id && groupNameById.has(tag.group_id)
            ? { group: groupNameById.get(tag.group_id) }
            : {})
        }))
        .sort((a, b) => b.assets - a.assets || a.name.localeCompare(b.name))

      const page = lines.slice(0, limit)

      return {
        success: true,
        count: lines.length,
        returnedCount: page.length,
        ...(lines.length > page.length ? { truncated: true } : {}),
        tags: page,
        message:
          `库里一共 ${tags.length} 个标签` +
          (keyword ? `，其中 ${lines.length} 个名字里含「${input.query}」` : '') +
          (lines.length > page.length ? `，这里只列了前 ${page.length} 个（按用量排序）` : '')
      }
    }
  })
}
