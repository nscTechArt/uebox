import { describe, expect, it } from 'vitest'

import enUS from '@renderer/i18n/locales/en-US'
import zhCN from '@renderer/i18n/locales/zh-CN'

import { describeStartupError, isAgentNetworkError } from './agentControlHandlers'

describe('Agent 错误分类', () => {
  it('没有错误码的 Connection error 也识别为网络问题', () => {
    expect(isAgentNetworkError({ message: 'Connection error.' })).toBe(true)
  })

  it('不把普通执行错误误判成网络问题', () => {
    expect(isAgentNetworkError({ message: 'Tool arguments are invalid' })).toBe(false)
  })
})

/**
 * 启动失败（`agent-v3:execute` 直接回 `success: false`）这条路不经过 `getErrorInfo`，
 * 原来是把主进程那句诊断原文原样显示在对话里 —— 于是用户读到
 *
 *     错误: 会话 3f2a8c1e-… 正在执行中。要改方向请用 agent-v3:steer。
 *
 * 一个 uuid 加一个 IPC 通道名，而界面上「改方向」就是在输入框里继续打字。
 */
describe('describeStartupError', () => {
  /*
   * 用真语言包，不用假 t。
   *
   * 这条文案是从表里查出来的（`STARTUP_ERROR_COPY`），不是字面量 `t('...')`，
   * 所以「渲染层用到的 key 两侧都存在」那道门禁（`usedKeyCoverage.test.ts`）
   * 扫不到它 —— 漏配就得在这里被抓住，否则界面上会直接显示 key。
   */
  const t = (key: string): string => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        zhCN as unknown
      )
    return typeof value === 'string' ? value : key
  }

  it('认识的码查文案，主进程那句原文不外露', () => {
    const text = describeStartupError(
      { message: '会话 3f2a8c1e-0000 正在执行中', code: 'SESSION_BUSY' },
      t,
      '兜底'
    )
    // 查到的是真文案，不是 key
    expect(text).not.toBe('assistant.agentMode.sessionBusy')
    expect(text).toContain('还有一轮在跑')
    expect(text).not.toContain('3f2a8c1e')
    expect(text).not.toContain('agent-v3')
  })

  /*
   * 两侧都要配上。`criticalPathCoverage` 只守顶层块对齐和「英文包里别混中文」，
   * 单个 key 缺一侧它看不见 —— 缺了的后果是英文用户在这里读到一句中文。
   */
  it('中英两侧都配了文案', () => {
    expect(typeof zhCN.assistant.agentMode.sessionBusy).toBe('string')
    expect(typeof enUS.assistant.agentMode.sessionBusy).toBe('string')
  })

  it('不认识的码退回原文 —— 难看但不丢信息', () => {
    expect(describeStartupError({ message: '磁盘写满了', code: 'WHATEVER' }, t, '兜底')).toBe(
      '磁盘写满了'
    )
  })

  it('文案没配上时也退回原文，不显示 key', () => {
    const noCopy = (key: string): string => key
    expect(
      describeStartupError({ message: '会话正在执行中', code: 'SESSION_BUSY' }, noCopy, '兜底')
    ).toBe('会话正在执行中')
  })

  it('什么都没有时用兜底', () => {
    expect(describeStartupError(undefined, t, '兜底')).toBe('兜底')
    expect(describeStartupError({}, t, '兜底')).toBe('兜底')
  })
})
