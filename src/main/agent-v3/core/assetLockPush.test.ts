import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acquire,
  forceReleaseAll,
  releaseAll,
  setLockChangeListener,
  type LockRecord
} from './assetLock'
import { createLockPusher, groupLocksByConnection } from './assetLockPush'
import { CURRENT_LEVEL_LOCK } from './assetLock'

function lock(path: string, connectionId: string | undefined, owner = 'sess-1'): LockRecord {
  return { path, connectionId, owner, acquiredAt: 0 }
}

beforeEach(() => {
  forceReleaseAll()
  setLockChangeListener(undefined)
})

describe('groupLocksByConnection', () => {
  it('按连接分组，避免 A 工程的锁跑到 B 工程的内容浏览器里亮灯', () => {
    const groups = groupLocksByConnection([
      lock('/Game/A', 'conn-a'),
      lock('/Game/B', 'conn-b'),
      lock('/Game/C', 'conn-a')
    ])

    expect(groups.get('conn-a')).toEqual(['/Game/A', '/Game/C'])
    expect(groups.get('conn-b')).toEqual(['/Game/B'])
  })

  it('路径排序 —— 顺序取决于模型先碰哪个资产，不排序会把同一批锁判成变了', () => {
    const groups = groupLocksByConnection([lock('/Game/Z', 'c'), lock('/Game/A', 'c')])
    expect(groups.get('c')).toEqual(['/Game/A', '/Game/Z'])
  })
})

describe('createLockPusher', () => {
  it('内容没变就不重复推 —— 模型一轮里会反复碰同一个资产', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'conn-a')])
    push([lock('/Game/A', 'conn-a')])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('conn-a', ['/Game/A'], [], false)
  })

  it('顺序不同但内容相同，同样不推', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'c'), lock('/Game/B', 'c')])
    push([lock('/Game/B', 'c'), lock('/Game/A', 'c')])

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('从有到无要推一次空列表，否则角标永远擦不掉', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'conn-a')])
    push([])

    expect(send).toHaveBeenNthCalledWith(2, 'conn-a', [], [], false)
  })

  it('清空之后不再重复推空 —— 空状态是稳态，不该每轮都发一遍', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'conn-a')])
    push([])
    push([])

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('多连接各推各的，只有变了的那个连接会收到', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'conn-a'), lock('/Game/B', 'conn-b')])
    send.mockClear()

    push([lock('/Game/A', 'conn-a'), lock('/Game/B', 'conn-b'), lock('/Game/C', 'conn-b')])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('conn-b', ['/Game/B', '/Game/C'], [], false)
  })

  it('没指定目标工程的锁走默认连接（connectionId 传 undefined）', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', undefined)])

    expect(send).toHaveBeenCalledWith(undefined, ['/Game/A'], [], false)
  })

  it('只读位翻上去会重推 —— 锁没变但文案从「会互相覆盖」变成「保存会被拦下」', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'c')], [])
    push([lock('/Game/A', 'c')], ['/Game/A'])

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(2, 'c', ['/Game/A'], ['/Game/A'], false)
  })

  /**
   * 发失败的那次同样被记成「已推」（callRequest 的 reject 在上层被吞掉）。
   * 编辑器随后才连上来时不重推的话，只要锁表内容不再变化就一个角标都不会出现。
   */
  it('forgetAll 之后同样的内容会重新推一次', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'conn-a')])
    push([lock('/Game/A', 'conn-a')])
    expect(send).toHaveBeenCalledTimes(1)

    push.forgetAll()
    push([lock('/Game/A', 'conn-a')])

    expect(send).toHaveBeenCalledTimes(2)
  })

  /**
   * 会话没绑定目标工程时 `getTargetConnectionId()` 返回 undefined，锁就记在默认
   * 分组里。编辑器连上来时按真实 connectionId 挑着忘的话，恰恰碰不到这一批 ——
   * 而那是单工程下最常见的形态，表现为「角标一个都不出现」。
   */
  it('forgetAll 也会把默认分组（connectionId 为 undefined）一起忘掉', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', undefined)])
    send.mockClear()

    push.forgetAll()
    push([lock('/Game/A', undefined)])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(undefined, ['/Game/A'], [], false)
  })

  /**
   * 关卡走的是哨兵，不是包路径。混进 paths 推过去的话，插件会拿它去匹配包名，
   * 匹配不上就什么都不显示 —— 等于白推。
   */
  it('关卡哨兵不进 paths，单独发一个布尔', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'conn-a'), lock(CURRENT_LEVEL_LOCK, 'conn-a')])

    expect(send).toHaveBeenCalledWith('conn-a', ['/Game/A'], [], true)
  })

  it('只锁了关卡时，paths 是空的但布尔为 true', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock(CURRENT_LEVEL_LOCK, 'conn-a')])

    expect(send).toHaveBeenCalledWith('conn-a', [], [], true)
  })

  it('关卡从没锁到锁上要重推 —— 路径列表没变，但文案变了', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'conn-a')])
    push([lock('/Game/A', 'conn-a'), lock(CURRENT_LEVEL_LOCK, 'conn-a')])

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(2, 'conn-a', ['/Game/A'], [], true)
  })

  it('enforced 只发给它自己那条连接', () => {
    const send = vi.fn()
    const push = createLockPusher(send)

    push([lock('/Game/A', 'conn-a'), lock('/Game/B', 'conn-b')], ['/Game/B'])

    expect(send).toHaveBeenCalledWith('conn-a', ['/Game/A'], [], false)
    expect(send).toHaveBeenCalledWith('conn-b', ['/Game/B'], ['/Game/B'], false)
  })
})

describe('锁表变更回调', () => {
  it('真的加了锁才回调，重复拿同一把不回调', () => {
    const seen = vi.fn()
    setLockChangeListener(seen)

    acquire('conn-a', 'sess-1', ['/Game/A'])
    acquire('conn-a', 'sess-1', ['/Game/A'])

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith([expect.objectContaining({ path: '/Game/A' })])
  })

  it('拿不到锁（冲突）不回调 —— 锁表根本没变', () => {
    acquire('conn-a', 'sess-1', ['/Game/A'])

    const seen = vi.fn()
    setLockChangeListener(seen)
    acquire('conn-a', 'sess-2', ['/Game/A'])

    expect(seen).not.toHaveBeenCalled()
  })

  it('释放时回调，且拿到的是释放后的空表', () => {
    acquire('conn-a', 'sess-1', ['/Game/A'])

    const seen = vi.fn()
    setLockChangeListener(seen)
    releaseAll('sess-1')

    expect(seen).toHaveBeenCalledWith([])
  })

  it('回调抛异常不能影响锁本身 —— 锁没放掉才是会卡死用户工程的那一头', () => {
    acquire('conn-a', 'sess-1', ['/Game/A'])
    setLockChangeListener(() => {
      throw new Error('界面炸了')
    })

    expect(() => releaseAll('sess-1')).not.toThrow()
    expect(acquire('conn-a', 'sess-2', ['/Game/A'])).toEqual({ ok: true })
  })
})
