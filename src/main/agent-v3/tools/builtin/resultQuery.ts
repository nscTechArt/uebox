/**
 * `result_query` —— 凭编号查一份存档的大结果。
 *
 * 存档怎么来的、为什么不另建存储，见 `core/resultArchive.ts` 文件头。
 *
 * 这个工具不常驻：常驻的两条字节线都满了（`toolSearchCatalog.test.ts`）。
 * 第一次有结果被存档时，`createAgent.ts` 的 `afterToolCall` 顺手把它加载上，
 * 模型下一轮就能看到 —— 从没触发存档的会话一个字节都不多花。
 * 所以它也不需要技能引用：它不是靠搜出来的。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import {
  RESULT_QUERY_TOOL_NAME,
  archiveDataOf,
  archiveOf,
  describeSnapshot,
  queryArchive
} from '../../core/resultArchive'

export interface ResultQueryDeps {
  /** 当前 agent 的完整消息历史（压缩前的那份） */
  getMessages: () => readonly unknown[]
  /** 这一次调用算不算修改类 —— 用工具自己声明的风险，快照说明拿它数「之后动过几次」 */
  isMutating: (toolName: string, args: unknown) => boolean
}

const cell = z.union([z.string(), z.number(), z.boolean()])

const input = z.object({
  ref: z.string().describe('存档编号，如 "r3"'),
  list: z
    .string()
    .optional()
    .describe('存档里有多张表时查哪一张（如 nodes / connections），默认第一张'),
  where: z
    .record(z.string(), z.union([cell, z.array(cell)]))
    .optional()
    .describe('按列等值筛（不分大小写）；值给数组表示任一，如 {"type":["StaticMesh","Texture"]}'),
  search: z.string().optional().describe('在每行所有文字里找这个子串（不分大小写）'),
  search_in: z
    .array(z.string())
    .optional()
    .describe('search 只在这几列里找，如 ["name"]；不给就找整行，路径这类长列容易让短关键词误中'),
  fields: z.array(z.string()).optional().describe('只要哪几列，默认整行'),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional()
})

export function createResultQueryTool(deps: ResultQueryDeps): UnrealAgentTool<unknown> {
  return defineTool({
    name: RESULT_QUERY_TOOL_NAME,
    namespace: 'core',
    risk: 'safe',
    description:
      '查一份被存档的大结果。工具结果太大时只回目录页，带 archived.ref（如 "r3"）；' +
      '要完整的行或目录里没列出的行，用这个按 ref 取。where 按列等值筛，search 找子串，' +
      'search_in 限定 search 找哪几列，fields 挑列，返回带 next_offset 时用 offset 翻页。查的是当时的快照：' +
      '之后改过东西的话返回里会说，要最新状态就重新调用原工具。',
    input,
    execute: async ({ ref, list, where, search, search_in, fields, offset, limit }) => {
      const messages = deps.getMessages()
      // 一遍找到消息；它的下标留给快照说明，免得再从头扫
      const index = messages.findIndex((message) => archiveOf(message)?.ref === ref)
      const record = index >= 0 ? archiveOf(messages[index]) : undefined
      if (!record) {
        const known = messages.map(archiveOf).flatMap((archive) => (archive ? [archive.ref] : []))
        throw new Error(
          `没有编号为 ${ref} 的存档。` +
            (known.length
              ? `这个对话里有：${known.join('、')}。`
              : '这个对话里还没有被存档的结果。') +
            '编号只在产生它的那个对话里有效。'
        )
      }
      const data = archiveDataOf(messages[index])
      if (!data || !record.lists.every((list) => Array.isArray(data[list]))) {
        // 编号在，数据不在了（这条结果的 details 被替换或丢了）—— 别说成「没有这个编号」
        throw new Error(
          `存档 ${ref} 的数据已经不在这条结果上了，查不了。要这份数据请重新调用 ${String(
            (messages[index] as { toolName?: string }).toolName ?? '原工具'
          )}。`
        )
      }

      const snapshot = describeSnapshot(messages, index, deps.isMutating)
      // 快照说明作为 preface 交给 queryArchive，一起算进每页的预算
      const result = queryArchive(
        record,
        data,
        {
          ...(list ? { list } : {}),
          ...(where ? { where } : {}),
          ...(search ? { search } : {}),
          ...(search_in ? { search_in } : {}),
          ...(fields ? { fields } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {})
        },
        snapshot ? { snapshot: snapshot.note } : {}
      )
      return { text: JSON.stringify(result) }
    }
  })
}
