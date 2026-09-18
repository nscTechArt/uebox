import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { __setAppAgentRunnerForTest, appExecuteAgent } from './appAgentRunner'

vi.mock('./useAgentMode', () => ({ useAgentMode: () => ({ executeAgent: vi.fn() }) }))

/**
 * 「谁来跑一轮 agent」这件事不归任何页面。
 *
 * 助手路由没开 `meta.keepAlive`，页面一切走就没了 —— 凡是拿页面来跑活的地方，
 * 用户切个页面就静默失效。这一层是那两处（跟进队列、语音派活）共用的出口。
 */
describe('应用级 agent 运行器', () => {
  afterEach(() => {
    __setAppAgentRunnerForTest(null)
  })

  it('装上之后原样转发给 executeAgent', async () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    __setAppAgentRunnerForTest(runner)

    await appExecuteAgent('把灯调暗', undefined, { chatSid: 'chat-1' })

    expect(runner).toHaveBeenCalledWith('把灯调暗', undefined, { chatSid: 'chat-1' })
  })

  /*
   * 没装上只可能是接线错了（常驻布局还没挂）。悄悄咽下去的话，用户看到的是
   * 「派了活但什么都没发生」——那正是这一轮要消灭的症状。
   */
  it('没装上时照实抛，不静默吞掉', async () => {
    __setAppAgentRunnerForTest(null)

    await expect(appExecuteAgent('把灯调暗', undefined, { chatSid: 'c' })).rejects.toThrow(
      '还没装上'
    )
  })
})

describe('接线', () => {
  it('常驻布局装运行器，且排在投递之前', () => {
    const layout = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/layout/MainLayout.vue'),
      'utf8'
    )

    expect(layout).toContain('useAppAgentRunner()')
    // 投递要用运行器，装晚了第一条就发不出去
    expect(layout.indexOf('useAppAgentRunner()')).toBeLessThan(
      layout.indexOf('useFollowUpDelivery()')
    )
  })

  // 语音派活曾经借助手页，助手页一关就报「助手页面都关了」
  it('语音派活不再借页面', () => {
    const voice = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/views/Assistant/composables/voiceAssistant.ts'),
      'utf8'
    )

    expect(voice).toContain('appExecuteAgent(')
    expect(voice).not.toContain('host.executeAgent')
    expect(voice).not.toContain('助手页面都关了，请让用户先打开')
  })
})
