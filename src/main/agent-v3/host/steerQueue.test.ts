import { describe, expect, it } from 'vitest'
import {
  cancelSteer,
  markSteerDelivered,
  queueSteer,
  type PendingSteer,
  type SteeringSink
} from './steerQueue'

/** 假内核队列。按 `steeringMode: 'all'` 的行为来：读一次把队列全端走 */
function fakeSink(): SteeringSink & { queued: unknown[]; drainAll(): unknown[] } {
  const queued: unknown[] = []
  return {
    queued,
    steer(message) {
      queued.push(message)
    },
    clearSteeringQueue() {
      queued.length = 0
    },
    hasQueuedMessages() {
      return queued.length > 0
    },
    drainAll() {
      const drained = [...queued]
      queued.length = 0
      return drained
    }
  }
}

describe('queueSteer', () => {
  it('同时送进内核和留底，两边缺一不可', () => {
    const pending: PendingSteer[] = []
    const sink = fakeSink()

    const id = queueSteer(pending, sink, '把材质也调一下', {
      role: 'user',
      content: '<闪存>\n\n把材质也调一下'
    })

    expect(id).toBeTruthy()
    expect(sink.queued).toHaveLength(1)
    expect(pending).toHaveLength(1)
    expect(pending[0].text).toBe('把材质也调一下')
  })

  it('每条一个号，撤回时才指认得了是哪一条', () => {
    const pending: PendingSteer[] = []
    const sink = fakeSink()

    const first = queueSteer(pending, sink, '甲', { content: '甲' })
    const second = queueSteer(pending, sink, '乙', { content: '乙' })

    expect(first).not.toBe(second)
  })
})

describe('markSteerDelivered', () => {
  it('内核回执来了就销号，之后撤不回来', () => {
    const pending: PendingSteer[] = []
    const sink = fakeSink()
    const id = queueSteer(pending, sink, '甲', { content: '甲' })

    markSteerDelivered(pending, '甲')

    expect(pending).toHaveLength(0)
    expect(cancelSteer(pending, sink, id)).toBe('already-sent')
  })

  it('同一句话插两次，先进的先销号', () => {
    const pending: PendingSteer[] = []
    const sink = fakeSink()
    const first = queueSteer(pending, sink, '快点', { content: '快点' })
    const second = queueSteer(pending, sink, '快点', { content: '快点' })

    markSteerDelivered(pending, '快点')

    expect(pending.map((item) => item.id)).toEqual([second])
    expect(first).not.toBe(second)
  })

  it('对不上任何一条的回执（本轮最初那句 prompt）不动队列', () => {
    const pending: PendingSteer[] = []
    const sink = fakeSink()
    queueSteer(pending, sink, '甲', { content: '甲' })

    markSteerDelivered(pending, '这是这一轮最初的提示词')

    expect(pending).toHaveLength(1)
  })
})

describe('cancelSteer', () => {
  it('撤掉中间那条，另外两条按原序留在内核队列里', () => {
    const pending: PendingSteer[] = []
    const sink = fakeSink()
    queueSteer(pending, sink, '甲', { content: '甲' })
    const second = queueSteer(pending, sink, '乙', { content: '乙' })
    queueSteer(pending, sink, '丙', { content: '丙' })

    expect(cancelSteer(pending, sink, second)).toBe('cancelled')

    expect(sink.queued).toEqual([{ content: '甲' }, { content: '丙' }])
    expect(pending.map((item) => item.text)).toEqual(['甲', '丙'])
  })

  it('内核队列已经空了 = 这一批全被读走了，撤回要失败而不是把别的重发一遍', () => {
    const pending: PendingSteer[] = []
    const sink = fakeSink()
    const first = queueSteer(pending, sink, '甲', { content: '甲' })
    queueSteer(pending, sink, '乙', { content: '乙' })

    // 内核读走了整批，回执还在路上（影子队列里两条都还挂着）
    sink.drainAll()

    expect(cancelSteer(pending, sink, first)).toBe('already-sent')
    // 关键：一条都不许重新排进去，否则模型会把同一件事干两遍
    expect(sink.queued).toEqual([])
    expect(pending).toEqual([])
  })

  it('号对不上就是撤不回来，不会误伤别的条目', () => {
    const pending: PendingSteer[] = []
    const sink = fakeSink()
    queueSteer(pending, sink, '甲', { content: '甲' })

    expect(cancelSteer(pending, sink, 'steer-不存在')).toBe('already-sent')
    expect(pending).toHaveLength(1)
    expect(sink.queued).toHaveLength(1)
  })

  it('撤掉唯一那条之后，内核队列是空的', () => {
    const pending: PendingSteer[] = []
    const sink = fakeSink()
    const id = queueSteer(pending, sink, '算了', { content: '算了' })

    expect(cancelSteer(pending, sink, id)).toBe('cancelled')
    expect(sink.queued).toEqual([])
    expect(pending).toEqual([])
  })
})
