/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

/**
 * 分享框：没连账户时先连，连上后以账户名义发布；提交的是技能名，文件由主进程从盘上重新打包。
 */

const api = vi.hoisted(() => ({
  packSkill: vi.fn(),
  submitSkill: vi.fn(),
  connect: vi.fn(),
  cancelConnect: vi.fn(),
  openPage: vi.fn(async () => undefined),
  onConnectPrompt: vi.fn(() => () => undefined)
}))
const message = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/utils/messageManager', () => ({ message }))
vi.mock('@renderer/api/share', () => ({ shareAPI: api }))

import SharedSkillShareModal from './SharedSkillShareModal.vue'

const PACK = { name: 'my-skill', files: [{ path: 'SKILL.md', content: 'x' }], skipped: [] }

async function openModal(): Promise<void> {
  const wrapper = mount(SharedSkillShareModal, {
    props: { name: 'my-skill', open: false },
    global: { mocks: { $t: (key: string) => key } },
    attachTo: document.body
  })
  await wrapper.setProps({ open: true })
  await flushPromises()
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('分享框', () => {
  it('没连账户：先显示「连接账户」，连上后才能发布', async () => {
    api.packSkill.mockResolvedValue({ ...PACK, account: null })
    api.connect.mockResolvedValue({ account: '陈东' })
    await openModal()

    expect(button('profile.skills.shareSubmit')).toBeUndefined()
    button('profile.skills.shareConnect')!.click()
    await flushPromises()

    expect(api.connect).toHaveBeenCalled()
    expect(button('profile.skills.shareSubmit')).toBeDefined()
  })

  it('连着账户：发布只传技能名，待审时说清楚', async () => {
    api.packSkill.mockResolvedValue({ ...PACK, account: '陈东' })
    api.submitSkill.mockResolvedValue({ id: 'my-skill', version: 1, status: 'pending', url: 'u' })
    await openModal()

    button('profile.skills.shareSubmit')!.click()
    await flushPromises()

    expect(api.submitSkill).toHaveBeenCalledWith('my-skill')
    expect(document.body.textContent).toContain('profile.skills.sharePending')
    expect(button('profile.skills.shareView')).toBeUndefined()
  })

  it('发布失败照实提示，并重新读一遍连接状态', async () => {
    api.packSkill.mockResolvedValue({ ...PACK, account: '陈东' })
    api.submitSkill.mockRejectedValue(new Error('UEBox 账户的连接已失效'))
    await openModal()

    button('profile.skills.shareSubmit')!.click()
    await flushPromises()

    expect(message.error).toHaveBeenCalled()
    expect(api.packSkill).toHaveBeenCalledTimes(2)
  })
})
