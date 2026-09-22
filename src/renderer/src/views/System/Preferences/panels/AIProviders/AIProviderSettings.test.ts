/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import AIProviderSettings from './AIProviderSettings.vue'
import { MODEL_ROLES, type SettingsView } from '@core/shared/aiProvider'

/**
 * 默认只露出四个核心角色，其余折叠在「更多能力」后面。
 *
 * 数量取自 `MODEL_ROLES` 而不是写死：写死的话，每加一个角色（image、tts、asr、
 * model3d 都加过）断言就红一次，而它们要守的其实是「骨架占位与真下拉一一对应」，
 * 与到底有几个角色无关。
 */
const CORE_ROLE_COUNT = 4
const ROLE_COUNT = MODEL_ROLES.length

/**
 * 这一页以前的毛病是**抢答**：settings 还在 IPC 路上，computed 全部落到空档
 * （providers 空列表、configured false、roles 空对象），界面先把「还没有可用的
 * 模型」「未设置」这些结论画出来，数据一到又全部推翻 —— 用户看到空态闪一下
 * 才变成真容。
 *
 * 这里守的是首屏时序：加载没回来时是骨架，回来之后结论才允许上屏。
 * 替身打在 `window.api.aiProvider` 上，composable 与视图都走真的。
 */

const stubs = {
  'a-tooltip': { template: '<span><slot name="title" /><slot /></span>' },
  'a-select': {
    props: [
      'value',
      'placeholder',
      'showSearch',
      'optionFilterProp',
      'optionLabelProp',
      'title',
      'ariaLabel'
    ],
    emits: ['change'],
    // role-clear 是测试用的把手：真下拉的「清除」按钮在 antd 内部，
    // 这里只要能把 change(undefined) 发出来就够了
    template:
      '<div class="role-select" :data-value="value" :data-search="showSearch" :data-filter="optionFilterProp" :data-label-prop="optionLabelProp" :title="title" :aria-label="ariaLabel"><button class="role-clear" type="button" @click="$emit(\'change\', undefined)" /><span class="ant-select-selection-item">{{ title }}</span><slot /></div>'
  },
  'a-select-opt-group': {
    props: ['label'],
    template: '<div class="model-group" :data-label="label"><slot /></div>'
  },
  'a-select-option': {
    props: ['value', 'label'],
    template: '<div class="model-option" :data-value="value" :data-label="label"><slot /></div>'
  },
  'a-skeleton': { template: '<div class="skeleton-card" />' },
  'a-skeleton-button': { template: '<div class="skeleton-select" />' },
  ModelManagerModal: { template: '<div />' },
  ProviderCatalogModal: { template: '<div />' }
}

const loadedSettings: SettingsView = {
  configured: true,
  encryptionAvailable: true,
  path: 'C:\\Users\\u\\AppData\\Roaming\\unreal-box\\models.json',
  providers: [
    {
      id: 'deepseek',
      displayName: 'DeepSeek',
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'https://api.deepseek.com/v1',
      models: [{ id: 'v4-flash', displayName: 'DeepSeek V4 Flash', supportsVision: true }],
      apiKey: { kind: 'none' }
    }
  ],
  roles: { chat: { providerId: 'deepseek', modelId: 'v4-flash' } }
}

const emptySettings: SettingsView = {
  providers: [],
  roles: {},
  path: '',
  encryptionAvailable: true,
  configured: false
}

const longNameSettings: SettingsView = {
  configured: true,
  encryptionAvailable: true,
  path: 'C:\\models.json',
  providers: [
    {
      id: 'dashscope',
      displayName: '阿里云百炼（通义千问）',
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'https://dashscope.example/v1',
      models: [
        { id: 'qwen3-coder-plus', displayName: 'Qwen3-Coder-Plus' },
        { id: 'qwen3-max', displayName: 'Qwen3-Max' },
        { id: 'qwen3-vl', displayName: 'Qwen3-VL', supportsVision: true }
      ],
      apiKey: { kind: 'none' }
    }
  ],
  roles: { chat: { providerId: 'dashscope', modelId: 'qwen3-coder-plus' } }
}

/**
 * 替掉 IPC 层。默认的 getSettings 是**永不落地**的 Promise —— 正好模拟
 * 「请求在途」；要测加载完成就传一个会 resolve 的实现。
 */
function stubAiProviderApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    aiProvider: {
      getSettings: vi.fn(() => new Promise<SettingsView>(() => {})),
      catalog: vi.fn(async () => []),
      ...overrides
    }
  } as unknown as typeof window.api
}

function mountSettings(): ReturnType<typeof mount> {
  return mount(AIProviderSettings, { global: { stubs } })
}

describe('AIProviderSettings 的首屏加载', () => {
  it('加载没回来时用骨架占位，不抢着显示空态', async () => {
    stubAiProviderApi()
    const wrapper = mountSettings()
    // onMounted 把 loading 抬起来后要等一个微任务重渲染才落到 DOM 上
    // —— 浏览器里这个刷新发生在绘制之前，所以用户看不见中间那一帧
    await nextTick()

    // 「还没有可用的模型」横幅和「未设置」徽标都是结论，加载完之前不允许上屏
    expect(wrapper.find('.provider-banner').exists()).toBe(false)
    expect(wrapper.find('.role-missing').exists()).toBe(false)

    // 真卡片与下拉退场，骨架替上：两张来源卡 + 每个角色一个占位
    expect(wrapper.find('.source-name').exists()).toBe(false)
    expect(wrapper.findAll('.skeleton-card')).toHaveLength(2)
    // 加载中还不知道哪些可选角色配过，先按默认露出的那四个占位
    expect(wrapper.findAll('.skeleton-select')).toHaveLength(CORE_ROLE_COUNT)
    // 「更多能力（N）」里的 N 这时候也还不知道，所以按钮一起等
    expect(wrapper.find('.role-disclosure').exists()).toBe(false)
  })

  it('加载完成后骨架退场，换上真内容', async () => {
    let resolveSettings!: (value: SettingsView) => void
    stubAiProviderApi({
      getSettings: vi.fn(
        () =>
          new Promise<SettingsView>((resolve) => {
            resolveSettings = resolve
          })
      )
    })
    const wrapper = mountSettings()

    resolveSettings(loadedSettings)
    await flushPromises()

    expect(wrapper.find('.skeleton-card').exists()).toBe(false)
    expect(wrapper.find('.skeleton-select').exists()).toBe(false)
    expect(wrapper.find('.provider-banner').exists()).toBe(false)

    const names = wrapper.findAll('.source-name').map((node) => node.text())
    expect(names).toEqual(['DeepSeek'])

    // 「对话」绑定要真的选中已存的那一项，而不是退回「未设置」
    const selects = wrapper.findAll('.role-select')
    expect(selects).toHaveLength(CORE_ROLE_COUNT)
    expect(selects[0].attributes('data-value')).toBe('deepseek::v4-flash')
  })

  it('摘要和快速合并为一个轻量任务模型选择', async () => {
    stubAiProviderApi({ getSettings: vi.fn(async () => loadedSettings) })
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.text()).toContain('轻量任务')
    expect(wrapper.text()).toContain('总结、起标题、判断意图')
    expect(wrapper.text()).not.toContain('快速')
  })

  it('加载完了确实一个服务商都没有：空态照常出现，不被骨架吞掉', async () => {
    stubAiProviderApi({ getSettings: vi.fn(async () => emptySettings) })
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.find('.provider-banner').exists()).toBe(true)
    expect(wrapper.text()).toContain('还没有服务商')
    // 真的没配就是不回落角色的真用不了，徽标该出现还是要出现
    expect(wrapper.findAll('.role-missing').length).toBeGreaterThan(0)
  })

  /**
   * 「一把密钥都没存」有两种截然相反的含义：本机推理确实不需要，
   * 厂商那边是漏填了。只看 apiKey.kind 分不出来，于是 Google Nano Banana
   * 这种必然 401 的条目会在列表上拿到一张写着「无需密钥」的绿卡。
   */
  it('目录说要密钥却一把没存时说「缺少密钥」，本机推理才是「无需密钥」', async () => {
    stubAiProviderApi({
      getSettings: vi.fn(async () => ({
        ...loadedSettings,
        providers: [
          { ...loadedSettings.providers[0], id: 'ollama', displayName: 'Ollama' },
          { ...loadedSettings.providers[0], id: 'google-image', displayName: 'Google Nano Banana' }
        ]
      })),
      catalog: vi.fn(async () => [
        { id: 'ollama', displayName: 'Ollama', requiresApiKey: false, models: [] },
        { id: 'google-image', displayName: 'Google Nano Banana', requiresApiKey: true, models: [] }
      ])
    })
    const wrapper = mountSettings()
    await flushPromises()

    const badges = wrapper.findAll('.source-key')
    expect(badges[0].text()).toBe('无需密钥')
    expect(badges[1].text()).toBe('缺少密钥')
    expect(badges[1].classes()).toContain('warn')
  })

  it('长 Provider 名不会再挡住模型名，并且菜单按 Provider 分组且可搜索', async () => {
    stubAiProviderApi({ getSettings: vi.fn(async () => longNameSettings) })
    const wrapper = mountSettings()
    await flushPromises()

    const chatSelect = wrapper.findAll('.role-select')[0]
    expect(chatSelect.attributes('data-search')).toBe('')
    expect(chatSelect.attributes('data-filter')).toBe('label')
    expect(chatSelect.attributes('data-label-prop')).toBe('label')
    expect(chatSelect.attributes('title')).toBe('Qwen3-Coder-Plus · 阿里云百炼（通义千问）')

    const groups = chatSelect.findAll('.model-group')
    expect(groups).toHaveLength(1)
    expect(groups[0].attributes('data-label')).toBe('阿里云百炼（通义千问）')

    const options = groups[0].findAll('.model-option')
    expect(options.map((option) => option.text())).toEqual([
      'Qwen3-Coder-Plus',
      'Qwen3-Max',
      'Qwen3-VL'
    ])
    expect(options[0].attributes('data-label')).toBe('Qwen3-Coder-Plus · 阿里云百炼（通义千问）')
  })

  /**
   * 用途上移之后，实时语音是**单独一条 Provider**，不再是通用 OpenAI 下的一个
   * 带能力位的模型。对话那条里的模型一个都不该混进来。
   */
  it('实时语音下拉只列 realtime 用途的 Provider，DeepSeek 与普通 GPT 不混入', async () => {
    const openai = {
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'chat' as const,
      protocol: 'openai-responses' as const,
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-5.6', displayName: 'GPT-5.6' }],
      apiKey: { kind: 'none' as const }
    }
    const realtime = {
      id: 'openai-realtime',
      displayName: 'OpenAI Realtime',
      kind: 'realtime' as const,
      protocol: 'openai-responses' as const,
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-realtime-2.1', displayName: 'GPT-Realtime-2.1' }],
      apiKey: { kind: 'none' as const }
    }
    stubAiProviderApi({
      getSettings: vi.fn(async () => ({
        ...loadedSettings,
        providers: [...loadedSettings.providers, openai, realtime]
      }))
    })
    const wrapper = mountSettings()
    await flushPromises()

    // 实时语音默认折在「更多能力」里
    await wrapper.get('.role-disclosure').trigger('click')

    const realtimeIndex = MODEL_ROLES.indexOf('realtime')
    const realtimeSelect = wrapper.findAll('.role-select')[realtimeIndex]
    const options = realtimeSelect.findAll('.model-option')

    expect(options.map((option) => option.attributes('data-value'))).toEqual([
      'openai-realtime::gpt-realtime-2.1'
    ])
    expect(realtimeSelect.text()).not.toContain('DeepSeek')
    expect(realtimeSelect.text()).not.toContain('GPT-5.6')
  })

  /**
   * 十四个角色平铺是一整屏下拉框，其中十个是没配的人根本不需要看见的可选能力。
   * 折叠规则只有一条：**核心四个 + 已经配过的**留在外面，其余收起来。
   */
  it('默认只露出核心四个，其余折进「更多能力」', async () => {
    stubAiProviderApi({ getSettings: vi.fn(async () => loadedSettings) })
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.findAll('.role-select')).toHaveLength(CORE_ROLE_COUNT)
    expect(wrapper.text()).toContain('对话')
    expect(wrapper.text()).not.toContain('音乐生成')
    expect(wrapper.get('.role-disclosure').text()).toContain(`${ROLE_COUNT - CORE_ROLE_COUNT}`)
  })

  it('展开看全部，再点一下收回去', async () => {
    stubAiProviderApi({ getSettings: vi.fn(async () => loadedSettings) })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('.role-disclosure').trigger('click')
    expect(wrapper.findAll('.role-select')).toHaveLength(ROLE_COUNT)
    expect(wrapper.get('.role-disclosure').attributes('aria-expanded')).toBe('true')

    await wrapper.get('.role-disclosure').trigger('click')
    expect(wrapper.findAll('.role-select')).toHaveLength(CORE_ROLE_COUNT)
  })

  it('配过的可选角色留在外面，不用每次展开才找得到', async () => {
    stubAiProviderApi({
      getSettings: vi.fn(async () => ({
        ...loadedSettings,
        providers: [
          ...loadedSettings.providers,
          {
            id: 'seedream',
            displayName: '火山方舟 Seedream',
            kind: 'image' as const,
            protocol: 'openai-completions' as const,
            baseUrl: 'https://ark.example/v3',
            models: [{ id: 'seedream-5', displayName: 'Seedream 5.0' }],
            apiKey: { kind: 'none' as const }
          }
        ],
        roles: {
          ...loadedSettings.roles,
          image: { providerId: 'seedream', modelId: 'seedream-5' }
        }
      }))
    })
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.findAll('.role-select')).toHaveLength(CORE_ROLE_COUNT + 1)
    expect(wrapper.text()).toContain('生图')
    // 露出来的那个不该再算进「还折着几个」
    expect(wrapper.get('.role-disclosure').text()).toContain(`${ROLE_COUNT - CORE_ROLE_COUNT - 1}`)
  })

  /**
   * 只进不出：折叠状态下把一个可选角色清成未设置，那一行不能当场消失 ——
   * 用户刚点完就找不到自己点的是哪儿了，想改回去还得先展开。
   */
  it('清空已配的可选角色后，那一行仍然留在外面', async () => {
    const withImage = {
      ...loadedSettings,
      roles: {
        ...loadedSettings.roles,
        image: { providerId: 'deepseek', modelId: 'v4-flash' }
      }
    }
    stubAiProviderApi({
      getSettings: vi.fn(async () => withImage),
      // 主进程回的是清掉 image 之后的整份设置
      setRoles: vi.fn(async () => ({ ok: true, data: loadedSettings }))
    })
    const wrapper = mountSettings()
    await flushPromises()

    const imageSelect = wrapper.findAll('.role-select')[CORE_ROLE_COUNT]
    expect(imageSelect.attributes('data-value')).toBe('deepseek::v4-flash')

    await imageSelect.get('.role-clear').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.role-select')).toHaveLength(CORE_ROLE_COUNT + 1)
    expect(
      wrapper.findAll('.role-select')[CORE_ROLE_COUNT].attributes('data-value')
    ).toBeUndefined()
  })

  it('悬停或聚焦被截断的已选模型时滚到末尾，离开后回到开头', async () => {
    stubAiProviderApi({ getSettings: vi.fn(async () => longNameSettings) })
    const wrapper = mountSettings()
    await flushPromises()

    const chatSelect = wrapper.findAll('.role-select')[0]
    const selection = chatSelect.find('.ant-select-selection-item').element as HTMLElement
    Object.defineProperty(selection, 'scrollWidth', { configurable: true, value: 500 })
    Object.defineProperty(selection, 'clientWidth', { configurable: true, value: 200 })
    const scrollTo = vi.fn()
    selection.scrollTo = scrollTo

    await chatSelect.trigger('mouseenter')
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 500 })

    await chatSelect.trigger('mouseleave')
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0 })

    await chatSelect.trigger('focus')
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 500 })
  })
})
