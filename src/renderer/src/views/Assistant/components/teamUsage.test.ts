import { describe, expect, it } from 'vitest'

import { ACCEPTOR, EMPTY_TEAM_USAGE, PRODUCER, type TeamUsage } from '@core/shared/agentTeam'
import { teamUsageRows, usageCostIsPartial } from './teamUsage'

const u = (total: number, over: Partial<TeamUsage> = {}): TeamUsage => ({
  ...EMPTY_TEAM_USAGE,
  input: total,
  total,
  unpriced: total,
  ...over
})

describe('团队用量按人排', () => {
  it('制作人在前、验收员在后，队员按名册；名册里没有的排在队员后面；全 0 的不列', () => {
    const rows = teamUsageRows(
      {
        total: u(100),
        byWho: {
          [ACCEPTOR]: u(5),
          走了的人: u(10),
          乙: u(20),
          [PRODUCER]: u(30),
          甲: u(35),
          丙: u(0)
        }
      },
      [{ name: '甲' }, { name: 'X' }, { name: '乙' }, { name: '丙' }]
    )
    expect(rows.map((r) => r.who)).toEqual([PRODUCER, '甲', '乙', '走了的人', ACCEPTOR])
  })

  it('名字不分大小写对名册', () => {
    const rows = teamUsageRows({ total: u(2), byWho: { b: u(1), A: u(1) } }, [
      { name: 'a' },
      { name: 'B' }
    ])
    expect(rows.map((r) => r.who)).toEqual(['A', 'b'])
  })

  it('没有账就没有行', () => {
    expect(teamUsageRows(undefined, [])).toEqual([])
  })

  it('既有金额又有没价目的 token，金额才要说明只算了一部分', () => {
    expect(usageCostIsPartial(u(10, { cost: 0.1, unpriced: 4 }))).toBe(true)
    expect(usageCostIsPartial(u(10, { cost: 0.1, unpriced: 0 }))).toBe(false)
    expect(usageCostIsPartial(u(10))).toBe(false)
  })
})
