/**
 * 资产库页面的数据源切换：选服务器库时数据源和能力跟着换，回本地库时原样恢复；
 * 服务端的失效通知和作业进度送到页面和全局导入任务条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetLibraryStore } from './assetLibraryStore'
import { useImportTasksStore } from './importTasks'
import {
  getActiveLibrarySource,
  setActiveLibrarySource
} from '@renderer/views/AssetManagement/data/activeLibrarySource'

vi.mock('@renderer/i18n', () => ({ default: { global: { t: (key: string) => key } } }))

type Listener = (event: unknown) => void
let listeners: Listener[]
let bridge: Record<string, ReturnType<typeof vi.fn>>

const status = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: 'srv:lab',
  online: true,
  signedOut: false,
  generation: 1,
  epoch: 1,
  state: 'ready',
  lastError: null,
  capabilities: {
    previews: true,
    annotations: true,
    events: true,
    changes: true,
    closure: null,
    lore: true
  },
  ...overrides
})

beforeEach(() => {
  setActivePinia(createPinia())
  listeners = []
  bridge = {
    list: vi.fn(async () => ({
      success: true,
      data: [
        {
          key: 'srv:lab',
          serverId: 'srv',
          libraryId: 'lab',
          name: 'Lab',
          addedAt: 1,
          server: { signedIn: true }
        }
      ]
    })),
    getActive: vi.fn(async () => ({ success: true, data: 'srv:lab' })),
    setActive: vi.fn(async () => ({ success: true })),
    watch: vi.fn(async () => ({ success: true, data: status() })),
    unwatch: vi.fn(async () => ({ success: true })),
    status: vi.fn(async () => ({ success: true, data: status() })),
    probeAnnotations: vi.fn(async () => ({ success: true, data: true })),
    remove: vi.fn(async () => ({ success: true })),
    onEvent: vi.fn((listener: Listener) => {
      listeners.push(listener)
      return () => undefined
    })
  }
  ;(window as unknown as { api: unknown }).api = { catalogLibrary: bridge }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
  setActiveLibrarySource(null)
})

describe('assetLibraryStore', () => {
  it('restores the server library chosen last time and switches the data source', async () => {
    const store = useAssetLibraryStore()
    await store.init()
    expect(store.isServer).toBe(true)
    expect(getActiveLibrarySource().kind).toBe('server')
    expect(store.capabilities).toMatchObject({
      tagModel: 'names',
      canImport: true,
      canEditStructure: false
    })
    expect(bridge.setActive).not.toHaveBeenCalled()
  })

  it('goes back to the local library and remembers the choice', async () => {
    const store = useAssetLibraryStore()
    await store.init()
    store.activateLocal()
    expect(store.isServer).toBe(false)
    expect(getActiveLibrarySource().kind).toBe('local')
    expect(store.capabilities.canEditStructure).toBe(true)
    expect(bridge.unwatch).toHaveBeenCalledWith('srv:lab')
    expect(bridge.setActive).toHaveBeenLastCalledWith(null)
  })

  it('turns offline into disabled imports with a reason', async () => {
    const store = useAssetLibraryStore()
    await store.init()
    listeners[0]({ kind: 'status', key: 'srv:lab', status: status({ online: false }) })
    expect(store.capabilities.canImport).toBe(false)
    expect(store.capabilities.reasons.canImport).toBe('catalogLibrary.reasons.offline')
  })

  it('shows sign-in when the server says the session ended', async () => {
    const store = useAssetLibraryStore()
    await store.init()
    expect(store.signedOut).toBe(false)
    listeners[0]({ kind: 'status', key: 'srv:lab', status: status({ signedOut: true }) })
    expect(store.signedOut).toBe(true)
  })

  it('counts invalidations for the library on screen only', async () => {
    const store = useAssetLibraryStore()
    await store.init()
    listeners[0]({
      kind: 'invalidate',
      key: 'other',
      scope: 'all',
      generation: 2,
      epoch: 1,
      reason: 'sse'
    })
    expect(store.invalidationCount).toBe(0)
    listeners[0]({
      kind: 'invalidate',
      key: 'srv:lab',
      scope: { dirIds: [], paths: ['Content'] },
      generation: 2,
      epoch: 1,
      reason: 'sse'
    })
    expect(store.invalidationCount).toBe(1)
    expect(store.lastInvalidation?.scope).toEqual({ dirIds: [], paths: ['Content'] })
  })

  it('puts import and download progress into the existing import task list', async () => {
    const store = useAssetLibraryStore()
    await store.init()
    const tasks = useImportTasksStore()
    listeners[0]({
      kind: 'job',
      key: 'srv:lab',
      job: { jobId: 'j1', type: 'import', phase: 'pushing', done: 2, total: 4 }
    })
    expect(tasks.tasks.get('j1')).toMatchObject({
      progress: 50,
      status: 'running',
      taskType: 'vault-import'
    })
    listeners[0]({
      kind: 'job',
      key: 'srv:lab',
      job: {
        jobId: 'j1',
        type: 'import',
        phase: 'failed',
        done: 2,
        total: 4,
        error: 'push refused'
      }
    })
    expect(tasks.tasks.get('j1')).toMatchObject({ status: 'error' })
  })

  it('stays on the local library when the saved server library is gone', async () => {
    bridge.getActive.mockResolvedValueOnce({ success: true, data: 'srv:removed' })
    const store = useAssetLibraryStore()
    await store.init()
    expect(store.isServer).toBe(false)
    expect(getActiveLibrarySource().kind).toBe('local')
  })
})
