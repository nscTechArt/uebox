import { describe, expect, it } from 'vitest'

import { ActiveRuns } from './activeRuns'

/** 一条会话的登记内容，测试里只要能认出来是谁就够了 */
interface Entry {
  name: string
}

describe('ActiveRuns', () => {
  it('同一会话重复登记不能覆盖原任务和等待者', async () => {
    const runs = new ActiveRuns<Entry>()
    runs.track('s1', { name: 'first' })
    const drained = runs.drain('s1', 1000)
    expect(() => runs.track('s1', { name: 'second' })).toThrow('already running')
    expect(runs.get('s1')).toEqual({ name: 'first' })
    runs.release('s1')
    await expect(drained).resolves.toBe(true)
  })
  it('登记之后能按 sessionId 找回来', () => {
    const runs = new ActiveRuns<Entry>()
    runs.track('s1', { name: 'a' })

    expect(runs.has('s1')).toBe(true)
    expect(runs.get('s1')).toEqual({ name: 'a' })
    expect(runs.entries()).toEqual([['s1', { name: 'a' }]])
  })

  it('摘掉之后就不在表里了', () => {
    const runs = new ActiveRuns<Entry>()
    runs.track('s1', { name: 'a' })
    runs.release('s1')

    expect(runs.has('s1')).toBe(false)
    expect(runs.get('s1')).toBeUndefined()
    expect(runs.entries()).toEqual([])
  })

  /**
   * 这是整个类存在的理由。
   *
   * 「停下来 → 立刻重发一轮」这条路上，重发必须发生在旧会话**真的摘掉之后**：
   * 早一步发出去，主进程只会顶回来一句「会话正在执行中」，用户刚敲的那段话
   * 就白打了。
   */
  it('drain 要等到 release 才兑现', async () => {
    const runs = new ActiveRuns<Entry>()
    runs.track('s1', { name: 'a' })

    let settled = false
    const drained = runs.drain('s1', 1000).then((value) => {
      settled = true
      return value
    })

    // 还没 release，drain 不该有结果
    await Promise.resolve()
    expect(settled).toBe(false)

    runs.release('s1')
    await expect(drained).resolves.toBe(true)
  })

  it('等超时了就如实回 false —— 卡住的会话确实存在', async () => {
    const runs = new ActiveRuns<Entry>()
    runs.track('s1', { name: 'a' })

    await expect(runs.drain('s1', 5)).resolves.toBe(false)
  })

  it('没在跑的会话直接回 true —— 要的结果本来就成立', async () => {
    const runs = new ActiveRuns<Entry>()

    await expect(runs.drain('unknown', 1000)).resolves.toBe(true)
  })

  it('同一条会话的多个等待者一起被唤醒', async () => {
    const runs = new ActiveRuns<Entry>()
    runs.track('s1', { name: 'a' })

    const waiters = Promise.all([runs.drain('s1', 1000), runs.drain('s1', 1000)])
    runs.release('s1')

    await expect(waiters).resolves.toEqual([true, true])
  })

  /** 会话跑完又被重新拉起（重新生成、断点续跑）时，两轮的等待互不干扰 */
  it('重新登记之后是新的一轮，旧的等待不受影响', async () => {
    const runs = new ActiveRuns<Entry>()
    runs.track('s1', { name: 'first' })
    const first = runs.drain('s1', 1000)
    runs.release('s1')
    await expect(first).resolves.toBe(true)

    runs.track('s1', { name: 'second' })
    expect(runs.get('s1')).toEqual({ name: 'second' })
    await expect(runs.drain('s1', 5)).resolves.toBe(false)
  })
})
