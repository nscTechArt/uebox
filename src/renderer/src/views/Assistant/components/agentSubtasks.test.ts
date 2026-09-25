import { describe, expect, it } from 'vitest'

import { buildSubtaskView, countRunningLanes, pickTitleLine } from './agentSubtasks'
import type { AgentProcessItem } from './AgentProcessLog.types'

function taskCall(callId: string, prompt: string, timestamp: number): AgentProcessItem {
  return {
    type: 'tool-call',
    data: {
      id: callId,
      type: 'function',
      function: { name: 'task', arguments: JSON.stringify({ prompt }) }
    },
    timestamp
  }
}

function taskProgress(callId: string, text: string, timestamp: number): AgentProcessItem {
  return {
    type: 'notify-users',
    data: {
      message: `子任务：${text}`,
      notifyType: 'progress',
      toolCallId: callId,
      toolName: 'task'
    },
    timestamp
  }
}

function taskResult(
  callId: string,
  result: Record<string, unknown>,
  timestamp: number,
  isError = false
): AgentProcessItem {
  return {
    type: 'tool-result',
    data: { toolName: 'task', toolCallId: callId, isError, result },
    timestamp
  }
}

describe('pickTitleLine', () => {
  /**
   * 真机上撞到的：三路子任务的 prompt 第一行是同一句框架说明，
   * 三张卡因此长得一模一样，用户看不出各自在干什么。
   */
  it('跳过整行括起来的框架说明，取第一句说人话的', () => {
    const title = pickTitleLine(
      '【这是纯只读的评审任务，你的产出是一份文字报告，不是对场景的任何改动】\n' +
        '检查主关卡里所有点光源的衰减半径是否超出房间尺寸'
    )

    expect(title).toBe('检查主关卡里所有点光源的衰减半径是否超出房间尺寸')
  })

  it('跳过分隔线和「任务」这种说不清事的小标题', () => {
    expect(pickTitleLine('## 任务\n---\n盘点材质球里的重复贴图')).toBe('盘点材质球里的重复贴图')
  })

  it('标题里不留 Markdown 标记', () => {
    expect(pickTitleLine('- 盘点材质球里的重复贴图')).toBe('盘点材质球里的重复贴图')
  })

  it('整段都是框架说明时退回首行，不留空', () => {
    expect(pickTitleLine('【只读评审，不要改场景】')).toBe('【只读评审，不要改场景】')
  })

  it('太长的标题截断，完整内容留给展开后的原文', () => {
    expect(pickTitleLine('好'.repeat(200))).toHaveLength(90)
  })
})

describe('buildSubtaskView', () => {
  it('两路并行的子任务各成一条泳道，进度不会互相覆盖', () => {
    const view = buildSubtaskView([
      taskCall('call-a', '盘点能用的模型，按用途列清楚', 1000),
      taskCall('call-b', '检查材质球里的重复贴图', 1100),
      // 两路推的进度文本一模一样 —— 只按文本分组会把它们并成一条
      taskProgress('call-a', '调用 ue_get_actor', 2000),
      taskProgress('call-b', '调用 ue_get_actor', 2100),
      taskProgress('call-a', '调用 ue_list_assets', 3000)
    ])

    expect(view.lanes).toHaveLength(2)
    expect(countRunningLanes(view.lanes)).toBe(2)

    const [first, second] = view.lanes
    expect(first.index).toBe(1)
    expect(first.title).toBe('盘点能用的模型，按用途列清楚')
    expect(first.latest).toBe('调用 ue_list_assets')
    expect(first.steps).toBe(2)

    expect(second.index).toBe(2)
    expect(second.latest).toBe('调用 ue_get_actor')
    expect(second.steps).toBe(1)
  })

  it('完整 prompt 原样留在泳道上，供界面展开查看', () => {
    const prompt = '【只读评审】\n盘点能用的模型\n- 按用途分组\n- 标出重复的'
    const view = buildSubtaskView([taskCall('call-a', prompt, 1000)])

    expect(view.lanes[0].prompt).toBe(prompt)
    expect(view.lanes[0].title).toBe('盘点能用的模型')
  })

  it('卡片长在派出去的位置上，属于这一路的条目不再单独成行', () => {
    const view = buildSubtaskView([
      { type: 'text', data: { text: '我先派两路并行的盘点。' }, timestamp: 900 },
      taskCall('call-a', '盘点模型', 1000),
      taskProgress('call-a', '调用 ue_get_actor', 2000)
    ])

    expect(view.laneAt.get(1)?.callId).toBe('call-a')
    expect([...view.absorbed].sort()).toEqual([1, 2])
    expect(view.absorbed.has(0)).toBe(false)
  })

  it('结果回来后泳道收口，带上结论和耗时', () => {
    const view = buildSubtaskView([
      taskCall('call-a', '盘点模型', 1000),
      taskResult('call-a', { text: '共 12 个模型可用', messageCount: 9 }, 5000)
    ])

    const lane = view.lanes[0]
    expect(lane.status).toBe('success')
    expect(lane.summary).toBe('共 12 个模型可用')
    expect(lane.endedAt).toBe(5000)
    expect(countRunningLanes(view.lanes)).toBe(0)
  })

  it('失败的那一路单独标出来，不跟着成功的一起算完成', () => {
    const view = buildSubtaskView([
      taskCall('call-a', '盘点模型', 1000),
      taskCall('call-b', '检查材质', 1100),
      taskResult('call-a', { text: '完成' }, 4000),
      taskResult('call-b', { success: false, error: '引擎没连上' }, 4200)
    ])

    expect(view.lanes.map((lane) => lane.status)).toEqual(['success', 'failed'])
    expect(view.lanes[1].summary).toBe('引擎没连上')
  })

  it('没有 toolCallId 的老消息原样退回扁平渲染', () => {
    const view = buildSubtaskView([
      {
        type: 'tool-call',
        data: { type: 'function', function: { name: 'task', arguments: '{"prompt":"盘点模型"}' } },
        timestamp: 1000
      },
      { type: 'notify-users', data: { message: '子任务：调用 ue_get_actor' }, timestamp: 2000 }
    ])

    expect(view.lanes).toHaveLength(0)
    expect(view.absorbed.size).toBe(0)
  })

  it('别的工具的调用和进度不会被当成子任务', () => {
    const view = buildSubtaskView([
      {
        type: 'tool-call',
        data: { id: 'call-x', type: 'function', function: { name: 'web_read', arguments: '{}' } },
        timestamp: 1000
      },
      taskProgress('call-x', '读取网页', 2000)
    ])

    expect(view.lanes).toHaveLength(0)
    expect(view.absorbed.size).toBe(0)
  })
})

describe('工作室模式的泳道', () => {
  const call = (callId: string, name: string, args: Record<string, unknown>): AgentProcessItem => ({
    type: 'tool-call',
    data: { id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    timestamp: 1
  })

  it('派给队员的活也是一条泳道，标题标上是谁在干；进度去掉「团队：」前缀', () => {
    const view = buildSubtaskView([
      call('s1', 'team_send', { to: '地编', message: '搭一个灰盒关卡\n要有起点和终点' }),
      {
        type: 'notify-users',
        data: {
          message: '团队：地编 · 调用 ue_spawn_actor',
          notifyType: 'progress',
          toolCallId: 's1',
          toolName: 'team_send'
        },
        timestamp: 2
      }
    ])
    expect(view.lanes).toHaveLength(1)
    expect(view.lanes[0]).toMatchObject({
      title: '地编：搭一个灰盒关卡',
      latest: '地编 · 调用 ue_spawn_actor',
      steps: 1
    })
  })

  /** 真机截图：三张卡的标题都是制作人写在每份开头的同一句背景 */
  it('几路共用的开场白不当标题，取各自真正的任务', () => {
    const preamble = '工程 TDGuardians 已在 UE 5.8 中打开并连上（I:/UE Project/TDGuardians）。'
    const view = buildSubtaskView([
      call('a', 'team_send', { to: '玩法主程', message: `${preamble}\n实现塔、敌人和波次` }),
      call('b', 'team_send', { to: '关卡美术', message: `${preamble}\n搭一条敌人行进路线` }),
      call('c', 'team_send', { to: 'UI程序', message: `${preamble}\n做金币和生命的 HUD` })
    ])
    expect(view.lanes.map((lane) => lane.title)).toEqual([
      '玩法主程：实现塔、敌人和波次',
      '关卡美术：搭一条敌人行进路线',
      'UI程序：做金币和生命的 HUD'
    ])
  })

  it('每一路都只有那一句时，退回原样，不留空标题', () => {
    const view = buildSubtaskView([
      call('a', 'team_send', { to: 'A', message: '同一句话，没有别的' }),
      call('b', 'team_send', { to: 'B', message: '同一句话，没有别的' })
    ])
    expect(view.lanes.map((lane) => lane.title)).toEqual([
      'A：同一句话，没有别的',
      'B：同一句话，没有别的'
    ])
  })

  it('交付验收单独一条泳道', () => {
    const view = buildSubtaskView([
      call('d1', 'team_deliver', { report: '做完了', how_to_play: 'WASD 移动' })
    ])
    expect(view.lanes[0]).toMatchObject({ title: '交付验收', prompt: '做完了\n\nWASD 移动' })
  })
})
