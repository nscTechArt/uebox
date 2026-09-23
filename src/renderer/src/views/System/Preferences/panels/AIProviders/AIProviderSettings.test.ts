/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import AIProviderSettings from './AIProviderSettings.vue'
import { MODEL_ROLES, type SettingsView } from '@core/shared/aiProvider'

/**
 * 角色数量取自 `MODEL_ROLES` 而不是写死。
 *
 * 写死的话，每加一个角色（image、tts、asr、model3d 都加过）这两条断言就红一次，
 * 而它们要守的其实是「骨架占位与真下拉一一对应」，与到底有几个角色无关。
 */
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
    template:
      '<div class="role-select" :data-value="value" :data-search="showSearch" :data-filter="optionFilterProp" :data-label-prop="optionLabelProp" :title="title" :aria-label="ariaLabel"><span class="ant-select-selection-item">{{ title }}</span><slot /></div>'
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
    expect(wrapper.findAll('.skeleton-select')).toHaveLength(ROLE_COUNT)
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
    expect(selects).toHaveLength(ROLE_COUNT)
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

    const realtimeIndex = MODEL_ROLES.indexOf('realtime')
    const realtimeSelect = wrapper.findAll('.role-select')[realtimeIndex]
    const options = realtimeSelect.findAll('.model-option')

    expect(options.map((option) => option.attributes('data-value'))).toEqual([
      'openai-realtime::gpt-realtime-2.1'
    ])
    expect(realtimeSelect.text()).not.toContain('DeepSeek')
    expect(realtimeSelect.text()).not.toContain('GPT-5.6')
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

/**
 * 创作者 Token Plan 的来源只读：它的地址、模型、Key 都由套餐卡片管。
 * 列表里不是按钮、点了不开编辑弹窗，只标一句「由创作者 Token Plan 管理」。
 */
describe('套餐来源只读', () => {
  const withPlan: SettingsView = {
    ...loadedSettings,
    providers: [
      ...loadedSettings.providers,
      {
        id: 'creator-plan',
        displayName: 'Creator Plan',
        kind: 'chat',
        protocol: 'openai-completions',
        baseUrl: 'https://plan.example/v1',
        models: [{ id: 'uebox-agent' }],
        apiKey: { kind: 'literal', hasKey: true }
      }
    ]
  }

  it('套餐来源显示「由创作者 Token Plan 管理」，点了不开编辑弹窗；别的来源照常能点', async () => {
    stubAiProviderApi({ getSettings: vi.fn(async () => withPlan) })
    const wrapper = mount(AIProviderSettings, {
      global: {
        stubs: {
          ...stubs,
          ModelManagerModal: {
            props: ['open'],
            template: '<div class="manager" :data-open="String(open)" />'
          }
        }
      }
    })
    await flushPromises()

    const plan = wrapper.find('[data-provider-id="creator-plan"]')
    expect(plan.element.tagName).toBe('DIV')
    expect(plan.text()).toContain('由创作者 Token Plan 管理')
    await plan.trigger('click')
    expect(wrapper.find('.manager').attributes('data-open')).toBe('false')

    await wrapper.find('[data-provider-id="deepseek"]').trigger('click')
    expect(wrapper.find('.manager').attributes('data-open')).toBe('true')
  })
})
