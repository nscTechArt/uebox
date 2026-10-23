/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

/**
 * 安装确认框是共享技能唯一的审批：网页、Agent、命令行三条入口都停在这里。守的是：
 * 用户看得到全文、点了「安装」才回复同意、关掉弹窗等于不装、几条请求排队一个个来。
 */

import type { SharedSkillInstallRequest } from '@core/shared/share'

const installReply = vi.fn()
const pendingInstalls = vi.fn()
let pushRequest: (request: SharedSkillInstallRequest) => void = () => undefined
const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/utils/messageManager', () => ({ message: { success, error } }))
vi.mock('@renderer/api/share', () => ({
  shareAPI: {
    pendingInstalls: () => pendingInstalls(),
    installReply: (...args: unknown[]) => installReply(...args),
    openPage: vi.fn(async () => undefined),
    onInstallRequest: (listener: (request: SharedSkillInstallRequest) => void) => {
      pushRequest = listener
      return () => undefined
    },
    onInstallFailed: () => () => undefined
  }
}))

import SharedSkillInstallHost from './SharedSkillInstallHost.vue'

function request(id: string, requestId = `req-${id}`): SharedSkillInstallRequest {
  return {
    requestId,
    origin: 'link',
    skill: {
      id,
      description: `Does ${id}.`,
      author: '作者甲',
      version: 1,
      updatedAt: '2026-10-21T00:00:00.000Z',
      installs: 3,
      files: [
        { path: 'references/a.md', content: 'reference body' },
        { path: 'SKILL.md', content: `---\nname: ${id}\n---\nbody of ${id}` }
      ]
    },
    conflict: { kind: 'none' },
    pageUrl: `https://example.test/s/${id}`
  }
}

function mountHost(): void {
  mount(SharedSkillInstallHost, {
    global: { mocks: { $t: (key: string) => key } },
    attachTo: document.body
  })
}

const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll('button')]
const click = (label: string): void =>
  buttons()
    .find((b) => b.textContent?.trim() === label)
    ?.click()

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  pendingInstalls.mockResolvedValue([])
  installReply.mockResolvedValue({ status: 'installed', id: 'a-skill', version: 1 })
})

describe('安装确认框', () => {
  it('先给看 SKILL.md 全文，点了安装才回复同意', async () => {
    mountHost()
    await flushPromises()
    pushRequest(request('a-skill'))
    await flushPromises()

    expect(document.querySelector('.file')?.textContent).toContain('body of a-skill')
    expect(installReply).not.toHaveBeenCalled()

    click('profile.skills.install')
    await flushPromises()

    expect(installReply).toHaveBeenCalledWith('req-a-skill', true)
    expect(success).toHaveBeenCalled()
  })

  it('取消就回复不装', async () => {
    installReply.mockResolvedValue({ status: 'declined', id: 'a-skill' })
    mountHost()
    await flushPromises()
    pushRequest(request('a-skill'))
    await flushPromises()

    click('common.cancel')
    await flushPromises()

    expect(installReply).toHaveBeenCalledWith('req-a-skill', false)
    expect(success).not.toHaveBeenCalled()
  })

  it('冷启动时挂着的请求在挂载后补上；多条排队，一次一个', async () => {
    pendingInstalls.mockResolvedValue([request('first')])
    mountHost()
    await flushPromises()
    pushRequest(request('second'))
    await flushPromises()

    expect(document.querySelector('.name')?.textContent).toBe('first')
    click('profile.skills.install')
    await flushPromises()
    expect(document.querySelector('.name')?.textContent).toBe('second')
  })

  it('安装失败照实提示', async () => {
    installReply.mockResolvedValue({ status: 'failed', id: 'a-skill', error: '磁盘已满' })
    mountHost()
    await flushPromises()
    pushRequest(request('a-skill'))
    await flushPromises()

    click('profile.skills.install')
    await flushPromises()

    expect(error).toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })
})
