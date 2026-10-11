/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `web_read` / `add_notebook_source` 读「允许浏览器访问局域网」的那一层。
 * 读不到设置就当关 —— 拿不准时不放开内网。
 */

const settings = vi.hoisted(() => ({ read: (): boolean => false }))
vi.mock('../../../appSettingsManager', () => ({
  appSettingsManager: { getAgentBrowserAllowLocalNetwork: () => settings.read() }
}))

import { browserLocalNetworkAllowed } from './localNetworkSetting'

beforeEach(() => {
  settings.read = () => false
})

describe('browserLocalNetworkAllowed', () => {
  it('每次现读设置', async () => {
    expect(await browserLocalNetworkAllowed()).toBe(false)
    settings.read = () => true
    expect(await browserLocalNetworkAllowed()).toBe(true)
  })

  it('读设置抛异常时按关处理', async () => {
    settings.read = () => {
      throw new Error('settings not ready')
    }
    expect(await browserLocalNetworkAllowed()).toBe(false)
  })
})
