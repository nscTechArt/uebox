import { describe, expect, it } from 'vitest'
import {
  CHATTER_ROUNDS,
  SILENCE_GAP_MS,
  chatterLine,
  decideSilenceAction,
  shortenInstruction,
  type SilenceInput
} from './antiSilence'

/** 已经安静了整整一分钟、开关开着、连接握完手的默认场景 */
function input(overrides: Partial<SilenceInput> = {}): SilenceInput {
  return {
    now: 60_000,
    enabled: true,
    autoHangupEnabled: true,
    connected: true,
    talking: false,
    lastTalkAt: 0,
    hasRunning: false,
    chatterDone: 0,
    ...overrides
  }
}

describe('decideSilenceAction', () => {
  it('简洁模式可独立开启自动结束', () => {
    expect(decideSilenceAction(input({ enabled: false }))).toEqual({ type: 'chatter', round: 1 })
    expect(decideSilenceAction(input({ enabled: false, chatterDone: 2 }))).toEqual({
      type: 'hangup'
    })
  })

  it('关闭自动结束不影响任务汇报，空闲时不搭话或挂断', () => {
    expect(decideSilenceAction(input({ autoHangupEnabled: false, hasRunning: true }))).toEqual({
      type: 'report'
    })
    expect(decideSilenceAction(input({ autoHangupEnabled: false, chatterDone: 2 }))).toEqual({
      type: 'none'
    })
    expect(decideSilenceAction(input({ autoHangupEnabled: false, enabled: false }))).toEqual({
      type: 'none'
    })
  })
  it('关掉开关就什么都不做', () => {
    expect(decideSilenceAction(input({ enabled: false, hasRunning: true }))).toEqual({
      type: 'none'
    })
  })

  it('厂商还没握完手时不开口 —— 发出去也没人收', () => {
    expect(decideSilenceAction(input({ connected: false }))).toEqual({ type: 'none' })
  })

  it('有人正说着话就闭嘴，不抢话', () => {
    expect(decideSilenceAction(input({ talking: true, hasRunning: true }))).toEqual({
      type: 'none'
    })
  })

  it('还没安静满一分钟不开口', () => {
    expect(decideSilenceAction(input({ now: SILENCE_GAP_MS - 1, lastTalkAt: 0 }))).toEqual({
      type: 'none'
    })
  })

  it('有活在跑就汇报进度，而且永远不会挂断', () => {
    expect(decideSilenceAction(input({ hasRunning: true }))).toEqual({ type: 'report' })
    expect(decideSilenceAction(input({ hasRunning: true, chatterDone: 99 }))).toEqual({
      type: 'report'
    })
  })

  it('闲着就搭话，第三次改成挂断', () => {
    expect(decideSilenceAction(input({ chatterDone: 0 }))).toEqual({ type: 'chatter', round: 1 })
    expect(decideSilenceAction(input({ chatterDone: 1 }))).toEqual({ type: 'chatter', round: 2 })
    expect(decideSilenceAction(input({ chatterDone: CHATTER_ROUNDS - 1 }))).toEqual({
      type: 'hangup'
    })
  })
})

describe('chatterLine', () => {
  it('两次搭话不说同一句 —— 一模一样的话重复念像卡带', () => {
    expect(chatterLine(1).speech).not.toBe(chatterLine(2).speech)
  })
})

describe('shortenInstruction', () => {
  /*
   * 真机（2026-09-05）：这条指令被整段念了回去，二十多秒。用户三分钟前刚说完，
   * 他要听的是做到哪了，不是自己那段话的复读。
   */
  it('冒号后面那串细节不念 —— 那是他刚说完的话', () => {
    expect(
      shortenInstruction(
        '把关卡里的游轮改成泰坦尼克号风格：调整船体造型、增加多层客舱、加装救生艇、改配色为黑 hull 白上层建筑，还原经典外观'
      )
    ).toBe('把关卡里的游轮改成泰坦尼克号风格')
  })

  it('本来就短的原样留着', () => {
    expect(shortenInstruction('把主灯调暗')).toBe('把主灯调暗')
  })

  it('既没冒号也没逗号的长句硬截，但要留个省略号，别断在半个词上装作说完了', () => {
    const short = shortenInstruction(
      '给当前关卡里的SM_BigBen大本钟模型添加适配的石材和金属钟面材质'
    )
    expect(short.length).toBeLessThanOrEqual(17)
    expect(short.endsWith('…')).toBe(true)
  })
})
