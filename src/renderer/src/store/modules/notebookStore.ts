import { defineStore } from 'pinia'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import {
  DEFAULT_NOTEBOOK_CONTEXT_LEVEL,
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

interface NotebookRuntimeTabState {
  sources: SourceItem[]
  isLoadingSources: boolean
  loadSourcesRequestId: number
}

const NOTEBOOK_STORE_KEY = 'notebook-store'

const createDefaultUiTabState = (): NotebookUiTabState => ({
  activeNotebookId: null,
  detailViewType: 'assistant',
  currentNoteId: null
})

const createDefaultRuntimeTabState = (): NotebookRuntimeTabState => ({
  sources: [],
  isLoadingSources: false,
  loadSourcesRequestId: 0
})

let legacyNotebookStateMigrated = false

/**
 * Notebook module state management.
 * UI state is stored per tab. Source content is cached per tab in memory
 * and sourced from SQLite rather than localStorage persistence.
 */
export const useNotebookStore = defineStore('notebook', {
  state: () => ({
    _tabId: 'default' as string,
    tabUiStates: {} as Record<string, NotebookUiTabState>,
    tabRuntimeStates: {} as Record<string, NotebookRuntimeTabState>,
    leftColWidth: 300,
    rightColWidth: 320
  }),

  getters: {
    activeNotebookId(state): string | null {
      return state.tabUiStates[state._tabId]?.activeNotebookId ?? null
    },

    detailViewType(state): NotebookDetailViewType {
      return state.tabUiStates[state._tabId]?.detailViewType ?? 'assistant'
    },

    currentNoteId(state): number | null {
      return state.tabUiStates[state._tabId]?.currentNoteId ?? null
    },

    sources(state): SourceItem[] {
      return state.tabRuntimeStates[state._tabId]?.sources ?? []
    },

    currentSources(): SourceItem[] {
      return this.sources
    },

    isLoadingSources(state): boolean {
      return state.tabRuntimeStates[state._tabId]?.isLoadingSources ?? false
    },

    /**
     * 会进上下文的来源 id。
     *
     * 这里是**算出来的**，不再另存一份数组：以前那份数组要和每条来源的
     * selected 手动保持一致，任何一条漏同步都会让「界面上勾着、实际没送进去」
     * 这种谁都查不出来的问题溜过去。
     */
    _selectedSourceIds(): string[] {
      return this.sources
        .filter((source) => normalizeNotebookContextLevel(source.contextLevel) !== 'excluded')
        .map((source) => source.id)
    },

    /**
     * Check whether a source already exists in the active tab.
     */
    isDuplicateSource(): (source: {
      type?: string
      filePath?: string
      sourceUrl?: string
    }) => boolean {
      return (source) => {
        if (source.type === 'file' && source.filePath) {
          return this.sources.some((item) => item.filePath === source.filePath)
        }
        if ((source.type === 'link' || source.type === 'wechat') && source.sourceUrl) {
          return this.sources.some((item) => item.sourceUrl === source.sourceUrl)
        }
        return false
      }
    }
  },

  actions: {
    migrateLegacyPersistedState() {
      if (legacyNotebookStateMigrated) return
      legacyNotebookStateMigrated = true

      try {
        const raw = localStorage.getItem(NOTEBOOK_STORE_KEY)
        if (!raw) return

        const data = JSON.parse(raw) as Partial<{
          tabUiStates: Record<string, NotebookUiTabState>
          activeNotebookId: string | null
          detailViewType: NotebookDetailViewType
          currentNoteId: number | null
          leftColWidth: number
          rightColWidth: number
        }>

        if (data.tabUiStates && Object.keys(data.tabUiStates).length > 0) {
          return
        }

        const hasLegacyUiState =
          'activeNotebookId' in data || 'detailViewType' in data || 'currentNoteId' in data
        if (!hasLegacyUiState) {
          return
        }

        this.tabUiStates.default = {
          activeNotebookId: data.activeNotebookId ?? null,
          detailViewType: data.detailViewType ?? 'assistant',
          currentNoteId: data.currentNoteId ?? null
        }

        if (typeof data.leftColWidth === 'number') {
          this.leftColWidth = data.leftColWidth
        }
        if (typeof data.rightColWidth === 'number') {
          this.rightColWidth = data.rightColWidth
        }
      } catch (error) {
        console.warn('[notebookStore] Failed to migrate legacy persisted state:', error)
      }
    },

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

    ensureTabRuntimeState(tabId: string): NotebookRuntimeTabState {
      const normalizedTabId = this.normalizeTabId(tabId)
      if (!this.tabRuntimeStates[normalizedTabId]) {
        this.tabRuntimeStates[normalizedTabId] = createDefaultRuntimeTabState()
      }
      return this.tabRuntimeStates[normalizedTabId]
    },

    setTabId(tabId: string): void {
      this.migrateLegacyPersistedState()
      const normalizedTabId = this.normalizeTabId(tabId)
      this._tabId = normalizedTabId
      this.ensureTabUiState(normalizedTabId)
      this.ensureTabRuntimeState(normalizedTabId)
    },

    getActiveNotebookIdForTab(tabId: string): string | null {
      this.migrateLegacyPersistedState()
      const uiState = this.ensureTabUiState(this.normalizeTabId(tabId))
      return uiState.activeNotebookId
    },

    copyStateToTabId(sourceTabId: string, targetTabId: string): void {
      this.migrateLegacyPersistedState()

      const sourceUiState = this.ensureTabUiState(this.normalizeTabId(sourceTabId))
      const sourceRuntimeState = this.ensureTabRuntimeState(this.normalizeTabId(sourceTabId))
      const normalizedTargetTabId = this.normalizeTabId(targetTabId)

      this.tabUiStates[normalizedTargetTabId] = { ...sourceUiState }
      this.tabRuntimeStates[normalizedTargetTabId] = {
        sources: sourceRuntimeState.sources.map((source) => ({ ...source })),
        isLoadingSources: sourceRuntimeState.isLoadingSources,
        loadSourcesRequestId: sourceRuntimeState.loadSourcesRequestId
      }
    },

    /**
     * Set the active notebook id for the current tab.
     */
    setActiveNotebookId(id: string | null) {
      this.ensureTabUiState(this._tabId).activeNotebookId = id
    },

    /**
     * Get a source from the current tab cache.
     */
    getSource(_notebookId: string, sourceId: string): SourceItem | undefined {
      return this.sources.find((source) => source.id === sourceId)
    },

    /**
     * Persist the detail view type for the current tab.
     */
    setDetailViewType(viewType: NotebookDetailViewType) {
      this.ensureTabUiState(this._tabId).detailViewType = viewType
    },

    /**
     * Persist the selected note id for the current tab.
     */
    setCurrentNoteId(noteId: number | null) {
      this.ensureTabUiState(this._tabId).currentNoteId = noteId
    },

    setLeftColWidth(width: number) {
      this.leftColWidth = width
    },

    setRightColWidth(width: number) {
      this.rightColWidth = width
    },

    /**
     * Load notebook sources for the current tab from SQLite.
     */
    async loadSources(notebookId: string): Promise<void> {
      const tabId = this.normalizeTabId(this._tabId)
      const runtimeState = this.ensureTabRuntimeState(tabId)
      const requestId = runtimeState.loadSourcesRequestId + 1
      runtimeState.loadSourcesRequestId = requestId
      runtimeState.isLoadingSources = true

      try {
        const dbSources = await window.api.notebook.getSources(notebookId)
        const latestRuntimeState = this.ensureTabRuntimeState(tabId)
        if (requestId !== latestRuntimeState.loadSourcesRequestId) {
          return
        }

        latestRuntimeState.sources = dbSources.map((source) => ({
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
        const latestRuntimeState = this.ensureTabRuntimeState(tabId)
        if (requestId === latestRuntimeState.loadSourcesRequestId) {
          latestRuntimeState.sources = []
        }
      } finally {
        const latestRuntimeState = this.ensureTabRuntimeState(tabId)
        if (requestId === latestRuntimeState.loadSourcesRequestId) {
          latestRuntimeState.isLoadingSources = false
        }
      }
    },

    /**
     * Add a source to the current tab and persist it to SQLite.
     */
    async addSource(notebookId: string, source: SourceItem): Promise<void> {
      const tabId = this.normalizeTabId(this._tabId)
      const runtimeState = this.ensureTabRuntimeState(tabId)
      const insertIndex = runtimeState.sources.length

      runtimeState.sources.push({
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
        const latestRuntimeState = this.ensureTabRuntimeState(tabId)
        if (latestRuntimeState.sources[insertIndex]?.id === source.id) {
          latestRuntimeState.sources.splice(insertIndex, 1)
        } else {
          latestRuntimeState.sources = latestRuntimeState.sources.filter(
            (item) => item.id !== source.id
          )
        }
        console.error('[notebookStore] Failed to create source:', error)
      }
    },

    /**
     * Update a source in the current tab and persist changes to SQLite.
     */
    async updateSource(
      _notebookId: string,
      sourceId: string,
      updates: Partial<SourceItem>
    ): Promise<void> {
      const tabId = this.normalizeTabId(this._tabId)
      const runtimeState = this.ensureTabRuntimeState(tabId)
      const index = runtimeState.sources.findIndex((source) => source.id === sourceId)
      const previousSource = index !== -1 ? { ...runtimeState.sources[index] } : null

      if (index !== -1) {
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
        const latestRuntimeState = this.ensureTabRuntimeState(tabId)
        if (index !== -1 && previousSource) {
          latestRuntimeState.sources[index] = previousSource
        }
        console.error('[notebookStore] Failed to update source:', error)
      }
    },

    /**
     * Remove a source from the current tab and SQLite.
     */
    async removeSource(_notebookId: string, sourceId: string): Promise<void> {
      const tabId = this.normalizeTabId(this._tabId)
      const runtimeState = this.ensureTabRuntimeState(tabId)
      const index = runtimeState.sources.findIndex((source) => source.id === sourceId)
      const removedSource = index !== -1 ? { ...runtimeState.sources[index] } : null

      if (index !== -1) {
        runtimeState.sources.splice(index, 1)
      }

      try {
        await window.api.notebook.deleteSource(sourceId)
      } catch (error) {
        const latestRuntimeState = this.ensureTabRuntimeState(tabId)
        if (removedSource) {
          latestRuntimeState.sources.splice(
            Math.min(index, latestRuntimeState.sources.length),
            0,
            removedSource
          )
        }
        console.error('[notebookStore] Failed to delete source:', error)
      }
    },

    /**
     * Clear only the active tab state when leaving a notebook detail page.
     */
    clearActiveNotebook(tabId?: string) {
      const normalizedTabId = this.normalizeTabId(tabId ?? this._tabId)
      const uiState = this.ensureTabUiState(normalizedTabId)
      const runtimeState = this.ensureTabRuntimeState(normalizedTabId)

      runtimeState.loadSourcesRequestId += 1
      runtimeState.sources = []
      runtimeState.isLoadingSources = false

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
    async setSourceContextLevel(sourceId: string, level: NotebookContextLevel): Promise<void> {
      const tabId = this.normalizeTabId(this._tabId)
      const runtimeState = this.ensureTabRuntimeState(tabId)
      const index = runtimeState.sources.findIndex((source) => source.id === sourceId)
      if (index === -1) return

      const previousLevel = runtimeState.sources[index].contextLevel
      runtimeState.sources[index] = { ...runtimeState.sources[index], contextLevel: level }

      try {
        await window.api.notebook.updateSource(sourceId, { contextLevel: level })
      } catch (error) {
        const latest = this.ensureTabRuntimeState(tabId)
        const latestIndex = latest.sources.findIndex((source) => source.id === sourceId)
        if (latestIndex !== -1) {
          latest.sources[latestIndex] = {
            ...latest.sources[latestIndex],
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
    async toggleSourceIncluded(sourceId: string): Promise<void> {
      const source = this.sources.find((item) => item.id === sourceId)
      if (!source) return

      const nextLevel: NotebookContextLevel =
        normalizeNotebookContextLevel(source.contextLevel) === 'excluded' ? 'full' : 'excluded'
      await this.setSourceContextLevel(sourceId, nextLevel)
    },

    /**
     * 把当前标签页里所有来源设成同一档。
     *
     * 逐条落库、各自回滚：一条写失败不该把其他几条也回滚（它们是真的写进去了）。
     * 失败的那条会自己滚回原档位并在控制台留一行，界面上就是那一条没跟着变。
     */
    async setAllContextLevels(level: NotebookContextLevel): Promise<void> {
      await Promise.all(this.sources.map((source) => this.setSourceContextLevel(source.id, level)))
    }
  },

  persist: usePersistOptions<{
    tabUiStates: Record<string, NotebookUiTabState>
    leftColWidth: number
    rightColWidth: number
  }>({
    key: NOTEBOOK_STORE_KEY,
    paths: ['tabUiStates', 'leftColWidth', 'rightColWidth'],
    storage: 'localStorage'
  })
})

export type { SourceItem, NotebookDetailViewType }
