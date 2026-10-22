import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount, shallowMount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { Router } from 'vue-router'
import { defineComponent, ref } from 'vue'
import i18n from '@renderer/i18n'
import NotebookDetail from './NotebookDetail.vue'
import NotebookLayout from './NotebookLayout.vue'
import { getTabCacheKey } from '@renderer/common/tabRoute'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { useNotebookStore } from '@renderer/store/modules/notebookStore'

vi.mock('./components/NoteSourcePanel.vue', () => ({
  default: defineComponent({
    name: 'NoteSourcePanelStub',
    template: '<div class="note-source-panel-stub" />'
  })
}))

vi.mock('@renderer/views/Assistant/Welcome.vue', () => ({
  default: defineComponent({
    name: 'AssistantWelcomeStub',
    props: { chatSid: { type: String, default: '' } },
    template: '<div class="assistant-welcome-stub" />'
  })
}))

vi.mock('@renderer/views/NoteEditor.vue', () => ({
  default: defineComponent({ name: 'NoteEditorStub', template: '<div class="note-editor-stub" />' })
}))

vi.mock('./components/NoteStudioPanel.vue', () => ({
  default: defineComponent({
    name: 'NoteStudioPanelStub',
    template: '<div class="note-studio-panel-stub" />'
  })
}))

vi.mock('./components/AddSourceModal.vue', () => ({
  default: defineComponent({
    name: 'AddSourceModalStub',
    template: '<div class="add-source-modal-stub" />'
  })
}))

vi.mock('./components/SourcePreviewPanel.vue', () => ({
  default: defineComponent({
    name: 'SourcePreviewPanelStub',
    template: '<div class="source-preview-panel-stub" />'
  })
}))

vi.mock('@renderer/services/webPage', () => ({
  createWebPageService: () => ({})
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/notebooks', name: 'NotebookList', component: { template: '<div />' } },
      { path: '/notebooks/:id', name: 'NotebookDetail', component: NotebookDetail }
    ]
  })
}

// 缓存 key 与 MainLayout 使用同一个函数：Layout 依靠它判断路由归属
const AppShell = defineComponent({
  setup: () => ({ getTabCacheKey }),
  template: `
    <router-view v-slot="{ Component, route }">
      <keep-alive>
        <component v-if="route.meta.keepAlive" :is="Component" :key="getTabCacheKey(route)" />
      </keep-alive>
      <component v-if="!route.meta.keepAlive" :is="Component" :key="route.fullPath" />
    </router-view>
  `
})

/**
 * 真实的 NotebookLayout + 外层 keep-alive：详情页拿到的 route 是 Layout
 * 冻结的那份，用户切去别的 tab 时它的 params 不会跟着变。
 *
 * 与真实应用一致，每次导航后创建 tab：Layout 根据 tab 是否还在决定是否保留子页。
 * useTabsStore() 取的是 beforeEach 设的那个 pinia，和挂载用的是同一个。
 */
function createLayoutTestRouter(): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: AppShell,
        children: [
          {
            path: 'notebooks',
            component: NotebookLayout,
            meta: { keepAlive: true },
            children: [
              {
                path: '',
                name: 'NotebookList',
                component: { template: '<div />' },
                meta: { keepAlive: true }
              },
              {
                path: ':id',
                name: 'NotebookDetail',
                component: NotebookDetail,
                meta: { keepAlive: true }
              }
            ]
          },
          { path: 'other', component: { template: '<div />' } }
        ]
      }
    ]
  })
  router.afterEach((to) => {
    useTabsStore().addTab(to)
  })
  return router
}

// 详情页挂载时会在 window 上监听 spotlight:source-added，不卸载会影响后续用例
enableAutoUnmount(afterEach)

describe('NotebookDetail', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)

    window.api = {
      ...window.api,
      notebook: {
        get: vi.fn().mockResolvedValue({
          id: 'notebook-1',
          title: 'Knowledge Alpha'
        }),
        getSources: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
        ragIndex: vi.fn(),
        updateSource: vi.fn(),
        createSource: vi.fn(),
        deleteSource: vi.fn()
      }
    } as unknown as typeof window.api
  })

  it('updates the dedicated tab title to the notebook title after loading data', async () => {
    const router = createTestRouter()
    await router.push('/notebooks/notebook-1?_tab_id=nb-tab-1')
    await router.isReady()

    const tabsStore = useTabsStore()
    tabsStore.historyTabs = [
      {
        key: '/notebooks/notebook-1?_tab_id=nb-tab-1',
        title: 'menu.notebookDetail',
        path: '/notebooks/notebook-1?_tab_id=nb-tab-1',
        sort: 1
      }
    ]

    shallowMount(NotebookDetail, {
      global: {
        plugins: [pinia, router, i18n],
        stubs: {
          teleport: true,
          'a-button': true
        }
      }
    })

    await flushPromises()

    expect(tabsStore.historyTabs[0]?.title).toBe('Knowledge Alpha')
  })

  /**
   * 社区版没有官方账号，也就没有云端分享。
   *
   * 断言的是「按钮不存在」而不是「点了会失败」—— 这个按钮此前判的是
   * `authStore.isAuthenticated`，而社区版那个值恒为 true（本机身份），
   * 所以它一直是可点的，点开分享弹层就会往官方服务端发请求。
   */
  it('社区版不渲染分享入口', async () => {
    const router = createTestRouter()
    await router.push('/notebooks/notebook-1')
    await router.isReady()

    const wrapper = shallowMount(NotebookDetail, {
      global: {
        plugins: [pinia, router, i18n],
        stubs: { teleport: true, 'a-button': true }
      }
    })

    await flushPromises()

    // 只剩「AI 对话」与「设置」两个本地能力入口，分享那个不渲染
    expect(wrapper.findAll('.header-right .header-action-btn')).toHaveLength(2)
  })

  it('内嵌助手收到的对话 id 是 chatSid（prop 改名类型检查看不见，这里兜住）', async () => {
    const router = createTestRouter()
    await router.push('/notebooks/notebook-1')
    await router.isReady()

    // keep-alive 在 shallowMount 里是空桩，不渲默认槽；renderStubDefaultSlot 让它渲出来，
    // 桩再把 prop 写进 DOM 属性断言（findComponent 穿不进 keep-alive）
    const assistantWelcomeStub = defineComponent({
      name: 'AssistantWelcomeStub',
      props: { chatSid: { type: String, default: '' } },
      template: '<div class="assistant-welcome-stub" :data-chat-sid="chatSid" />'
    })
    const wrapper = shallowMount(NotebookDetail, {
      global: {
        plugins: [pinia, router, i18n],
        renderStubDefaultSlot: true,
        stubs: { teleport: true, 'a-button': true, AssistantWelcome: assistantWelcomeStub }
      }
    })
    await flushPromises()

    expect(wrapper.find('.assistant-welcome-stub').attributes('data-chat-sid')).toBe(
      'notebook-chat-notebook-1'
    )
  })

  /**
   * 缓存中的详情页完成异步任务后（这里用 Spotlight 的「来源已添加」触发一次 loadSources），
   * 要写回它自己的笔记本，不能写进用户当前在前台查看的 tab。
   */
  it('writes sources loaded while cached by keep-alive to its own notebook', async () => {
    const router = createTestRouter()
    await router.push('/notebooks/notebook-cached')
    await router.isReady()

    const visible = ref(true)
    mount(
      defineComponent({
        components: { NotebookDetail },
        setup: () => ({ visible }),
        template: '<KeepAlive><NotebookDetail v-if="visible" /></KeepAlive>'
      }),
      {
        global: {
          plugins: [pinia, router, i18n],
          stubs: { teleport: true, 'a-button': true }
        }
      }
    )
    await flushPromises()

    type SourceRows = Awaited<ReturnType<typeof window.api.notebook.getSources>>
    const rowsOf = (sourceId: string): SourceRows =>
      [{ sourceId, title: sourceId, type: 'text', content: 'x' }] as unknown as SourceRows
    vi.mocked(window.api.notebook.getSources).mockImplementation(async (notebookId: string) =>
      rowsOf(notebookId === 'notebook-cached' ? 'cached-source' : 'front-source')
    )

    // 切到别的 tab：那个 tab 打开的是另一个笔记本
    visible.value = false
    await flushPromises()
    const notebookStore = useNotebookStore()
    notebookStore.setActiveNotebookId('notebook-front', 'front-tab')
    // 前台 tab 的详情页持有它自己的笔记本
    notebookStore.retainSources('notebook-front')
    await notebookStore.loadSources('notebook-front')

    window.dispatchEvent(
      new CustomEvent('spotlight:source-added', {
        detail: { notebookId: 'notebook-cached', sourceId: 'cached-source' }
      })
    )
    await flushPromises()

    expect(notebookStore.sourcesOf('notebook-front').map((s) => s.id)).toEqual(['front-source'])
    expect(notebookStore.sourcesOf('notebook-cached').map((s) => s.id)).toEqual(['cached-source'])
  })

  /**
   * keep-alive 中的 activated 会在两种情况下触发：新开 tab 首次挂载时，以及真正从后台切回时。
   * 前者已由 watch(immediate) 加载过，只有后者才需要重新拉取数据。
   */
  it('只在从缓存回到前台时才重新加载，首次挂载不重复请求', async () => {
    const router = createTestRouter()
    await router.push('/notebooks/notebook-1')
    await router.isReady()

    const visible = ref(true)
    mount(
      defineComponent({
        components: { NotebookDetail },
        setup: () => ({ visible }),
        template: '<KeepAlive><NotebookDetail v-if="visible" /></KeepAlive>'
      }),
      {
        global: {
          plugins: [pinia, router, i18n],
          stubs: { teleport: true, 'a-button': true }
        }
      }
    )
    await flushPromises()

    // 首次挂载：由 watch(immediate) 加载一次。这次 activated 不算从后台切回，不能重复加载
    expect(window.api.notebook.get).toHaveBeenCalledTimes(1)

    visible.value = false
    await flushPromises()
    visible.value = true
    await flushPromises()

    // 真正从后台切回时才重新拉取
    expect(window.api.notebook.get).toHaveBeenCalledTimes(2)
  })

  /**
   * 缓存中的详情页不能把整个应用带回列表页：它看到的是 Layout 冻结的路由，
   * 切到别的 tab 时 params 不变，所以跳转前要确认自己的 tab 仍在前台。
   */
  it('切去别的 tab 后，缓存页拿到「知识库不存在」不再跳转', async () => {
    const router = createLayoutTestRouter()
    let resolveGet!: (value: unknown) => void
    window.api.notebook.get = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve
        })
    ) as unknown as typeof window.api.notebook.get

    await router.push('/notebooks/n1?_tab_id=t1')
    await router.isReady()
    mount(defineComponent({ template: '<router-view />' }), {
      global: { plugins: [pinia, router, i18n] }
    })
    await flushPromises()

    await router.push('/other')
    await flushPromises()

    resolveGet(null)
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/other')
  })

  it('前台详情页拿到「知识库不存在」照旧跳回列表页', async () => {
    const router = createLayoutTestRouter()
    let resolveGet!: (value: unknown) => void
    window.api.notebook.get = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve
        })
    ) as unknown as typeof window.api.notebook.get

    await router.push('/notebooks/n1?_tab_id=t1')
    await router.isReady()
    mount(defineComponent({ template: '<router-view />' }), {
      global: { plugins: [pinia, router, i18n] }
    })
    await flushPromises()

    resolveGet(null)
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('NotebookList')
  })

  /**
   * 页面卸载后，缓存中的来源正文已经释放，但后台加工（retry 重新读取网页）完成后
   * 仍需向量化 —— 就绪判断不能依赖已不在缓存中的来源。
   */
  it('来源在页面卸载后加工完，照样触发向量化', async () => {
    const router = createTestRouter()
    await router.push('/notebooks/notebook-1')
    await router.isReady()

    window.api.notebook.getSources = vi.fn(async () => [
      {
        sourceId: 'src-1',
        title: 't',
        type: 'link',
        content: 'existing',
        sourceUrl: 'https://example.com'
      }
    ]) as unknown as typeof window.api.notebook.getSources
    let resolveRead!: (value: unknown) => void
    window.api.webRead = {
      read: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve
          })
      )
    } as unknown as typeof window.api.webRead
    window.api.notebook.ragIndex = vi.fn(async () => ({
      indexedSources: 1,
      indexedChunks: 1
    })) as unknown as typeof window.api.notebook.ragIndex

    const wrapper = mount(NotebookDetail, {
      global: {
        plugins: [pinia, router, i18n],
        stubs: { teleport: true, 'a-button': true }
      }
    })
    await flushPromises()

    // 触发 retry：先把来源标记为 loading，然后停在重新读取网页这一步
    wrapper.findComponent({ name: 'NoteSourcePanelStub' }).vm.$emit('retry', 'src-1')
    await flushPromises()

    wrapper.unmount()

    vi.useFakeTimers()
    try {
      resolveRead({ success: true, title: 't', content: 'page content' })
      await vi.advanceTimersByTimeAsync(10000)
    } finally {
      vi.useRealTimers()
    }

    expect(window.api.notebook.ragIndex).toHaveBeenCalledWith({ notebookId: 'notebook-1' })
  })

  /** keep-alive 不会因关闭 tab 而清理缓存：tab 关闭后，后台详情页必须卸载并释放来源正文 */
  it('关掉后台 tab 后详情页卸载，来源正文放掉', async () => {
    const router = createLayoutTestRouter()
    window.api.notebook.getSources = vi.fn(async () => [
      { sourceId: 'src-1', title: 't', type: 'text', content: 'x' }
    ]) as unknown as typeof window.api.notebook.getSources

    await router.push('/notebooks/n1?_tab_id=t1')
    await router.isReady()
    mount(defineComponent({ template: '<router-view />' }), {
      global: { plugins: [pinia, router, i18n] }
    })
    await flushPromises()
    const notebookStore = useNotebookStore()
    expect(notebookStore.sourcesOf('n1')).toHaveLength(1)

    await router.push('/other')
    await flushPromises()
    // tab 仍然打开：缓存中的页面继续持有
    expect(notebookStore.sourcesOf('n1')).toHaveLength(1)

    const tabsStore = useTabsStore()
    tabsStore.historyTabs = tabsStore.historyTabs.filter(
      (tab) => tab.key !== '/notebooks/n1?_tab_id=t1'
    )
    await flushPromises()

    expect(notebookStore.sourcesOf('n1')).toEqual([])
  })

  /**
   * 同一笔记本在两个 tab 中打开，关闭其中一个：另一个的来源不受影响；被关闭那个
   * 在途的加载返回后，不能再去恢复被中断的加工（另一个 tab 仍持有，loadSources 会放行）。
   */
  it('关掉开着同一笔记本的另一个 tab，不影响这边，也不再发起恢复', async () => {
    const router = createLayoutTestRouter()
    const pendingGets: ((value: unknown) => void)[] = []
    window.api.notebook.get = vi.fn(
      () =>
        new Promise((resolve) => {
          pendingGets.push(resolve)
        })
    ) as unknown as typeof window.api.notebook.get
    // 一条被中断的网页来源：处于 loading 状态且没有正文，加载完成后会被重新读取
    window.api.notebook.getSources = vi.fn(async () => [
      {
        sourceId: 'src-1',
        title: 't',
        type: 'link',
        content: '',
        loading: true,
        sourceUrl: 'https://example.com'
      }
    ]) as unknown as typeof window.api.notebook.getSources
    window.api.webRead = {
      read: vi.fn(() => new Promise(() => {}))
    } as unknown as typeof window.api.webRead

    await router.push('/notebooks/n1?_tab_id=t1')
    await router.isReady()
    mount(defineComponent({ template: '<router-view />' }), {
      global: { plugins: [pinia, router, i18n] }
    })
    await flushPromises()
    await router.push('/notebooks/n1?_tab_id=t2')
    await flushPromises()
    expect(pendingGets).toHaveLength(2)

    // t2 先加载完成：恢复它那条被中断的来源
    pendingGets[1]({ id: 'n1', title: 'N' })
    await flushPromises()
    expect(window.api.webRead.read).toHaveBeenCalledTimes(1)

    // 关闭后台的 t1，再让它在途的加载返回
    const tabsStore = useTabsStore()
    tabsStore.historyTabs = tabsStore.historyTabs.filter(
      (tab) => tab.key !== '/notebooks/n1?_tab_id=t1'
    )
    await flushPromises()
    pendingGets[0]({ id: 'n1', title: 'N' })
    await flushPromises()

    expect(window.api.webRead.read).toHaveBeenCalledTimes(1)
    expect(useNotebookStore().sourcesOf('n1')).toHaveLength(1)
  })
})
