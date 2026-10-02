/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { createPendingSlot } from './pendingSlot'

/**
 * 暂存格要守的几件事：
 * - 取走即清
 * - 超时作废（界面一分钟后才来取，那条动作早就没意义了）
 * - 只留最新一条
 */

describe('托盘动作暂存格', () => {
  it('take 取出值然后清空', () => {
    const slot = createPendingSlot<string>({ ttlMs: 1_000 })

    slot.put('a')
    expect(slot.take()).toBe('a')
    expect(slot.take()).toBeNull()
  })

  it('空的时候 take 是 null', () => {
    expect(createPendingSlot<string>({ ttlMs: 1_000 }).take()).toBeNull()
  })

  it('过期的作废', () => {
    let now = 0
    const slot = createPendingSlot<string>({ ttlMs: 1_000, now: () => now })

    slot.put('a')
    now = 1_001

    expect(slot.take()).toBeNull()
  })

  it('TTL 边界：刚好到期那一刻还认', () => {
    let now = 0
    const slot = createPendingSlot<string>({ ttlMs: 1_000, now: () => now })

    slot.put('a')
    now = 1_000

    expect(slot.take()).toBe('a')
  })

  it('put 覆盖：只留最新一条', () => {
    const slot = createPendingSlot<string>({ ttlMs: 1_000 })

    slot.put('old')
    slot.put('new')

    expect(slot.take()).toBe('new')
    expect(slot.take()).toBeNull()
  })
})
