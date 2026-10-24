import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createApp } from 'vue'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import { StorageUtils } from '../../common/utils/storage'
import { chatHistoryStorage } from '../../utils/chatHistoryStorage'
import { useTabsStore } from './tabs'
import { useBaiduyunStore } from './baiduyun'
import { useWebdavStore } from './webdav'
import { useChatSessionsStore } from './chatSessions'
import { useAIConfigStore } from './aiConfig'
import { useChatSidebarStore } from './chatSidebarStore'
import { useNoteViewStore } from './noteViewStore'
import { useAssetViewStore } from './assetViewStore'
import { useAssetSelectionStore } from './assetSelectionStore'

/**
 * pick 白名单必须真生效：插件 v4 只认 pick/omit，字段清单写成 v3 的 paths
 * 会被静默忽略、整份 state 落盘并整份恢复。断言每个 store 的持久化内容只剩
 * pick 列出的键。baiduyun/webdav/chat-sessions/note-view/asset-view 的 state
 * 有 pick 之外的字段，回退到 paths 时落盘键会多出来，这几条因此能防住回退
 * （用例改动字段是为了触发写盘）；tabs/ai-config/chat-sidebar/asset-selection
 * 的 state 恰好等于 pick，这几条只钉落盘键集合，测试本身防不住回退 —— 那由
 * 类型检查兜底：usePersistOptions 的参数和插件的 PersistenceOptions 都没有 paths。
 */
describe('store 持久化 pick 白名单', () => {
  beforeEach(() => {
    localStorage.clear()
    // chatHistoryStorage 是模块单例，内存镜像 cache 不随 localStorage.clear() 清掉
    chatHistoryStorage.removeItem('chat-sessions')
    const pinia = createPinia().use(piniaPluginPersistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
  })

  const readPersisted = (key: string, encrypted = false): Record<string, unknown> => {
    const raw = localStorage.getItem(key)
    expect(raw).not.toBeNull()
    const parsed = encrypted
      ? StorageUtils.decrypt<Record<string, unknown>>(raw!)
      : JSON.parse(raw!)
    expect(parsed).not.toBeNull()
    return parsed as Record<string, unknown>
  }

  it('usePersistOptions 把字段清单映射为插件 v4 的 pick，不再发 paths', () => {
    const options = usePersistOptions<{ a: string }>({ key: 'k', pick: ['a'] })
    expect(options).toMatchObject({ key: 'k', pick: ['a'] })
    expect(options).not.toHaveProperty('paths')
  })

  // 钉住整张落盘清单，而不是只查「没有 imageDraftsById」—— 文字草稿是故意落盘的
  // （打了半段话关掉应用，那段话不该没）。图片草稿不许进：File 序列化后只剩 {}，
  // 恢复出来是坏草稿；preview 是 base64，可能让整份重写的 chat-sessions.json
  // 膨胀到几十 MB。往这张单子里加东西要有意为之。
  it('chat-sessions 只落 pick 字段；base64 图片草稿不进持久层', async () => {
    const store = useChatSessionsStore()
    store.setDraft('s1', 'half typed')
    store.trySetImageDraft('s1', [
      {
        id: 'i1',
        file: new File(['x'], 'a.png', { type: 'image/png' }),
        preview: 'data:image/png;base64,eA==',
        uploading: false
      }
    ])
    await flushPromises()

    const raw = chatHistoryStorage.getItem('chat-sessions')
    expect(raw).not.toBeNull()
    const persisted = JSON.parse(raw!) as Record<string, unknown>
    expect(Object.keys(persisted).sort()).toEqual(['draftsById', 'permissionModeById', 'sessions'])
    expect(persisted).not.toHaveProperty('imageDraftsById')
  })

  it('tabs-store 只落 historyTabs 和 activeTab', async () => {
    useTabsStore().$patch({ activeTab: '/notes' })
    await flushPromises()
    expect(Object.keys(readPersisted('tabs-store')).sort()).toEqual(['activeTab', 'historyTabs'])
  })

  it('baiduyun-store 落 token/appConfig/currentDir，上传任务运行态不落盘', async () => {
    const store = useBaiduyunStore()
    store.setCurrentDir('/dir/sub')
    store.$patch({ uploadTasksVersion: 9 })
    await flushPromises()
    expect(Object.keys(readPersisted('baiduyun-store', true)).sort()).toEqual([
      'appConfig',
      'currentDir',
      'token'
    ])
  })

  it('webdav-store 落 connection/history/currentDir，上传任务运行态不落盘', async () => {
    const store = useWebdavStore()
    store.setCurrentDir('/dir/sub')
    store.$patch({ uploadTasksVersion: 9 })
    await flushPromises()
    expect(Object.keys(readPersisted('webdav-store', true)).sort()).toEqual([
      'connection',
      'currentDir',
      'history'
    ])
  })

  it('ai-config-store 只落 config', async () => {
    const store = useAIConfigStore()
    store.$patch({ config: { ...store.config, autoRetitleEnabled: true } })
    await flushPromises()
    expect(Object.keys(readPersisted('ai-config-store', true))).toEqual(['config'])
  })

  it('chat-sidebar 落侧边栏那六个字段', async () => {
    useChatSidebarStore().$patch({ collapsedGroups: ['g1'] })
    await flushPromises()
    expect(Object.keys(readPersisted('chat-sidebar')).sort()).toEqual([
      'collapsedGroups',
      'groupMode',
      'hiddenProjects',
      'manualProjects',
      'pinnedProjects',
      'sortMode'
    ])
  })

  it('note-view-store 只落 tabStates，更新通知标记不落盘', async () => {
    const store = useNoteViewStore()
    store.setTabState('t1', { selectedNoteId: 5 })
    store.notifyNoteUpdated(3)
    await flushPromises()
    expect(Object.keys(readPersisted('note-view-store', true))).toEqual(['tabStates'])
  })

  it('asset-view-store 只落 mode', async () => {
    const store = useAssetViewStore()
    store.ensureWebdav()
    store.markTreeNeedsRefresh({ parentKey: 'k', createdCount: 1 })
    await flushPromises()
    expect(Object.keys(readPersisted('asset-view-store', true))).toEqual(['mode'])
  })

  it('asset-selection-store 只落两个选中项', async () => {
    useAssetSelectionStore().$patch({ selectedTreeKey: 'k1' })
    await flushPromises()
    expect(Object.keys(readPersisted('asset-selection-store', true)).sort()).toEqual([
      'selectedShortcut',
      'selectedTreeKey'
    ])
  })
})
