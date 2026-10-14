import { describe, expect, it } from 'vitest'

import type { TeamStateView } from '@core/shared/agentTeam'

import { toolKind } from './officeActivity'
import {
  hairStyle,
  memberMode,
  officeMembers,
  activityTool,
  recentTools,
  producerMode,
  teamEvents
} from './officeInput'

const team: TeamStateView = {
  objective: '做个小游戏',
  verdict: null,
  verdictStale: false,
  deliveries: 0,
  members: [
    { name: '阿场景', persona: '', tier: 'strong', readOnly: false, hiredAt: 2 },
    { name: '阿实体', persona: '', tier: 'strong', readOnly: false, hiredAt: 1 }
  ],
  board: [{ id: 't1', title: '关卡', status: 'doing', owner: '阿场景', updatedAt: 1 }],
  mail: []
}

describe('toolKind', () => {
  it('按工具名粗分动作；认不出的当成改东西', () => {
    expect(toolKind('blueprint_apply_graph')).toBe('write')
    expect(toolKind('ue_set_property')).toBe('write')
    expect(toolKind('blueprint_describe')).toBe('read')
    expect(toolKind('ue_content_search')).toBe('read')
    expect(toolKind('blueprint_compile')).toBe('run')
    expect(toolKind('ue_run_python_script')).toBe('run')
    expect(toolKind('ue_screenshot')).toBe('look')
    expect(toolKind('ue_autoplay')).toBe('play')
    expect(toolKind('team_message')).toBe('talk')
    expect(toolKind('something_new')).toBe('write')
  })
})

describe('memberMode', () => {
  const tools = new Map([['阿场景', { tool: 'ue_screenshot', at: 1 }]])

  it('等回话优先；在跑的看最近一次工具；没调工具时是在想', () => {
    const live = {
      running: ['阿场景', '阿实体'],
      waiting: ['阿实体'],
      awaited: [],
      assignments: [],
      recent: []
    }
    expect(memberMode({ ...team, live }, '阿实体', tools)).toEqual({ kind: 'wait' })
    expect(memberMode({ ...team, live }, '阿场景', tools)).toEqual({ kind: 'work', tool: 'look' })
    expect(memberMode({ ...team, live }, '阿场景', new Map())).toEqual({
      kind: 'work',
      tool: 'think'
    })
  })

  it('手上有活但这一刻没在跑（排着队）也算在干活', () => {
    const live = {
      running: [],
      waiting: [],
      awaited: [],
      assignments: [{ member: '阿场景', text: '搭关卡', since: 1 }],
      recent: []
    }
    expect(memberMode({ ...team, live }, '阿场景', new Map()).kind).toBe('work')
  })

  it('最后一条留言是「没干完」→ 停工；之后又交了活就不算', () => {
    const stopped = {
      ...team,
      mail: [
        {
          id: 'm1',
          from: '阿实体',
          to: 'producer',
          at: 1,
          text: '【没干完】阿实体 这件活停下了：403'
        }
      ]
    }
    expect(memberMode(stopped, '阿实体', new Map())).toEqual({ kind: 'out' })
    const recovered = {
      ...stopped,
      mail: [
        ...stopped.mail,
        { id: 'm2', from: '阿实体', to: 'producer', at: 2, text: '【交活】阿实体 回话：\n好了' }
      ]
    }
    expect(memberMode(recovered, '阿实体', new Map())).toEqual({ kind: 'idle' })
  })
})

describe('officeMembers', () => {
  it('按入职顺序分衬衫颜色；名字小写当 id；发型不撞制作人的耳麦', () => {
    const members = officeMembers(team, new Map())
    expect(members.map((m) => [m.name, m.crew])).toEqual([
      ['阿实体', 0],
      ['阿场景', 1]
    ])
    expect(members[0]!.id).toBe('阿实体')
    for (const name of ['a', 'b', 'Alice', '阿中枢', '阿界面', 'x'.repeat(30)]) {
      expect(hairStyle(name)).not.toBe(6)
      expect(hairStyle(name)).toBe(hairStyle(name))
    }
  })
})

describe('producerMode', () => {
  it('卡在等队员交活 → 站到那人身后；在跑 → 写白板；否则闲着', () => {
    const live = {
      running: ['producer'],
      waiting: [],
      awaited: ['阿场景'],
      assignments: [],
      recent: []
    }
    expect(producerMode({ ...team, live }, true)).toEqual({ kind: 'awaiting', on: '阿场景' })
    expect(producerMode({ ...team, live: { ...live, awaited: [] } }, false)).toEqual({
      kind: 'board'
    })
    expect(producerMode(team, true)).toEqual({ kind: 'board' })
    expect(producerMode(team, false)).toEqual({ kind: 'idle' })
  })
})

describe('teamEvents', () => {
  it('第一次不放事件；之后新留言、标完成、卡住、验收结论各出一个', () => {
    expect(teamEvents(null, team)).toEqual([])
    const next: TeamStateView = {
      ...team,
      verdict: 'pass',
      verdictAt: 5,
      board: [{ id: 't1', title: '关卡', status: 'done', owner: '阿场景', updatedAt: 2 }],
      mail: [{ id: 'm1', from: '阿场景', to: 'producer', at: 2, text: '好了' }]
    }
    expect(teamEvents(team, next)).toEqual([
      { kind: 'mail', from: '阿场景', to: 'producer' },
      { kind: 'done', id: '阿场景' },
      { kind: 'verdict', result: 'pass' }
    ])
    expect(teamEvents(next, next)).toEqual([])
  })
})

describe('动态 → 工具', () => {
  it('认出调的是哪个工具；它说的话算在想；每人取最后一条', () => {
    expect(activityTool('调用 ue_set_property /Game/Maps/Arena')).toBe('ue_set_property')
    expect(activityTool('我先看看关卡')).toBe('')
    const tools = recentTools([
      { member: '阿场景', text: '调用 ue_screenshot', at: 1 },
      { member: '阿场景', text: '调用 blueprint_compile', at: 2 },
      { member: 'Bob', text: '想一想', at: 3 }
    ])
    expect(tools.get('阿场景')).toEqual({ tool: 'blueprint_compile', at: 2 })
    expect(tools.get('bob')).toEqual({ tool: '', at: 3 })
  })

  it('这件活开工之前的动态不算', () => {
    const live = {
      running: ['阿场景'],
      waiting: [],
      awaited: [],
      assignments: [{ member: '阿场景', text: '搭关卡', since: 10 }],
      recent: []
    }
    const old = new Map([['阿场景', { tool: 'ue_screenshot', at: 5 }]])
    expect(memberMode({ ...team, live }, '阿场景', old)).toEqual({ kind: 'work', tool: 'think' })
  })
})
