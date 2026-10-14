/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ProfileAI from './ProfileAI.vue'

/**
 * 「修改资产时设为只读」和「允许浏览器访问局域网」两个开关：都默认关，
 * 都存在主进程的应用设置里。守住三件事：读回来的值显示对、打开设置页不写回、
 * 拨一下真的交给主进程。
 */

const appSettingsGet = vi.fn()
const appSettingsSet = vi.fn()

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./ArchivedChatsModal.vue', () => ({ default: { template: '<div />' } }))

function mountPanel(): ReturnType<typeof mount> {
  return mount(ProfileAI, { global: { mocks: { $t: (key: string) => key } } })
}

function switchFor(
  wrapper: ReturnType<typeof mount>,
  labelKey: string
): Omit<DOMWrapper<Element>, 'exists'> {
  const row = wrapper
    .findAll('.setting-item')
    .find((item) => item.get('.setting-label').text() === labelKey)!
  return row.get('[role="switch"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  appSettingsSet.mockResolvedValue({ success: true })
  ;(window as unknown as { api: unknown }).api = {
    appSettings: { get: appSettingsGet, set: appSettingsSet },
    invoke: vi.fn(async () => undefined)
  }
})

describe('AI 设置 · 资产只读锁与浏览器局域网访问', () => {
  it.each([
    ['profile.ai.assetReadonlyLock', 'assetReadonlyLock'],
    ['profile.ai.browserAllowLocalNetwork', 'agentBrowserAllowLocalNetwork']
  ])('%s：旧配置没有这个字段时显示为关，打开设置页不写回', async (label) => {
    appSettingsGet.mockResolvedValue({ agentBrowserMode: 'embedded' })
    const wrapper = mountPanel()
    await flushPromises()

    expect(switchFor(wrapper, label).attributes('aria-checked')).toBe('false')
    expect(appSettingsSet).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each([
    ['profile.ai.assetReadonlyLock', 'assetReadonlyLock'],
    ['profile.ai.browserAllowLocalNetwork', 'agentBrowserAllowLocalNetwork']
  ])('%s：拨开后把值交给主进程', async (label, field) => {
    appSettingsGet.mockResolvedValue({ agentBrowserMode: 'embedded' })
    const wrapper = mountPanel()
    await flushPromises()

    await switchFor(wrapper, label).trigger('click')
    await flushPromises()

    expect(appSettingsSet).toHaveBeenCalledWith({ [field]: true })
    wrapper.unmount()
  })

  it('读回已开启的值', async () => {
    appSettingsGet.mockResolvedValue({
      agentBrowserMode: 'embedded',
      assetReadonlyLock: true,
      agentBrowserAllowLocalNetwork: true
    })
    const wrapper = mountPanel()
    await flushPromises()

    expect(switchFor(wrapper, 'profile.ai.assetReadonlyLock').attributes('aria-checked')).toBe(
      'true'
    )
    expect(
      switchFor(wrapper, 'profile.ai.browserAllowLocalNetwork').attributes('aria-checked')
    ).toBe('true')
    expect(appSettingsSet).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
