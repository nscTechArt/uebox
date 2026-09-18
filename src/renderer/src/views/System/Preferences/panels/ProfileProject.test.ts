/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ProfileProject from './ProfileProject.vue'

/**
 * 「打开工程后隐藏主界面」是个能让窗口消失的开关，界面这一侧要守住三件事：
 * 1. 挂载时把用户设的值读回来
 * 2. 挂载本身不写回去（少了「读完了没有」的标志，用户开着的值会被默认值覆盖）
 * 3. 拨动开关真的把值交给主进程，而不是只改了本地 ref
 */

const appSettingsGet = vi.fn()
const appSettingsSet = vi.fn()

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

function mountPanel(): ReturnType<typeof mount> {
  return mount(ProfileProject, { global: { mocks: { $t: (key: string) => key } } })
}

beforeEach(() => {
  vi.clearAllMocks()
  appSettingsGet.mockResolvedValue({ hideWindowOnProjectLaunch: false })
  appSettingsSet.mockResolvedValue({ success: true })
  ;(window as unknown as { api: unknown }).api = {
    appSettings: { get: appSettingsGet, set: appSettingsSet }
  }
})

describe('项目设置 · 打开工程后隐藏主界面', () => {
  it('读回用户已开的值，并且不写回去', async () => {
    appSettingsGet.mockResolvedValue({ hideWindowOnProjectLaunch: true })

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.get('button[role="switch"]').attributes('aria-checked')).toBe('true')
    expect(appSettingsSet).not.toHaveBeenCalled()
  })

  /**
   * 旧配置文件里没有这个字段。界面的兜底必须和主进程一致（只认 true），
   * 否则会出现最糟的错位：开关看着是开的，窗口却不藏 —— 或者反过来。
   */
  it('旧配置没有这个字段时按关闭算', async () => {
    appSettingsGet.mockResolvedValue({})

    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.get('button[role="switch"]').attributes('aria-checked')).toBe('false')
    expect(appSettingsSet).not.toHaveBeenCalled()
  })

  it('打开开关把值交给主进程', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.get('button[role="switch"]').trigger('click')
    await flushPromises()

    expect(appSettingsSet).toHaveBeenCalledWith({ hideWindowOnProjectLaunch: true })
  })
})
