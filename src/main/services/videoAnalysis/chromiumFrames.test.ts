/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { frameTimes } from './chromiumFrames'

describe('frameTimes', () => {
  it('短片子每秒两帧，取每段中点避开黑场', () => {
    expect(frameTimes(2)).toEqual([0.25, 0.75, 1.25, 1.75])
  })

  it('长片子总数压在两张联系表以内，且覆盖到片尾', () => {
    const times = frameTimes(600)
    expect(times).toHaveLength(48)
    expect(times[times.length - 1]).toBeGreaterThan(590)
  })

  it('不到半秒的片子也至少抽一帧', () => {
    expect(frameTimes(0.2)).toHaveLength(1)
  })
})
