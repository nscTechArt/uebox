import { config, flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import zhCN from '@renderer/i18n/locales/zh-CN'
import enUS from '@renderer/i18n/locales/en-US'
import type { AiProvidersState } from './useAiProviders'
import ApiKeyField from './ApiKeyField.vue'

vi.mock('@renderer/utils/messageManager', () => ({
  message: { info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))
afterEach(() => vi.unstubAllGlobals())

describe('ZCode subscription sign-in field', () => {
  it.each(['zh-CN', 'en-US'])(
    'shows honest expiry guidance and reuses sign-in (%s)',
    async (locale) => {
      const oauthLogin = vi.fn().mockResolvedValue({ ok: true, saved: true })
      const state = {
        draft: ref({ id: 'zcode-2', apiKeyInput: '' }),
        selectedId: ref('zcode-2'),
        catalog: ref([{ id: 'zcode', displayName: 'ZCode Coding Plan', supportsOAuth: true }]),
        providers: ref([{ id: 'zcode-2', apiKey: { kind: 'oauth', hasKey: true } }]),
        authorizing: ref(false),
        oauthLogin,
        cancelOAuth: vi.fn()
      } as unknown as AiProvidersState
      const messages = { 'zh-CN': zhCN, 'en-US': enUS }
      const copy = messages[locale as keyof typeof messages].aiProvider.apiKey
      vi.stubGlobal('api', { ...window.api, aiProvider: { onOAuthDeviceCode: () => () => {} } })
      const previousPlugins = config.global.plugins
      config.global.plugins = []
      const wrapper = mount(ApiKeyField, {
        props: { state },
        global: {
          plugins: [createI18n({ legacy: false, locale, messages })],
          stubs: { AppModal: true }
        }
      })
      config.global.plugins = previousPlugins
      expect(wrapper.text()).toContain(copy.zcodeHint)
      expect(wrapper.text()).toContain(copy.zcodeLinked.replace('{name}', 'ZCode Coding Plan'))
      expect(wrapper.text()).not.toContain(copy.oauthLinked.replace('{name}', 'ZCode Coding Plan'))
      await wrapper.get('.key-row button').trigger('click')
      await flushPromises()
      expect(oauthLogin).toHaveBeenCalledWith('zcode')
      expect(wrapper.get('input').element.value).toBe('')
      wrapper.unmount()
    }
  )
})
