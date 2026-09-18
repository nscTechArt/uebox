import { describe, expect, it } from 'vitest'

import {
  PROGRESS_THROTTLE_MS,
  decideNotice,
  drainNotices,
  enqueueNotice,
  stageOf,
  type VoiceFloor,
  type VoiceNotice
} from './narrator'

const IDLE: VoiceFloor = { active: true, userSpeaking: false, assistantSpeaking: false }

function notice(taskId: string, priority: VoiceNotice['priority'], text = taskId): VoiceNotice {
  return { taskId, speech: text, context: text, priority }
}

describe('decideNotice', () => {
  it('用户正在说话时一个字都不插 —— 抢用户的话比冷场难受得多', () => {
    const floor: VoiceFloor = { active: true, userSpeaking: true, assistantSpeaking: false }

    expect(decideNotice({ priority: 'low', floor, lastSpokenAt: 0, now: 1_000_000 })).toBe('queue')
    // 高优先级也不行。这条是红线，不分优先级
    expect(decideNotice({ priority: 'high', floor, lastSpokenAt: 0, now: 1_000_000 })).toBe('queue')
  })

  /*
   * 原先高优先级可以打断模型。真机上这条把整路会话弄哑了：Agent 刚派出去一秒就反问，
   * 模型那句「开始做了」还没说完就被塞了一段 TTS，从此它再没发过任何事件。
   */
  it('模型正在说话时高优先级也等它说完，不打断', () => {
    const floor: VoiceFloor = { active: true, userSpeaking: false, assistantSpeaking: true }

    expect(decideNotice({ priority: 'high', floor, lastSpokenAt: 0, now: 1_000_000 })).toBe('queue')
    expect(decideNotice({ priority: 'low', floor, lastSpokenAt: 0, now: 1_000_000 })).toBe('queue')
  })

  it('低优先级进度受节流约束，高优先级不受', () => {
    const now = 1_000_000
    const justSpoke = now - PROGRESS_THROTTLE_MS + 1

    expect(decideNotice({ priority: 'low', floor: IDLE, lastSpokenAt: justSpoke, now })).toBe(
      'queue'
    )
    expect(decideNotice({ priority: 'high', floor: IDLE, lastSpokenAt: justSpoke, now })).toBe(
      'speak'
    )
    expect(
      decideNotice({ priority: 'low', floor: IDLE, lastSpokenAt: now - PROGRESS_THROTTLE_MS, now })
    ).toBe('speak')
  })

  it('语音会话没开就直接丢 —— 没人听，攒着也没意义', () => {
    const floor: VoiceFloor = { active: false, userSpeaking: false, assistantSpeaking: false }

    expect(decideNotice({ priority: 'high', floor, lastSpokenAt: 0, now: 1 })).toBe('drop')
  })
})

describe('enqueueNotice', () => {
  it('同一件任务的进度互相顶掉 —— 攒三条旧的连着念，用户听到的都是过去式', () => {
    let queue: VoiceNotice[] = []
    queue = enqueueNotice(queue, notice('t1', 'low', '在改蓝图'))
    queue = enqueueNotice(queue, notice('t1', 'low', '在编译'))

    expect(queue).toEqual([notice('t1', 'low', '在编译')])
  })

  it('不同任务的进度各留各的', () => {
    let queue: VoiceNotice[] = []
    queue = enqueueNotice(queue, notice('t1', 'low'))
    queue = enqueueNotice(queue, notice('t2', 'low'))

    expect(queue.map((item) => item.taskId)).toEqual(['t1', 't2'])
  })

  it('高优先级一条都不能丢 —— 失败和反问各是各的事', () => {
    let queue: VoiceNotice[] = []
    queue = enqueueNotice(queue, notice('t1', 'high', '要问用户'))
    queue = enqueueNotice(queue, notice('t1', 'high', '失败了'))

    expect(queue).toHaveLength(2)
  })
})

describe('drainNotices', () => {
  it('一次只放一条，剩下的继续等', () => {
    const queue = [notice('t1', 'high', 'a'), notice('t2', 'high', 'b')]

    const [ready, rest] = drainNotices(queue, IDLE, 0, 1_000_000)

    expect(ready?.speech).toBe('a')
    expect(rest).toHaveLength(1)
  })

  it('跳过还不能播的，先放能播的那条', () => {
    // 低优先级被节流挡着，高优先级不受影响 —— 队首堵住不该让整队都卡死
    const now = 1_000_000
    const queue = [notice('t1', 'low', '进度'), notice('t2', 'high', '失败了')]

    const [ready] = drainNotices(queue, IDLE, now - 1, now)

    expect(ready?.speech).toBe('失败了')
  })

  it('会话没了就整队丢掉', () => {
    const off: VoiceFloor = { active: false, userSpeaking: false, assistantSpeaking: false }

    expect(drainNotices([notice('t1', 'high')], off, 0, 1)).toEqual([null, []])
  })
})

describe('stageOf', () => {
  it('按命名空间说人话，不逐个工具翻译', () => {
    expect(stageOf('blueprint_apply_graph', 'mutating')).toBe('在改蓝图')
    expect(stageOf('material_set_param', 'mutating')).toBe('在调材质')
    expect(stageOf('ue_playtest', 'mutating')).toBe('在运行试玩')
  })

  // 用户只是问「他那个动画蓝图是怎么选的」，语音报「在改蓝图」——
  // 听着像资产被动过（2026-09-17 反馈）
  it('只是查的，说「在看」不说「在改」', () => {
    expect(stageOf('blueprint_describe', 'safe')).toBe('在看蓝图')
    expect(stageOf('blueprint_get_graph', 'safe')).toBe('在看蓝图')
    expect(stageOf('material_get_graph', 'safe')).toBe('在看材质')
    expect(stageOf('widget_get_hierarchy', 'safe')).toBe('在看界面控件')
  })

  it('查询类的中间步骤不值得播 —— 说出来只是噪音', () => {
    expect(stageOf('ue_content_search', 'safe')).toBe('')
    expect(stageOf('search_assets', 'safe')).toBe('')
  })

  it('风险等级查不到就不播 —— 宁可不说，也不说成「在改」', () => {
    expect(stageOf('blueprint_apply_graph', undefined)).toBe('')
  })
})
