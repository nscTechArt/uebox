/**
 * @vitest-environment node
 *
 * `ue_inject_input` 按键那条路的回执：插件回 accepted:false 时视口没接这个键，
 * 第一句不许说「已发送」（AGENTS.md §5 第 14 条）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { createInjectInputTool } from './injectInput'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createInjectInputTool() as unknown as Executable).execute(input)

const KEY_RESPONSE = {
  ok: true,
  injected_at: 'key',
  key: 'W',
  event: 'tap',
  layer_note: 'Injected through the real player path.'
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_inject_input（按键）', () => {
  it('视口接受了就照常说已发送', async () => {
    callRequest.mockResolvedValue({ ...KEY_RESPONSE, accepted: true })

    const r = await run({ key: 'W' })

    expect(String(r.message).startsWith('已发送按键 W')).toBe(true)
  })

  it('accepted:false 时第一句是 ⚠️ 没被接受，排在警告之前，不说已发送', async () => {
    callRequest.mockResolvedValue({
      ...KEY_RESPONSE,
      accepted: false,
      warnings: ['Input mode is UIOnly']
    })

    const r = await run({ key: 'W' })

    const message = String(r.message)
    expect(message.startsWith('⚠️ 按键 W')).toBe(true)
    expect(message).toContain('没被游戏视口接受')
    expect(message).not.toContain('已发送')
    expect(message.indexOf('没被游戏视口接受')).toBeLessThan(message.indexOf('UIOnly'))
    expect(r.accepted).toBe(false)
    expect(Object.keys(r)[0]).toBe('message')
  })

  it('老插件不回 accepted 时按原话说', async () => {
    callRequest.mockResolvedValue(KEY_RESPONSE)

    const r = await run({ key: 'W' })

    expect(String(r.message)).toContain('已发送按键 W')
  })
})
