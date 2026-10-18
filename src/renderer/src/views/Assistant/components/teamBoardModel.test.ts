import { describe, expect, it } from 'vitest'

import type { TeamJob, TeamStateView } from '@core/shared/agentTeam'

import { buildBoardModel, latestRequestLine, type BoardModel } from './teamBoardModel'

const NOW = 1_000_000_000
const min = (n: number): number => NOW - n * 60_000

function team(over: Partial<TeamStateView> = {}): TeamStateView {
  return {
    objective: '统计项目',
    verdict: null,
    verdictStale: false,
    deliveries: 0,
    roundStartedAt: min(30),
    members: [
      { name: 'A', persona: '', tier: 'strong', readOnly: true, hiredAt: 1 },
      { name: 'B', persona: '', tier: 'strong', readOnly: true, hiredAt: 2 }
    ],
    board: [],
    mail: [],
    jobs: [],
    events: [],
    ...over
  }
}

const job = (over: Partial<TeamJob> & { id: string; member: string }): TeamJob => ({
  brief: '干活',
  startedAt: min(10),
  ...over
})

const live = (running: string[]): TeamStateView['live'] => ({
  running,
  waiting: [],
  awaited: [],
  assignments: [],
  recent: []
})

const build = (t: TeamStateView, running = false): BoardModel =>
  buildBoardModel(t, [], { running, now: NOW })

describe('buildBoardModel：这一轮到哪了', () => {
  it('有活在写就是进行中；在跑但还没派活是安排中；跑完是本轮完成；什么都没有是待命', () => {
    const writing = team({ jobs: [job({ id: 'j1', member: 'A' })], live: live(['producer', 'a']) })
    expect(build(writing, true).phase).toBe('working')
    expect(build(team({ live: live(['producer']) }), true).phase).toBe('planning')
    const done = team({
      jobs: [job({ id: 'j1', member: 'A', endedAt: min(1), outcome: 'done', report: '# 报告' })]
    })
    expect(build(done).phase).toBe('done')
    expect(build(team()).phase).toBe('idle')
  })

  it('最近一件停下了算要人看；停下之后又派了一件并交回来，就不算', () => {
    const stopped = team({
      jobs: [job({ id: 'j1', member: 'A', endedAt: min(5), outcome: 'stopped', reason: '断开' })]
    })
    expect(build(stopped)).toMatchObject({ phase: 'alert', stopped: 1 })
    const redone = team({
      jobs: [
        job({ id: 'j1', member: 'A', endedAt: min(5), outcome: 'stopped', reason: '断开' }),
        job({ id: 'j2', member: 'A', startedAt: min(4), endedAt: min(1), outcome: 'done' })
      ]
    })
    expect(build(redone)).toMatchObject({ phase: 'done', stopped: 0 })
  })

  /**
   * 停下的活不上成果架，折成一行。只留还没人管的：同一个人之后又接了活
   * （制作人已经接手），或用户点过重开（已经交回制作人），都只留在日志里
   */
  it('停着没人管的才进 stops；被接手、被重开的不算', () => {
    const m = build(
      team({
        jobs: [
          job({ id: 'j1', member: 'A', endedAt: min(9), outcome: 'stopped', reason: '断开' }),
          job({ id: 'j2', member: 'A', startedAt: min(8), endedAt: min(7), outcome: 'stopped' }),
          job({ id: 'j3', member: 'B', endedAt: min(6), outcome: 'stopped', reopenedAt: min(1) }),
          job({ id: 'j4', member: 'B', startedAt: min(5), endedAt: min(4), outcome: 'stopped' })
        ]
      })
    )
    expect(m.stops.map((j) => j.id)).toEqual(['j4', 'j2'])
    expect(m.stopped).toBe(2)

    const allReopened = build(
      team({
        jobs: [
          job({ id: 'j1', member: 'A', endedAt: min(5), outcome: 'stopped', reopenedAt: min(1) })
        ]
      })
    )
    expect(allReopened).toMatchObject({ stopped: 0, stops: [] })
    expect(allReopened.phase).not.toBe('alert')
  })

  it('账上还挂着在写、可这次运行里没人在跑：上次被打断了，算没交回', () => {
    const orphan = team({ jobs: [job({ id: 'j1', member: 'A' })] })
    expect(build(orphan).round[0]!.state).toBe('lost')
    expect(build({ ...orphan, live: live(['a']) }, true).round[0]!.state).toBe('writing')
  })

  it('验收只认这一轮的、没人在跑时的', () => {
    const old = team({ verdict: 'pass', verdictAt: min(60) })
    expect(build(old).verdict).toBeNull()
    const fresh = team({ verdict: 'pass', verdictAt: min(1), deliveries: 2 })
    expect(build(fresh).verdict).toMatchObject({ kind: 'pass', count: 2 })
    expect(build(fresh, true).verdict).toBeNull()
  })

  it('每次验收各占往来里一条；老数据没有验收事件时拿最近那次补一条', () => {
    const verdicts = (t: TeamStateView): string[] =>
      build(t)
        .log.filter((e) => e.kind === 'verdict')
        .map((e) => e.verdict ?? '')
    const history = team({
      verdict: 'pass',
      verdictAt: min(1),
      deliveries: 3,
      events: [
        { kind: 'verdict', verdict: 'fail', at: min(20) },
        { kind: 'crashed', at: min(15) },
        { kind: 'verdict', verdict: 'fail', at: min(10) },
        { kind: 'verdict', verdict: 'pass', at: min(1) }
      ]
    })
    expect(verdicts(history)).toEqual(['pass', 'fail', 'fail'])
    expect(verdicts(team({ verdict: 'fail', verdictAt: min(1), deliveries: 1 }))).toEqual(['fail'])
  })

  it('这一轮之前交回的放进「更早」；这一轮的按开工先后', () => {
    const t = team({
      jobs: [
        job({ id: 'j1', member: 'A', startedAt: min(90), endedAt: min(80), outcome: 'done' }),
        job({ id: 'j2', member: 'B', startedAt: min(20), endedAt: min(2), outcome: 'done' }),
        job({ id: 'j3', member: 'A', startedAt: min(10) })
      ],
      live: live(['a'])
    })
    const model = build(t, true)
    expect(model.round.map((j) => j.id)).toEqual(['j2', 'j3'])
    expect(model.earlier.map((j) => j.id)).toEqual(['j1'])
  })
})

describe('buildBoardModel：交回了什么', () => {
  it('报告的标题当名字；正文去掉客套话和重复的标题；没标题用派活那句', () => {
    const t = team({
      jobs: [
        job({
          id: 'j1',
          member: 'A',
          endedAt: min(1),
          outcome: 'done',
          report: '任务已完成，报告全文如下。\n\n# 资产统计\n\n- 21,384 个'
        }),
        job({
          id: 'j2',
          member: 'B',
          brief: '统计配置',
          endedAt: min(1),
          outcome: 'done',
          report: '都正常。'
        })
      ]
    })
    const [a, b] = build(t).round
    expect(a).toMatchObject({ title: '资产统计', body: '- 21,384 个' })
    expect(b).toMatchObject({ title: '统计配置', body: '都正常。' })
  })

  it('有活的账之前的老数据：拿后台交活的留言补成交回的活；之后的同一份不重复', () => {
    const t = team({
      jobs: [job({ id: 'j1', member: 'A', startedAt: min(5), endedAt: min(1), outcome: 'done' })],
      mail: [
        {
          id: 'm1',
          from: 'B',
          to: 'producer',
          text: '【交活】B 回话：\n# 旧报告\n- 一条',
          at: min(20)
        },
        { id: 'm2', from: 'A', to: 'producer', text: '【交活】A 回话：\n# 新报告', at: min(1) }
      ]
    })
    const model = build(t)
    expect(model.round.map((j) => j.title)).toEqual(['旧报告', '干活'])
    // 交活留言不在往来里重复
    expect(model.log.filter((e) => e.kind === 'mail')).toHaveLength(0)
  })

  it('闲下来的人：账上最近一件交回了就说交了什么，停下了就说停在哪', () => {
    const t = team({
      jobs: [
        job({ id: 'j1', member: 'A', endedAt: min(2), outcome: 'done', report: '# 资产统计' }),
        job({ id: 'j2', member: 'B', endedAt: min(2), outcome: 'stopped', reason: '连接断开' })
      ]
    })
    const [a, b] = build(t).crew
    expect(a!.status).toMatchObject({ kind: 'delivered', title: '资产统计' })
    expect(b!.status).toMatchObject({ kind: 'stopped', reason: '连接断开' })
    expect(b!.mood).toBe('alert')
  })
})

describe('buildBoardModel：往来和事件', () => {
  it('同一个人连着把一样的话发给几个人：合成一条；有人没读到就算未读', () => {
    const text = '提醒：编辑器崩溃过。'
    const t = team({
      mail: [
        { id: 'm1', from: 'producer', to: 'A', text, at: min(3), readAt: min(2) },
        { id: 'm2', from: 'producer', to: 'B', text, at: min(3) }
      ]
    })
    const mails = build(t).log.filter((e) => e.kind === 'mail')
    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatchObject({ to: ['A', 'B'], unread: true })
  })

  it('崩溃算进当时手上有活的人的往来，并在他们身上挂一阵子', () => {
    const t = team({
      jobs: [
        job({ id: 'j1', member: 'A', startedAt: min(10) }),
        job({ id: 'j2', member: 'B', startedAt: min(2) })
      ],
      events: [{ kind: 'crashed', at: min(4) }],
      live: live(['a', 'b'])
    })
    const [a, b] = build(t, true).crew
    expect(a!.shaken).toBe(true)
    expect(a!.thread.some((e) => e.kind === 'crashed')).toBe(true)
    expect(b!.shaken).toBe(false)
  })
})

describe('latestRequestLine：委托下面那行最新要求', () => {
  it('短的原样显示，换行压成空格', () => {
    expect(latestRequestLine('主角\n换成猫 ')).toBe('主角 换成猫')
  })

  it('长的截末尾：用户自己的话在最后，前面是拼进来的上下文', () => {
    const line = latestRequestLine(`${'上下文'.repeat(100)}主角换成猫`)
    expect(line.startsWith('…')).toBe(true)
    expect(line.endsWith('主角换成猫')).toBe(true)
    expect(line.length).toBe(121)
  })
})
