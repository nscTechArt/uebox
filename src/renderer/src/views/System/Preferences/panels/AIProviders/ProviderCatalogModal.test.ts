/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import type { CatalogEntry } from '@core/shared/aiProvider'
import ProviderCatalogModal from './ProviderCatalogModal.vue'

const catalog: CatalogEntry[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    kind: 'chat',
    protocol: 'openai-responses',
    baseUrl: 'https://example.invalid',
    group: 'cloud',
    requiresApiKey: true,
    hasLogo: true,
    models: []
  },
  {
    id: 'without-logo',
    displayName: 'Fallback',
    kind: 'chat',
    protocol: 'openai-completions',
    baseUrl: 'https://example.invalid',
    group: 'cloud',
    requiresApiKey: true,
    models: []
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot AI',
    kind: 'chat',
    protocol: 'openai-completions',
    baseUrl: 'https://example.invalid',
    group: 'cn',
    requiresApiKey: true,
    models: [{ id: 'kimi-k2', displayName: 'Kimi K2' } as CatalogEntry['models'][number]]
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    kind: 'chat',
    protocol: 'openai-completions',
    baseUrl: 'http://localhost:11434/v1',
    group: 'local',
    requiresApiKey: false,
    models: []
  },
  {
    id: 'seedream',
    displayName: 'Seedream',
    kind: 'image',
    protocol: 'openai-completions',
    baseUrl: 'https://example.invalid',
    requiresApiKey: true,
    models: []
  }
]

const modalStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', slots.default?.())
  }
})

function mountModal(): ReturnType<typeof mount<typeof ProviderCatalogModal>> {
  return mount(ProviderCatalogModal, {
    props: { visible: true, catalog },
    global: {
      stubs: { AppModal: modalStub },
      mocks: { $t: (key: string) => key }
    }
  })
}

function cardNames(wrapper: ReturnType<typeof mountModal>): string[] {
  return wrapper.findAll('.catalog-card-name').map((node) => node.text())
}

describe('ProviderCatalogModal provider logos', () => {
  it('renders bundled provider logos as native images and keeps fallback text separate', () => {
    const wrapper = mountModal()

    const logo = wrapper.get('img.catalog-card-logo-image')
    expect(logo.attributes('src')).toMatch(/^data:image\/svg\+xml/)
    expect(wrapper.find('.mono-icon').exists()).toBe(false)
    const fallback = wrapper
      .findAll('.catalog-card')
      .find((card) => card.find('.catalog-card-name').text() === 'Fallback')!
    expect(fallback.get('.catalog-card-logo-fallback').text()).toBe('F')
  })
})

/**
 * 目录长到 73 家之后，一条直筒滚动把 32 家能力型厂商全挤到第一屏外面，
 * 表现和「目录里没有」几乎一样。分页是为了治这个，所以这几条测的都是
 * **该看见的看得见**，而不是样式。
 */
describe('ProviderCatalogModal 分页', () => {
  it('默认停在对话页，生图厂商不占对话页的位置', () => {
    const wrapper = mountModal()

    expect(cardNames(wrapper)).toContain('OpenAI')
    expect(cardNames(wrapper)).not.toContain('Seedream')
  })

  it('切到生图页才看得到生图厂商', async () => {
    const wrapper = mountModal()

    // 分页顺序：对话、生图与视频、语音、音乐与 3D、检索与工具
    await wrapper.findAll('.app-segmented__item')[1].trigger('click')

    expect(cardNames(wrapper)).toContain('Seedream')
    expect(cardNames(wrapper)).not.toContain('OpenAI')
  })

  it('分页标题上带命中数，搜索时跟着关键词变', async () => {
    const wrapper = mountModal()
    const counts = (): string[] => wrapper.findAll('.catalog-tab-count').map((node) => node.text())

    expect(counts()[0]).toBe('4')
    expect(counts()[1]).toBe('1')

    await wrapper.get('.catalog-search').setValue('seedream')
    await nextTick()

    expect(counts()[0]).toBe('0')
    expect(counts()[1]).toBe('1')
  })
})

describe('ProviderCatalogModal 搜索', () => {
  it('搜得到模型名 —— 想配 Kimi 的人未必知道厂商叫 Moonshot', async () => {
    const wrapper = mountModal()

    await wrapper.get('.catalog-search').setValue('kimi')
    await nextTick()

    expect(cardNames(wrapper)).toEqual(['Moonshot AI'])
  })

  it('命中的东西在别的分页里就把人带过去，而不是谎称没有', async () => {
    const wrapper = mountModal()
    await wrapper.findAll('.app-segmented__item')[1].trigger('click')
    expect(cardNames(wrapper)).toContain('Seedream')

    await wrapper.get('.catalog-search').setValue('kimi')
    await nextTick()
    await nextTick()

    expect(wrapper.find('.catalog-empty').exists()).toBe(false)
    expect(cardNames(wrapper)).toEqual(['Moonshot AI'])
  })

  it('敲关键词直接回车就选中第一条，不用碰鼠标', async () => {
    const wrapper = mountModal()

    await wrapper.get('.catalog-search').setValue('kimi')
    await nextTick()
    await wrapper.get('.catalog-search').trigger('keydown.enter')

    expect(wrapper.emitted('pick')?.[0]?.[0]).toMatchObject({ id: 'moonshot' })
  })

  // 输入法拼字时的回车是「上屏」：不能顺手把高亮那家选上、把弹窗关了
  it('输入法拼字时按回车不选', async () => {
    const wrapper = mountModal()

    await wrapper.get('.catalog-search').setValue('kimi')
    await nextTick()
    await wrapper.get('.catalog-search').trigger('keydown.enter', { isComposing: true })

    expect(wrapper.emitted('pick')).toBeUndefined()
  })

  it('上下键在结果里走，走到哪高亮到哪', async () => {
    const wrapper = mountModal()

    await wrapper.get('.catalog-search').setValue('o')
    await nextTick()
    // 分区顺序是 local → cn → cloud，键盘就按这个顺序走
    expect(cardNames(wrapper)).toEqual(['Ollama', 'Moonshot AI', 'OpenAI', 'Fallback'])
    expect(wrapper.get('.catalog-card.is-active .catalog-card-name').text()).toBe('Ollama')

    await wrapper.get('.catalog-search').trigger('keydown.down')
    expect(wrapper.get('.catalog-card.is-active .catalog-card-name').text()).toBe('Moonshot AI')

    // 到头了要绕回去，不然最后一条底下按不动，看着像卡住
    await wrapper.get('.catalog-search').trigger('keydown.up')
    await wrapper.get('.catalog-search').trigger('keydown.up')
    expect(wrapper.get('.catalog-card.is-active .catalog-card-name').text()).toBe('Fallback')
  })

  it('不搜索时不预选，免得一打开就有个看不出来源的高亮', () => {
    const wrapper = mountModal()

    expect(wrapper.find('.catalog-card.is-active').exists()).toBe(false)
  })
})

describe('ProviderCatalogModal 卡片副标题', () => {
  it('先说要不要密钥 —— 那才决定「我现在能不能用上」', () => {
    const wrapper = mountModal()
    const descOf = (name: string): string =>
      wrapper
        .findAll('.catalog-card')
        .find((card) => card.find('.catalog-card-name').text() === name)!
        .get('.catalog-card-desc')
        .text()

    expect(descOf('Ollama')).toContain('aiProvider.catalog.access.free')
    expect(descOf('OpenAI')).toContain('aiProvider.catalog.access.key')
    expect(descOf('OpenAI')).toContain('aiProvider.catalog.noPresetModelsShort')
    expect(descOf('Moonshot AI')).toContain('aiProvider.catalog.modelCountShort')
  })
})
