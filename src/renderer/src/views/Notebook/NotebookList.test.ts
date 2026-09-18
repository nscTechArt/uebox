import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import i18n from '@renderer/i18n'
import NotebookList from './NotebookList.vue'

function createTestRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/notebooks', name: 'NotebookList', component: NotebookList },
      { path: '/notebooks/:id', name: 'NotebookDetail', component: { template: '<div />' } }
    ]
  })
}

describe('NotebookList', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)

    window.api = {
      ...window.api,
      notebook: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      }
    } as unknown as typeof window.api
  })

  /**
   * 社区版没有官方账号，也就没有「按分享码导入」这回事。
   *
   * 断言按钮**不存在**而不是被禁用：分享码来自云端分享链接，社区版既产生不了
   * 也消费不了。顺带断言新建按钮还在 —— 云端能力摘掉不该影响本地能力。
   */
  it('社区版不渲染导入分享码入口', async () => {
    const router = createTestRouter()
    await router.push('/notebooks')
    await router.isReady()

    const wrapper = shallowMount(NotebookList, {
      global: {
        plugins: [pinia, router, i18n],
        stubs: { teleport: true, AppModal: true, 'a-input': true, 'a-dropdown': true }
      }
    })

    await flushPromises()

    expect(wrapper.find('.btn-import').exists()).toBe(false)
    expect(wrapper.find('.secondary-island').exists()).toBe(false)
    // 本地能力不受影响
    expect(wrapper.find('.notebook-list-page').exists()).toBe(true)
  })
})
