import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildNotebookRagContext, resolveNotebookRagTarget } from './notebookRagContext'

const createPreparedResult = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  mode: 'no_indexed_sources',
  citations: [],
  sourceStates: [],
  warnings: [],
  diagnostics: {
    queryLength: 4,
    selectedSourceCount: 0,
    indexedSourceCount: 0,
    resultCount: 0,
    contextChars: 0,
    elapsedMs: 1
  },
  ...overrides
})

describe('notebookRagContext', () => {
  const chatV2Prepare = vi.fn()
  const ragQueueIndex = vi.fn()

  beforeEach(() => {
    chatV2Prepare.mockReset()
    ragQueueIndex.mockReset()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api?: Record<string, unknown> }).api,
      notebook: {
        chatV2Prepare,
        ragQueueIndex
      }
    }
  })

  it('queues background indexing for Chat V2 sources that are not ready yet', async () => {
    chatV2Prepare.mockResolvedValue(
      createPreparedResult({
        warnings: [
          {
            code: 'no_indexed_sources',
            message: '当前选中的知识库来源还没有可用向量索引，本轮将先按普通对话继续。',
            severity: 'info'
          }
        ],
        sourceStates: [
          {
            sourceId: 'source-1',
            shouldIndex: true
          },
          {
            sourceId: 'source-2',
            shouldIndex: false
          }
        ]
      })
    )
    ragQueueIndex.mockResolvedValue({
      queuedJobs: 1,
      skippedSources: 0,
      queuedSourceIds: ['source-1']
    })

    const result = await buildNotebookRagContext({
      notebookId: 'nb-1',
      query: '材质怎么做'
    })

    expect(ragQueueIndex).toHaveBeenCalledWith({
      notebookId: 'nb-1',
      sourceIds: ['source-1']
    })
    expect(result.queuedIndexSourceIds).toEqual(['source-1'])
    expect(result.warnings?.[0]?.code).toBe('no_indexed_sources')
  })

  it('does not call Chat V2 for empty queries', async () => {
    const result = await buildNotebookRagContext({
      notebookId: 'nb-1',
      query: '   '
    })

    expect(chatV2Prepare).not.toHaveBeenCalled()
    expect(ragQueueIndex).not.toHaveBeenCalled()
    expect(result.citations).toEqual([])
  })

  it('uses explicitly bound notebooks before route fallback', async () => {
    const getNotebook = vi.fn()

    const target = await resolveNotebookRagTarget({
      boundNotebook: {
        notebookId: 'bound-nb',
        title: '绑定知识库'
      },
      routeName: 'NotebookDetail',
      routeNotebookId: 'route-nb',
      getNotebook
    })

    expect(target).toEqual({
      notebookId: 'bound-nb',
      title: '绑定知识库'
    })
    expect(getNotebook).not.toHaveBeenCalled()
  })

  it('does not resolve a RAG target for ordinary chat without a bound notebook', async () => {
    const getNotebook = vi.fn()

    const target = await resolveNotebookRagTarget({
      routeName: 'Assistant',
      routeNotebookId: 'route-nb',
      getNotebook
    })

    expect(target).toBeNull()
    expect(getNotebook).not.toHaveBeenCalled()
  })

  it('falls back to the current NotebookDetail route for Agent RAG', async () => {
    const getNotebook = vi.fn().mockResolvedValue({ title: '当前页面知识库' })

    const target = await resolveNotebookRagTarget({
      routeName: 'NotebookDetail',
      routeNotebookId: 'route-nb',
      getNotebook
    })

    expect(getNotebook).toHaveBeenCalledWith('route-nb')
    expect(target).toEqual({
      notebookId: 'route-nb',
      title: '当前页面知识库'
    })
  })
})
