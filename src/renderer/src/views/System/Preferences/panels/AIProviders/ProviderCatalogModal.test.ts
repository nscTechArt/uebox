/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
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
  }
]

const modalStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', slots.default?.())
  }
})

describe('ProviderCatalogModal provider logos', () => {
  it('renders bundled provider logos as native images and keeps fallback text separate', () => {
    const wrapper = mount(ProviderCatalogModal, {
      props: { visible: true, catalog },
      global: {
        stubs: { AppModal: modalStub },
        mocks: { $t: (key: string) => key }
      }
    })

    const logo = wrapper.get('img.catalog-card-logo-image')
    expect(logo.attributes('src')).toMatch(/^data:image\/svg\+xml/)
    expect(wrapper.find('.mono-icon').exists()).toBe(false)
    expect(wrapper.get('.catalog-card-logo-fallback').text()).toBe('F')
  })
})
