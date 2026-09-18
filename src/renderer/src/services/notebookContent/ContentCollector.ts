/**
 * 内容收集器
 * 从知识库来源和聊天历史中收集内容
 *
 * 送什么进模型由每条来源的**上下文档位**决定（全文 / 只给摘要 / 不进上下文），
 * 换算规则集中在 `@core/shared/notebookContext`，界面上的预算计量条算的是同一份账 ——
 * 两边各算各的，用户就会看到「说好送 3 万字，产出却像只读了一半」。
 */

import type { ContentItem } from './types'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import { resolveContextContent } from '@core/shared/notebookContext'

/**
 * 内容收集统计信息
 */
export interface CollectionStats {
  /** 总来源数 */
  totalSources: number
  /** 有效来源数（真的送进去的） */
  validSources: number
  /** 使用摘要的来源数 */
  usedSummaryCount: number
  /** 被截断的来源数 */
  truncatedCount: number
  /** 选了摘要但摘要还没生成、退回正文开头的来源数 */
  summaryMissingCount: number
  /** 原始总字符数 */
  originalTotalLength: number
  /** 处理后总字符数 */
  processedTotalLength: number
}

/**
 * 从知识库来源收集内容
 * @param sources 知识库来源列表
 * @returns 格式化后的内容项列表
 */
export function collectFromSources(sources: SourceItem[]): ContentItem[] {
  const items: ContentItem[] = []
  const stats: CollectionStats = {
    totalSources: sources.length,
    validSources: 0,
    usedSummaryCount: 0,
    truncatedCount: 0,
    summaryMissingCount: 0,
    originalTotalLength: 0,
    processedTotalLength: 0
  }

  for (const source of sources) {
    // 不进上下文、还在加载、加载失败、空内容 —— 都轮不到它
    const resolved = resolveContextContent(source)
    if (!resolved) continue

    stats.validSources++
    stats.originalTotalLength += source.content.length
    stats.processedTotalLength += resolved.text.length
    if (resolved.usedSummary) stats.usedSummaryCount++
    if (resolved.truncated) stats.truncatedCount++
    if (resolved.summaryMissing) stats.summaryMissingCount++

    // 用户笔记优先级最高，其他来源为中优先级
    const priority = source.type === 'text' ? 'high' : 'medium'

    // 截断的话在正文末尾说一句，否则模型会把半句话当成作者写完了
    const content = resolved.truncated
      ? `${resolved.text}\n\n[⚠️ 内容已截断，原文共 ${source.content.length} 字]`
      : resolved.text

    items.push({
      id: `source-${source.id}`,
      source: 'knowledge',
      type: source.type,
      content,
      title: source.title,
      timestamp: parseInt(source.id) || Date.now(),
      priority
    })
  }

  console.log(
    `[ContentCollector] 📊 收集完成: ` +
      `${stats.validSources}/${stats.totalSources} 个来源进上下文, ` +
      `${stats.usedSummaryCount} 个用摘要, ` +
      `${stats.summaryMissingCount} 个摘要缺失退回正文开头, ` +
      `${stats.truncatedCount} 个被截断, ` +
      `原始 ${formatBytes(stats.originalTotalLength)} → 处理后 ${formatBytes(stats.processedTotalLength)}`
  )

  return items
}

/**
 * 格式化字节数为可读字符串
 */
function formatBytes(chars: number): string {
  if (chars < 1000) return `${chars}字`
  if (chars < 10000) return `${(chars / 1000).toFixed(1)}K字`
  return `${Math.round(chars / 1000)}K字`
}

/**
 * 从聊天历史收集内容
 * @param messages 聊天消息列表
 * @returns 格式化后的内容项列表
 */
export function collectFromMessages(messages: ChatMessage[]): ContentItem[] {
  const items: ContentItem[] = []

  for (const msg of messages) {
    // 跳过正在输入的消息
    if (msg.status === 'typing') {
      continue
    }

    // 提取文本内容
    let textContent = ''
    if (typeof msg.content === 'string') {
      textContent = msg.content
    } else if (Array.isArray(msg.content)) {
      // 多模态消息：只提取文本部分
      textContent = msg.content
        .filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text)
        .join('\n')
    }

    if (!textContent.trim()) {
      continue
    }

    // 从消息ID提取时间戳
    const match = msg.id.match(/^(\d+)-/)
    const timestamp = match ? parseInt(match[1]) : Date.now()

    // 用户消息为中优先级，助手消息为低优先级
    const priority = msg.role === 'user' ? 'medium' : 'low'

    items.push({
      id: `msg-${msg.id}`,
      source: 'chat',
      type: 'message',
      content: textContent,
      role: msg.role,
      timestamp,
      priority
    })
  }

  return items
}

/**
 * 收集所有内容
 * @param sources 知识库来源
 * @param messages 聊天消息
 * @returns 合并后的内容项列表
 */
export function collectAllContent(sources: SourceItem[], messages: ChatMessage[]): ContentItem[] {
  const sourceItems = collectFromSources(sources)
  const messageItems = collectFromMessages(messages)

  // 优先级权重映射
  const priorityWeight = { high: 3, medium: 2, low: 1 }

  // 合并后先按优先级排序，同优先级再按时间戳排序（新的在前）
  return [...sourceItems, ...messageItems].sort((a, b) => {
    const aPriority = priorityWeight[a.priority || 'medium']
    const bPriority = priorityWeight[b.priority || 'medium']
    if (bPriority !== aPriority) {
      return bPriority - aPriority
    }
    return (b.timestamp || 0) - (a.timestamp || 0)
  })
}

/**
 * 计算内容总字符数
 * @param items 内容项列表
 * @returns 总字符数
 */
export function calculateTotalLength(items: ContentItem[]): number {
  return items.reduce((sum, item) => sum + item.content.length, 0)
}
