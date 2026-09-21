/**
 * 读一份文档：PDF、Word、PPT、Excel、EPUB 都解析成 Markdown 文本。
 *
 * ## 为什么补这个工具
 *
 * 知识库早就能读这些格式（`sqliteDataBase/ipc/documentLoader`），聊天框拖进去
 * 也能读，唯独 agent 自己拿到一条 PDF 路径时没有入口 —— 只能用
 * `read_local_file`，而那条会把 PDF 的字节按 UTF-8 硬解成乱码。同一台机器上、
 * 同一份文件，换个入口就读不出来，这正是「工具不许比后端窄」那条。
 *
 * 解析器与知识库**共用同一个** `loadDocument`，不另起一套：两边对同一个 PDF
 * 给出不同结果，是用户最没法理解的那种毛病。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { loadDocument } from '../../../sqliteDataBase/ipc/documentLoader'
import { assertPathAllowed } from './pathBoundary'
import { assertInAccessScope } from './accessScope'

const ReadDocumentInput = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      '文档的本地绝对路径，如 "D:/需求/策划案.pdf"。支持 pdf/doc/docx/ppt/pptx/xls/xlsx/odt/rtf/epub'
    )
})

export interface ReadDocumentDetails extends Record<string, unknown> {
  success: boolean
  path: string
  /** 解析出多少字。截断时用户得知道原文有多长 */
  length?: number
}

/**
 * 一次进上下文的上限。
 *
 * 一本 300 页的 PDF 解出来能有几十万字，整份塞进去会把 `requestBudget` 的
 * 3MB 顶穿，而且 pi 每轮重发整条 transcript —— 一次失误会毒死后面每一轮。
 * 截断时明说截了，让模型知道自己只看了开头。
 */
const MAX_CHARS = 60_000

export function createReadDocumentTool(): UnrealAgentTool<ReadDocumentDetails> {
  return defineTool<typeof ReadDocumentInput, ReadDocumentDetails>({
    name: 'read_document',
    namespace: 'local',
    risk: 'safe',
    description: `把一份文档解析成文本读给你听。支持 PDF / Word / PPT / Excel / ODF / RTF / EPUB。

【什么时候用】用户给了一份 PDF 或 Word 的路径、让你看需求文档或策划案、
要从一份表格里取数据。**读这些格式一律用本工具，不要用 \`read_local_file\`** ——
那个会把文档的二进制按文本硬解，你拿到的是乱码。

【读不出来的情况】扫描件 PDF（整页都是图、没有文字层）会明确报错而不是返回空白。
遇到这种就如实告诉用户这是扫描件，需要 OCR，别假装读到了内容。

【很长的文档】超过 ${MAX_CHARS} 字会截断，结果里会说明。需要后半段时告诉用户，
不要反复调用本工具试图凑齐 —— 每次都是从头解析，凑不出来。`,
    input: ReadDocumentInput,
    execute: async (args, ctx) => {
      const target = args.path
      const denied = assertPathAllowed(target) ?? (await assertInAccessScope(target))
      if (denied) return { isError: true, text: denied }

      ctx.report({ text: '正在解析文档…' })
      const loaded = await loadDocument(target)

      if (!loaded.success || !loaded.content) {
        return {
          isError: true,
          text: loaded.error || `解析 ${target} 失败`,
          details: { success: false, path: target }
        }
      }

      const full = loaded.content
      const truncated = full.length > MAX_CHARS
      const body = truncated ? full.slice(0, MAX_CHARS) : full

      return {
        text: [
          `【${target}】`,
          truncated ? `（全文 ${full.length} 字，这里只给了前 ${MAX_CHARS} 字。）` : '',
          '',
          body
        ]
          .filter(Boolean)
          .join('\n'),
        details: { success: true, path: target, length: full.length }
      }
    }
  })
}
