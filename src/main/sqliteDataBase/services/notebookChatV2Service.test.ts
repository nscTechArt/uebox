import { describe, expect, it } from 'vitest'
import {
  buildNotebookChatV2ContextMessage,
  classifyNotebookChatV2Source,
  type NotebookChatV2Citation
} from './notebookChatV2Service'

const baseSource = {
  sourceId: 'source-1',
  title: '测试来源',
  type: 'text',
  loading: 0,
  contextLevel: 'full',
  indexStatus: 'indexed',
  indexError: null,
  indexedAt: '2026-04-30T10:00:00.000Z',
  updatedAt: '2026-04-30T10:00:00.000Z',
  contentHash: 'hash-1',
  contentRevision: 1,
  indexedContentHash: 'hash-1',
  indexedRevision: 1,
  contentLength: 100,
  chunkCount: 2
}

describe('notebookChatV2Service source readiness', () => {
  it('uses only fresh indexed sources for search', () => {
    const state = classifyNotebookChatV2Source(baseSource)

    expect(state.indexFreshness).toBe('indexed')
    expect(state.canSearch).toBe(true)
    expect(state.vectorReady).toBe(true)
    expect(state.shouldIndex).toBe(false)
  })

  it('marks stale indexed sources for background re-index instead of search', () => {
    const state = classifyNotebookChatV2Source({
      ...baseSource,
      contentHash: 'hash-2',
      contentRevision: 2
    })

    expect(state.indexFreshness).toBe('stale')
    expect(state.canSearch).toBe(false)
    expect(state.shouldIndex).toBe(true)
  })

  it('marks migrated indexed sources without fingerprints for background re-index', () => {
    const state = classifyNotebookChatV2Source({
      ...baseSource,
      contentHash: null,
      indexedContentHash: null,
      indexedRevision: null
    })

    expect(state.indexFreshness).toBe('stale')
    expect(state.canSearch).toBe(false)
    expect(state.shouldIndex).toBe(true)
  })

  it('仅关键词的来源能检索、不再排队，但向量未就绪', () => {
    const state = classifyNotebookChatV2Source({ ...baseSource, indexStatus: 'keyword' })

    expect(state.indexFreshness).toBe('keyword')
    expect(state.canSearch).toBe(true)
    expect(state.vectorReady).toBe(false)
    // 向量缺是因为模型不可用，反复排队只会反复失败
    expect(state.shouldIndex).toBe(false)
  })

  it('仅关键词但内容已更新的来源按过期处理', () => {
    const state = classifyNotebookChatV2Source({
      ...baseSource,
      indexStatus: 'keyword',
      contentHash: 'hash-2',
      contentRevision: 2
    })

    expect(state.indexFreshness).toBe('stale')
    expect(state.canSearch).toBe(false)
    expect(state.shouldIndex).toBe(true)
  })

  /**
   * 向量化中途失败时后台队列会把状态改回 pending 重试。片段和全文索引都还在，
   * 关键词那一路照常能答 —— 能不能检索看片段，不看状态。
   */
  it('状态被队列改回 pending 但片段仍是当前内容的来源，依旧可检索', () => {
    const state = classifyNotebookChatV2Source({ ...baseSource, indexStatus: 'pending' })

    expect(state.indexFreshness).toBe('pending')
    expect(state.canSearch).toBe(true)
    expect(state.vectorReady).toBe(false)
    expect(state.shouldIndex).toBe(true)
  })

  it('keeps loading and empty sources out of background indexing', () => {
    const loading = classifyNotebookChatV2Source({ ...baseSource, loading: 1 })
    const empty = classifyNotebookChatV2Source({ ...baseSource, contentLength: 0 })

    expect(loading.canSearch).toBe(false)
    expect(loading.shouldIndex).toBe(false)
    expect(empty.canSearch).toBe(false)
    expect(empty.shouldIndex).toBe(false)
  })
})

describe('notebookChatV2Service context message', () => {
  const citation = (id: string, title: string, content: string): NotebookChatV2Citation => ({
    id,
    title,
    sourceId: `source-${id}`,
    content,
    type: 'text'
  })

  it('唯一那条自己就超预算时截到预算内，并明说截了', () => {
    const message = buildNotebookChatV2ContextMessage([citation('1', '长文档', 'A'.repeat(2000))], {
      notebookTitle: '工程知识库',
      maxChars: 1000
    })

    expect(message?.content).toContain('相关知识库上下文 - 工程知识库')
    expect(message?.content).toContain('已截断')
    expect(message?.content).toContain('引用时请在句尾使用 [x]')
    // 真的截到预算内了，而不是原样塞进去
    expect(message?.content.length).toBeLessThan(1300)
  })

  it('超长时按引用整条丢，不从句子中间切断', () => {
    const message = buildNotebookChatV2ContextMessage(
      [citation('1', '甲', 'A'.repeat(600)), citation('2', '乙', 'B'.repeat(600))],
      { maxChars: 1000 }
    )

    // 第一条完整进去
    expect(message?.content).toContain('A'.repeat(600))
    // 第二条整条不进，而不是留半句挂在 `[2] 来源：乙` 后面
    expect(message?.content).not.toContain('B')
    expect(message?.content).toContain('[1] 来源：甲')
    expect(message?.content).not.toContain('[2] 来源：乙')
    expect(message?.content).toContain('还有 1 条')
  })

  it('都装得下时一条不丢，也不加截断说明', () => {
    const message = buildNotebookChatV2ContextMessage(
      [citation('1', '甲', '短内容'), citation('2', '乙', '也很短')],
      { maxChars: 5000 }
    )

    expect(message?.content).toContain('[1] 来源：甲')
    expect(message?.content).toContain('[2] 来源：乙')
    expect(message?.content).not.toContain('未列出')
  })

  it('没有引用时不产生上下文消息', () => {
    expect(buildNotebookChatV2ContextMessage([])).toBeUndefined()
  })
})
