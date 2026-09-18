/** 知识库产出通过主进程调用用户配置的模型，在本地管理进度、取消和文件保存。 */

import { aiAPI } from '@renderer/api/ai'
import i18n, { getLocale } from '@renderer/i18n'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import {
  FALLBACK_CONTEXT_CHAR_BUDGET,
  packSourcesWithinBudget,
  resolveContextContent
} from '@core/shared/notebookContext'
import { resolveOutputTokens } from './contextBudget'
import { getPrompt } from './taskPrompts'

/** 支持的产出类型 */
export type NotebookTaskType =
  | 'mindmap'
  | 'report'
  | 'knowledgeGraph'
  | 'interview'
  | 'webpage'
  | 'brainstorm'

/** 一条来源。id 会带进提示词，面试题要靠它标注出处 */
export interface TaskSource {
  id: string
  title?: string
  content: string
}

/** 一条对话记录 */
export interface TaskMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface MindmapResult {
  /** 缩进式 markdown 列表，由 MindmapService 解析成树 */
  markdown: string
}

export interface ReportResult {
  content: string
  title: string
}

export interface KnowledgeGraphResult {
  nodes: Array<{ id: string; label: string; type?: string }>
  edges: Array<{ source: string; target: string; label?: string }>
}

export interface InterviewResult {
  title?: string
  knowledgePoints?: Array<{
    id: string
    title: string
    content: string
    type?: string
  }>
  questions: Array<{
    id: string
    question: string
    questionType?: string
    options?: Array<{ id: string; text: string }>
    correctAnswer?: string
    hint?: string
    explanation?: string
    sourceId?: string
    sourceTitle?: string
  }>
}

export interface WebpageResult {
  htmlContent: string
  title: string
}

export interface BrainstormResult {
  topicSummary?: string
  ideas: Array<{
    id: string | number
    title: string
    description: string
    category?: string
    priority?: string
    reasoning?: string
  }>
}

/** 一次生成的输入 */
export interface TaskInput {
  sources: TaskSource[]
  messages: TaskMessage[]
  options: Record<string, unknown>
}

/** 配方能用的两件事：知道什么时候该停、把进度报出去 */
export interface TaskRunContext {
  signal: AbortSignal
  /** 汇报进度（0-100） */
  report: (progress: number) => void
}

export type TaskRunner<T> = (input: TaskInput, ctx: TaskRunContext) => Promise<T>

/** 对话记录最多带多少字。它是背景，不该把来源正文挤出去 */
const MAX_TRANSCRIPT_CHARS = 4000

/**
 * 把知识库来源按各自的上下文档位换算成喂给模型的形状。
 *
 * 六个产出 Service 以前各写一份「优先用摘要 + 硬截断」，其中两份根本没写 ——
 * 同一批来源在思维导图里被压过、在知识图谱里是全文。现在统一从这里出。
 *
 * 不进上下文、内容没就绪的来源直接不在返回值里，调用方拿到的就是这次真会送出去的那些。
 */
export function toTaskSources(sources: readonly SourceItem[]): TaskSource[] {
  const taskSources: TaskSource[] = []

  for (const source of sources) {
    const resolved = resolveContextContent(source)
    if (!resolved) continue
    taskSources.push({
      id: source.id || String(Date.now()),
      title: source.title || '',
      content: resolved.text
    })
  }

  return taskSources
}

/**
 * 这次产出用什么语言写。
 *
 * 调用方显式给了 `language` 就听它的（报告、图谱、网页三处会传），
 * 没给就跟界面语言走。
 */
function outputLanguage(input: TaskInput): string {
  const explicit = String(input.options.language || '')
  const source = explicit || getLocale()
  return source.toLowerCase().startsWith('zh') ? '中文' : 'English'
}

/** 知识库标题。没有就给个中性的说法，别在提示词里留一个 undefined */
function notebookTitle(input: TaskInput): string {
  return String(input.options.notebookTitle || '未命名知识库')
}

/**
 * 把来源与对话整理成一段喂给模型的文本。
 *
 * 带上来源 id 与标题：面试题要标注出处，图谱要能把实体归到具体来源上。
 */
export function buildContentDigest(input: TaskInput): string {
  // 预算由 executeTask 按当前模型的窗口算好放进 options —— 和界面上那条计量条
  // 是同一个数。拿不到时回落到保守缺省值，少送一点总好过撑爆窗口
  const charBudget =
    typeof input.options.charBudget === 'number'
      ? input.options.charBudget
      : FALLBACK_CONTEXT_CHAR_BUDGET

  const usable = input.sources.filter((source) => source.content?.trim())
  const { included, dropped } = packSourcesWithinBudget(usable, charBudget)

  if (dropped.length > 0) {
    // 这里只剩兜底：界面在点生成之前就应该用同一份账把超额告诉用户了
    console.warn(
      `[notebookTask] 内容超出 ${charBudget} 字上限，${dropped.length} 条来源未送入模型：` +
        dropped.map((source) => source.title || source.id).join('、')
    )
  }

  const blocks = included.map(
    (source) =>
      `## ${source.title?.trim() || '未命名来源'}（来源 id：${source.id}）\n${source.content}`
  )

  const transcript = input.messages
    .filter((m) => m.content?.trim())
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.trim()}`)
    .join('\n')
    .slice(0, MAX_TRANSCRIPT_CHARS)

  if (transcript) blocks.push(`## 用户与助手的对话记录\n${transcript}`)

  /*
    什么材料都没有 —— 必须在这里停住。

    装箱是「装不下的整条丢掉」，所以每条来源都比预算大时 `included` 会是空的。
    再往下走，提示词就成了「以下材料……」后面什么都没有，模型会**凭标题编一整份**
    报告／导图出来，而用户完全看不出这份东西跟他的资料没有半点关系 ——
    这比报错严重得多。

    判的是 `blocks`（来源 + 对话）而不是只判来源：来源全超预算、但有对话记录时，
    那段对话本身就是能用的材料，照着它生成是合理的，不该硬失败。

    这里不改成「截半条塞进去」：那是上面刻意否掉的做法（残句会被模型当成写完了）。
    宁可明说装不下，用户换个窗口大的模型、或者把这条来源拆开，都是他能做的动作。
  */
  if (blocks.length === 0 && usable.length > 0) {
    throw new Error(
      i18n.global.t('notebook.studio.sourcesOverBudget', { budget: charBudget }) as string
    )
  }

  return blocks.join('\n\n---\n\n')
}

interface ChatStep {
  system?: string
  user: string
  /** 要 JSON 就置 true，会同时开厂商的结构化输出并按 JSON 解析 */
  json?: boolean
  maxTokens: number
  /** 这一步在整体进度里占的区间 */
  from: number
  to: number
  callType: string
}

/**
 * 发一次模型调用，把进度按**已收到的字数**推上去。
 *
 * 模型不会告诉你「还差百分之几」，所以百分比只能估。这里估的分母是 maxTokens
 * （中文约一字一 token），分子是真的已经收到的字数 —— 估得不准的部分表现为
 * 进度条走到某个位置停住，而不是一个凭空跳动的假动画。
 */
async function runStep(ctx: TaskRunContext, step: ChatStep): Promise<string> {
  // 发请求之前先看一眼有没有被取消。配方在这之前要读一次自定义提示词（走 IPC），
  // 用户完全可能在那几十毫秒里点了取消 —— 不查的话这一步照样会发出去，
  // 钱花了、然后结果被丢掉。
  if (ctx.signal.aborted) throw new Error('已取消')

  ctx.report(step.from)

  /*
    把配方想写的长度钳进这个模型真正接受的范围。

    各配方写的是 4000～12000 这样的固定值，而不少模型的单次输出上限只有 4096
    （Claude Haiku、一批 Qwen/DeepSeek/本地模型都是）。不钳就是一次 400，
    整个产出在发出去的瞬间就死了。主进程也不钳，原样往下传。
  */
  const maxTokens = await resolveOutputTokens(step.maxTokens)

  const text = await aiAPI.chatText({
    messages: [
      ...(step.system ? ([{ role: 'system', content: step.system }] as const) : []),
      { role: 'user', content: step.user }
    ],
    level: 'medium',
    maxTokens,
    callType: step.callType,
    ...(step.json ? { responseFormat: { type: 'json_object' as const } } : {}),
    signal: ctx.signal,
    onDelta: (_delta, all) => {
      const ratio = Math.min(1, all.length / step.maxTokens)
      ctx.report(step.from + (step.to - step.from) * ratio)
    }
  })

  ctx.report(step.to)
  const trimmed = text.trim()
  if (!trimmed) throw new Error('模型没有返回内容')
  return trimmed
}

/**
 * 把模型的回答解成对象。
 *
 * 开了结构化输出也不能假定拿到的一定是干净 JSON：不是每家都支持
 * `response_format`，不支持的那几家会照着提示词返回，外面常常裹一层
 * ```json 代码块，或者前面先寒暄一句。
 */
export function parseJsonObject<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const body = (fenced ? fenced[1] : text).trim()

  try {
    return JSON.parse(body) as T
  } catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1)) as T
      } catch {
        /* 落到下面统一报错 */
      }
    }
    throw new Error('模型返回的不是合法 JSON，请换一个更强的模型再试')
  }
}

/** 从 markdown 正文里取标题：第一个一级标题，没有就退回知识库名 */
function extractTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)
  return heading ? heading[1].trim() : fallback
}

/** 模型爱把 HTML 裹进代码块，或者在前面写一句「好的，这是……」 */
function extractHtml(text: string): string {
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)\s*```/i)
  let html = (fenced ? fenced[1] : text).trim()

  const doctype = html.indexOf('<!DOCTYPE html')
  const htmlTag = html.indexOf('<html')
  if (doctype !== -1) html = html.slice(doctype)
  else if (htmlTag !== -1) html = html.slice(htmlTag)

  const end = html.lastIndexOf('</html>')
  if (end !== -1) html = html.slice(0, end + '</html>'.length)

  return html.trim()
}

/**
 * 六类产出各自的做法。
 *
 * 大部分是「一段提示词 + 一次调用 + 一次解析」；网页是两段（先把材料读成设计
 * Brief，再让模型照 Brief 排版）—— 把三万字原文直接丢给排版这一步，模型会忙着
 * 复述内容而不是设计版面。
 */
export const NOTEBOOK_TASK_RUNNERS: {
  mindmap: TaskRunner<MindmapResult>
  report: TaskRunner<ReportResult>
  knowledgeGraph: TaskRunner<KnowledgeGraphResult>
  interview: TaskRunner<InterviewResult>
  webpage: TaskRunner<WebpageResult>
  brainstorm: TaskRunner<BrainstormResult>
} = {
  async mindmap(input, ctx) {
    const markdown = await runStep(ctx, {
      system: `${await getPrompt('mindmap')}\n\n所有节点文字一律用${outputLanguage(input)}书写。`,
      user: `知识库《${notebookTitle(input)}》的材料如下，请整理成思维导图：\n\n${buildContentDigest(input)}`,
      maxTokens: 4000,
      from: 10,
      to: 95,
      callType: 'notebook-mindmap'
    })

    // 模型偶尔还是会裹一层代码块，去掉再交给 MindmapService 解析缩进
    return {
      markdown: markdown
        .replace(/^```(?:markdown)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim()
    }
  },

  async report(input, ctx) {
    const content = await runStep(ctx, {
      system: `${await getPrompt('report')}\n\n全文一律用${outputLanguage(input)}书写。`,
      user: `请基于知识库《${notebookTitle(input)}》的以下材料写一份报告：\n\n${buildContentDigest(input)}`,
      maxTokens: 8000,
      from: 10,
      to: 95,
      callType: 'notebook-report'
    })

    return { content, title: extractTitle(content, notebookTitle(input)) }
  },

  async knowledgeGraph(input, ctx) {
    const text = await runStep(ctx, {
      system: `${await getPrompt('knowledgeGraph')}\n\n实体名称一律用${outputLanguage(input)}书写（type 与 label 保持英文枚举值）。`,
      user: `请从知识库《${notebookTitle(input)}》的以下材料中抽取知识图谱：\n\n${buildContentDigest(input)}`,
      json: true,
      maxTokens: 6000,
      from: 10,
      to: 95,
      callType: 'notebook-knowledge-graph'
    })

    const parsed = parseJsonObject<Partial<KnowledgeGraphResult>>(text)
    return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] }
  },

  async interview(input, ctx) {
    const text = await runStep(ctx, {
      system: `${await getPrompt('interview')}\n\n题目与解析一律用${outputLanguage(input)}书写。`,
      user: `请分析以下知识库内容，生成面试配置：\n\n${buildContentDigest(input)}`,
      json: true,
      maxTokens: 8000,
      from: 10,
      to: 95,
      callType: 'notebook-mock-interview'
    })

    const parsed = parseJsonObject<Partial<InterviewResult>>(text)
    return {
      ...(parsed.title ? { title: parsed.title } : {}),
      knowledgePoints: parsed.knowledgePoints ?? [],
      questions: parsed.questions ?? []
    }
  },

  async brainstorm(input, ctx) {
    const text = await runStep(ctx, {
      system: `${await getPrompt('brainstorm')}\n\n所有文字一律用${outputLanguage(input)}书写（category 保持英文枚举值）。`,
      user: `请基于知识库《${notebookTitle(input)}》的以下材料做一次头脑风暴：\n\n${buildContentDigest(input)}`,
      json: true,
      maxTokens: 5000,
      from: 10,
      to: 95,
      callType: 'notebook-brainstorm'
    })

    const parsed = parseJsonObject<Partial<BrainstormResult>>(text)
    return {
      ...(parsed.topicSummary ? { topicSummary: parsed.topicSummary } : {}),
      ideas: parsed.ideas ?? []
    }
  },

  async webpage(input, ctx) {
    const language = outputLanguage(input)

    const brief = await runStep(ctx, {
      system: `${await getPrompt('webpage.analyze')}\n\n所有文字一律用${language}书写。`,
      user: `材料如下：\n\n${buildContentDigest(input)}`,
      json: true,
      maxTokens: 6000,
      from: 5,
      to: 40,
      callType: 'notebook-webpage'
    })

    const html = await runStep(ctx, {
      system: `${await getPrompt('webpage.html')}\n\n页面上的文字一律用${language}书写。`,
      user: `设计 Brief：\n\n${brief}`,
      maxTokens: 12000,
      from: 40,
      to: 95,
      callType: 'notebook-webpage'
    })

    const htmlContent = extractHtml(html)
    if (!htmlContent.includes('<html')) throw new Error('模型没有返回可用的网页代码')

    // Brief 里的 title 就是这个页面的标题，解析失败也不该让整次生成白跑
    let title = notebookTitle(input)
    try {
      title = String(parseJsonObject<{ title?: string }>(brief).title || title)
    } catch {
      console.warn('[notebookTask] 网页 Brief 解析失败，标题回落到知识库名')
    }

    return { htmlContent, title }
  }
}
