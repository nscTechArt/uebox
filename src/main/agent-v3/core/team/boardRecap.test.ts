/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import type { BoardTask } from '../../../../shared/agentTeam'
import {
  buildBoardNudge,
  carryOverTasks,
  changedSince,
  formatBoardCarryOver,
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
    expect(buildBoardNudge([board[0]!], 4 * HOUR)).toMatch(/^\[team mode · automatic check\] This is not the user speaking/)
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
