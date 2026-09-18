import { z } from 'zod'

import { getPublicDatabase } from '../../../sqliteDataBase'
import { searchNotebookRag } from '../../../sqliteDataBase/services/notebookRagService'
import { defineTool, type UnrealAgentTool } from '../defineTool'

/**
 * 在当前知识库的来源里做语义检索。
 *
 * ## 为什么要有这个工具
 *
 * 知识库问答以前走的是一条**一问一答**的路：渲染层先替模型检索一遍，把命中的
 * 片段拼进提示词，再发一次普通对话请求。那条路有两个硬伤：
 *
 * - **只检索一次，而且是在模型开口之前。** 检索用的是用户的原话，模型看完
 *   资料想再查一个词、换个说法找找，没有任何办法 —— 它只能拿着那一把片段硬答。
 * - 模型手里没有别的工具，读不了文件、写不了笔记，只能聊天。
 *
 * 现在知识库问答跑的是 Agent，检索变成它自己能调的工具：先查、看完不够再查，
 * 顺带还能把结论写进笔记。
 *
 * ## 为什么不让模型指定知识库
 *
 * `notebookId` 从会话上下文来，不进参数表。用户是在某个知识库的页面里提问的，
 * 「查哪个库」这件事没有歧义；开成参数只会多一种模型填错 id 的失败方式，
 * 而它填错时的表现是「查无此库」——用户看着自己的知识库明明在那儿。
 */

/** 一次最多回多少片段。再多就开始挤占上下文，而前几条通常已经够答 */
const MAX_CHUNKS = 8
/** 单个片段截断长度。整段几千字的 PDF 片段会把上下文吃干 */
const MAX_CHUNK_CHARS = 1200

const searchInput = z.object({
  query: z
    .string()
    .describe(
      '检索词。关键词和自然语言都行：底层是关键词全文检索 + 语义检索两路融合，' +
        '专有名词、文件名、代码标识符这类精确词靠关键词命中，描述性的问题靠语义'
    ),
  limit: z.number().optional().describe(`最多返回几段，默认 ${MAX_CHUNKS}`)
})

/** 一段命中，压成模型读得懂、又不至于吃满上下文的形状 */
interface SourceHit {
  /** 来源标题（文件名 / 网页标题），模型引用时说得出「出自哪一份」 */
  source: string
  /** 片段正文，超长截断 */
  content: string
  /** 语义距离，越小越贴题。只按关键词命中的片段没有这个值 */
  distance: number | null
  /** 哪路命中的：两路都中的最可信 */
  matchedBy: 'semantic' | 'keyword' | 'both'
}

function truncate(text: string): string {
  const normalized = String(text || '').trim()
  return normalized.length > MAX_CHUNK_CHARS
    ? `${normalized.slice(0, MAX_CHUNK_CHARS)}…（片段已截断）`
    : normalized
}

/**
 * 建这个工具需要知道**查哪个知识库**，所以由 registry 在会话带着知识库时才注册。
 * 没绑知识库的会话根本不该看到它 —— 看到了也只能拿到一句「没有知识库」。
 */
export function createSearchNotebookSourcesTool(notebook: {
  id: string
  title?: string
}): UnrealAgentTool<SourceHit[]> {
  const where = notebook.title ? `知识库「${notebook.title}」` : '当前知识库'
  return defineTool({
    name: 'search_notebook_sources',
    namespace: 'notebook',
    risk: 'safe',
    description:
      `在${where}的来源资料里检索，拿回最相关的片段。\n\n` +
      '【什么时候用】用户在知识库里问问题时**先用它查一遍**，别凭记忆答 —— ' +
      '知识库里装的是用户自己传的资料，模型没见过。\n' +
      '一轮不够就换个说法再查：第一次用用户的原话，看完片段之后往往能想到更准的词。\n\n' +
      '【返回】每段带来源标题、命中方式（关键词 / 语义 / 两路都中）与语义距离（越小越贴题，' +
      '只按关键词命中的没有）。答完记得说清楚结论出自哪一份资料。',
    input: searchInput,
    async execute(input) {
      const limit = Math.min(Math.max(1, Math.floor(input.limit ?? MAX_CHUNKS)), MAX_CHUNKS)
      const hits = await searchNotebookRag(getPublicDatabase(), notebook.id, input.query, { limit })

      if (hits.length === 0) {
        return {
          // 空结果不是错误，但要说清楚下一步能干什么，否则模型会原样再查一遍
          text:
            `${where}里没有检索到与「${input.query}」相关的内容。\n` +
            '可能是资料里确实没有，也可能是这批来源还没建索引。换个说法或换几个关键词再试一次，' +
            '仍然没有就如实告诉用户，别自己编。'
        }
      }

      const results: SourceHit[] = hits.map((hit) => ({
        source: hit.sourceTitle || hit.fileName || hit.sourceUrl || '未命名来源',
        content: truncate(hit.content),
        distance: hit.distance === null ? null : Number(hit.distance.toFixed(4)),
        matchedBy: hit.matchedBy ?? 'semantic'
      }))

      return {
        text: results
          .map((hit, index) => `【片段 ${index + 1}｜${hit.source}】\n${hit.content}`)
          .join('\n\n'),
        details: results
      }
    }
  })
}
