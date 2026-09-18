import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  getTabStates,
  useAssetNavigationStore,
  type HistoryNavigateContext
} from './assetNavigationStore'

function deferred(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(): {
  store: ReturnType<typeof useAssetNavigationStore>
  ctx: {
    navigateToFolderById: ReturnType<typeof vi.fn<HistoryNavigateContext['navigateToFolderById']>>
    navigateRoot: ReturnType<typeof vi.fn>
  }
} {
  const store = useAssetNavigationStore()
  store.setVaultId('vault-a')
  store.setTabId('tab-a')
  for (const key of ['A', 'B', 'C']) store.push(`/${key}`, key)
  const ctx = {
    navigateToFolderById: vi.fn<HistoryNavigateContext['navigateToFolderById']>(async () => true),
    navigateRoot: vi.fn()
  }
  return { store, ctx }
}

beforeEach(() => {
  setActivePinia(createPinia())
  getTabStates().clear()
})

describe('asset navigation history', () => {
  it('serializes rapid back requests and supports forward afterwards', async () => {
    const { store, ctx } = setup()
    const pending = deferred()
    ctx.navigateToFolderById.mockReturnValueOnce(pending.promise)
    const first = store.navigate('back', ctx)
    const second = store.navigate('back', ctx)
    await Promise.resolve()
    expect(ctx.navigateToFolderById).toHaveBeenCalledTimes(1)
    expect(store.current).toBe('/C')
    pending.resolve(true)
    await Promise.all([first, second])
    expect(ctx.navigateToFolderById.mock.calls.map((call) => call[0])).toEqual(['B', 'A'])
    expect(store.current).toBe('/A')
    await store.navigate('forward', ctx)
    expect(store.current).toBe('/B')
  })

  it('uses the original folder ID after rename and distinguishes identical paths', async () => {
    const { store, ctx } = setup()
    store.push('/C', 'another-C')
    await store.navigate('back', ctx)
    expect(ctx.navigateToFolderById).toHaveBeenCalledWith('C', expect.any(Function))
    store.push('/renamed-C', 'C')
    expect(store.history).toHaveLength(4)
    expect(store.current).toBe('/renamed-C')
    expect(store.canGoForward).toBe(true)
  })

  it('keeps the current position when the target was deleted or loading failed', async () => {
    const { store, ctx } = setup()
    ctx.navigateToFolderById.mockResolvedValueOnce(false)
    expect(await store.navigate('back', ctx)).toBeUndefined()
    expect(store.current).toBe('/C')
    expect(ctx.navigateRoot).not.toHaveBeenCalled()
    ctx.navigateToFolderById.mockRejectedValueOnce(new Error('failed'))
    await expect(store.navigate('back', ctx)).rejects.toThrow('failed')
    expect(store.current).toBe('/C')
    expect(store.navigating).toBe(false)
    await store.navigate('back', ctx)
    expect(store.current).toBe('/B')
  })

  it('clears all tab histories and cancels queued work when switching vaults', async () => {
    const { store, ctx } = setup()
    store.copyStateToTabId('tab-a', 'tab-b')
    const pending = deferred()
    ctx.navigateToFolderById.mockReturnValueOnce(pending.promise)
    const first = store.navigate('back', ctx)
    const second = store.navigate('back', ctx)
    await Promise.resolve()
    store.setVaultId('vault-b')
    store.push('/ALL', 'new-all')
    pending.resolve(true)
    await Promise.all([first, second])
    expect(store.current).toBe('/ALL')
    expect(store.canGoBack).toBe(false)
    expect(ctx.navigateToFolderById).toHaveBeenCalledTimes(1)
    store.setTabId('tab-b')
    expect(store.history).toEqual([])
  })

  it('cancels stale callbacks on deactivation without changing another tab history', async () => {
    const { store, ctx } = setup()
    const pending = deferred()
    ctx.navigateToFolderById.mockReturnValueOnce(pending.promise)
    const first = store.navigate('back', ctx)
    await Promise.resolve()
    const isCurrent = ctx.navigateToFolderById.mock.calls[0][1]
    store.cancelNavigation()
    expect(isCurrent()).toBe(false)
    store.setTabId('tab-b')
    store.push('/D', 'D')
    pending.resolve(true)
    await first
    expect(store.current).toBe('/D')
    store.setTabId('tab-a')
    expect(store.current).toBe('/C')
  })

  it('handles root, boundaries and truncates forward history on a new visit', async () => {
    const store = useAssetNavigationStore()
    const ctx = {
      navigateToFolderById: vi.fn<HistoryNavigateContext['navigateToFolderById']>(async () => true),
      navigateRoot: vi.fn()
    }
    expect(await store.navigate('back', ctx)).toBeUndefined()
    store.push('/')
    store.push('/A', 'A')
    await store.navigate('back', ctx)
    expect(ctx.navigateRoot).toHaveBeenCalledOnce()
    expect(store.current).toBe('/')
    store.push('/B', 'B')
    expect(store.canGoForward).toBe(false)
    expect(store.history.map((entry) => entry.folderKey)).toEqual([null, 'B'])
  })
})
