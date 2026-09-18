import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h } from 'vue'
import i18n from '@renderer/i18n'
import NotebookDetail from './NotebookDetail.vue'
import { useNotebookStore } from '@renderer/store/modules/notebookStore'

/**
 * 回归测试：批量添加网页搜索结果时，来源 ID 不能撞车。
 *
 * ## 复现的是什么
 *
 * `NoteSourcePanel.vue` 的「添加选中」是一个同步 for 循环，连续 emit 好几个
 * `add-web-source`。`NotebookDetail.vue::handleAddSource` 原来用
 * `Date.now().toString()` 当 ID —— 循环体每一轮的同步部分（几个字符串操作、
 * 一次数组 push）远用不到 1 毫秒，`Date.now()` 精度只有毫秒，于是好几个来源
 * 拿到完全相同的 ID。source_id 在数据库里是 UNIQUE 约束，后面几个的
 * createSource 请求全部因主键冲突失败；失败清理逻辑按 ID 做等值判断来定位
 * 要移除的那一条，ID 相同时这个判断对哪一条都成立，于是每失败一次就顺手
 * 删掉数组里随便一条同 ID 的来源——5 个只剩 1 个。
 *
 * 这里不经过真实的搜索结果弹窗（那需要伺候 antd Modal/Checkbox 的 teleport
 * 和交互，跟这个 bug 本身无关），而是把 `NoteSourcePanel` 换成一个精简桩：
 * 一次点击就同步触发 5 次 `add-web-source`——这正是原来那个 for 循环在
 * 一个事件循环 tick 里做的事，是复现这个 bug 的最小充分条件。
 */

vi.mock('./components/NoteSourcePanel.vue', () => ({
  default: defineComponent({
    name: 'NoteSourcePanelStub',
    emits: ['add-web-source'],
    setup(_props, { emit }) {
      const fireFiveSynchronously = (): void => {
        for (let i = 0; i < 5; i++) {
          emit('add-web-source', `https://example.com/page-${i}`, `Page ${i}`)
        }
      }
      return () =>
        h('button', { class: 'fire-five-web-sources', onClick: fireFiveSynchronously }, '批量添加')
    }
  })
}))

vi.mock('@renderer/views/Assistant/Welcome.vue', () => ({
  default: defineComponent({
    name: 'AssistantWelcomeStub',
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

function createTestRouter(): ReturnType<typeof createRouter> {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/notebooks', name: 'NotebookList', component: { template: '<div />' } },
      { path: '/notebooks/:id', name: 'NotebookDetail', component: NotebookDetail }
    ]
  })
}

describe('批量添加网页来源', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)

    window.api = {
      ...window.api,
      // 模拟数据库真实的 UNIQUE 约束：同一个 sourceId 第二次插入直接拒绝，
      // 不用这条约束的话，这个测试就算原来的 Date.now() bug 还在也会通过——
      // 那样测试就没有意义了
      notebook: {
        get: vi.fn().mockResolvedValue({ id: 'notebook-1', title: 'Knowledge Alpha' }),
        getSources: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
        ragIndex: vi.fn(),
        updateSource: vi.fn(),
        createSource: vi.fn(async (data: { sourceId?: string }) => {
          const seen = (createSourceCalls.seenIds ??= new Set<string>())
          createSourceCalls.calls.push(data.sourceId ?? '')
          if (data.sourceId && seen.has(data.sourceId)) {
            throw new Error('UNIQUE constraint failed: notebook_sources.source_id')
          }
          if (data.sourceId) seen.add(data.sourceId)
          return data.sourceId ?? ''
        }),
        deleteSource: vi.fn()
      },
      jina: {
        read: vi.fn().mockResolvedValue({ success: false, error: 'not used in this test' })
      }
    } as unknown as typeof window.api
  })

  const createSourceCalls: { calls: string[]; seenIds?: Set<string> } = { calls: [] }

  it('同一个事件循环 tick 里连续添加 5 个来源，全部拿到不重复的 ID', async () => {
    createSourceCalls.calls = []
    createSourceCalls.seenIds = undefined

    const router = createTestRouter()
    await router.push('/notebooks/notebook-1')
    await router.isReady()

    const wrapper = shallowMount(NotebookDetail, {
      global: {
        plugins: [pinia, router, i18n],
        // shallowMount 会把「每一个子组件」都自动换成空壳，不管它是不是已经
        // 被 vi.mock 过——NoteSourcePanel 必须显式排除在外，测试才踩得到
        // 上面那个精简桩里真正会 emit 事件的按钮
        stubs: { teleport: true, 'a-button': true, NoteSourcePanel: false }
      }
    })

    await flushPromises()

    await wrapper.find('.fire-five-web-sources').trigger('click')
    await flushPromises()

    // 五次 createSource 调用，sourceId 互不相同——这是这次修的那个条件本身
    expect(createSourceCalls.calls).toHaveLength(5)
    expect(new Set(createSourceCalls.calls).size).toBe(5)

    // 因此没有一条因为 UNIQUE 冲突被清理逻辑顺手删掉：5 个来源全部留在列表里
    const notebookStore = useNotebookStore()
    expect(notebookStore.sources).toHaveLength(5)
    expect(new Set(notebookStore.sources.map((s) => s.id)).size).toBe(5)
  })
})
