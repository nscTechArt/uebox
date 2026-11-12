import { defineStore } from 'pinia'
import {
  DEFAULT_NOTEBOOK_CONTEXT_LEVEL,
  isSourceIncluded,
  normalizeNotebookContextLevel,
  type NotebookContextLevel
} from '@core/shared/notebookContext'

/**
 * Source item interface mapped from notebook_sources rows.
 */
interface SourceItem {
  id: string
  title: string
  type: 'file' | 'link' | 'youtube' | 'bilibili' | 'text' | 'note' | 'ue-project' | 'wechat' | 'mp'
  content: string
  /** 抓回来的原文（清洗过的网页才有）。界面上「看原文」用它 */
  rawContent?: string | null
  sourceUrl?: string
  loading?: boolean
  error?: string | null
  /** 进上下文的档位：全文 / 只给摘要 / 不进上下文 */
  contextLevel?: NotebookContextLevel
  fileName?: string
  filePath?: string
  thumbnail?: string
  description?: string
  summaryContent?: string | null
  summaryStatus?: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | null
  mediaUrl?: string
  indexStatus?: string | null
  indexedAt?: string | null
  indexError?: string | null
  embeddingModel?: string | null
  embeddingDim?: number | null
}

type NotebookDetailViewType = 'assistant' | 'note-editor' | 'source-preview'

interface NotebookUiTabState {
  activeNotebookId: string | null
  detailViewType: NotebookDetailViewType
  currentNoteId: number | null
}

interface NotebookRuntimeState {
  sources: SourceItem[]
  loadSourcesRequestId: number
}

const NOTEBOOK_STORE_KEY = 'notebook-store'

const createDefaultUiTabState = (): NotebookUiTabState => ({
  activeNotebookId: null,
  detailViewType: 'assistant',
  currentNoteId: null
})

const createDefaultRuntimeState = (): NotebookRuntimeState => ({
  sources: [],
  loadSourcesRequestId: 0
})

/**
 * Notebook module state management.
 * UI state is stored per tab. Source content is cached per notebook in memory
 * and sourced from SQLite rather than localStorage persistence.
 *
 * 来源按笔记本而不是按 tab 存储：后台 tab 中（被 keep-alive 缓存）的详情页完成异步任务后，
 * 要写回它自己的笔记本；按 tab 存储的话，只能写进当时位于前台的 tab。
 * 同一个笔记本在两个 tab 中打开时，看到的本来就是库里的同一份数据。
 */
export const useNotebookStore = defineStore('notebook', {
  state: () => ({
    tabUiStates: {} as Record<string, NotebookUiTabState>,
    notebookRuntimeStates: {} as Record<string, NotebookRuntimeState>,
    sourceHolders: {} as Record<string, number>
  }),

  getters: {
    /**
     * 指定笔记本的来源，与它是否位于前台 tab 无关。
     *
     * 有意不提供「前台 tab 的来源」：后台缓存的页面也在执行异步任务，
     * 读取前台的来源会拿到别的笔记本的数据。需要哪个笔记本就按 id 获取。
     */
    sourcesOf(state): (notebookId: string) => SourceItem[] {
      return (notebookId) => state.notebookRuntimeStates[notebookId]?.sources ?? []
    },

    /**
     * Check whether a source already exists in a notebook.
     *
     * 按传入的笔记本查重，而不是按前台 tab：拖入文件夹后要等扫描完成才逐个添加，
     * 期间用户可能已经切到别的 tab，此时前台的来源属于另一个笔记本。
     */
    isDuplicateSource(): (
      notebookId: string,
      source: { type?: string; filePath?: string; sourceUrl?: string }
    ) => boolean {
      return (notebookId, source) => {
        const sources = this.sourcesOf(notebookId)
        if (source.type === 'file' && source.filePath) {
          return sources.some((item) => item.filePath === source.filePath)
        }
        if ((source.type === 'link' || source.type === 'wechat') && source.sourceUrl) {
          return sources.some((item) => item.sourceUrl === source.sourceUrl)
        }
        return false
      }
    }
  },

  actions: {
    normalizeTabId(tabId: string | null | undefined): string {
      return String(tabId || '').trim() || 'default'
    },

    ensureTabUiState(tabId: string): NotebookUiTabState {
      const normalizedTabId = this.normalizeTabId(tabId)
      if (!this.tabUiStates[normalizedTabId]) {
        this.tabUiStates[normalizedTabId] = createDefaultUiTabState()
      }
      return this.tabUiStates[normalizedTabId]
    },

    /** 指定笔记本的内存状态；尚未 loadSources 时为 undefined */
    findRuntimeState(notebookId: string): NotebookRuntimeState | undefined {
      return this.notebookRuntimeStates[notebookId]
    },

    getActiveNotebookIdForTab(tabId: string): string | null {
      return this.ensureTabUiState(tabId).activeNotebookId
    },

    copyStateToTabId(sourceTabId: string, targetTabId: string): void {
      const sourceUiState = this.ensureTabUiState(sourceTabId)
      const normalizedTargetTabId = this.normalizeTabId(targetTabId)

      this.tabUiStates[normalizedTargetTabId] = { ...sourceUiState }
    },

    /**
     * Set the active notebook id for a tab.
     */
    setActiveNotebookId(id: string | null, tabId: string) {
      this.ensureTabUiState(tabId).activeNotebookId = id
    },

    /**
     * Get a source from the notebook cache.
     */
    getSource(notebookId: string, sourceId: string): SourceItem | undefined {
      return this.sourcesOf(notebookId).find((source) => source.id === sourceId)
    },

    /**
     * Persist the detail view type for a tab.
     */
    setDetailViewType(viewType: NotebookDetailViewType, tabId: string) {
      this.ensureTabUiState(tabId).detailViewType = viewType
    },

    /**
     * Persist the selected note id for a tab.
     */
    setCurrentNoteId(noteId: number | null, tabId: string) {
      this.ensureTabUiState(tabId).currentNoteId = noteId
    },

    /**
     * 来源的生命周期跟随展示它的详情页实例：每有一个页面展示该笔记本的来源，
     * 就记一次持有。
     */
    retainSources(notebookId: string): void {
      this.sourceHolders[notebookId] = (this.sourceHolders[notebookId] ?? 0) + 1
    },

    /**
     * 释放一次持有；无人持有时释放正文。
     *
     * 内存状态本身保留（字段原地重置）：在途的 loadSources 返回后会通过
     * requestId 发现请求已失效，不会把已释放的内容写回。
     */
    releaseSources(notebookId: string): void {
      const remaining = (this.sourceHolders[notebookId] ?? 0) - 1
      if (remaining > 0) {
        this.sourceHolders[notebookId] = remaining
        return
      }
      delete this.sourceHolders[notebookId]
      const runtimeState = this.notebookRuntimeStates[notebookId]
      if (runtimeState) {
        runtimeState.sources = []
        runtimeState.loadSourcesRequestId += 1
      }
    },

    /**
     * Load a notebook's sources from SQLite.
     *
     * 只有这里会创建笔记本的内存状态；对未加载过的笔记本，增删改只写数据库，
     * 避免留下只有一两条的残缺列表。
     *
     * 无人持有时不加载：页面卸载后才到达的刷新（Agent 添加来源、后台读图完成等）
     * 不能把已释放的正文重新载入内存。
     */
    async loadSources(notebookId: string): Promise<void> {
      if (!this.sourceHolders[notebookId]) return
      if (!this.notebookRuntimeStates[notebookId]) {
        this.notebookRuntimeStates[notebookId] = createDefaultRuntimeState()
      }
      const runtimeState = this.notebookRuntimeStates[notebookId]
      const requestId = runtimeState.loadSourcesRequestId + 1
      runtimeState.loadSourcesRequestId = requestId

      try {
        const dbSources = await window.api.notebook.getSources(notebookId)
        if (requestId !== runtimeState.loadSourcesRequestId) {
          return
        }

        runtimeState.sources = dbSources.map((source) => ({
          id: source.sourceId,
          title: source.title,
          type: source.type,
          content: source.content,
          rawContent: source.rawContent ?? undefined,
          sourceUrl: source.sourceUrl || undefined,
          loading: source.loading,
          error: source.error || undefined,
          fileName: source.fileName || undefined,
          filePath: source.filePath || undefined,
          summaryContent: source.summaryContent || undefined,
          summaryStatus: source.summaryStatus || undefined,
          mediaUrl: source.mediaUrl || undefined,
          indexStatus: source.indexStatus ?? undefined,
          indexedAt: source.indexedAt ?? undefined,
          indexError: source.indexError ?? undefined,
          embeddingModel: source.embeddingModel ?? undefined,
          embeddingDim: source.embeddingDim ?? undefined,
          contextLevel: normalizeNotebookContextLevel(source.contextLevel)
        }))
      } catch (error) {
        console.error('[notebookStore] Failed to load sources:', error)
        if (requestId === runtimeState.loadSourcesRequestId) {
          runtimeState.sources = []
        }
      }
    },

    /**
     * Add a source to a notebook and persist it to SQLite.
     */
    async addSource(notebookId: string, source: SourceItem): Promise<void> {
      // 无人持有时只写数据库：在途的添加不能把残缺列表写回已释放的内存状态
      const runtimeState = this.sourceHolders[notebookId]
        ? this.findRuntimeState(notebookId)
        : undefined
      const insertIndex = runtimeState?.sources.length ?? -1

      runtimeState?.sources.push({
        ...source,
        contextLevel: normalizeNotebookContextLevel(
          source.contextLevel ?? DEFAULT_NOTEBOOK_CONTEXT_LEVEL
        )
      })

      try {
        await window.api.notebook.createSource({
          sourceId: source.id,
          notebookId,
          title: source.title,
          type: source.type,
          content: source.content,
          rawContent: source.rawContent,
          sourceUrl: source.sourceUrl,
          fileName: source.fileName,
          filePath: source.filePath,
          loading: source.loading,
          error: source.error ?? undefined
        })
      } catch (error) {
        const latestRuntimeState = this.findRuntimeState(notebookId)
        if (latestRuntimeState) {
          if (latestRuntimeState.sources[insertIndex]?.id === source.id) {
            latestRuntimeState.sources.splice(insertIndex, 1)
          } else {
            latestRuntimeState.sources = latestRuntimeState.sources.filter(
              (item) => item.id !== source.id
            )
          }
        }
        console.error('[notebookStore] Failed to create source:', error)
      }
    },

    /**
     * Update a source in a notebook and persist changes to SQLite.
     */
    async updateSource(
      notebookId: string,
      sourceId: string,
      updates: Partial<SourceItem>
    ): Promise<void> {
      const runtimeState = this.findRuntimeState(notebookId)
      const generation = runtimeState?.loadSourcesRequestId
      const index = runtimeState?.sources.findIndex((source) => source.id === sourceId) ?? -1
      const previousSource =
        runtimeState && index !== -1 ? { ...runtimeState.sources[index] } : null

      if (runtimeState && index !== -1) {
        runtimeState.sources[index] = { ...runtimeState.sources[index], ...updates }
      }

      try {
        await window.api.notebook.updateSource(sourceId, {
          title: updates.title,
          type: updates.type,
          content: updates.content,
          rawContent: updates.rawContent,
          sourceUrl: updates.sourceUrl,
          fileName: updates.fileName,
          filePath: updates.filePath,
          loading: updates.loading,
          error: updates.error,
          summaryContent: updates.summaryContent,
          summaryStatus: updates.summaryStatus,
          contextLevel: updates.contextLevel,
          mediaUrl: updates.mediaUrl
        })
      } catch (error) {
        // await 期间列表若被整体替换（重新加载或释放）则不回滚：替换后的就是库里的数据，
        // 写入失败时库里本来就是旧值。未被替换时也按 id 查找：期间可能有条目被删除，下标已经变化
        if (runtimeState && previousSource && runtimeState.loadSourcesRequestId === generation) {
          const latestIndex = runtimeState.sources.findIndex((source) => source.id === sourceId)
          if (latestIndex !== -1) {
            runtimeState.sources[latestIndex] = previousSource
          }
        }
        console.error('[notebookStore] Failed to update source:', error)
      }
    },

    /**
     * Remove a source from a notebook and SQLite.
     */
    async removeSource(notebookId: string, sourceId: string): Promise<void> {
      const runtimeState = this.findRuntimeState(notebookId)
      const generation = runtimeState?.loadSourcesRequestId
      const index = runtimeState?.sources.findIndex((source) => source.id === sourceId) ?? -1
      const removedSource = runtimeState && index !== -1 ? { ...runtimeState.sources[index] } : null
      const precedingIds =
        runtimeState && index !== -1
          ? runtimeState.sources.slice(0, index).map((source) => source.id)
          : []

      if (runtimeState && index !== -1) {
        runtimeState.sources.splice(index, 1)
      }

      try {
        await window.api.notebook.deleteSource(sourceId)
      } catch (error) {
        // await 期间列表若被整体替换则不插回：重新加载后库里那条还在，再插入会重复；
        // 释放之后再插入，会得到只有这一条的残缺列表。
        // 未被替换时，按前面仍存在的那一条定位插回，这样期间前面有条目被删除也不会错位
        if (runtimeState && removedSource && runtimeState.loadSourcesRequestId === generation) {
          let insertIndex = 0
          for (let i = precedingIds.length - 1; i >= 0; i -= 1) {
            const position = runtimeState.sources.findIndex(
              (source) => source.id === precedingIds[i]
            )
            if (position !== -1) {
              insertIndex = position + 1
              break
            }
          }
          runtimeState.sources.splice(insertIndex, 0, removedSource)
        }
        console.error('[notebookStore] Failed to delete source:', error)
      }
    },

    /**
     * Clear only the tab's ui state when leaving a notebook detail page.
     * 来源按笔记本存储，其他 tab 可能还打开着同一个笔记本，因此不清空。
     */
    clearActiveNotebook(tabId: string) {
      const uiState = this.ensureTabUiState(tabId)

      uiState.activeNotebookId = null
      uiState.detailViewType = 'assistant'
      uiState.currentNoteId = null
    },

    /**
     * 改一条来源的上下文档位，并落库。
     *
     * 失败就把界面上的档位改回去 —— 显示成改成功了、下次生成却按老档位送，
     * 是最难查的一类问题。
     */
    async setSourceContextLevel(
      notebookId: string,
      sourceId: string,
      level: NotebookContextLevel
    ): Promise<void> {
      const runtimeState = this.findRuntimeState(notebookId)
      const index = runtimeState?.sources.findIndex((source) => source.id === sourceId) ?? -1
      if (!runtimeState || index === -1) return

      const previousLevel = runtimeState.sources[index].contextLevel
      runtimeState.sources[index] = { ...runtimeState.sources[index], contextLevel: level }

      try {
        await window.api.notebook.updateSource(sourceId, { contextLevel: level })
      } catch (error) {
        const latestIndex = runtimeState.sources.findIndex((source) => source.id === sourceId)
        if (latestIndex !== -1) {
          runtimeState.sources[latestIndex] = {
            ...runtimeState.sources[latestIndex],
            contextLevel: previousLevel
          }
        }
        console.warn('[notebookStore] Failed to set source context level:', error)
      }
    },

    /**
     * 在「进上下文」和「不进上下文」之间来回切。
     *
     * 重新勾上时回到全文而不是上一次的摘要档：勾选框只表达进不进，
     * 记住一个用户看不见的档位只会让下次生成的字数对不上他的预期。
     */
    async toggleSourceIncluded(notebookId: string, sourceId: string): Promise<void> {
      const source = this.sourcesOf(notebookId).find((item) => item.id === sourceId)
      if (!source) return

      const nextLevel: NotebookContextLevel = isSourceIncluded(source) ? 'excluded' : 'full'
      await this.setSourceContextLevel(notebookId, sourceId, nextLevel)
    },

    /**
     * 把一个笔记本的所有来源设成同一档。
     *
     * 逐条落库、各自回滚：一条写失败不该把其他几条也回滚（它们是真的写进去了）。
     * 失败的那条会自己滚回原档位并在控制台留一行，界面上就是那一条没跟着变。
     */
    async setAllContextLevels(notebookId: string, level: NotebookContextLevel): Promise<void> {
      await Promise.all(
        this.sourcesOf(notebookId).map((source) =>
          this.setSourceContextLevel(notebookId, source.id, level)
        )
      )
    }
  },

  // 插件 v4 只识别 pick，不识别 paths；若写成 paths，整个 state 都会落盘，
  // 包括来源正文和持有计数
  persist: {
    key: NOTEBOOK_STORE_KEY,
    storage: localStorage,
    pick: ['tabUiStates']
  }
})

export type { SourceItem, NotebookDetailViewType }
