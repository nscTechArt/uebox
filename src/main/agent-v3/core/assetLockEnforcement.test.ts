import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  enforceAfterWrite,
  listEnforced,
  releaseEnforcement,
  releaseProtectionBeforeDelete,
  resetEnforcementState,
  restoreOnConnect,
  setEnforcementChangeListener,
  setLockRepublishTrigger,
  setProjectRootResolver,
  suspendForWrite
} from './assetLockEnforcement'
import { countProtected, resetReadonlyGuardCaches } from './assetReadonlyGuard'
import { acquire, forceReleaseAll, releaseAll } from './assetLock'
import type { LockRecord } from './assetLock'

let root: string

function makeAsset(relative: string): string {
  const file = path.join(root, 'Content', ...relative.split('/')) + '.uasset'
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'bytes', 'utf8')
  return file
}

function isWritable(file: string): boolean {
  return (statSync(file).mode & 0o200) !== 0
}

function lock(packagePath: string, connectionId: string | undefined): LockRecord {
  return { path: packagePath, connectionId, owner: 'sess-1', acquiredAt: 0 }
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ual-enforce-'))
  setProjectRootResolver(async () => root)
  setEnforcementChangeListener(undefined)
  setLockRepublishTrigger(undefined)
  resetEnforcementState()
  resetReadonlyGuardCaches()
  // restoreOnConnect / releaseEnforcement 都要读锁表，上一条用例漏下的锁
  // 会被当成「仍被持有」而改变这一条的结果
  forceReleaseAll()
})

afterEach(async () => {
  setProjectRootResolver(undefined)
  setEnforcementChangeListener(undefined)
  setLockRepublishTrigger(undefined)
  // 留下的只读文件会让 Windows 上的 rm 失败
  const content = path.join(root, 'Content')
  if (existsSync(content)) {
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else chmodSync(full, 0o666)
      }
    }
    walk(content)
  }
  rmSync(root, { recursive: true, force: true })
})

describe('持有者写入前后的开合', () => {
  it('做完之后位翻上去，再开工之前又清掉', async () => {
    const file = makeAsset('Materials/M_Rock')

    await enforceAfterWrite([lock('/Game/Materials/M_Rock', 'conn-a')])
    expect(isWritable(file)).toBe(false)

    await suspendForWrite([lock('/Game/Materials/M_Rock', 'conn-a')])
    expect(isWritable(file)).toBe(true)

    // 清位期间**不动台账** —— 崩了也只是把可写文件再设成可写
    expect(await countProtected(root)).toBe(1)
  })

  it('解析不出工程根目录就整个跳过，不抛', async () => {
    setProjectRootResolver(async () => undefined)
    const file = makeAsset('Materials/M_Rock')

    await expect(
      enforceAfterWrite([lock('/Game/Materials/M_Rock', 'conn-a')])
    ).resolves.toBeUndefined()
    expect(isWritable(file)).toBe(true)
  })

  it('底层抛异常也不往上冒 —— 只读位是增强层，不能让工具失败', async () => {
    setProjectRootResolver(async () => {
      throw new Error('工程管理器炸了')
    })

    await expect(enforceAfterWrite([lock('/Game/A', 'conn-a')])).resolves.toBeUndefined()
    await expect(suspendForWrite([lock('/Game/A', 'conn-a')])).resolves.toBeUndefined()
  })
})

describe('listEnforced', () => {
  it('只报真的翻上去了的那些 —— 决定界面敢不敢说「保存会被拦下」', async () => {
    makeAsset('Materials/M_Real')

    await enforceAfterWrite([
      lock('/Game/Materials/M_Real', 'conn-a'),
      lock('/Game/Materials/M_Missing', 'conn-a')
    ])

    const locks = [
      lock('/Game/Materials/M_Real', 'conn-a'),
      lock('/Game/Materials/M_Missing', 'conn-a')
    ]
    expect(listEnforced(locks)).toEqual(['/Game/Materials/M_Real'])
  })

  it('只读位状态变了会通知 —— 锁没变但文案变了', async () => {
    makeAsset('Materials/M_Rock')
    const seen = vi.fn()
    setEnforcementChangeListener(seen)

    await enforceAfterWrite([lock('/Game/Materials/M_Rock', 'conn-a')])

    expect(seen).toHaveBeenCalled()
  })
})

describe('releaseEnforcement', () => {
  it('一轮 run 结束把位全解掉', async () => {
    const file = makeAsset('Materials/M_Rock')
    await enforceAfterWrite([lock('/Game/Materials/M_Rock', 'conn-a')])

    await releaseEnforcement([lock('/Game/Materials/M_Rock', 'conn-a')])

    expect(isWritable(file)).toBe(true)
    expect(await countProtected(root)).toBe(0)
    expect(listEnforced([lock('/Game/Materials/M_Rock', 'conn-a')])).toEqual([])
  })
})

describe('restoreOnConnect', () => {
  it('工程连上来时把上次没解干净的还原 —— 崩溃兜底', async () => {
    const file = makeAsset('Materials/M_Rock')
    await enforceAfterWrite([lock('/Game/Materials/M_Rock', 'conn-a')])

    // 模拟盒子崩了重开：内存全没了，只剩盘上的台账
    expect(await restoreOnConnect('conn-a')).toBe(1)
    expect(isWritable(file)).toBe(true)
  })

  /**
   * 编辑器崩溃重连时会走这条路，而那会儿会话往往还在跑。把它正握着的位一起
   * 清掉的话，界面继续说「保存会被拦下」而位已经没了 —— 文案红线上最坏的一种。
   */
  it('当前仍被持有的锁不还原', async () => {
    const held = makeAsset('Materials/M_Held')
    const stale = makeAsset('Materials/M_Stale')
    await enforceAfterWrite([
      lock('/Game/Materials/M_Held', 'conn-a'),
      lock('/Game/Materials/M_Stale', 'conn-a')
    ])

    acquire('conn-a', 'sess-live', ['/Game/Materials/M_Held'])
    try {
      expect(await restoreOnConnect('conn-a')).toBe(1)

      expect(isWritable(held)).toBe(false)
      expect(isWritable(stale)).toBe(true)
      // 界面对这两个的说法都还对得上
      expect(listEnforced([lock('/Game/Materials/M_Held', 'conn-a')])).toEqual([
        '/Game/Materials/M_Held'
      ])
      expect(listEnforced([lock('/Game/Materials/M_Stale', 'conn-a')])).toEqual([])
    } finally {
      releaseAll('sess-live')
    }
  })
})

/**
 * 同一批工具是并发跑的（见 defineTool.ts 的 concurrency），而它们的 held 互相
 * 包含。没有引用计数的话先返回的那个会在兄弟工具还在写盘时把位翻回去。
 */
describe('清位引用计数', () => {
  it('兄弟调用还开着时，先完成的那个不许把位翻回来', async () => {
    const file = makeAsset('Materials/M_Shared')
    const held = [lock('/Game/Materials/M_Shared', 'conn-a')]

    await enforceAfterWrite(held)
    expect(isWritable(file)).toBe(false)

    // 工具 A 和工具 B 先后开工
    await suspendForWrite(held)
    await suspendForWrite(held)
    expect(isWritable(file)).toBe(true)

    // B 先返回 —— A 还在写，位不能翻回去
    await enforceAfterWrite(held)
    expect(isWritable(file)).toBe(true)

    // A 也返回了，这才翻回来
    await enforceAfterWrite(held)
    expect(isWritable(file)).toBe(false)
  })
})

/**
 * 角标重推是 C 阶段的主功能，和只读位（B 阶段）没有半点关系。它一度被放进
 * `restoreOnConnect` 里、排在 `if (!root) return 0` 后面 —— 插件没报工程路径
 * 这种小事就让内容浏览器一个角标都不出现。
 */
describe('工程连上来时的角标重推', () => {
  it('正常路径会重推', async () => {
    const republish = vi.fn()
    setLockRepublishTrigger(republish)

    await restoreOnConnect('conn-a')

    expect(republish).toHaveBeenCalledTimes(1)
  })

  it('解不出工程根目录时照样重推 —— 它不该依赖只读位那条路', async () => {
    setProjectRootResolver(async () => undefined)
    const republish = vi.fn()
    setLockRepublishTrigger(republish)

    expect(await restoreOnConnect('conn-a')).toBe(0)
    expect(republish).toHaveBeenCalledTimes(1)
  })

  it('还原过程抛异常也要重推', async () => {
    setProjectRootResolver(async () => {
      throw new Error('工程管理器炸了')
    })
    const republish = vi.fn()
    setLockRepublishTrigger(republish)

    expect(await restoreOnConnect('conn-a')).toBe(0)
    expect(republish).toHaveBeenCalledTimes(1)
  })
})

/**
 * 会话没绑定目标工程时 `getTargetConnectionId()` 返回 undefined，单工程下的
 * 普通对话记的锁全长这样。两套键空间对不上的话，界面会对着一个已经没有只读位的
 * 资产继续说「保存会被拦下」。
 */
describe('connectionId 为 undefined 的锁', () => {
  it('restoreOnConnect 不会把它们的位当成残留清掉', async () => {
    const file = makeAsset('Materials/M_Rock')
    await enforceAfterWrite([lock('/Game/Materials/M_Rock', undefined)])
    expect(isWritable(file)).toBe(false)

    acquire(undefined, 'sess-live', ['/Game/Materials/M_Rock'])
    try {
      expect(await restoreOnConnect('conn-7')).toBe(0)

      expect(isWritable(file)).toBe(false)
      expect(listEnforced([lock('/Game/Materials/M_Rock', undefined)])).toEqual([
        '/Game/Materials/M_Rock'
      ])
    } finally {
      releaseAll('sess-live')
    }
  })
})

/**
 * 释放是 `releaseAll` 里发出来的未 await 调用，等它轮到时下一轮可能已经把同一批
 * 路径重新抢走了。清计数和解位必须用同一份名单 —— 抹平计数会让先返回的那个
 * 工具当成「最后一个关」把位翻上去，而兄弟工具还在写。
 */
describe('释放与下一轮抢锁的交叠', () => {
  it('还锁着的包不许动它的清位引用计数', async () => {
    const file = makeAsset('Materials/M_Rock')
    const held = [lock('/Game/Materials/M_Rock', 'conn-a')]
    await enforceAfterWrite(held)

    acquire('conn-a', 'sess-next', ['/Game/Materials/M_Rock'])
    try {
      await suspendForWrite(held)
      await suspendForWrite(held)
      expect(isWritable(file)).toBe(true)

      await releaseEnforcement(held)

      await enforceAfterWrite(held)
      expect(isWritable(file)).toBe(true)

      await enforceAfterWrite(held)
      expect(isWritable(file)).toBe(false)
    } finally {
      releaseAll('sess-next')
    }
  })
})

/**
 * 删除前的撤保护。只读的包引擎删不掉且一声不吭（UE 5.5 实测），所以删之前
 * 要把盒子自己翻的位清掉 —— 包括**不在当前锁里**的陈年台账条目，
 * 那种正是「自己的锁把自己挡在门外」而且完全查不出原因的来源。
 */
describe('删资产之前撤掉自己的只读保护', () => {
  it('清位并销账，界面的「已拦截」也跟着摘掉', async () => {
    const file = makeAsset('Materials/M_Doomed')
    const held = [lock('/Game/Materials/M_Doomed', 'conn-a')]

    await enforceAfterWrite(held)
    expect(isWritable(file)).toBe(false)
    expect(listEnforced(held)).toEqual(['/Game/Materials/M_Doomed'])

    await releaseProtectionBeforeDelete('conn-a', ['/Game/Materials/M_Doomed'])

    expect(isWritable(file)).toBe(true)
    expect(await countProtected(root)).toBe(0)
    expect(listEnforced(held)).toEqual([])
  })

  it('当前一把锁都没有，台账里的陈年条目照样清得掉', async () => {
    const file = makeAsset('Materials/M_Stale')

    // 上一次 run 留下的：位翻着、台账记着，但这一轮谁都没锁它
    await enforceAfterWrite([lock('/Game/Materials/M_Stale', 'conn-a')])
    resetEnforcementState()
    expect(isWritable(file)).toBe(false)

    await releaseProtectionBeforeDelete('conn-a', ['/Game/Materials/M_Stale'])

    expect(isWritable(file)).toBe(true)
    expect(await countProtected(root)).toBe(0)
  })

  it('解析不出工程、底层抛异常都不往上冒', async () => {
    setProjectRootResolver(async () => {
      throw new Error('工程管理器炸了')
    })
    await expect(releaseProtectionBeforeDelete('conn-a', ['/Game/A'])).resolves.toBeUndefined()

    setProjectRootResolver(async () => undefined)
    await expect(releaseProtectionBeforeDelete('conn-a', ['/Game/A'])).resolves.toBeUndefined()
  })
})
