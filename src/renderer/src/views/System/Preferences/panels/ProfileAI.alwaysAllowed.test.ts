/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ProfileAI from './ProfileAI.vue'

/**
 * 「已设为始终允许的操作」：审批卡片上点过「以后都允许」的工具。
 * 守住三件事：没有就整行不显示、有就用人话列出来、移除一项真的交给主进程。
 */

const appSettingsGet = vi.fn()
const appSettingsSet = vi.fn()

const LABELS: Record<string, string> = {
  'assistant.changes.tools.ue_open_level': '打开关卡'
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => LABELS[key] ?? key,
    te: (key: string) => key in LABELS
  })
}))
vi.mock('./ArchivedChatsModal.vue', () => ({ default: { template: '<div />' } }))

function mountPanel(): ReturnType<typeof mount> {
  return mount(ProfileAI, { global: { mocks: { $t: (key: string) => key } } })
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

describe('AI 设置 · 已设为始终允许的操作', () => {
  it('名单是空的（含旧配置没有这个字段）：整行不显示', async () => {
    appSettingsGet.mockResolvedValue({ agentBrowserMode: 'embedded' })
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('.always-allowed-list').exists()).toBe(false)
    wrapper.unmount()
  })

  it('列出工具的人话名称，查不到的退回工具名', async () => {
    appSettingsGet.mockResolvedValue({
      agentBrowserMode: 'embedded',
      agentAlwaysAllowedTools: ['ue_open_level', 'some_new_tool']
    })
    const wrapper = mountPanel()
    await flushPromises()

    const names = wrapper.findAll('.always-allowed-name').map((item) => item.text())
    expect(names).toEqual(['打开关卡', 'some_new_tool'])
    expect(appSettingsSet).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('移除一项：把剩下的名单交给主进程，界面跟着少一行', async () => {
    appSettingsGet.mockResolvedValue({
      agentBrowserMode: 'embedded',
      agentAlwaysAllowedTools: ['ue_open_level', 'some_new_tool']
    })
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.findAll('.always-allowed-item')[0]!.get('button').trigger('click')
    await flushPromises()

    expect(appSettingsSet).toHaveBeenCalledWith({ agentAlwaysAllowedTools: ['some_new_tool'] })
    expect(wrapper.findAll('.always-allowed-name').map((item) => item.text())).toEqual([
      'some_new_tool'
    ])
    wrapper.unmount()
  })
})
