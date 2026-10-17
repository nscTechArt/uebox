import { mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import type { ProviderDraft } from '@core/shared/aiProvider'
import type { AiProvidersState } from './useAiProviders'
import ProviderFields from './ProviderFields.vue'

describe('Provider advanced image settings', () => {
  it('edits music API independently and hides unsupported model import', async () => {
    const draft = ref<ProviderDraft>({
      id: 'music',
      displayName: 'Music',
      kind: 'music',
      musicApi: 'elevenlabs-music',
      protocol: 'openai-completions',
      baseUrl: 'https://music.example/v1',
      models: []
    })
    const wrapper = mount(ProviderFields, {
      props: { state: { draft, importing: ref(false) } as unknown as AiProvidersState },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: { ApiKeyField: true, 'a-select': true, 'a-select-option': true }
      }
    })
    const music = wrapper
      .findAllComponents({ name: 'ASelect' })
      .find((select) => select.attributes('value') === 'elevenlabs-music')!
    expect(music).toBeDefined()
    music.vm.$emit('update:value', 'mureka-music')
    await wrapper.vm.$nextTick()
    expect(draft.value.musicApi).toBe('mureka-music')
    expect(wrapper.find('input[type="url"]').exists()).toBe(false)
    music.vm.$emit('update:value', 'sunoapi-music')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('input[type="url"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('aiProvider.field.import')
    expect(wrapper.text()).not.toContain('aiProvider.field.protocol')
    wrapper.unmount()
  })
  it('starts off, toggles the draft, and only appears for image providers', async () => {
    const draft = ref<ProviderDraft>({
      id: 'images',
      displayName: 'Images',
      kind: 'image',
      protocol: 'openai-completions',
      baseUrl: 'https://gateway.example.com/v1',
      models: [],
      apiKeyInput: ''
    })
    const wrapper = mount(ProviderFields, {
      props: { state: { draft, importing: ref(false) } as unknown as AiProvidersState },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: { ApiKeyField: true, 'a-select': true, 'a-select-option': true }
      }
    })
    await wrapper.get('.fold-head').trigger('click')
    const toggle = wrapper.get('[role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    expect(draft.value.imageResolutionTiers).toBe(true)
    await toggle.trigger('click')
    expect(draft.value.imageResolutionTiers).toBe(false)
    draft.value.kind = 'chat'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="switch"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('Provider 用途', () => {
  function mountWith(catalogId?: string): { wrapper: VueWrapper; kind: VueWrapper } {
    const draft = ref<ProviderDraft>({
      id: 'elevenlabs-music',
      displayName: 'ElevenLabs Music',
      catalogId,
      kind: 'music',
      musicApi: 'elevenlabs-music',
      protocol: 'openai-completions',
      baseUrl: 'https://api.elevenlabs.io/v1',
      models: [{ id: 'music_v2' }]
    })
    const wrapper = mount(ProviderFields, {
      props: { state: { draft, importing: ref(false) } as unknown as AiProvidersState },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: { ApiKeyField: true, 'a-select': true, 'a-select-option': true }
      }
    })
    const kind = wrapper
      .findAllComponents({ name: 'ASelect' })
      .find((select) => select.attributes('value') === 'music')!
    return { wrapper, kind }
  }

  it('从目录添加的锁死用途，提示去目录添加另一条', () => {
    const { wrapper, kind } = mountWith('elevenlabs-music')
    expect(kind.attributes('disabled')).toBe('true')
    expect(wrapper.text()).toContain('aiProvider.field.kindLockedDesc')
    wrapper.unmount()
  })

  it('手工新建的用途可以改', () => {
    const { wrapper, kind } = mountWith(undefined)
    expect(kind.attributes('disabled')).toBe('false')
    expect(wrapper.text()).toContain('aiProvider.field.kindDesc')
    wrapper.unmount()
  })
})
