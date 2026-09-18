import { defineStore } from 'pinia'

interface HistoryEntry {
  path: string
  folderKey: string | null
}
interface TabHistory {
  history: HistoryEntry[]
  index: number
}
export interface HistoryNavigateContext {
  navigateToFolderById: (key: string, isCurrent: () => boolean) => Promise<boolean>
  navigateRoot: () => Promise<void> | void
  isCurrent?: () => boolean
}

const tabStates = new Map<string, TabHistory>()
const queues = new WeakMap<object, Promise<unknown>>()

export function getTabStates(): Map<string, TabHistory> {
  return tabStates
}

export const useAssetNavigationStore = defineStore('assetNavigation', {
  state: () => ({
    history: [] as HistoryEntry[],
    index: -1,
    navigating: false,
    _tabId: 'default',
    _vaultId: null as string | null,
    _revision: 0
  }),
  getters: {
    canGoBack: (state) => state.index > 0,
    canGoForward: (state) => state.index < state.history.length - 1,
    current: (state): string | null => state.history[state.index]?.path ?? null
  },
  actions: {
    cancelNavigation(): void {
      this._revision++
      this.navigating = false
      queues.delete(this)
    },
    setVaultId(vaultId: string | null): void {
      if (this._vaultId === vaultId) return
      this.cancelNavigation()
      this._vaultId = vaultId
      tabStates.clear()
      this.history = []
      this.index = -1
    },
    setTabId(tabId: string): void {
      if (this._tabId === tabId) return
      this.cancelNavigation()
      this._tabId = tabId
      const saved = tabStates.get(tabId)
      this.history = saved?.history.map((entry) => ({ ...entry })) ?? []
      this.index = saved?.index ?? -1
    },
    save(): void {
      tabStates.set(this._tabId, {
        history: this.history.map((entry) => ({ ...entry })),
        index: this.index
      })
    },
    push(path: string, folderKey: string | null = null): void {
      if (this.navigating) return
      const normalized = (path || '/').replace(/\/+/g, '/')
      // Non-root entries must carry a stable ID; names are not unique or immutable.
      if (normalized !== '/' && !folderKey) return
      const entry = { path: normalized, folderKey }
      if (this.history[this.index]?.folderKey === folderKey) {
        this.history[this.index] = entry
      } else {
        this.history.splice(this.index + 1)
        this.history.push(entry)
        this.index = this.history.length - 1
      }
      this.save()
    },
    navigate(
      direction: 'back' | 'forward',
      ctx: HistoryNavigateContext
    ): Promise<string | undefined> {
      const revision = this._revision
      const isCurrent = (): boolean => revision === this._revision && (ctx.isCurrent?.() ?? true)
      const run = async (): Promise<string | undefined> => {
        if (!isCurrent()) return undefined
        const targetIndex = this.index + (direction === 'back' ? -1 : 1)
        const target = this.history[targetIndex]
        if (!target) return undefined
        this.navigating = true
        try {
          if (target.folderKey) {
            if (!(await ctx.navigateToFolderById(target.folderKey, isCurrent))) return undefined
          } else {
            await ctx.navigateRoot()
          }
          if (!isCurrent()) return undefined
          this.index = targetIndex
          this.save()
          return target.path
        } finally {
          if (revision === this._revision) this.navigating = false
        }
      }
      // Keep failures from poisoning subsequent requests, while returning each result to its caller.
      const result = (queues.get(this) ?? Promise.resolve()).then(run, run)
      queues.set(
        this,
        result.catch(() => undefined)
      )
      return result
    },
    copyStateToTabId(sourceTabId: string, targetTabId: string): void {
      const source = tabStates.get(sourceTabId)
      if (source) {
        tabStates.set(targetTabId, {
          history: source.history.map((entry) => ({ ...entry })),
          index: source.index
        })
      }
    }
  }
})
