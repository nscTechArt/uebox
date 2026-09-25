import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acquire,
  describeConflicts,
  extractPackagePaths,
  forceReleaseAll,
  getLockOwner,
  listLocks,
  releaseAll,
  rootSessionId,
  runWithLockOwner,
  setLockConflictNotifier
} from './assetLock'

const CONN = 'conn-a'

beforeEach(() => {
  forceReleaseAll()
  setLockConflictNotifier(undefined)
})

describe('extractPackagePaths', () => {
  it('按值的形状认路径，不看参数叫什么名字', () => {
    expect(
      extractPackagePaths({
        blueprint_path: '/Game/BP_Door',
        material_path: '/Game/M_Rock',
        某个没见过的字段: '/Game/Nested/Thing'
      })
    ).toEqual(expect.arrayContaining(['/Game/BP_Door', '/Game/M_Rock', '/Game/Nested/Thing']))
  })

  it('磁盘路径一律不认', () => {
    expect(
      extractPackagePaths({
        path: 'H:\\UnrealAgent\\thing.uasset',
        source_path: '/c/Users/me/file.fbx',
        cwd: 'C:/Program Files',
        url: 'https://example.com/Game/Fake'
      })
    ).toEqual([])
  })

  it('内容根本身不是资产', () => {
    expect(extractPackagePaths({ path: '/Game/' })).toEqual([])
    expect(extractPackagePaths({ path: '/Game' })).toEqual([])
  })

  it('引擎内容不认 —— agent 本来就不该改它', () => {
    expect(extractPackagePaths({ path: '/Engine/BasicShapes/Cube' })).toEqual([])
  })

  it('子对象削回包路径，同一个文件不会被当成两个', () => {
    expect(extractPackagePaths({ a: '/Game/BP_Door.BP_Door_C', b: '/Game/BP_Door' })).toEqual([
      '/Game/BP_Door'
    ])
  })

  it('目录名里的点不会被误削', () => {
    expect(extractPackagePaths({ path: '/Game/v1.2/M_Rock' })).toEqual(['/Game/v1.2/M_Rock'])
  })

  it('钻进数组和嵌套对象', () => {
    expect(
      extractPackagePaths({
        assets: ['/Game/A', '/Game/B'],
        nested: { deeper: { path: '/Game/C' } }
      })
    ).toEqual(expect.arrayContaining(['/Game/A', '/Game/B', '/Game/C']))
  })
})

describe('rootSessionId', () => {
  it('剥掉子 agent 后缀', () => {
    expect(rootSessionId('s1:sub-3')).toBe('s1')
    expect(rootSessionId('s1')).toBe('s1')
  })
})

describe('runWithLockOwner', () => {
  it('主人跟着执行流走，异步之后也还在', async () => {
    const seen = await runWithLockOwner('s1:sub-2', async () => {
      await Promise.resolve()
      return getLockOwner()
    })
    // 子 agent 的执行流里读到的是**根**会话，父子共享同一把锁
    expect(seen).toBe('s1')
  })

  it('不在上下文里时没有主人', () => {
    expect(getLockOwner()).toBeUndefined()
  })
})

describe('acquire', () => {
  it('别的会话占着就拿不到', () => {
    expect(acquire(CONN, 's1', ['/Game/A'])).toEqual({ ok: true })

    const result = acquire(CONN, 's2', ['/Game/A'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.conflicts).toEqual([
        { path: '/Game/A', owner: 's1', since: expect.any(Number) }
      ])
    }
  })

  it('同一个主人重复拿是幂等的', () => {
    expect(acquire(CONN, 's1', ['/Game/A'])).toEqual({ ok: true })
    expect(acquire(CONN, 's1', ['/Game/A'])).toEqual({ ok: true })
    expect(listLocks()).toHaveLength(1)
  })

  it('父 agent 和它的子 agent 不互锁', () => {
    expect(acquire(CONN, 's1', ['/Game/A'])).toEqual({ ok: true })
    // 子 agent 拿同一个资产必须放行，否则父等子、子被父挡住，整轮卡死
    expect(acquire(CONN, 's1:sub-1', ['/Game/A'])).toEqual({ ok: true })
  })

  it('不同工程的同名路径互不影响', () => {
    expect(acquire('conn-a', 's1', ['/Game/A'])).toEqual({ ok: true })
    expect(acquire('conn-b', 's2', ['/Game/A'])).toEqual({ ok: true })
    expect(listLocks()).toHaveLength(2)
  })

  it('大小写不同视为同一个资产', () => {
    expect(acquire(CONN, 's1', ['/Game/A'])).toEqual({ ok: true })
    expect(acquire(CONN, 's2', ['/game/a']).ok).toBe(false)
  })

  it('一批里有一个拿不到就整批不拿，不留残锁', () => {
    expect(acquire(CONN, 's1', ['/Game/B'])).toEqual({ ok: true })

    const result = acquire(CONN, 's2', ['/Game/A', '/Game/B', '/Game/C'])
    expect(result.ok).toBe(false)

    // s2 一把都不该留下：/Game/A 和 /Game/C 必须仍然是自由的
    expect(listLocks().map((lock) => lock.owner)).toEqual(['s1'])
    expect(acquire(CONN, 's3', ['/Game/A', '/Game/C'])).toEqual({ ok: true })
  })

  it('冲突要通知出去，但同一个 (会话, 资产) 只通知一次', () => {
    const notify = vi.fn()
    setLockConflictNotifier(notify)

    acquire(CONN, 's1', ['/Game/A'])
    acquire(CONN, 's2', ['/Game/A'])
    acquire(CONN, 's2', ['/Game/A'])
    acquire(CONN, 's2', ['/Game/A'])

    // 模型会重试，重试不该把界面刷屏
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/Game/A', owner: 's1', requester: 's2' })
    )
  })
})

describe('releaseAll', () => {
  it('只放自己的，别人的不动', () => {
    acquire(CONN, 's1', ['/Game/A', '/Game/B'])
    acquire(CONN, 's2', ['/Game/C'])

    expect(releaseAll('s1')).toBe(2)
    expect(listLocks().map((lock) => lock.path)).toEqual(['/Game/C'])
  })

  it('子 agent 的锁跟着根会话一起放', () => {
    runWithLockOwner('s1:sub-1', () => acquire(CONN, 's1:sub-1', ['/Game/A']))
    expect(releaseAll('s1')).toBe(1)
    expect(listLocks()).toHaveLength(0)
  })

  it('放完之后同一个冲突可以重新提示 —— 那是新的一轮了', () => {
    const notify = vi.fn()
    setLockConflictNotifier(notify)

    acquire(CONN, 's1', ['/Game/A'])
    acquire(CONN, 's2', ['/Game/A'])
    releaseAll('s2')
    acquire(CONN, 's2', ['/Game/A'])

    expect(notify).toHaveBeenCalledTimes(2)
  })
})

describe('describeConflicts', () => {
  it('说清楚哪个资产、没改动、以及别原样重试', () => {
    const text = describeConflicts([{ path: '/Game/A', owner: 'b04ba478-uuid' }])
    expect(text).toContain('/Game/A')
    expect(text).toContain('未做任何改动')
    expect(text).toContain('重试')
  })

  it('不把会话 id 交给模型 —— 它只会把一串 uuid 原样转述给用户', () => {
    const text = describeConflicts([{ path: '/Game/A', owner: 'b04ba478-uuid' }])
    expect(text).not.toContain('b04ba478')
  })

  it('明说与编辑器操作无关 —— 模型曾把用户支去关闭资产，那不会解锁', () => {
    const text = describeConflicts([{ path: '/Game/A', owner: 's1' }])
    expect(text).toContain('虚幻编辑器')
  })
})

/**
 * 工作室模式：同一个团队里的制作人（锁主 = 会话）和队员（锁主 = `<会话>:mate-<名字>`）。
 * 2026-09-26 真机反馈：三张材质被一把目录「锁」拦下、改默认 GameMode 被 GameMode 蓝图的锁拦下、
 * 报错只说「另一条 AI 会话」—— 队友之间撞锁时说不清是谁。
 */
describe('工作室模式的锁', () => {
  it('目录参数不当资产锁：往同一个目录里建东西不会互相挡', () => {
    expect(
      extractPackagePaths({ material_name: 'M_Rock', destination_path: '/Game/Materials' })
    ).toEqual([])
    expect(extractPackagePaths({ folder: '/Game/UI', asset_path: '/Game/UI/WBP_Card' })).toEqual([
      '/Game/UI/WBP_Card'
    ])
  })

  it('写 ini 的参数：值里的资产引用不锁（改配置不碰那个资产）', () => {
    expect(
      extractPackagePaths({
        config_name: 'Engine',
        section: '/Script/EngineSettings.GameMapsSettings',
        key: 'GlobalDefaultGameMode',
        value: '/Game/Core/BP_GameMode.BP_GameMode_C'
      })
    ).toEqual([])
  })

  it('撞上队友的锁：说清是哪个队友、什么时候放，不说「另一条 AI 会话」', () => {
    const text = describeConflicts([{ path: '/Game/Core/BP_GM', owner: 's1:mate-玩法主程' }], 's1')
    expect(text).toContain('队友「玩法主程」')
    expect(text).toContain('team_message')
    expect(text).not.toContain('另一条 AI 会话')
    expect(describeConflicts([{ path: '/Game/A', owner: 's1' }], 's1:mate-美术')).toContain(
      '制作人'
    )
  })

  it('队友之间撞锁不弹「两个窗口抢资产」的提示；跨会话照旧弹', () => {
    const notify = vi.fn()
    setLockConflictNotifier(notify)
    acquire(CONN, 's1:mate-美术', ['/Game/A'])
    acquire(CONN, 's1', ['/Game/A'])
    expect(notify).not.toHaveBeenCalled()
    acquire(CONN, 's2', ['/Game/A'])
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
