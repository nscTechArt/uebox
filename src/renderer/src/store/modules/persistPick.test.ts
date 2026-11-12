import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createApp } from 'vue'
import { StorageUtils } from '../../common/utils/storage'
import { secureStorage } from '../../utils/secureStorage'
import { useAIConfigStore } from './aiConfig'
import { useAssetSelectionStore } from './assetSelectionStore'
import { useAssetViewStore } from './assetViewStore'
import { useBaiduyunStore } from './baiduyun'
import { useChatSessionsStore } from './chatSessions'
import { useChatSidebarStore } from './chatSidebarStore'
import { useNoteViewStore } from './noteViewStore'
import { useTabsStore } from './tabs'
import { useWebdavStore } from './webdav'

// 对话列表本来写磁盘，这里换成 localStorage，好跟其他 store 用同一种方式读回来
vi.mock('../../utils/chatHistoryStorage', () => ({ chatHistoryStorage: localStorage }))

/**
 * 每个 store 实际写进存储的字段，必须正好是 pick 声明的那几个。
 *
 * 插件 v4 不认旧的 `paths`，写错配置项名不会报错，只会把整份 state 落盘
 * （曾经因此把 base64 图片草稿写进对话历史）。所以这里不看源码怎么写，
 * 只看存储里真的有什么：把没声明的字段都改成标记值，再读回存储检查。
 */
const MARKER = '__not_persisted__'

type AnyStore = {
  $state: Record<string, unknown>
  $patch: (mutate: (state: Record<string, unknown>) => void) => void
}

const cases: {
  key: string
  encoded: boolean
  use: () => unknown
  pick: string[]
  /** 凭据类 store 写主进程加密存储，测试里读它的内存副本 */
  storage?: Pick<Storage, 'getItem'>
}[] = [
  { key: 'ai-config-store', encoded: true, use: useAIConfigStore, pick: ['config'] },
  {
    key: 'asset-selection-store',
    encoded: true,
    use: useAssetSelectionStore,
    pick: ['selectedShortcut', 'selectedTreeKey']
  },
  { key: 'asset-view-store', encoded: true, use: useAssetViewStore, pick: ['mode'] },
  {
    key: 'baiduyun-store',
    encoded: true,
    use: useBaiduyunStore,
    pick: ['token', 'appConfig'],
    storage: secureStorage
  },
  {
    key: 'chat-sessions',
    encoded: false,
    use: useChatSessionsStore,
    pick: ['sessions', 'permissionModeById', 'draftsById']
  },
  {
    key: 'chat-sidebar',
    encoded: false,
    use: useChatSidebarStore,
    pick: [
      'groupMode',
      'sortMode',
      'collapsedGroups',
      'manualProjects',
      'hiddenProjects',
      'pinnedProjects'
    ]
  },
  { key: 'note-view-store', encoded: true, use: useNoteViewStore, pick: ['tabStates'] },
  { key: 'tabs-store', encoded: false, use: useTabsStore, pick: ['historyTabs', 'activeTab'] },
  {
    key: 'webdav-store',
    encoded: true,
    use: useWebdavStore,
    pick: ['connection', 'history'],
    storage: secureStorage
  }
]

describe('store persistence writes only the picked fields', () => {
  beforeEach(() => {
    localStorage.clear()
    // 插件要在 pinia 装到 app 上之后才生效
    const pinia = createPinia().use(piniaPluginPersistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
  })

  it.each(cases)('$key', async ({ key, encoded, use, pick, storage = localStorage }) => {
    const store = use() as AnyStore
    const unpicked = Object.keys(store.$state).filter((field) => !pick.includes(field))
    store.$patch((state) => {
      for (const field of unpicked) state[field] = MARKER
    })
    await flushPromises()

    const raw = storage.getItem(key)
    expect(raw).not.toBeNull()
    const saved = (encoded ? StorageUtils.decrypt(raw!) : JSON.parse(raw!)) as object
    expect(Object.keys(saved).sort()).toEqual([...pick].sort())
    expect(JSON.stringify(saved)).not.toContain(MARKER)
    if (storage !== localStorage) expect(localStorage.getItem(key)).toBeNull()
  })

  it('chat sessions do not persist image drafts', async () => {
    const store = useChatSessionsStore() as unknown as AnyStore
    store.$patch((state) => {
      state.imageDraftsById = { s1: [{ id: 'img', preview: 'data:image/png;base64,AAAA' }] }
      state.draftsById = { s1: 'half a sentence' }
    })
    await flushPromises()

    const saved = JSON.parse(localStorage.getItem('chat-sessions')!)
    expect(saved.draftsById).toEqual({ s1: 'half a sentence' })
    expect(saved).not.toHaveProperty('imageDraftsById')
  })

  it('a stored value that cannot be decoded leaves the store at its defaults', () => {
    localStorage.setItem('note-view-store', 'not base64 json')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(useNoteViewStore().tabStates).toEqual({})
    expect(StorageUtils.createCustomSerializer().deserialize('not base64 json')).toEqual({})
  })
})
