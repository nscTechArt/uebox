/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { createLaunchTracker, LAUNCH_TTL_MS, withProjectState } from './launchTracker'
import type { TrayProjectCandidate } from './recentProjects'

/**
 * 「启动中」要守的几件事：
 * - begin 之后立刻算启动中；打开还没落定（null）的那段**不吃 TTL**
 * - complete(true) 才开始算「等引擎连上」的 TTL；complete(false) 直接摘掉
 * - clearIfRunning 只摘「等连接」的计时标记 —— 进行中的打开被 running 撞上
 *   也不放行，不然 connect-then-disconnect 之间就能点开第二份
 * - withProjectState：running 优先于 launching，连上了顺手摘计时标记
 */

function candidate(partial: Partial<TrayProjectCandidate> = {}): TrayProjectCandidate {
  return {
    projectKey: 'key-1',
    name: 'Demo',
    originPath: 'D:/Demo/Demo.uproject',
    ...partial
  }
}

describe('启动中跟踪', () => {
  it('begin 之后在启动中，complete(false) 之后不在', () => {
    const tracker = createLaunchTracker()

    tracker.begin('k')
    expect(tracker.isLaunching('k')).toBe(true)

    tracker.complete('k', false)
    expect(tracker.isLaunching('k')).toBe(false)
  })

  it('没标过的从来不算启动中', () => {
    expect(createLaunchTracker().isLaunching('never-marked')).toBe(false)
  })

  it('打开还没落定的那段不吃 TTL：过了 TTL 照样拦着第二下', () => {
    let now = 1_000
    const tracker = createLaunchTracker({ now: () => now })

    tracker.begin('k')
    now += LAUNCH_TTL_MS + 1

    expect(tracker.isLaunching('k')).toBe(true)
  })

  it('complete(true) 之后才开始算 TTL：计时从落定那一刻起，不从点下那一刻起', () => {
    let now = 1_000
    const tracker = createLaunchTracker({ now: () => now })

    tracker.begin('k')
    now += LAUNCH_TTL_MS + 60_000
    tracker.complete('k', true)

    expect(tracker.isLaunching('k')).toBe(true)
    now += LAUNCH_TTL_MS
    expect(tracker.isLaunching('k')).toBe(true)
    now += 1
    expect(tracker.isLaunching('k')).toBe(false)
  })

  it('TTL 边界：刚好到期那一刻还算启动中', () => {
    let now = 1_000
    const tracker = createLaunchTracker({ now: () => now })

    tracker.begin('k')
    tracker.complete('k', true)
    now += LAUNCH_TTL_MS

    expect(tracker.isLaunching('k')).toBe(true)
  })

  it('clearIfRunning 摘掉「等连接」的计时标记', () => {
    const tracker = createLaunchTracker()
    tracker.begin('k')
    tracker.complete('k', true)

    tracker.clearIfRunning('k')
    expect(tracker.isLaunching('k')).toBe(false)
  })

  it('clearIfRunning 摘不动进行中的打开：连上过又断开，也还在启动中', () => {
    const tracker = createLaunchTracker()
    tracker.begin('k')

    tracker.clearIfRunning('k')
    expect(tracker.isLaunching('k')).toBe(true)
  })

  describe('nextExpiryDelay', () => {
    it('没有任何标记时返回 null', () => {
      expect(createLaunchTracker().nextExpiryDelay()).toBeNull()
    })

    it('只有进行中的打开时返回 null：那段不排期', () => {
      const tracker = createLaunchTracker()
      tracker.begin('k')
      expect(tracker.nextExpiryDelay()).toBeNull()
    })

    it('等连接的标记给出 ttl+1 的剩余时间（正好到期那刻还算启动中）', () => {
      let now = 1_000
      const tracker = createLaunchTracker({ now: () => now })
      tracker.begin('k')
      tracker.complete('k', true)

      expect(tracker.nextExpiryDelay()).toBe(LAUNCH_TTL_MS + 1)
      now += 60_000
      expect(tracker.nextExpiryDelay()).toBe(LAUNCH_TTL_MS + 1 - 60_000)
    })

    it('多个等连接的工程取最早的到期点', () => {
      let now = 1_000
      const tracker = createLaunchTracker({ now: () => now })
      tracker.begin('a')
      tracker.complete('a', true)
      now += 30_000
      tracker.begin('b')
      tracker.complete('b', true)

      expect(tracker.nextExpiryDelay()).toBe(LAUNCH_TTL_MS + 1 - 30_000)
    })

    it('过期的标记顺手删掉，不再占着排期', () => {
      let now = 1_000
      const tracker = createLaunchTracker({ now: () => now })
      tracker.begin('old')
      tracker.complete('old', true)
      now += LAUNCH_TTL_MS + 10
      tracker.begin('fresh')
      tracker.complete('fresh', true)

      expect(tracker.nextExpiryDelay()).toBe(LAUNCH_TTL_MS + 1)
      expect(tracker.isLaunching('old')).toBe(false)
    })
  })

  describe('withProjectState', () => {
    it('标过的非运行工程标启动中，没标过的原样', () => {
      const tracker = createLaunchTracker()
      tracker.begin('key-1')

      const [a, b] = withProjectState(
        [candidate({ projectKey: 'key-1' }), candidate({ projectKey: 'key-2' })],
        new Set(),
        tracker
      )

      expect(a.launching).toBe(true)
      expect(b.launching).toBe(false)
    })

    it('运行中的不算启动中，还把「等连接」的计时标记摘掉', () => {
      const tracker = createLaunchTracker()
      tracker.begin('key-1')
      tracker.complete('key-1', true)

      const [a] = withProjectState(
        [candidate({ projectKey: 'key-1' })],
        new Set(['key-1']),
        tracker
      )

      expect(a.running).toBe(true)
      expect(a.launching).toBe(false)
      // 连上了 = 启动结束了，不该再留着标记到 TTL
      expect(tracker.isLaunching('key-1')).toBe(false)
    })

    it('连上又断开时打开还在进行：running 投影摘不掉 pending，依旧拦着', () => {
      const tracker = createLaunchTracker()
      tracker.begin('key-1')

      const [during] = withProjectState(
        [candidate({ projectKey: 'key-1' })],
        new Set(['key-1']),
        tracker
      )
      expect(during.running).toBe(true)

      const [after] = withProjectState([candidate({ projectKey: 'key-1' })], new Set(), tracker)
      expect(after.running).toBe(false)
      expect(after.launching).toBe(true)
    })

    it('不往候选名单上写字段，也不动传进来的对象', () => {
      const tracker = createLaunchTracker()
      tracker.begin('key-1')
      const input = candidate({ projectKey: 'key-1' })

      const [projected] = withProjectState([input], new Set(), tracker)
      projected.name = '改过的'
      expect(projected.name).toBe('改过的')
      expect(input).toEqual({
        projectKey: 'key-1',
        name: 'Demo',
        originPath: 'D:/Demo/Demo.uproject'
      })
    })
  })
})
