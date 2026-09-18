/**
 * 把工作台产出转成一段 markdown，好让它能存回知识库当来源。
 *
 * ## 为什么要能存回去
 *
 * 六种产出以前是**死路**：生成完躺在工作台里，检索不到、也进不了下一次生成的上下文。
 * AI 上周替用户写的那份分析报告，这周在同一个知识库里问它，它想不起来 ——
 * 因为那份报告根本不在来源里。
 *
 * 存回去之后它就是一条普通来源：会被向量化、会被 `search_notebook_sources` 检索到、
 * 也能自己选档位。
 */

import type { StudioOutput } from '@renderer/store/modules/studioOutputStore'
import type { KnowledgeGraphData } from '@renderer/services/knowledgeGraph/types'
import type { BrainstormSession } from '@renderer/services/brainstorm/types'

/** 思维导图的节点形状。这里只用到文字和孩子，不引 simple-mind-map 的完整类型 */
interface MindmapNodeLike {
  data?: { text?: string }
  children?: MindmapNodeLike[]
}

/** 转换结果 */
export interface StudioOutputMarkdown {
  title: string
  markdown: string
}

/** 把思维导图递归成缩进列表 —— 存进来源里就是一份大纲 */
function mindmapToMarkdown(node: MindmapNodeLike, depth = 0): string[] {
  const text = node.data?.text?.trim()
  const lines: string[] = []
  if (text) lines.push(`${'  '.repeat(depth)}- ${text}`)
  for (const child of node.children ?? []) {
    lines.push(...mindmapToMarkdown(child, text ? depth + 1 : depth))
  }
  return lines
}

function knowledgeGraphToMarkdown(graph: KnowledgeGraphData): string {
  const nodeLabels = new Map(graph.nodes.map((node) => [node.id, node.label]))

  const entities = graph.nodes.map((node) =>
    node.description
      ? `- **${node.label}**（${node.category}）：${node.description}`
      : `- **${node.label}**（${node.category}）`
  )

  // 关系用 id 存，存进来源要换回名字 —— 来源里躺着一堆 n1/n2 谁也检索不到
  const relations = graph.edges.map((edge) => {
    const from = nodeLabels.get(edge.source) ?? edge.source
    const to = nodeLabels.get(edge.target) ?? edge.target
    return `- ${from} —[${edge.relation}]→ ${to}`
  })

  return [`## 实体`, ...entities, '', `## 关系`, ...relations].join('\n')
}

function brainstormToMarkdown(session: BrainstormSession): string {
  const blocks = session.ideas.map((idea) => {
    const lines = [`### ${idea.title}`, idea.description]
    if (idea.reasoning) lines.push(`> 依据：${idea.reasoning}`)
    if (idea.expandedDetail) lines.push(idea.expandedDetail)
    return lines.join('\n\n')
  })

  return [session.topicSummary, '', ...blocks].join('\n')
}

function interviewToMarkdown(config: NonNullable<StudioOutput['interviewConfig']>): string {
  const knowledge = config.knowledgePoints.map((point) => `- **${point.title}**：${point.content}`)

  const questions = config.questions.map((question, index) => {
    const lines = [`### ${index + 1}. ${question.question}`]
    if (question.options?.length) {
      lines.push(question.options.map((option) => `- ${option.id}. ${option.text}`).join('\n'))
    }
    if (question.correctAnswer) lines.push(`**答案**：${question.correctAnswer}`)
    if (question.explanation) lines.push(`**解析**：${question.explanation}`)
    return lines.join('\n\n')
  })

  const parts: string[] = []
  if (knowledge.length) parts.push('## 考察知识点', knowledge.join('\n'), '')
  parts.push('## 题目', ...questions)
  return parts.join('\n')
}

/**
 * 从生成的网页里抠出可读文字。
 *
 * 存 HTML 原文没意义：检索时命中的会是 `<div class=...>` 这种噪音，
 * 而且几万字的样式表会把上下文预算吃干。这里靠 DOMParser 取 textContent ——
 * 渲染进程里本来就有一个浏览器，不用再引一个 HTML 解析库。
 */
function webpageToMarkdown(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('script, style').forEach((element) => element.remove())
    return (doc.body?.textContent ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
  } catch (error) {
    console.warn('[studioOutputToMarkdown] 网页解析失败，退回原始 HTML:', error)
    return html
  }
}

/**
 * 把一份产出转成能当来源存的 markdown。
 *
 * 还没生成完、或者这种产出压根没有文字（信息图是一张图、视频概览没做），
 * 返回 null —— 调用方据此把「存为来源」这个入口藏掉，而不是存一条空来源进去。
 */
export function studioOutputToMarkdown(output: StudioOutput): StudioOutputMarkdown | null {
  const title = output.title?.trim() || '未命名产出'

  switch (output.type) {
    case 'report':
      return output.reportContent?.trim() ? { title, markdown: output.reportContent.trim() } : null

    case 'mindmap': {
      if (!output.mindmapData) return null
      const lines = mindmapToMarkdown(output.mindmapData as MindmapNodeLike)
      return lines.length > 0 ? { title, markdown: lines.join('\n') } : null
    }

    case 'knowledgeGraph': {
      const graph = output.knowledgeGraphData
      if (!graph?.nodes?.length) return null
      return { title, markdown: knowledgeGraphToMarkdown(graph) }
    }

    case 'interview': {
      const config = output.interviewConfig
      if (!config?.questions?.length) return null
      return { title, markdown: interviewToMarkdown(config) }
    }

    case 'brainstorm': {
      const session = output.brainstormData
      if (!session?.ideas?.length) return null
      return { title, markdown: brainstormToMarkdown(session) }
    }

    case 'webpage': {
      if (!output.webpageHtml) return null
      const text = webpageToMarkdown(output.webpageHtml)
      return text.trim() ? { title, markdown: text } : null
    }

    // 信息图是一张图片，视频概览还没做 —— 都没有可检索的正文
    case 'infographic':
    case 'video':
    default:
      return null
  }
}

/** 这份产出能不能存成来源。界面靠它决定要不要显示「存为来源」 */
export function canSaveOutputAsSource(output: StudioOutput): boolean {
  return studioOutputToMarkdown(output) !== null
}
