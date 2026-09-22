/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
// 直接 spy antd 的 Modal：confirmDialog 就是转调它，这样连选项翻译一起测到
import { Modal } from 'ant-design-vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { computed, ref } from 'vue'
import {} from '@renderer/utils/dialog'
import ModelManagerModal from './ModelManagerModal.vue'
import type { ProviderDraft, ProviderKind, ProviderView } from '@core/shared/aiProvider'
import type { AiProvidersState } from './useAiProviders'

/**
 * 这个弹窗自己只管两件事：**树的选中状态** 和 保存/删除/测试。
 *
 * 选中状态最容易出错的是删模型之后：下标全往前挪了一位，焦点不跟着动的话
 * 右边显示的就是**另一个模型** —— 用户会在完全不知情的情况下改错东西。
 */

const stubs = {
  // 只渲染 open 的弹窗：拦截框和主体是同一个 AppModal，不看 open 就分不出它开没开
  AppModal: {
    props: ['open'],
    template: '<div v-if="open !== false"><slot name="title" /><slot /></div>'
  },
  ProviderFields: { template: '<div class="provider-pane" />' },
  ModelFields: {
    props: ['state', 'index'],
    template: '<div class="model-pane">{{ index }}</div>'
  }
}

function makeState(
  models: { id: string; displayName?: string }[] = [],
  overrides: Partial<AiProvidersState> = {}
): AiProvidersState {
  const draft = ref<ProviderDraft>({
    id: 'p1',
    displayName: 'P1',
    kind: 'chat',
    protocol: 'openai-completions',
    baseUrl: 'https://a/v1',
    models: [...models]
  })

  return {
    draft,
    providers: computed(() => [
      {
        id: 'p1',
        displayName: 'P1',
        kind: 'chat',
        protocol: 'openai-completions',
        baseUrl: '',
        models: [],
        apiKey: { kind: 'none' }
      },
      {
        id: 'p2',
        displayName: 'P2',
        kind: 'chat',
        protocol: 'openai-completions',
        baseUrl: '',
        models: [],
        apiKey: { kind: 'none' }
      }
    ]),
    isNew: ref(false),
    isDirty: computed(() => false),
    saving: ref(false),
    testing: ref(false),
    selectedId: ref('p1'),
    configPath: computed(() => '/tmp/models.json'),
    selectProvider: vi.fn(),
    cancelEdit: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    importModels: vi.fn(),
    ...overrides
  } as unknown as AiProvidersState
}

function mountManager(state: AiProvidersState): VueWrapper {
  return mount(ModelManagerModal, {
    props: { open: true, state },
    global: { stubs, mocks: { $t: (key: string) => key } }
  })
}

describe('ModelManagerModal 的树', () => {
  it('默认显示 Provider 面板，不是某个模型', () => {
    const wrapper = mountManager(makeState([{ id: 'a' }]))

    expect(wrapper.find('.provider-pane').exists()).toBe(true)
    expect(wrapper.find('.model-pane').exists()).toBe(false)
  })

  it('点树上的模型，右边换成那个模型', async () => {
    const wrapper = mountManager(makeState([{ id: 'a' }, { id: 'b' }]))

    await wrapper.findAll('.tree-model')[1].trigger('click')

    expect(wrapper.find('.model-pane').text()).toBe('1')
    expect(wrapper.find('.provider-pane').exists()).toBe(false)
  })

  it('新建来源选中模型后，点 Provider 能回到来源面板', async () => {
    const state = makeState([{ id: 'a' }], {
      isNew: ref(true),
      selectedId: ref(null)
    })
    const wrapper = mountManager(state)

    await wrapper.find('.tree-model').trigger('click')
    await wrapper.findAll('.tree-provider').at(-1)!.trigger('click')

    expect(wrapper.find('.provider-pane').exists()).toBe(true)
    expect(wrapper.find('.model-pane').exists()).toBe(false)
  })

  /**
   * 删掉焦点**前面**那条时，剩下的下标整体前移一位。
   * 焦点不跟着减，右边显示的就是另一个模型 —— 而界面上没有任何变化提示。
   */
  it('删掉前面的模型后，焦点跟着往前挪一位', async () => {
    const state = makeState([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const wrapper = mountManager(state)

    await wrapper.findAll('.tree-model')[2].trigger('click')
    expect(wrapper.find('.model-pane').text()).toBe('2')

    // 删掉第 0 条：原来的 c 现在是下标 1
    await wrapper.findAll('.tree-model-remove')[0].trigger('click')

    expect(wrapper.find('.model-pane').text()).toBe('1')
    expect(state.draft.value!.models.map((m) => m.id)).toEqual(['b', 'c'])
  })

  it('删掉的正是选中那条时退回 Provider 面板', async () => {
    const wrapper = mountManager(makeState([{ id: 'a' }, { id: 'b' }]))

    await wrapper.findAll('.tree-model')[0].trigger('click')
    await wrapper.findAll('.tree-model-remove')[0].trigger('click')

    expect(wrapper.find('.provider-pane').exists()).toBe(true)
  })

  it('新增模型后直接聚焦到它，省得再点一次', async () => {
    const state = makeState([{ id: 'a' }])
    const wrapper = mountManager(state)

    await wrapper.find('.tree-add').trigger('click')

    expect(state.draft.value!.models).toHaveLength(2)
    expect(wrapper.find('.model-pane').text()).toBe('1')
  })

  /** 树上没填 id 的新模型不能是一行空白，否则根本点不着 */
  it('还没填 id 的模型在树上有占位名', () => {
    const wrapper = mountManager(makeState([{ id: '' }]))

    // modelLabel 走的是真的 i18n（组件内 useI18n），断言「有名字」而不是断言某个词
    expect(wrapper.findAll('.tree-model-name')[0].text().trim()).not.toBe('')
  })

  it('填了 id 就显示 id，填了显示名就优先显示显示名', () => {
    const wrapper = mountManager(makeState([{ id: 'a' }, { id: 'b', displayName: 'B 模型' }]))
    const names = wrapper.findAll('.tree-model-name').map((node) => node.text())

    expect(names[0]).toBe('a')
    expect(names[1]).toBe('B 模型')
  })
})

/**
 * 改到一半切走，以前是**静默丢弃**：`selectProvider` 直接覆盖草稿，
 * 界面上一点提示都没有，用户是过后发现改动没生效才回来重做的。
 */
describe('ModelManagerModal 的未保存拦截', () => {
  function dirtyState(overrides: Partial<AiProvidersState> = {}): AiProvidersState {
    return makeState([{ id: 'a' }], { isDirty: computed(() => true), ...overrides })
  }

  it('没改过就直接切，不弹拦截', async () => {
    const state = makeState([{ id: 'a' }])
    const wrapper = mountManager(state)

    await wrapper.findAll('.tree-provider')[1].trigger('click')

    expect(state.selectProvider).toHaveBeenCalledWith('p2')
    expect(wrapper.find('.unsaved-actions').exists()).toBe(false)
  })

  it('改过之后切 Provider 会被拦下来，且不真的切过去', async () => {
    const state = dirtyState()
    const wrapper = mountManager(state)

    await wrapper.findAll('.tree-provider')[1].trigger('click')

    expect(wrapper.find('.unsaved-actions').exists()).toBe(true)
    expect(state.selectProvider).not.toHaveBeenCalled()
  })

  it('选「留在这儿」：拦截框关掉，什么都没发生', async () => {
    const state = dirtyState()
    const wrapper = mountManager(state)

    await wrapper.findAll('.tree-provider')[1].trigger('click')
    await wrapper.findAll('.unsaved-actions button')[0].trigger('click')

    expect(wrapper.find('.unsaved-actions').exists()).toBe(false)
    expect(state.selectProvider).not.toHaveBeenCalled()
  })

  it('选「丢弃改动」：接着完成原来那个切换', async () => {
    const state = dirtyState()
    const wrapper = mountManager(state)

    await wrapper.findAll('.tree-provider')[1].trigger('click')
    await wrapper.find('.unsaved-actions .app-button--danger').trigger('click')

    expect(state.selectProvider).toHaveBeenCalledWith('p2')
  })

  it('选「保存并继续」：先存盘，存成功了才切', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true })
    const state = dirtyState({ save })
    const wrapper = mountManager(state)

    await wrapper.findAll('.tree-provider')[1].trigger('click')
    await wrapper.find('.unsaved-actions .app-button--primary').trigger('click')
    await flushPromises()

    expect(save).toHaveBeenCalled()
    expect(state.selectProvider).toHaveBeenCalledWith('p2')
  })

  /**
   * 存一条**新建**的 Provider 会让 selectedId 从 null 变成新 id，组件里那个
   * watch 跟着把待办清掉。先存盘再去读待办就是 null —— 表现是「存是存上了，
   * 但没有继续」，而用户以为自己已经切过去了。
   */
  it('保存的是新建的 Provider（selectedId 变了）也照样继续', async () => {
    const selectedId = ref<string | null>(null)
    const save = vi.fn().mockImplementation(async () => {
      selectedId.value = 'p-new'
      return { ok: true }
    })
    const state = dirtyState({ save, selectedId, isNew: ref(true) })
    const wrapper = mountManager(state)

    await wrapper.findAll('.tree-provider')[1].trigger('click')
    await wrapper.find('.unsaved-actions .app-button--primary').trigger('click')
    await flushPromises()

    expect(save).toHaveBeenCalled()
    expect(state.selectProvider).toHaveBeenCalledWith('p2')
  })

  /** 存盘失败还照切，等于把「保存并继续」变成了「丢弃并继续」 */
  it('存盘失败就留在原地，不切也不丢', async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, error: 'boom' })
    const state = dirtyState({ save })
    const wrapper = mountManager(state)

    await wrapper.findAll('.tree-provider')[1].trigger('click')
    await wrapper.find('.unsaved-actions .app-button--primary').trigger('click')
    await flushPromises()

    expect(state.selectProvider).not.toHaveBeenCalled()
    expect(wrapper.find('.unsaved-actions').exists()).toBe(true)
  })

  /** 关弹窗和切 Provider 一样是「离开草稿」，漏掉这个出口等于没拦 */
  it('关弹窗也走拦截，不直接关掉', async () => {
    const state = dirtyState()
    const wrapper = mountManager(state)

    await wrapper.findAll('.footer-actions .app-button--soft')[1].trigger('click')

    expect(wrapper.find('.unsaved-actions').exists()).toBe(true)
    expect(state.cancelEdit).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:open')).toBeUndefined()
  })

  it('「+ 添加 Provider」同样会被拦下来', async () => {
    const wrapper = mountManager(dirtyState())

    await wrapper.find('.tree-add-provider').trigger('click')

    expect(wrapper.find('.unsaved-actions').exists()).toBe(true)
    expect(wrapper.emitted('addProvider')).toBeUndefined()
  })

  /** 点树上的模型只是换右侧面板，草稿没动，拦了反而莫名其妙 */
  it('在同一个 Provider 里点模型不拦', async () => {
    const wrapper = mountManager(dirtyState())

    await wrapper.findAll('.tree-model')[0].trigger('click')

    expect(wrapper.find('.unsaved-actions').exists()).toBe(false)
    expect(wrapper.find('.model-pane').exists()).toBe(true)
  })

  it('改过的那条 Provider 在树上带个点', () => {
    expect(mountManager(dirtyState()).find('.tree-dirty').exists()).toBe(true)
    expect(
      mountManager(makeState([{ id: 'a' }]))
        .find('.tree-dirty')
        .exists()
    ).toBe(false)
  })
})

/**
 * 删除按钮**删的是右边正在看的那个东西**。
 *
 * 真实事故：按钮画在两个面板共用的标题行上，但不管右边显示的是 Provider
 * 还是某个模型，它调的永远是「删掉整条 Provider」。按钮就贴在模型的
 * 「模型 ID / 显示名」上面，用户以为删的是这个模型，一点下去连密钥、
 * 其余模型、指向它的角色绑定一起没 —— 而且这一步是直接落盘的，撤不回来。
 */
describe('ModelManagerModal 的删除按钮', () => {
  /** 拦住 Modal.confirm，把它的配置交出来，并允许直接触发 onOk */
  function captureConfirm(): { options: () => Record<string, unknown>; ok: () => unknown } {
    const spy = vi.spyOn(Modal, 'confirm').mockImplementation((options) => {
      return options as never
    })
    const options = (): Record<string, unknown> =>
      (spy.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>
    return {
      options,
      ok: () => (options().onOk as (() => unknown) | undefined)?.()
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('选中模型时，删除按钮删的是那个模型，不碰 Provider', async () => {
    const state = makeState([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const wrapper = mountManager(state)
    const confirm = captureConfirm()

    await wrapper.findAll('.tree-model')[1].trigger('click')
    await wrapper.find('.detail-actions .app-button--danger').trigger('click')
    confirm.ok()

    expect(state.remove).not.toHaveBeenCalled()
    expect(state.draft.value!.models.map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('选中 Provider 时，删除按钮才删整条 Provider', async () => {
    const state = makeState([{ id: 'a' }], {
      remove: vi.fn().mockResolvedValue({ ok: true })
    })
    const wrapper = mountManager(state)
    const confirm = captureConfirm()

    await wrapper.find('.detail-actions .app-button--danger').trigger('click')
    await confirm.ok()

    expect(state.remove).toHaveBeenCalledWith('p1')
  })

  /** 文案得写明删的是谁，否则两个确认框长得一样，用户凭位置猜 */
  it('两种删除的按钮文案不一样', async () => {
    const wrapper = mountManager(makeState([{ id: 'a' }]))
    const providerLabel = wrapper.find('.detail-actions .app-button--danger').text()

    await wrapper.findAll('.tree-model')[0].trigger('click')
    const modelLabel = wrapper.find('.detail-actions .app-button--danger').text()

    expect(providerLabel).not.toBe(modelLabel)
  })

  /** 删模型只是改草稿，点「保存」才落地；删 Provider 是立刻落盘的 */
  it('删模型不会顺手把草稿存盘', async () => {
    const state = makeState([{ id: 'a' }, { id: 'b' }])
    const wrapper = mountManager(state)
    const confirm = captureConfirm()

    await wrapper.findAll('.tree-model')[0].trigger('click')
    await wrapper.find('.detail-actions .app-button--danger').trigger('click')
    confirm.ok()

    expect(state.save).not.toHaveBeenCalled()
  })

  /** 新建中的 Provider 还没存盘，「删除 Provider」无从删起，但模型得能删 */
  it('新建中的草稿：能删模型，不给删 Provider', async () => {
    const state = makeState([{ id: 'a' }], { isNew: ref(true), selectedId: ref(null) })
    const wrapper = mountManager(state)

    expect(wrapper.find('.detail-actions .app-button--danger').exists()).toBe(false)

    await wrapper.findAll('.tree-model')[0].trigger('click')
    expect(wrapper.find('.detail-actions .app-button--danger').exists()).toBe(true)
  })
})

/**
 * 这一组原来逐条比对本文件里手写的 `.primary-btn` / `.ghost-btn` / `.danger-btn`
 * CSS（反相底、hover、focus-visible、disabled 各一条正则）。那些声明已经删了 ——
 * 三档全部收编进 `AppButton`，配色和状态反馈由它统一负责，`AppButton.test.ts`
 * 和 `docs/UI-Design-Standards.md` 在那边守着。
 *
 * 这里剩下要守的是**这个弹窗自己的选择**：哪个按钮是主操作、哪些是次操作、
 * 哪个是危险操作。再抄一遍颜色只会在改主题时多一处要同步的地方。
 */
describe('ModelManagerModal 的按钮层级', () => {
  it('底部只有「保存」是主按钮，测试和关闭走软按钮', () => {
    const wrapper = mountManager(makeState([{ id: 'a' }]))
    const footer = wrapper.findAll('.footer-actions button')

    expect(footer.filter((b) => b.classes('app-button--primary'))).toHaveLength(1)
    expect(footer[footer.length - 1].classes()).toContain('app-button--primary')
    expect(footer.filter((b) => b.classes('app-button--soft'))).toHaveLength(2)
  })

  it('删除按钮带危险语义，不是普通次按钮', async () => {
    const wrapper = mountManager(makeState([{ id: 'a' }]))
    await wrapper.findAll('.tree-model')[0].trigger('click')

    expect(wrapper.find('.detail-actions .app-button--danger').exists()).toBe(true)
  })
})

/**
 * 树按用途（kind）分组，标题能折叠。
 *
 * 分组用的是每条 Provider 自带的 kind 字段，标签复用表单里「用途」下拉的那一套文案。
 * 最容易翻的两处：折叠着的组里的 Provider 被选中了、新建的草稿归错组 —— 两种都会
 * 变成「右边在改一条左边看不见的东西」。
 */
function providerOf(id: string, kind: ProviderKind): ProviderView {
  return {
    id,
    displayName: id.toUpperCase(),
    kind,
    protocol: 'openai-completions',
    baseUrl: '',
    models: [],
    apiKey: { kind: 'none' }
  } as ProviderView
}

function groupTitles(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.tree-group-name').map((node) => node.text())
}

describe('ModelManagerModal 的树按用途分组', () => {
  it('每种用途一组，用「用途」下拉的文案做标题，没有 Provider 的用途不出现', () => {
    const wrapper = mountManager(
      makeState([], {
        providers: computed(() => [providerOf('deepseek', 'chat'), providerOf('seedream', 'image')])
      })
    )

    expect(groupTitles(wrapper)).toEqual([
      'aiProvider.field.kinds.chat',
      'aiProvider.field.kinds.image'
    ])
    expect(wrapper.findAll('.tree-provider-name').map((n) => n.text())).toEqual([
      'DEEPSEEK',
      'SEEDREAM'
    ])
  })

  it('组的顺序按用途固定，不看 Provider 数组里谁先谁后', () => {
    const wrapper = mountManager(
      makeState([], {
        providers: computed(() => [
          providerOf('doubao-rt', 'realtime'),
          providerOf('seedream', 'image'),
          providerOf('deepseek', 'chat')
        ])
      })
    )

    expect(groupTitles(wrapper)).toEqual([
      'aiProvider.field.kinds.chat',
      'aiProvider.field.kinds.image',
      'aiProvider.field.kinds.realtime'
    ])
  })

  it('标题上标着这一组有几条', () => {
    const wrapper = mountManager(
      makeState([], {
        providers: computed(() => [
          providerOf('a', 'chat'),
          providerOf('b', 'chat'),
          providerOf('c', 'image')
        ])
      })
    )

    expect(wrapper.findAll('.tree-group-count').map((n) => n.text())).toEqual(['2', '1'])
  })

  it('点标题折叠这一组，再点展开', async () => {
    const wrapper = mountManager(
      makeState([], {
        providers: computed(() => [providerOf('deepseek', 'chat'), providerOf('seedream', 'image')])
      })
    )
    const imageTitle = wrapper.findAll('.tree-group-title')[1]

    await imageTitle.trigger('click')
    expect(wrapper.findAll('.tree-provider-name').map((n) => n.text())).toEqual(['DEEPSEEK'])
    expect(imageTitle.attributes('aria-expanded')).toBe('false')
    // 折叠只影响这一组，标题本身还在，才有地方再点开
    expect(groupTitles(wrapper)).toHaveLength(2)

    await imageTitle.trigger('click')
    expect(wrapper.findAll('.tree-provider-name').map((n) => n.text())).toEqual([
      'DEEPSEEK',
      'SEEDREAM'
    ])
    expect(imageTitle.attributes('aria-expanded')).toBe('true')
  })

  it('折叠着的组里的 Provider 被选中时，这一组自动展开', async () => {
    const selectedId = ref<string | null>('deepseek')
    const wrapper = mountManager(
      makeState([], {
        selectedId,
        providers: computed(() => [providerOf('deepseek', 'chat'), providerOf('seedream', 'image')])
      })
    )

    await wrapper.findAll('.tree-group-title')[1].trigger('click')
    expect(wrapper.findAll('.tree-provider')).toHaveLength(1)

    selectedId.value = 'seedream'
    await flushPromises()

    expect(wrapper.findAll('.tree-provider-name').map((n) => n.text())).toEqual([
      'DEEPSEEK',
      'SEEDREAM'
    ])
  })

  it('搜服务商名：不匹配的整条连同空掉的组一起收起来', async () => {
    const wrapper = mountManager(
      makeState([], {
        providers: computed(() => [providerOf('deepseek', 'chat'), providerOf('seedream', 'image')])
      })
    )

    await wrapper.get('.tree-search').setValue('seed')

    expect(wrapper.findAll('.tree-provider-name').map((n) => n.text())).toEqual(['SEEDREAM'])
    expect(groupTitles(wrapper)).toEqual(['aiProvider.field.kinds.image'])
  })

  /** 想找 Kimi K3 的人未必记得它挂在哪条服务商底下 */
  it('搜模型名也能把它所属的那条服务商捞出来', async () => {
    const withModel = {
      ...providerOf('kimi-code', 'chat'),
      models: [{ id: 'k3-256k', displayName: 'Kimi K3-256K' }]
    } as ProviderView
    const wrapper = mountManager(
      makeState([], {
        providers: computed(() => [providerOf('deepseek', 'chat'), withModel])
      })
    )

    await wrapper.get('.tree-search').setValue('k3')

    expect(wrapper.findAll('.tree-provider-name').map((n) => n.text())).toEqual(['KIMI-CODE'])
  })

  /** 命中的东西藏在折叠着的组里，等于告诉用户「没找到」 */
  it('搜索时折叠的组一律展开', async () => {
    const wrapper = mountManager(
      makeState([], {
        providers: computed(() => [providerOf('deepseek', 'chat'), providerOf('seedream', 'image')])
      })
    )

    await wrapper.findAll('.tree-group-title')[1].trigger('click')
    expect(wrapper.findAll('.tree-provider')).toHaveLength(1)

    await wrapper.get('.tree-search').setValue('seed')
    expect(wrapper.findAll('.tree-provider-name').map((n) => n.text())).toEqual(['SEEDREAM'])
  })

  it('新建中的草稿归到它用途对应的组里，那一组原本没有 Provider 也会出现', () => {
    const state = makeState([], {
      isNew: ref(true),
      selectedId: ref(null),
      providers: computed(() => [providerOf('deepseek', 'chat')])
    })
    state.draft.value!.kind = 'image'
    const wrapper = mountManager(state)

    expect(groupTitles(wrapper)).toEqual([
      'aiProvider.field.kinds.chat',
      'aiProvider.field.kinds.image'
    ])
    // 新建那条在「生图」组里，计数也算上它
    expect(wrapper.findAll('.tree-group-count').map((n) => n.text())).toEqual(['1', '1'])
    const imageGroup = wrapper.findAll('.tree-group')[1]
    expect(imageGroup.find('.tree-provider.active .tree-provider-name').text()).toBe('P1')
  })

  it('新建草稿在表单里换了用途，树上跟着搬到新的组', async () => {
    const state = makeState([], {
      isNew: ref(true),
      selectedId: ref(null),
      providers: computed(() => [providerOf('deepseek', 'chat')])
    })
    const wrapper = mountManager(state)
    expect(groupTitles(wrapper)).toEqual(['aiProvider.field.kinds.chat'])

    state.draft.value!.kind = 'realtime'
    await flushPromises()

    expect(groupTitles(wrapper)).toEqual([
      'aiProvider.field.kinds.chat',
      'aiProvider.field.kinds.realtime'
    ])
    expect(wrapper.findAll('.tree-group')[0].findAll('.tree-provider')).toHaveLength(1)
    expect(wrapper.findAll('.tree-group')[1].find('.tree-provider.active').exists()).toBe(true)
  })
})
