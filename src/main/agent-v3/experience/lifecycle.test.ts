import { describe, expect, it } from 'vitest'

import { applyOutcome, emptyStats, lift, type EntryStats, type Outcome } from './lifecycle'

const shown = (adopted: boolean, ok: boolean | undefined): Outcome => ({
  arm: 'shown',
  adopted,
  ok
})
const holdout = (ok: boolean): Outcome => ({ arm: 'holdout', adopted: false, ok })

function run(
  outcomes: Outcome[],
  status: 'trial' | 'proven' = 'trial',
  pinned = false
): { stats: EntryStats; status: 'trial' | 'proven' | 'retired' } {
  let stats: EntryStats = emptyStats()
  let current: 'trial' | 'proven' | 'retired' = status
  for (const outcome of outcomes) {
    const next = applyOutcome({ status: current, pinned }, stats, outcome)
    stats = next.stats
    current = next.status
  }
  return { stats, status: current }
}

describe('lifecycle', () => {
  it('只给被采纳且随后成功的记功：没被采纳的成功不算', () => {
    const { stats, status } = run([shown(false, true), shown(false, true), shown(false, true)])
    expect(stats.adoptedOk).toBe(0)
    expect(status).toBe('trial')
  })

  it('对照样本不够时，采纳后成功 3 次且成功率达标就转正', () => {
    expect(run([shown(true, true), shown(true, true), shown(true, true)]).status).toBe('proven')
  })

  it('有对照时看提升：出场不比不出场好就不转正', () => {
    const { status, stats } = run([
      holdout(true),
      holdout(true),
      holdout(true),
      shown(true, true),
      shown(true, true),
      shown(true, false),
      shown(true, true)
    ])
    expect(lift(stats)).toBeLessThan(0)
    expect(status).not.toBe('proven')
  })

  it('照着做了还是同一个错：转正的当场降回试用，试用的错两次退休', () => {
    expect(run([shown(true, false)], 'proven').status).toBe('trial')
    expect(run([shown(true, false), shown(true, false)]).status).toBe('retired')
  })

  it('连续被忽略 5 次退休；钉住的不退休', () => {
    const ignored = Array.from({ length: 5 }, () => shown(false, undefined))
    expect(run(ignored).status).toBe('retired')
    expect(run(ignored, 'trial', true).status).toBe('trial')
  })

  it('样本够了、提升不为正就退休', () => {
    const outcomes = [
      ...Array.from({ length: 5 }, () => holdout(true)),
      ...Array.from({ length: 5 }, () => shown(true, undefined))
    ]
    expect(run(outcomes).status).toBe('retired')
  })
})
