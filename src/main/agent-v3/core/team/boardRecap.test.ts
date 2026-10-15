/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import type { BoardTask } from '../../../../shared/agentTeam'
import {
  buildBoardNudge,
  carryOverTasks,
  changedSince,
  formatBoardCarryOver,
  reopenedJobTask,
  verdictIsStale
} from './boardRecap'

const HOUR = 60 * 60_000
const task = (patch: Partial<BoardTask> & { id: string }): BoardTask => ({
  title: patch.id,
  status: 'todo',
  updatedAt: 0,
  ...patch
})

/**
 * 2026-09-30 真机：第一轮制作人把 5 件活标成「卡住」，之后几轮它自己动手干活、
 * 任务板一个字没动，界面上永远是 5 个红色的「卡住」。
 */
describe('任务板旧账', () => {
  const board = [
    task({ id: 'old-blocked', status: 'blocked', updatedAt: 1 * HOUR, note: '等用户决定死亡规则' }),
    task({ id: 'old-doing', status: 'doing', updatedAt: 1 * HOUR }),
    task({ id: 'fresh-blocked', status: 'blocked', updatedAt: 3 * HOUR }),
    task({ id: 'old-todo', status: 'todo', updatedAt: 1 * HOUR }),
    task({ id: 'old-done', status: 'done', updatedAt: 1 * HOUR }),
    task({ id: 'reopened', status: 'todo', updatedAt: 3 * HOUR, reopenedAt: 3 * HOUR })
  ]

  it('只挑上一轮的「进行中 / 卡住」和用户重开的；待办和完成本来就不是对「现在」的断言', () => {
    expect(carryOverTasks(board, 2 * HOUR).map((t) => t.id)).toEqual([
      'old-blocked',
      'old-doing',
      'reopened'
    ])
  })

  it('开局那段：带上卡住原因和多久前，并说清用户这句话可能就是回答', () => {
    const text = formatBoardCarryOver(carryOverTasks(board, 2 * HOUR), 4 * HOUR)
    expect(text).toMatch(/^<team_board_carryover>/)
    expect(text).toContain('[blocked · last updated 3 h ago] old-blocked')
    expect(text).toContain('note: 等用户决定死亡规则')
    expect(text).toContain('reopened by the user 1 h ago')
    expect(text).toMatch(/no longer blocked/)
  })

  it('没有旧账：什么都不拼', () => {
    expect(formatBoardCarryOver([], 0)).toBe('')
  })

  it('收尾提醒不冒充用户', () => {
    expect(buildBoardNudge([board[0]!], 4 * HOUR)).toMatch(
      /^\[team mode · automatic check\] This is not the user speaking/
    )
  })
})

describe('改没改过工程', () => {
  const activity = [
    { who: '美术', at: 50, what: '做材质', writes: 'material_create ×3' },
    { who: '评审', at: 80, what: '看一眼', writes: '' }
  ]

  it('制作人自己的写操作或者队员带写操作的交活都算；只读的交活不算', () => {
    expect(changedSince(40, undefined, activity)).toBe(true)
    expect(changedSince(60, undefined, activity)).toBe(false)
    expect(changedSince(60, 70, activity)).toBe(true)
  })

  it('验收之后改过才算过期；没验收过谈不上过期', () => {
    expect(verdictIsStale(undefined, 100, activity)).toBe(false)
    expect(verdictIsStale(60, undefined, activity)).toBe(false)
    expect(verdictIsStale(40, undefined, activity)).toBe(true)
  })
})

/**
 * 成果架上「重开」一件停下的活：不另起通知，变成任务板上一项「用户重开」的待办，
 * 下一轮开局制作人在旧账里就能看到
 */
describe('停下的活交回制作人', () => {
  const job = {
    id: 'j7',
    member: '审核',
    brief: '同步现状',
    startedAt: 1,
    endedAt: 2,
    outcome: 'stopped' as const,
    reason: 'API key\n  auth failed'
  }

  it('变成一项挂着用户重开的待办，派给原来那个人，原因写进备注', () => {
    expect(reopenedJobTask(job, 5 * HOUR)).toEqual({
      id: 'redo-j7',
      title: '同步现状',
      owner: '审核',
      status: 'todo',
      note: 'stopped before finishing: API key auth failed',
      reopenedAt: 5 * HOUR
    })
  })

  it('下一轮开局的旧账里有它', () => {
    const patch = reopenedJobTask(job, 5 * HOUR)
    const board = [task({ ...patch, title: patch.title!, updatedAt: 5 * HOUR })]
    expect(carryOverTasks(board, 6 * HOUR).map((t) => t.id)).toEqual(['redo-j7'])
    expect(formatBoardCarryOver(carryOverTasks(board, 6 * HOUR), 6 * HOUR)).toContain(
      'reopened by the user'
    )
  })
})
