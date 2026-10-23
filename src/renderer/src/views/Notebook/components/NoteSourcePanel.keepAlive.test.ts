import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import NoteSourcePanel from './NoteSourcePanel.vue'
import { useNotebookStore, type SourceItem } from '@renderer/store/modules/notebookStore'

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  autoUpdate: vi.fn(() => vi.fn()),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn()
}))

const SOURCE_CHANGED = 'agent:notebook:source-changed'

function mountPanel(notebookId: string, sources: SourceItem[] = []): VueWrapper {
  return mount(NoteSourcePanel, {
    props: { sources, notebookId },
    global: { stubs: { 'a-input': true } }
  }) as VueWrapper
}

/**
 * 详情页被 keep-alive 缓存时，会同时存在多个 NoteSourcePanel，
 * 而且缓存中的面板不会重新挂载。它们之间不能互相干扰。
 */
describe('NoteSourcePanel 与别的缓存面板共存', () => {
  type Listener = (event: unknown, ...args: unknown[]) => unknown
  const listeners = new Map<string, Set<Listener>>()
  const ipc = vi.mocked(window.electron.ipcRenderer)

  // 按 preload 的实际行为模拟监听：on 返回只移除自身监听的函数，removeAllListeners 清空整个频道
  beforeEach(() => {
    listeners.clear()
    ipc.on.mockImplementation((channel: string, listener: Listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(channel, set)
      return () => {
        set.delete(listener)
      }
    })
    ipc.removeAllListeners.mockImplementation((channel: string) => {
      listeners.delete(channel)
    })
  })

  afterEach(() => {
    ipc.on.mockReset()
    ipc.removeAllListeners.mockReset()
  })

  it('一个面板卸载后，别的面板照样收到「助手存了来源」', async () => {
    const store = useNotebookStore()
    const loadSources = vi.spyOn(store, 'loadSources').mockResolvedValue(undefined)

    const kept = mountPanel('nb-kept')
    const leaving = mountPanel('nb-leaving')
    leaving.unmount()

    for (const listener of listeners.get(SOURCE_CHANGED) ?? []) {
      listener({}, { notebookId: 'nb-kept' })
    }

    expect(loadSources).toHaveBeenCalledWith('nb-kept')
    kept.unmount()
  })

  it('选中状态按面板自己的来源算，不跟前台 tab 走', () => {
    const store = useNotebookStore()
    // 前台 tab 开着的是另一个笔记本
    store.setActiveNotebookId('nb-front', 'front-tab')

    const wrapper = mountPanel('nb-background', [
      { id: 'kept-in', title: '进上下文', type: 'note', content: '正文', contextLevel: 'full' },
      { id: 'left-out', title: '不进', type: 'note', content: '正文', contextLevel: 'excluded' }
    ])

    const [included, excluded] = wrapper.findAll('.source-item')
    expect(included.classes()).not.toContain('unselected')
    expect(excluded.classes()).toContain('unselected')
  })
})
