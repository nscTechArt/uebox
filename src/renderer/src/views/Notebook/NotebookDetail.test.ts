import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import i18n from '@renderer/i18n'
import NotebookDetail from './NotebookDetail.vue'
import { useTabsStore } from '@renderer/store/modules/tabs'

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
})
