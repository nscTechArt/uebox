/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
import ProviderCatalogModal from './ProviderCatalogModal.vue'
import ModelManagerModal from './ModelManagerModal.vue'
import { Z_CATALOG, Z_CONFIRM, Z_MANAGER } from './modalLayers'
import type { AiProvidersState } from './useAiProviders'

/**
 * 弹窗层级。
 *
 * 不钉死会怎样：ant 的 Modal 默认全是 z-index 1000，谁压谁就由 body 里的
 * DOM 先后决定 —— 而那个先后是「本次会话里谁先被打开过一次」。于是同一段
 * 代码有两种表现：先开过目录再进管理弹窗，管理弹窗里点「+ 添加 Provider」
 * 弹出来的目录在**后面**（看上去像点了没反应）；反过来又是好的。
 *
 * 所以这里断言的是**数值关系**，不是具体数字。
 */
describe('弹窗层级', () => {
  it('目录压住管理弹窗，确认框压住所有人', () => {
    expect(Z_CATALOG).toBeGreaterThan(Z_MANAGER)
    expect(Z_CONFIRM).toBeGreaterThan(Z_CATALOG)
  })

  /** ant 的下拉取「基准 + 50」，层号排太密下拉会卡在两层弹窗中间 */
  it('层与层之间留得下 ant 的浮层（基准 + 50）', () => {
    expect(Z_CATALOG - Z_MANAGER).toBeGreaterThan(50)
    expect(Z_CONFIRM - Z_CATALOG).toBeGreaterThan(50)
  })

  /** 记下每个 AppModal 拿到的 z-index，同时把默认插槽渲染出来（内嵌的弹窗在里面） */
  function spyModal(seen: number[]): ReturnType<typeof defineComponent> {
    return defineComponent({
      inheritAttrs: false,
      props: { zIndex: { type: Number, default: 0 } },
      setup(props, { slots }) {
        seen.push(props.zIndex)
        return () => h('div', slots.default?.())
      }
    })
  }

  it('目录弹窗真的把层级传给了 AppModal', () => {
    const seen: number[] = []
    const wrapper = mount(ProviderCatalogModal, {
      props: { visible: true, catalog: [] },
      global: {
        stubs: { AppModal: spyModal(seen) },
        mocks: { $t: (key: string) => key }
      }
    })

    expect(seen).toContain(Z_CATALOG)
    wrapper.unmount()
  })

  it('管理弹窗与它内嵌的未保存确认框各自拿到自己那层', () => {
    const seen: number[] = []
    const state = {
      draft: ref({
        id: 'p1',
        displayName: 'P1',
        protocol: 'openai-completions',
        baseUrl: '',
        models: []
      }),
      providers: computed(() => []),
      isNew: ref(false),
      isDirty: computed(() => true),
      saving: ref(false),
      testing: ref(false),
      selectedId: ref('p1'),
      configPath: computed(() => '')
    } as unknown as AiProvidersState

    const wrapper = mount(ModelManagerModal, {
      props: { open: true, state },
      global: {
        stubs: { AppModal: spyModal(seen), ProviderFields: true, ModelFields: true },
        mocks: { $t: (key: string) => key }
      }
    })

    expect(seen).toContain(Z_MANAGER)
    expect(seen).toContain(Z_CONFIRM)
    wrapper.unmount()
  })
})
