import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNotebookStore, type SourceItem } from './notebookStore'

/** 某个 tab 展示的来源：store 只按笔记本提供，tab 打开的是哪个笔记本由它的界面状态决定 */
function tabSources(store: ReturnType<typeof useNotebookStore>, tabId: string): SourceItem[] {
  const notebookId = store.getActiveNotebookIdForTab(tabId)
  return notebookId ? store.sourcesOf(notebookId) : []
}

describe('notebookStore tab isolation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('keeps notebook ui state isolated per tab', () => {
    const store = useNotebookStore()

    store.setActiveNotebookId('notebook-a', 'tab-a')
    store.setDetailViewType('note-editor', 'tab-a')
    store.setCurrentNoteId(101, 'tab-a')

    expect(store.ensureTabUiState('tab-b')).toEqual({
      activeNotebookId: null,
      detailViewType: 'assistant',
      currentNoteId: null
    })

    store.setActiveNotebookId('notebook-b', 'tab-b')
    store.setDetailViewType('source-preview', 'tab-b')
    store.setCurrentNoteId(202, 'tab-b')

    expect(store.ensureTabUiState('tab-a')).toEqual({
      activeNotebookId: 'notebook-a',
      detailViewType: 'note-editor',
      currentNoteId: 101
    })
    expect(store.ensureTabUiState('tab-b')).toEqual({
      activeNotebookId: 'notebook-b',
      detailViewType: 'source-preview',
      currentNoteId: 202
    })
  })

  it('copies notebook tab state when a tab is duplicated', () => {
    const store = useNotebookStore()

    store.setActiveNotebookId('notebook-source', 'source-tab')
    store.setDetailViewType('note-editor', 'source-tab')
    store.setCurrentNoteId(88, 'source-tab')

    store.copyStateToTabId('source-tab', 'target-tab')

    expect(store.ensureTabUiState('target-tab')).toEqual({
      activeNotebookId: 'notebook-source',
      detailViewType: 'note-editor',
      currentNoteId: 88
    })
  })
})

/**
 * 来源按笔记本存储：后台 tab 中的详情页写入自己的笔记本，不能写进当时位于前台的 tab。
 */
describe('notebookStore sources per notebook', () => {
  type SourceRows = Awaited<ReturnType<typeof window.api.notebook.getSources>>
  const rowsOf = (...sourceIds: string[]): SourceRows =>
    sourceIds.map((sourceId) => ({
      sourceId,
      title: sourceId,
      type: 'text',
      content: 'x'
    })) as unknown as SourceRows

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(async (notebookId: string) =>
          rowsOf(notebookId === 'notebook-a' ? 'a-1' : 'b-1')
        ),
        updateSource: vi.fn(async () => undefined)
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the other tab untouched when a background notebook loads or updates', async () => {
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    store.retainSources('notebook-b')
    store.setActiveNotebookId('notebook-a', 'tab-a')
    await store.loadSources('notebook-a')
    store.setActiveNotebookId('notebook-b', 'tab-b')
    await store.loadSources('notebook-b')

    await store.loadSources('notebook-a')
    await store.updateSource('notebook-a', 'a-1', { title: 'renamed' })

    expect(tabSources(store, 'tab-b').map((s) => s.id)).toEqual(['b-1'])
    expect(tabSources(store, 'tab-a').map((s) => s.title)).toEqual(['renamed'])
  })

  it('shows the same sources in two tabs that open the same notebook', async () => {
    const store = useNotebookStore()
    store.setActiveNotebookId('notebook-a', 'tab-1')
    store.setActiveNotebookId('notebook-a', 'tab-2')
    store.retainSources('notebook-a')
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    await store.updateSource('notebook-a', 'a-1', { title: 'renamed' })

    expect(tabSources(store, 'tab-2').map((s) => s.title)).toEqual(['renamed'])
    expect(tabSources(store, 'tab-1').map((s) => s.title)).toEqual(['renamed'])
  })

  // 后台详情页扫描完文件夹后才添加来源，查重应针对它自己的笔记本，而不是用户当前在看的那个
  it('checks duplicates against the given notebook, not the foreground tab', async () => {
    const fileRow = (sourceId: string, filePath: string): SourceRows =>
      [{ sourceId, title: sourceId, type: 'file', content: 'x', filePath }] as unknown as SourceRows
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(async (notebookId: string) =>
          notebookId === 'notebook-a' ? fileRow('a-1', 'D:/a.pdf') : fileRow('b-1', 'D:/b.pdf')
        )
      }
    })
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    store.retainSources('notebook-b')
    await store.loadSources('notebook-a')
    store.setActiveNotebookId('notebook-b', 'tab-b')
    await store.loadSources('notebook-b')

    const isDuplicateInA = (filePath: string): boolean =>
      store.isDuplicateSource('notebook-a', { type: 'file', filePath })
    expect(isDuplicateInA('D:/a.pdf')).toBe(true)
    expect(isDuplicateInA('D:/b.pdf')).toBe(false)
  })

  /**
   * 来源的生命周期跟随展示它的详情页实例：最后一个持有者释放后，
   * 缓存中的正文也应随之释放。
   */
  it("frees a notebook's sources when its last holder releases", async () => {
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    expect(store.sourcesOf('notebook-a').map((s) => s.id)).toEqual(['a-1'])

    store.releaseSources('notebook-a')

    expect(store.sourcesOf('notebook-a')).toEqual([])
  })

  it('keeps sources while another holder remains', async () => {
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    store.releaseSources('notebook-a')

    expect(store.sourcesOf('notebook-a').map((s) => s.id)).toEqual(['a-1'])
  })

  // 释放之后才返回的加载结果不能把内容写回：release 会让在途请求的 requestId 失效
  it('discards an in-flight load that resolves after the last release', async () => {
    let resolveGet: (rows: SourceRows) => void = () => {}
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(
          () =>
            new Promise<SourceRows>((resolve) => {
              resolveGet = resolve
            })
        ),
        updateSource: vi.fn(async () => undefined)
      }
    })
    const store = useNotebookStore()
    store.retainSources('notebook-a')

    const loading = store.loadSources('notebook-a')
    store.releaseSources('notebook-a')
    resolveGet(rowsOf('a-1'))
    await loading

    expect(store.sourcesOf('notebook-a')).toEqual([])
  })

  // 页面卸载后才到达的刷新（Agent 添加来源、后台读图完成等）不能把已释放的正文重新载入内存
  it('loads sources only while a holder exists', async () => {
    const store = useNotebookStore()

    await store.loadSources('notebook-a')
    expect(window.api.notebook.getSources).not.toHaveBeenCalled()
    expect(store.sourcesOf('notebook-a')).toEqual([])

    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')
    expect(window.api.notebook.getSources).toHaveBeenCalledTimes(1)
    expect(store.sourcesOf('notebook-a').map((s) => s.id)).toEqual(['a-1'])
  })

  // 关闭 tab 时文件夹仍在扫描：之后添加的来源只写入数据库，不能在已释放的内存状态里拼出一份残缺的列表
  it('only persists a source added after the last release', async () => {
    const createSource = vi.fn(async () => undefined)
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(async () => rowsOf('a-1')),
        createSource
      }
    })
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')
    store.releaseSources('notebook-a')

    await store.addSource('notebook-a', {
      id: 'a-2',
      title: 'a-2',
      type: 'text',
      content: 'x'
    } as SourceItem)

    expect(createSource).toHaveBeenCalledTimes(1)
    expect(store.sourcesOf('notebook-a')).toEqual([])
  })

  // 乐观插入的那条在写库失败后要撤掉，不能碰列表里的其他来源
  it('rolls back only the optimistic source when the create write fails', async () => {
    const createSource = vi.fn(async () => {
      throw new Error('db down')
    })
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(async () => rowsOf('s1', 's2')),
        createSource
      }
    })
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    await store.addSource('notebook-a', {
      id: 's-new',
      title: 's-new',
      type: 'text',
      content: 'x'
    } as SourceItem)

    expect(store.sourcesOf('notebook-a').map((s) => s.id)).toEqual(['s1', 's2'])
  })

  // await 期间列表被整体重新加载过时，回滚按 id 匹配 —— 不能误删重新加载出来的那几条
  it('leaves a reloaded list intact when the failed add is rolled back', async () => {
    const store = useNotebookStore()
    const getSources = vi
      .fn(async () => rowsOf('s1', 's2', 's3'))
      .mockResolvedValueOnce(rowsOf('s1', 's2'))
    const createSource = vi.fn(async () => {
      await store.loadSources('notebook-a')
      throw new Error('db down')
    })
    vi.stubGlobal('api', {
      notebook: { getSources, createSource }
    })
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    await store.addSource('notebook-a', {
      id: 's-new',
      title: 's-new',
      type: 'text',
      content: 'x'
    } as SourceItem)

    expect(store.sourcesOf('notebook-a').map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  // 同 id 的来源已经在列表里时（例如同一条笔记被加了两次），写库会因 UNIQUE 冲突失败：
  // 回滚只撤掉刚插入的那一条，原有的那条要留着
  it('keeps the existing source when a duplicate-id add fails', async () => {
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(async () => rowsOf('s1')),
        createSource: vi.fn(async () => {
          throw new Error('UNIQUE constraint failed: notebook_sources.source_id')
        })
      }
    })
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    await store.addSource('notebook-a', {
      id: 's1',
      title: 's1-dup',
      type: 'text',
      content: 'x'
    } as SourceItem)

    const remaining = store.sourcesOf('notebook-a')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.title).toBe('s1')
  })

  /**
   * 上下文档位操作按传入的笔记本写库和回滚，与前台 tab 无关：
   * 前台打开 B 时修改 A 的来源，写入失败时回滚的是 A 的那一条。
   */
  it('rolls back the passed notebook when writing the context level fails', async () => {
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    store.retainSources('notebook-b')
    await store.loadSources('notebook-a')
    store.setActiveNotebookId('notebook-b', 'tab-b')
    await store.loadSources('notebook-b')

    vi.mocked(window.api.notebook.updateSource).mockRejectedValueOnce(new Error('db down'))

    await store.setSourceContextLevel('notebook-a', 'a-1', 'excluded')

    expect(store.sourcesOf('notebook-a')[0]?.contextLevel).toBe('full')
    expect(store.sourcesOf('notebook-b')[0]?.contextLevel).toBe('full')
  })
})

/**
 * 写库失败的回滚：await 期间列表可能被整体替换（重新加载或释放），下标也可能被其他操作改变。
 * 回滚不能按发起请求时的下标写入。
 */
describe('notebookStore rollback after a failed write', () => {
  type SourceRows = Awaited<ReturnType<typeof window.api.notebook.getSources>>
  const rowsOf = (...sourceIds: string[]): SourceRows =>
    sourceIds.map((sourceId) => ({
      sourceId,
      title: sourceId,
      type: 'text',
      content: 'x'
    })) as unknown as SourceRows

  function deferred(): { promise: Promise<never>; reject: (error: unknown) => void } {
    let reject: (error: unknown) => void = () => {}
    const promise = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
    return { promise, reject }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not write back into sources released while the update was in flight', async () => {
    const pending = deferred()
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(async () => rowsOf('a-1', 'a-2')),
        updateSource: vi.fn(() => pending.promise)
      }
    })
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    const updating = store.updateSource('notebook-a', 'a-2', { title: 'renamed' })
    store.releaseSources('notebook-a')
    pending.reject(new Error('db down'))
    await updating

    expect(store.sourcesOf('notebook-a')).toEqual([])
  })

  it('rolls back the updated source, not its neighbour, after an earlier one was removed', async () => {
    const pending = deferred()
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(async () => rowsOf('a-1', 'a-2', 'a-3')),
        updateSource: vi.fn(() => pending.promise),
        deleteSource: vi.fn(async () => true)
      }
    })
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    const updating = store.updateSource('notebook-a', 'a-2', { title: 'renamed' })
    await store.removeSource('notebook-a', 'a-1')
    pending.reject(new Error('db down'))
    await updating

    expect(store.sourcesOf('notebook-a').map((s) => [s.id, s.title])).toEqual([
      ['a-2', 'a-2'],
      ['a-3', 'a-3']
    ])
  })

  it('reinserts a failed delete after its surviving predecessor when an earlier one was removed', async () => {
    const pending = deferred()
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(async () => rowsOf('a', 'b', 'c', 'd')),
        deleteSource: vi.fn((sourceId: string) =>
          sourceId === 'c' ? pending.promise : Promise.resolve(true)
        )
      }
    })
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    const removing = store.removeSource('notebook-a', 'c')
    await store.removeSource('notebook-a', 'a')
    pending.reject(new Error('db down'))
    await removing

    expect(store.sourcesOf('notebook-a').map((s) => s.id)).toEqual(['b', 'c', 'd'])
  })

  it('does not reinsert a source the list was reloaded with while the delete was in flight', async () => {
    const pending = deferred()
    vi.stubGlobal('api', {
      notebook: {
        getSources: vi.fn(async () => rowsOf('a-1', 'a-2')),
        deleteSource: vi.fn(() => pending.promise)
      }
    })
    const store = useNotebookStore()
    store.retainSources('notebook-a')
    await store.loadSources('notebook-a')

    const removing = store.removeSource('notebook-a', 'a-1')
    await store.loadSources('notebook-a')
    pending.reject(new Error('db down'))
    await removing

    expect(store.sourcesOf('notebook-a').map((s) => s.id)).toEqual(['a-1', 'a-2'])
  })
})
