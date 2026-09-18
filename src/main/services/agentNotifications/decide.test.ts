import { describe, expect, it } from 'vitest'

import type { AgentRunSignal } from '../../agent-v3/host/runObserver'

import { decideNotification, settledKey, TextBuffer, type NotificationPrefs } from './decide'

const ALL_ON: NotificationPrefs = {
  turnComplete: 'unfocused',
  approvalRequired: true,
  questionRequired: true
}

function decide(
  signal: AgentRunSignal,
  overrides: Partial<{ prefs: NotificationPrefs; windowFocused: boolean; text: string }> = {}
): ReturnType<typeof decideNotification> {
  return decideNotification({
    signal,
    prefs: overrides.prefs ?? ALL_ON,
    windowFocused: overrides.windowFocused ?? false,
    text: overrides.text,
    language: 'zh-CN'
  })
}

const DONE: AgentRunSignal = { type: 'done', sessionId: 's1' }
const APPROVAL: AgentRunSignal = {
  type: 'approval',
  sessionId: 's1',
  toolCallId: 'call-1',
  toolName: 'delete_asset',
  risk: 'destructive',
  allowAlways: false
}
const QUESTION: AgentRunSignal = {
  type: 'question',
  sessionId: 's1',
  toolCallId: 'call-2',
  questions: [{ header: '选材质', question: '这两个材质用哪个？', multiSelect: false, options: [] }]
}

describe('轮次完成通知', () => {
  it('默认档下，窗口不在前台才提醒', () => {
    expect(decide(DONE, { windowFocused: false })).not.toBeNull()
    expect(decide(DONE, { windowFocused: true })).toBeNull()
  })

  it('「始终」档下，窗口在前台也提醒 —— 多显示器时用户的眼睛可能在别的屏上', () => {
    const prefs: NotificationPrefs = { ...ALL_ON, turnComplete: 'always' }
    expect(decide(DONE, { prefs, windowFocused: true })).not.toBeNull()
  })

  it('关掉就不提醒', () => {
    const prefs: NotificationPrefs = { ...ALL_ON, turnComplete: 'off' }
    expect(decide(DONE, { prefs, windowFocused: false })).toBeNull()
  })

  it('正文用它最后说的那几句，而不是一句干巴巴的「完成了」', () => {
    const plan = decide(DONE, { text: '已经把 3 个材质实例的粗糙度调到 0.4' })
    expect(plan?.body).toBe('已经把 3 个材质实例的粗糙度调到 0.4')
  })

  it('正文太长要截断，不留给系统去截', () => {
    const plan = decide(DONE, { text: 'x'.repeat(500) })
    expect(plan!.body.length).toBeLessThanOrEqual(120)
    expect(plan!.body.endsWith('…')).toBe(true)
  })

  it('没有正文时兜底成一句话，不能给出空通知', () => {
    expect(decide(DONE, { text: '   ' })?.body).toBeTruthy()
  })

  it('报错走同一档开关，但标题和正文都换成失败那一套', () => {
    const error: AgentRunSignal = { type: 'error', sessionId: 's1', message: '引擎连接断了' }
    const plan = decide(error, { text: '正在改材质' })
    expect(plan?.title).toBe('任务失败')
    expect(plan?.body).toBe('引擎连接断了')
  })

  it('用户自己按的停止不提醒 —— 他就在屏幕前面', () => {
    expect(decide({ type: 'stopped', sessionId: 's1' })).toBeNull()
  })

  it('同一条会话的轮次通知复用同一个 key，通知中心不会堆出一列过期的「完成」', () => {
    expect(decide(DONE)?.key).toBe('turn:s1')
  })
})

describe('审批与反问通知', () => {
  it('窗口在前台时不提醒 —— 确认框就在用户眼前，再说一遍是噪音', () => {
    expect(decide(APPROVAL, { windowFocused: true })).toBeNull()
    expect(decide(QUESTION, { windowFocused: true })).toBeNull()
  })

  it('窗口不在前台时提醒，且不自动消失', () => {
    expect(decide(APPROVAL)?.requireInteraction).toBe(true)
    expect(decide(QUESTION)?.requireInteraction).toBe(true)
  })

  it('不受「轮次完成」那一档影响 —— 关掉完成提醒不该连带关掉挡着活的提醒', () => {
    const prefs: NotificationPrefs = { ...ALL_ON, turnComplete: 'off' }
    expect(decide(APPROVAL, { prefs })).not.toBeNull()
    expect(decide(QUESTION, { prefs })).not.toBeNull()
  })

  it('各自的开关能单独关掉', () => {
    expect(decide(APPROVAL, { prefs: { ...ALL_ON, approvalRequired: false } })).toBeNull()
    expect(decide(QUESTION, { prefs: { ...ALL_ON, questionRequired: false } })).toBeNull()
  })

  it('不可逆操作在通知里就点明，用户只看一眼也能判断要不要切回来', () => {
    expect(decide(APPROVAL)?.body).toContain('高风险')
    const mutating: AgentRunSignal = { ...APPROVAL, risk: 'mutating' }
    expect(decide(mutating)?.body).not.toContain('高风险')
  })

  it('反问的正文用问题原文', () => {
    expect(decide(QUESTION)?.body).toBe('这两个材质用哪个？')
  })

  it('key 带上 toolCallId —— 并发审批时两条通知不能互相顶掉', () => {
    expect(decide(APPROVAL)?.key).toBe('approval:s1:call-1')
    expect(decide(QUESTION)?.key).toBe('question:s1:call-2')
  })
})

describe('settledKey', () => {
  it('落定信号能算出要收掉哪条通知', () => {
    expect(settledKey({ type: 'approval-settled', sessionId: 's1', toolCallId: 'call-1' })).toBe(
      'approval:s1:call-1'
    )
    expect(settledKey({ type: 'question-settled', sessionId: 's1', toolCallId: 'call-2' })).toBe(
      'question:s1:call-2'
    )
  })

  it('和 decideNotification 算出来的 key 对得上 —— 对不上就永远收不掉', () => {
    expect(settledKey({ type: 'approval-settled', sessionId: 's1', toolCallId: 'call-1' })).toBe(
      decide(APPROVAL)?.key
    )
  })

  it('其他信号不收任何通知', () => {
    expect(settledKey(DONE)).toBeNull()
  })
})

describe('TextBuffer', () => {
  it('攒起来的增量拼成完整正文', () => {
    const buffer = new TextBuffer()
    buffer.append('s1', '已经把 ')
    buffer.append('s1', '材质改好了')
    expect(buffer.take('s1')).toBe('已经把 材质改好了')
  })

  it('只留结尾，长任务不会攒出几十 KB', () => {
    const buffer = new TextBuffer()
    buffer.append('s1', 'a'.repeat(10_000))
    expect(buffer.take('s1').length).toBeLessThanOrEqual(240)
  })

  it('按会话分开存，两条会话同时跑不会串正文', () => {
    const buffer = new TextBuffer()
    buffer.append('s1', '甲')
    buffer.append('s2', '乙')
    expect(buffer.take('s1')).toBe('甲')
    expect(buffer.take('s2')).toBe('乙')
  })

  it('清掉之后回空串，不是 undefined', () => {
    const buffer = new TextBuffer()
    buffer.append('s1', '甲')
    buffer.clear('s1')
    expect(buffer.take('s1')).toBe('')
  })
})

describe('英文界面', () => {
  it('跟随语言设置出英文文案', () => {
    const plan = decideNotification({
      signal: DONE,
      prefs: ALL_ON,
      windowFocused: false,
      language: 'en-US'
    })
    expect(plan?.title).toBe('Task finished')
  })
})
