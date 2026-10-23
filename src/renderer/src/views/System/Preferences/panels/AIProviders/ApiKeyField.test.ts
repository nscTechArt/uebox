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

/**
 * 「Codex 生图」与「Codex」对话是同一个 ChatGPT 账号：已经登录过的，添加生图来源时
 * 要说清楚「保存就行」，登录按钮也要走 chatgpt 那一家的授权而不是生图条目自己的 id。
 */
describe('Codex image source reuses the ChatGPT sign-in', () => {
  function mountField(
    providers: unknown[],
    apiKeyInput = ''
  ): {
    wrapper: ReturnType<typeof mount>
    oauthLogin: ReturnType<typeof vi.fn>
  } {
    const oauthLogin = vi.fn().mockResolvedValue({ ok: true, saved: true })
    const state = {
      draft: ref({ id: 'chatgpt-image', catalogId: 'chatgpt-image', apiKeyInput }),
      selectedId: ref(null),
      catalog: ref([
        {
          id: 'chatgpt-image',
          displayName: 'Codex 生图（ChatGPT 订阅）',
          supportsOAuth: true,
          oauthProvider: 'chatgpt'
        }
      ]),
      providers: ref(providers),
      authorizing: ref(false),
      oauthLogin,
      cancelOAuth: vi.fn()
    } as unknown as AiProvidersState
    vi.stubGlobal('api', { ...window.api, aiProvider: { onOAuthDeviceCode: () => () => {} } })
    const previousPlugins = config.global.plugins
    config.global.plugins = []
    const wrapper = mount(ApiKeyField, {
      props: { state },
      global: {
        plugins: [
          createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN, 'en-US': enUS } })
        ],
        stubs: { AppModal: true }
      }
    })
    config.global.plugins = previousPlugins
    return { wrapper, oauthLogin }
  }

  const codexChat = {
    id: 'chatgpt',
    displayName: 'Codex',
    apiKey: { kind: 'oauth', provider: 'chatgpt', hasKey: true }
  }
  const shared = zhCN.aiProvider.apiKey.oauthShared.replace('{name}', 'Codex')

  it('已有 Codex 登录：提示沿用，保存即可', () => {
    const { wrapper } = mountField([codexChat])
    expect(wrapper.text()).toContain(shared)
    wrapper.unmount()
  })

  it('没有登录过、或用户自己填了密钥：不提示', () => {
    const none = mountField([])
    expect(none.wrapper.text()).not.toContain(shared)
    none.wrapper.unmount()
    const typed = mountField([codexChat], 'OPENAI_KEY')
    expect(typed.wrapper.text()).not.toContain(shared)
    typed.wrapper.unmount()
  })

  it('登录按钮走 chatgpt 那一家的授权', async () => {
    const { wrapper, oauthLogin } = mountField([])
    await wrapper.get('.key-row button').trigger('click')
    await flushPromises()
    expect(oauthLogin).toHaveBeenCalledWith('chatgpt')
    wrapper.unmount()
  })
})
