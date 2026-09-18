import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  countProtected,
  detectSourceControl,
  packageToFile,
  protectPackages,
  resetReadonlyGuardCaches,
  restoreLedger,
  suspendProtection,
  throwOnNextLedgerOpForTest,
  unprotectPackages
} from './assetReadonlyGuard'

let root: string

/** 造一个最小工程：Content 下放几个假 .uasset */
function makeAsset(relative: string, ext = '.uasset'): string {
  const file = path.join(root, 'Content', ...relative.split('/')) + ext
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'fake package bytes', 'utf8')
  return file
}

function isWritable(file: string): boolean {
  return (statSync(file).mode & 0o200) !== 0
}

function ledgerFile(): string {
  return path.join(root, 'Saved', 'UnrealBox', 'readonly-ledger.json')
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ual-readonly-'))
  // 台账和版本控制现在都有进程内缓存，不清的话上一条用例的状态会漏过来
  resetReadonlyGuardCaches()
})

afterEach(() => {
  // 测试里可能留下只读文件，先全放开再删，否则 Windows 上 rm 会失败
  try {
    const parsed = JSON.parse(readFileSync(ledgerFile(), 'utf8'))
    for (const entry of parsed.entries ?? []) {
      if (existsSync(entry.file)) chmodSync(entry.file, 0o666)
    }
  } catch {
    /* 没台账就没什么要放开的 */
  }
  rmSync(root, { recursive: true, force: true })
})

describe('packageToFile', () => {
  it('/Game/... 映到 Content 下，关卡认 .umap', () => {
    const asset = makeAsset('Materials/M_Rock')
    const level = makeAsset('Maps/MainMap', '.umap')

    expect(packageToFile(root, '/Game/Materials/M_Rock')).toBe(asset)
    expect(packageToFile(root, '/Game/Maps/MainMap')).toBe(level)
  })

  it('文件不存在返回 null —— 新建还没落盘的资产没有位可翻', () => {
    expect(packageToFile(root, '/Game/Nope')).toBeNull()
  })

  it('越出 Content 的路径一律拒绝', () => {
    expect(packageToFile(root, '/Game/../../Windows/System32/drivers')).toBeNull()
  })

  it('不是 /Game/ 的一律拒绝 —— /Engine/ 在引擎安装目录里，绝不能碰', () => {
    expect(packageToFile(root, '/Engine/BasicShapes/Cube')).toBeNull()
    expect(packageToFile(root, 'H:/somewhere/thing.uasset')).toBeNull()
  })
})

describe('detectSourceControl', () => {
  it('没有配置就是没启用', () => {
    expect(detectSourceControl(root).enabled).toBe(false)
  })

  it('Provider=None 不算启用', () => {
    const ini = path.join(root, 'Saved', 'Config', 'WindowsEditor', 'SourceControlSettings.ini')
    mkdirSync(path.dirname(ini), { recursive: true })
    writeFileSync(ini, '[SourceControl.SourceControlSettings]\nProvider=None\n', 'utf8')

    expect(detectSourceControl(root).enabled).toBe(false)
  })

  it('Provider=Perforce 算启用', () => {
    const ini = path.join(root, 'Saved', 'Config', 'WindowsEditor', 'SourceControlSettings.ini')
    mkdirSync(path.dirname(ini), { recursive: true })
    writeFileSync(ini, '[SourceControl.SourceControlSettings]\nProvider=Perforce\n', 'utf8')

    expect(detectSourceControl(root)).toMatchObject({ enabled: true, provider: 'Perforce' })
  })
})

describe('protectPackages', () => {
  it('翻只读位并记账，回读校验通过才算 enforced', async () => {
    const file = makeAsset('Materials/M_Rock')

    const outcome = await protectPackages(root, ['/Game/Materials/M_Rock'])

    expect(outcome.enforced).toEqual(['/Game/Materials/M_Rock'])
    expect(isWritable(file)).toBe(false)
    expect(await countProtected(root)).toBe(1)
  })

  it('启用了版本控制就一个都不翻 —— 那个位归 Perforce 管', async () => {
    const file = makeAsset('Materials/M_Rock')
    const ini = path.join(root, 'Saved', 'Config', 'WindowsEditor', 'SourceControlSettings.ini')
    mkdirSync(path.dirname(ini), { recursive: true })
    writeFileSync(ini, 'Provider=Perforce\n', 'utf8')

    const outcome = await protectPackages(root, ['/Game/Materials/M_Rock'])

    expect(outcome.enforced).toEqual([])
    expect(outcome.skipped[0].reason).toContain('版本控制')
    expect(isWritable(file)).toBe(true)
    expect(await countProtected(root)).toBe(0)
  })

  it('原本就只读的不接管 —— 那不是我们翻的位', async () => {
    const file = makeAsset('Materials/M_Locked')
    chmodSync(file, 0o444)

    const outcome = await protectPackages(root, ['/Game/Materials/M_Locked'])

    expect(outcome.enforced).toEqual([])
    expect(outcome.skipped[0].reason).toContain('原本就是只读')
    expect(await countProtected(root)).toBe(0)
  })

  it('磁盘上没有文件就跳过，不记账', async () => {
    const outcome = await protectPackages(root, ['/Game/NotSavedYet'])

    expect(outcome.enforced).toEqual([])
    expect(await countProtected(root)).toBe(0)
  })

  it('重复保护是幂等的，台账不会长胖', async () => {
    makeAsset('Materials/M_Rock')

    await protectPackages(root, ['/Game/Materials/M_Rock'])
    const second = await protectPackages(root, ['/Game/Materials/M_Rock'])

    expect(second.enforced).toEqual(['/Game/Materials/M_Rock'])
    expect(await countProtected(root)).toBe(1)
  })

  it('位被外部改回可写（用户点了 Make Writable）会补翻回来', async () => {
    const file = makeAsset('Materials/M_Rock')
    await protectPackages(root, ['/Game/Materials/M_Rock'])

    chmodSync(file, 0o666)
    expect(isWritable(file)).toBe(true)

    const outcome = await protectPackages(root, ['/Game/Materials/M_Rock'])

    expect(outcome.enforced).toEqual(['/Game/Materials/M_Rock'])
    expect(isWritable(file)).toBe(false)
  })
})

describe('suspendProtection', () => {
  it('清位但不动台账 —— 崩了也只是把可写文件再设成可写，无害', async () => {
    const file = makeAsset('Materials/M_Rock')
    await protectPackages(root, ['/Game/Materials/M_Rock'])

    await suspendProtection(root, ['/Game/Materials/M_Rock'])

    expect(isWritable(file)).toBe(true)
    expect(await countProtected(root)).toBe(1)
  })

  it('不在台账里的文件不碰 —— 用户自己设成只读的资产不该被我们放开', async () => {
    const file = makeAsset('Materials/M_UserLocked')
    chmodSync(file, 0o444)

    await suspendProtection(root, ['/Game/Materials/M_UserLocked'])

    expect(isWritable(file)).toBe(false)
  })
})

describe('unprotectPackages / restoreLedger', () => {
  it('解除保护会清位并销账', async () => {
    const file = makeAsset('Materials/M_Rock')
    await protectPackages(root, ['/Game/Materials/M_Rock'])

    await unprotectPackages(root, ['/Game/Materials/M_Rock'])

    expect(isWritable(file)).toBe(true)
    expect(await countProtected(root)).toBe(0)
  })

  it('台账空了就把文件删掉，不留一个空壳', async () => {
    makeAsset('Materials/M_Rock')
    await protectPackages(root, ['/Game/Materials/M_Rock'])
    expect(existsSync(ledgerFile())).toBe(true)

    await unprotectPackages(root, ['/Game/Materials/M_Rock'])

    expect(existsSync(ledgerFile())).toBe(false)
  })

  it('启动兜底：台账上剩下的全部还原', async () => {
    const a = makeAsset('Materials/M_A')
    const b = makeAsset('Materials/M_B')
    await protectPackages(root, ['/Game/Materials/M_A', '/Game/Materials/M_B'])

    // 模拟盒子崩了：内存状态全没了，只剩盘上的台账
    const restored = await restoreLedger(root)

    expect(restored).toBe(2)
    expect(isWritable(a)).toBe(true)
    expect(isWritable(b)).toBe(true)
    expect(await countProtected(root)).toBe(0)
  })

  it('文件已经不在了也要销账，不然那条会一直留着', async () => {
    const file = makeAsset('Materials/M_Gone')
    await protectPackages(root, ['/Game/Materials/M_Gone'])

    chmodSync(file, 0o666)
    rmSync(file)

    expect(await restoreLedger(root)).toBe(1)
    expect(await countProtected(root)).toBe(0)
  })

  /**
   * 反查磁盘路径的写法在这里会翻车：资产已经改名，`/Game/Materials/M_Old`
   * 对应的文件不在了，反查返回 null，这条就永远匹配不上、烂在台账里。
   */
  it('资产被改名后仍然能按台账销账', async () => {
    const file = makeAsset('Materials/M_Old')
    await protectPackages(root, ['/Game/Materials/M_Old'])

    chmodSync(file, 0o666)
    renameSync(file, path.join(path.dirname(file), 'M_New.uasset'))

    expect(await unprotectPackages(root, ['/Game/Materials/M_Old'])).toBe(1)
    expect(await countProtected(root)).toBe(0)
  })

  it('还原时可以指定跳过仍被持有的锁', async () => {
    const a = makeAsset('Materials/M_A')
    const b = makeAsset('Materials/M_B')
    await protectPackages(root, ['/Game/Materials/M_A', '/Game/Materials/M_B'])

    expect(await restoreLedger(root, ['/Game/Materials/M_A'])).toBe(1)

    expect(isWritable(a)).toBe(false)
    expect(isWritable(b)).toBe(true)
    expect(await countProtected(root)).toBe(1)
  })
})

/**
 * 台账是读-改-写，而同一批工具是并发跑的（见 defineTool.ts 的 concurrency）。
 * 不串行的话后写的会把先写的条目抹掉，而那个文件的只读位已经翻上去了 ——
 * 用户工程里从此躺着一个存不进去、台账里又查不到的资产。
 */
describe('并发', () => {
  it('并发保护不同资产时，台账一条都不能丢', async () => {
    const files = ['M_A', 'M_B', 'M_C', 'M_D'].map((name) => makeAsset(`Materials/${name}`))

    await Promise.all(
      ['M_A', 'M_B', 'M_C', 'M_D'].map((name) => protectPackages(root, [`/Game/Materials/${name}`]))
    )

    expect(await countProtected(root)).toBe(4)
    for (const file of files) expect(isWritable(file)).toBe(false)

    // 盘上那份也要全 —— 缓存对了盘上丢了同样会留下孤儿
    const onDisk = JSON.parse(readFileSync(ledgerFile(), 'utf8'))
    expect(onDisk.entries).toHaveLength(4)
  })

  it('并发释放不会互相覆盖', async () => {
    const names = ['M_A', 'M_B', 'M_C']
    const files = names.map((name) => makeAsset(`Materials/${name}`))
    await protectPackages(
      root,
      names.map((name) => `/Game/Materials/${name}`)
    )

    await Promise.all(names.map((name) => unprotectPackages(root, [`/Game/Materials/${name}`])))

    expect(await countProtected(root)).toBe(0)
    for (const file of files) expect(isWritable(file)).toBe(true)
  })
})

/**
 * 台账文件被外部删掉（用户为了清缓存把整个 `Saved/` 删了是常规操作）之后，
 * 内存里还记着我们接管了哪些文件，而盘上什么都没有 —— 此刻崩掉留下的就是
 * 一批无人认领的只读文件。`withLedger` 的收尾负责把它补回来。
 */
describe('台账被外部删掉之后的补写', () => {
  it('下一次台账操作会把文件补回来', async () => {
    makeAsset('Materials/M_Rock')
    await protectPackages(root, ['/Game/Materials/M_Rock'])
    expect(existsSync(ledgerFile())).toBe(true)

    rmSync(ledgerFile())
    await suspendProtection(root, ['/Game/Materials/M_Rock'])

    expect(existsSync(ledgerFile())).toBe(true)
    expect(JSON.parse(readFileSync(ledgerFile(), 'utf8')).entries).toHaveLength(1)
  })

  it('操作抛异常时补写照跑 —— 那正是最需要它的时刻', async () => {
    makeAsset('Materials/M_Rock')
    await protectPackages(root, ['/Game/Materials/M_Rock'])
    rmSync(ledgerFile())

    throwOnNextLedgerOpForTest()
    await expect(suspendProtection(root, ['/Game/Materials/M_Rock'])).rejects.toThrow(
      'throwOnNextLedgerOpForTest'
    )

    expect(existsSync(ledgerFile())).toBe(true)
  })
})

/**
 * 台账是读-改-写，而同一批工具是并发跑的。不串行的话后写的会把先写的条目抹掉，
 * 而那个文件的只读位已经翻上去了 —— 用户工程里从此躺着一个存不进去、台账里
 * 又查不到的资产。
 */
describe('并发', () => {
  it('并发保护不同资产时，台账一条都不能丢', async () => {
    const names = ['M_A', 'M_B', 'M_C', 'M_D']
    const files = names.map((n) => makeAsset('Materials/' + n))

    await Promise.all(names.map((n) => protectPackages(root, ['/Game/Materials/' + n])))

    expect(await countProtected(root)).toBe(4)
    for (const f of files) expect(isWritable(f)).toBe(false)
    expect(JSON.parse(readFileSync(ledgerFile(), 'utf8')).entries).toHaveLength(4)
  })

  it('并发释放不会互相覆盖', async () => {
    const names = ['M_A', 'M_B', 'M_C']
    const files = names.map((n) => makeAsset('Materials/' + n))
    await protectPackages(
      root,
      names.map((n) => '/Game/Materials/' + n)
    )

    await Promise.all(names.map((n) => unprotectPackages(root, ['/Game/Materials/' + n])))

    expect(await countProtected(root)).toBe(0)
    for (const f of files) expect(isWritable(f)).toBe(true)
  })
})

describe('还原时可以保住仍被持有的锁', () => {
  it('keepPackagePaths 里的不还原', async () => {
    const a = makeAsset('Materials/M_A')
    const b = makeAsset('Materials/M_B')
    await protectPackages(root, ['/Game/Materials/M_A', '/Game/Materials/M_B'])

    expect(await restoreLedger(root, ['/Game/Materials/M_A'])).toBe(1)

    expect(isWritable(a)).toBe(false)
    expect(isWritable(b)).toBe(true)
    expect(await countProtected(root)).toBe(1)
  })
})
