import { describe, expect, it } from 'vitest'

import {
  clearFollowUps,
  dequeueFollowUp,
  EMPTY_QUEUES,
  enqueueFollowUp,
  findFollowUp,
  listFollowUps,
  removeFollowUp,
  resolveFollowUpAction,
  type FollowUpQueues
} from './followUpQueue'

type Payload = { content: string }

function empty(): FollowUpQueues<Payload> {
  return EMPTY_QUEUES as FollowUpQueues<Payload>
}

function seed(chatSid: string, ...texts: string[]): FollowUpQueues<Payload> {
  return texts.reduce<FollowUpQueues<Payload>>(
    (queues, text) => enqueueFollowUp(queues, chatSid, text, { content: text }).queues,
    empty()
  )
}

describe('排队', () => {
  it('排进去能读出来', () => {
    const queues = seed('chat-a', '顺便把材质也调一下')
    expect(listFollowUps(queues, 'chat-a').map((item) => item.text)).toEqual(['顺便把材质也调一下'])
  })

  it('没排过的对话读出空数组，不是 undefined', () => {
    expect(listFollowUps(empty(), 'chat-a')).toEqual([])
  })

  it('先进先出', () => {
    const queues = seed('chat-a', '第一条', '第二条')
    const first = dequeueFollowUp(queues, 'chat-a')
    expect(first.item?.text).toBe('第一条')
    expect(dequeueFollowUp(first.queues, 'chat-a').item?.text).toBe('第二条')
  })

  it('一次只取一条 —— 第二条要等这一条也跑完，不然照样撞上「正在执行中」', () => {
    const queues = seed('chat-a', '第一条', '第二条')
    const after = dequeueFollowUp(queues, 'chat-a')
    expect(listFollowUps(after.queues, 'chat-a')).toHaveLength(1)
  })

  it('空队列取出来是 undefined，队列本身不变', () => {
    const result = dequeueFollowUp(empty(), 'chat-a')
    expect(result.item).toBeUndefined()
    expect(listFollowUps(result.queues, 'chat-a')).toEqual([])
  })

  it('重复的话不合并 —— 说两遍「再试一次」多半真的是想试两次', () => {
    const queues = seed('chat-a', '再试一次', '再试一次')
    expect(listFollowUps(queues, 'chat-a')).toHaveLength(2)
  })

  it('两条对话各排各的，切走再回来不会串', () => {
    let queues = seed('chat-a', 'A 的话')
    queues = enqueueFollowUp(queues, 'chat-b', 'B 的话', { content: 'B 的话' }).queues
    expect(listFollowUps(queues, 'chat-a').map((i) => i.text)).toEqual(['A 的话'])
    expect(listFollowUps(queues, 'chat-b').map((i) => i.text)).toEqual(['B 的话'])
  })

  it('取 A 的队首不动 B 的队列', () => {
    let queues = seed('chat-a', 'A 的话')
    queues = enqueueFollowUp(queues, 'chat-b', 'B 的话', { content: 'B 的话' }).queues
    const after = dequeueFollowUp(queues, 'chat-a')
    expect(listFollowUps(after.queues, 'chat-b')).toHaveLength(1)
  })

  it('原队列不被就地改写 —— 界面靠换引用重绘', () => {
    const queues = seed('chat-a', '第一条')
    dequeueFollowUp(queues, 'chat-a')
    expect(listFollowUps(queues, 'chat-a')).toHaveLength(1)
  })
})

describe('按 id 找一条（「立即插话」要用）', () => {
  it('找得到，且带着原样的 payload', () => {
    const queues = seed('chat-a', '第一条', '第二条')
    const target = listFollowUps(queues, 'chat-a')[1]
    expect(findFollowUp(queues, 'chat-a', target.id)?.payload).toEqual({ content: '第二条' })
  })

  it('找的时候不动队列 —— 插话可能失败，失败了它得还在原地', () => {
    const queues = seed('chat-a', '第一条')
    const target = listFollowUps(queues, 'chat-a')[0]
    findFollowUp(queues, 'chat-a', target.id)
    expect(listFollowUps(queues, 'chat-a')).toHaveLength(1)
  })

  it('id 对不上、或者对话对不上，都是 undefined', () => {
    const queues = seed('chat-a', '第一条')
    const target = listFollowUps(queues, 'chat-a')[0]
    expect(findFollowUp(queues, 'chat-a', '不存在')).toBeUndefined()
    expect(findFollowUp(queues, 'chat-b', target.id)).toBeUndefined()
  })
})

describe('取消', () => {
  it('按 id 点掉其中一条，其余保持原序', () => {
    const queues = seed('chat-a', '第一条', '第二条', '第三条')
    const target = listFollowUps(queues, 'chat-a')[1]
    const after = removeFollowUp(queues, 'chat-a', target.id)
    expect(listFollowUps(after, 'chat-a').map((i) => i.text)).toEqual(['第一条', '第三条'])
  })

  it('id 对不上就原样返回', () => {
    const queues = seed('chat-a', '第一条')
    expect(removeFollowUp(queues, 'chat-a', '不存在')).toBe(queues)
  })

  it('清空只清这条对话', () => {
    let queues = seed('chat-a', 'A 的话')
    queues = enqueueFollowUp(queues, 'chat-b', 'B 的话', { content: 'B 的话' }).queues
    const after = clearFollowUps(queues, 'chat-a')
    expect(listFollowUps(after, 'chat-a')).toEqual([])
    expect(listFollowUps(after, 'chat-b')).toHaveLength(1)
  })

  it('清一条没排过东西的对话是空操作', () => {
    const queues = empty()
    expect(clearFollowUps(queues, 'chat-a')).toBe(queues)
  })

  it('取完最后一条后不留空桶', () => {
    const queues = seed('chat-a', '唯一一条')
    const after = dequeueFollowUp(queues, 'chat-a').queues
    expect(Object.keys(after)).toEqual([])
  })
})

describe('回车走哪条路', () => {
  it('没在跑的时候永远是普通发送 —— 没有队可排也没有方向可改', () => {
    expect(resolveFollowUpAction('queue', false, false)).toBe('send')
    expect(resolveFollowUpAction('steer', true, false)).toBe('send')
  })

  it('跑着的时候按设置走', () => {
    expect(resolveFollowUpAction('queue', false, true)).toBe('queue')
    expect(resolveFollowUpAction('steer', false, true)).toBe('steer')
  })

  it('按住 Ctrl 对这一条反着来', () => {
    expect(resolveFollowUpAction('queue', true, true)).toBe('steer')
    expect(resolveFollowUpAction('steer', true, true)).toBe('queue')
  })
})
