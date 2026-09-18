/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ProfileAI from './ProfileAI.vue'

/**
 * 「文件访问范围」这一格是这个设置的**唯一入口** —— 主进程那边
 * （`agent-v3/tools/builtin/accessScope.ts`）判得再对，界面上点不到就等于不存在。
 *
 * 三件事必须守住：
 * 1. 两个档位都渲染得出来
 * 2. 点一下真的把值交给主进程（不是只改了本地 ref）
 * 3. **打开设置页不会把用户已经设的值覆盖成默认值** —— watch 少了那个
 *    「读回来了没有」的标志，用户设的「仅虚幻相关」会在挂载的一瞬间被写回 full
 */

const appSettingsGet = vi.fn()
const appSettingsSet = vi.fn()

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./ArchivedChatsModal.vue', () => ({ default: { template: '<div />' } }))

function mountPanel(): ReturnType<typeof mount> {
  return mount(ProfileAI, { global: { mocks: { $t: (key: string) => key } } })
}

/** 档位按钮在这一格里，靠 label 的 i18n key 认（$t 被替身成原样返回 key） */
function scopeButtons(wrapper: ReturnType<typeof mount>): ReturnType<typeof mount>['findAll'] {
  const row = wrapper
    .findAll('.setting-item')
    .find((item) => item.text().includes('profile.ai.fileAccessScope'))!
  return row.findAll('.app-segmented__item') as never
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  appSettingsGet.mockResolvedValue({ agentBrowserMode: 'window', agentFileAccessScope: 'ue-only' })
  appSettingsSet.mockResolvedValue({ success: true })
  ;(window as unknown as { api: unknown }).api = {
    appSettings: { get: appSettingsGet, set: appSettingsSet },
    invoke: vi.fn(async () => undefined)
  }
})

describe('AI 设置 · 文件访问范围', () => {
  it('每项只显示一段说明，切换范围后直接更新该段说明', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    for (const row of wrapper.findAll('.setting-item')) {
      expect(row.findAll('.setting-desc').length).toBeLessThanOrEqual(1)
    }
    const row = wrapper
      .findAll('.setting-item')
      .find((item) => item.text().includes('profile.ai.fileAccessScope'))!
    expect(row.get('.setting-desc').text()).toBe('profile.ai.fileAccessScopeUeOnlyHint')
    await row.findAll('.app-segmented__item')[1].trigger('click')
    await flushPromises()
    expect(row.get('.setting-desc').text()).toBe('profile.ai.fileAccessScopeFullHint')
    wrapper.unmount()
  })

  it('渲染出两个档位', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const buttons = scopeButtons(wrapper) as unknown as Array<{ text: () => string }>
    expect(buttons.map((b) => b.text())).toEqual([
      'profile.ai.fileAccessScopeUeOnly',
      'profile.ai.fileAccessScopeFull'
    ])
  })

  it('点「整台电脑」把值交给主进程', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const buttons = scopeButtons(wrapper) as unknown as Array<{ trigger: (e: string) => unknown }>
    await buttons[1].trigger('click')
    await flushPromises()

    expect(appSettingsSet).toHaveBeenCalledWith({ agentFileAccessScope: 'full' })
  })

  it('读回用户已设的档位，并且不写回去', async () => {
    appSettingsGet.mockResolvedValue({ agentBrowserMode: 'window', agentFileAccessScope: 'full' })

    const wrapper = mountPanel()
    await flushPromises()

    const buttons = scopeButtons(wrapper) as unknown as Array<{ classes: () => string[] }>
    expect(buttons[1].classes()).toContain('active')
    // 挂载本身不该产生任何写入 —— 有的话就是 watch 把默认值覆盖上去了
    expect(appSettingsSet).not.toHaveBeenCalled()
  })

  /**
   * 旧配置文件里没有这个字段。界面的兜底必须和主进程一致（只认 `ue-only`），
   * 否则会出现最糟的一种错位：界面高亮着一档，实际生效的是另一档，
   * 用户看着设置对不上行为。
   */
  it('旧配置没有这个字段时落到默认的「整台电脑」', async () => {
    appSettingsGet.mockResolvedValue({ agentBrowserMode: 'embedded' })

    const wrapper = mountPanel()
    await flushPromises()

    const buttons = scopeButtons(wrapper) as unknown as Array<{ classes: () => string[] }>
    expect(buttons[1].classes()).toContain('active')
    expect(appSettingsSet).not.toHaveBeenCalled()
  })

  /** 收窄是用户主动选出来的一档，读回来要照选的显示，也不能被默认值覆盖回去 */
  it('读回用户选的「仅虚幻相关」，并且不写回去', async () => {
    appSettingsGet.mockResolvedValue({
      agentBrowserMode: 'embedded',
      agentFileAccessScope: 'ue-only'
    })

    const wrapper = mountPanel()
    await flushPromises()

    const buttons = scopeButtons(wrapper) as unknown as Array<{ classes: () => string[] }>
    expect(buttons[0].classes()).toContain('active')
    expect(appSettingsSet).not.toHaveBeenCalled()
  })
})
