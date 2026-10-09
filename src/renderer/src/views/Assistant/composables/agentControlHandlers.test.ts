import { describe, expect, it } from 'vitest'

import enUS from '@renderer/i18n/locales/en-US'
import zhCN from '@renderer/i18n/locales/zh-CN'

import {
  describeStartupError,
  describeSteerRejection,
  isAgentNetworkError
} from './agentControlHandlers'

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

/**
 * 插话被按码拒绝：同一句拒绝在两条入口下结局不同 ——
 * 输入框那条内容放回了输入框（`restored`），排队那条留在队列里照发
 * （`queued`）。一律「插话失败」会把留在队列里那条说成丢了。
 */
describe('describeSteerRejection', () => {
  /*
   * 同 describeStartupError：文案是从表里查的，`usedKeyCoverage` 扫不到
   * 动态 key，用真语言包验，漏配在这里红，不会在界面上显示 key。
   */
  const t = (key: string, params?: Record<string, unknown>): string => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        zhCN as unknown
      )
    const text = typeof value === 'string' ? value : key
    return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
      params?.[name] === undefined ? `{${name}}` : String(params[name])
    )
  }

  it('表里每个码两侧都真的配了文案', () => {
    const keys = [
      'assistantInputComposer.steerTurnEndedRestored',
      'assistantInputComposer.steerTurnEndedQueued',
      'assistantInputComposer.steerProjectMismatchRestored',
      'assistantInputComposer.steerProjectMismatchQueued',
      'assistantInputComposer.steerOtherProject'
    ]
    for (const key of keys) {
      for (const pack of [zhCN, enUS]) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown> | undefined)?.[part],
            pack as unknown
          )
        expect(typeof value, `${key} 缺配`).toBe('string')
      }
    }
  })

  it('NOT_RUNNING + 放回输入框：说内容放回去了，不说失败', () => {
    const text = describeSteerRejection({ code: 'NOT_RUNNING' }, 'restored', t)
    expect(text).toContain('放回输入框')
    expect(text).not.toContain('失败')
  })

  it('NOT_RUNNING + 留在队列：说会按排队顺序发出', () => {
    const text = describeSteerRejection({ code: 'NOT_RUNNING' }, 'queued', t)
    expect(text).toContain('排队顺序')
    expect(text).not.toContain('失败')
  })

  it('PROJECT_MISMATCH 两条路各说各的，工程名拼进去', () => {
    const result = {
      code: 'PROJECT_MISMATCH',
      errorParams: { snapshotProject: 'GameA', runProject: 'GameB' }
    }

    const restored = describeSteerRejection(result, 'restored', t)
    expect(restored).toContain('GameA')
    expect(restored).toContain('GameB')
    expect(restored).toContain('放回输入框')

    const queued = describeSteerRejection(result, 'queued', t)
    expect(queued).toContain('GameA')
    expect(queued).toContain('GameB')
    expect(queued).not.toContain('放回输入框')
  })

  it('工程名是空串时代入「另一个工程」，不把空引号丢给用户', () => {
    const text = describeSteerRejection(
      {
        code: 'PROJECT_MISMATCH',
        errorParams: { snapshotProject: '', runProject: '' }
      },
      'restored',
      t
    )
    expect(text).toContain('另一个工程')
    expect(text).not.toContain('「」')
  })

  it('不认识的码、没文案时都返回 undefined —— 调用方退回 steerFailed', () => {
    const noCopy = (key: string): string => key

    expect(describeSteerRejection({ code: 'WHATEVER' }, 'restored', t)).toBeUndefined()
    expect(describeSteerRejection({}, 'restored', t)).toBeUndefined()
    expect(describeSteerRejection(null, 'queued', t)).toBeUndefined()
    expect(describeSteerRejection({ code: 'NOT_RUNNING' }, 'restored', noCopy)).toBeUndefined()
  })
})
