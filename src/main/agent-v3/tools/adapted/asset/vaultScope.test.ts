/**
 * @vitest-environment node
 *
 * 跨保管库执行。
 *
 * 这一层管着一条**故意的**设计边界：读跨库，写不跨库。
 * 搜索和统计要看遍所有库（否则用户看得见的东西 agent 看不见），
 * 而移动/删除/导入一律只在当前活跃库里发生 —— 切库是用户在界面上的动作。
 * 所以 `explainVaultMiss` 只负责把话说准，绝不代替用户去别的库动手。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { vaultManager } = vi.hoisted(() => ({
  vaultManager: {
    getAllVaults: vi.fn(),
    getCurrentVault: vi.fn(),
    withVaultDatabase: vi.fn()
  }
}))

vi.mock('../../../../sqliteDataBase', () => ({
  getDatabaseManager: () => ({ getVaultManager: () => vaultManager })
}))

const { runAcrossVaults, explainVaultMiss, explainVaultMissBatch } = await import('./vaultScope')

const DEFAULT_VAULT = { id: 'v_default', name: '默认保管库', isActive: false }
const AIGC_VAULT = { id: 'v_aigc', name: 'AIGC 资产库', isActive: true }

const DB = { v_default: { tag: 'default' }, v_aigc: { tag: 'aigc' } } as Record<string, unknown>

/** 两个库，当前站在 AIGC 库上 —— 真机上翻车的那个配置 */
const standOnAIGC = (): void => {
  vaultManager.getAllVaults.mockReturnValue([DEFAULT_VAULT, AIGC_VAULT])
  vaultManager.getCurrentVault.mockReturnValue(AIGC_VAULT)
  vaultManager.withVaultDatabase.mockImplementation(
    async (id: string, op: (db: unknown) => unknown) => await op(DB[id])
  )
}

beforeEach(() => {
  vaultManager.getAllVaults.mockReset()
  vaultManager.getCurrentVault.mockReset()
  vaultManager.withVaultDatabase.mockReset()
  standOnAIGC()
})

describe('runAcrossVaults：范围解析', () => {
  it('不填就是全部库，当前库排最前', async () => {
    const seen: string[] = []
    await runAcrossVaults(undefined, (_db, vault) => void seen.push(vault.name))

    expect(seen).toEqual(['AIGC 资产库', '默认保管库'])
  })

  it('"current" 只跑当前库', async () => {
    const seen: string[] = []
    await runAcrossVaults('current', (_db, vault) => void seen.push(vault.name))

    expect(seen).toEqual(['AIGC 资产库'])
  })

  it('填库名就只跑那一个', async () => {
    const seen: string[] = []
    await runAcrossVaults('默认保管库', (_db, vault) => void seen.push(vault.name))

    expect(seen).toEqual(['默认保管库'])
  })

  it('库名不存在时报错并把有哪些库列出来，一个都不跑', async () => {
    const op = vi.fn()
    const { runs, error } = await runAcrossVaults('不存在的库', op)

    expect(runs).toEqual([])
    expect(String(error)).toContain('默认保管库')
    expect(String(error)).toContain('AIGC 资产库')
    expect(op).not.toHaveBeenCalled()
  })
})

describe('runAcrossVaults：一个库坏了', () => {
  it('不拖垮其余的，坏掉的那个在 error 里说清楚是谁', async () => {
    const { runs } = await runAcrossVaults('all', (_db, vault) => {
      if (vault.id === 'v_default') throw new Error('库文件不存在')
      return 'ok'
    })

    expect(runs.map((r) => [r.vault.name, r.value ?? r.error])).toEqual([
      ['AIGC 资产库', 'ok'],
      ['默认保管库', '库文件不存在']
    ])
  })
})

describe('explainVaultMiss：说准，但不越权', () => {
  it('东西在别的库里时，说清楚在哪、并指路到 switch_vault', async () => {
    const reason = await explainVaultMiss(
      '当前保管库里没有这条记录',
      (db) => db === DB.v_default // 只有默认保管库里有
    )

    expect(reason).toContain('默认保管库')
    expect(reason).toContain('AIGC 资产库')
    // 切库要走工具（用户会看到确认框），不是让模型自己想办法
    expect(reason).toContain('switch_vault')
  })

  it('说明切库要用户点头，被拒绝时得如实转达而不是绕路', async () => {
    const reason = await explainVaultMiss('当前保管库里没有这条记录', (db) => db === DB.v_default)

    expect(reason).toContain('本会话都允许')
    expect(reason).toContain('被拒绝')
  })

  it('**明确不许**把这句话说成「库里没有这个东西」', async () => {
    const reason = await explainVaultMiss('当前保管库里没有这条记录', (db) => db === DB.v_default)

    expect(reason).toContain('不要告诉用户「库里没有这个东西」')
  })

  it('哪个库都没有时原样报基础原因，不编一句「在别的库里」', async () => {
    const reason = await explainVaultMiss('当前保管库里没有这条记录', () => false)

    expect(reason).toBe('当前保管库里没有这条记录')
  })

  it('不会把用户已经在的那个库当成「别的库」报回去', async () => {
    // 两个库里都有，但当前就站在 AIGC 上 —— 不能回一句「它在 AIGC 库里，请切过去」
    const reason = await explainVaultMiss('当前保管库里没有这条记录', () => true)

    expect(reason).toContain('默认保管库')
    expect(reason).not.toContain('它在「AIGC 资产库')
  })

  it('只读不写：探针只拿到连接，全程没有任何改动发生', async () => {
    const probe = vi.fn().mockReturnValue(false)
    await explainVaultMiss('没有', probe)

    // 别的库只被 probe 看过一眼，没有第二种交互
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(DB.v_default)
  })

  it('查别的库这件事本身失败了，也不能把原操作搞崩', async () => {
    vaultManager.getAllVaults.mockImplementation(() => {
      throw new Error('注册表读不出来')
    })

    const reason = await explainVaultMiss('当前保管库里没有这条记录', () => true)

    expect(reason).toBe('当前保管库里没有这条记录')
  })
})

/**
 * 整批预检：动手之前一次说清楚「这批在哪个库」。
 *
 * 逐条版本在导入 51 个资产时会回 51 行同样的长文案，而且是开工之后才发现的。
 * 收到 assetKeys 的那一刻就能判断它们属于哪个库 —— 这一组用例钉住这件事。
 */
describe('explainVaultMissBatch：整批一次说清楚', () => {
  /** 只有默认库里有这三个 key，AIGC 库（当前活跃）一个都没有 */
  const onlyInDefault = (db: unknown, key: string): boolean =>
    db === DB.v_default && ['a', 'b', 'c'].includes(key)

  it('整批都在另一个库里：一句话说清是哪个库、有几个、该怎么办', async () => {
    const miss = await explainVaultMissBatch(['a', 'b', 'c'], onlyInDefault)

    expect(miss.missing).toEqual(['a', 'b', 'c'])
    expect(miss.foundIn).toEqual({ 默认保管库: 3 })
    expect(miss.message).toContain('默认保管库')
    expect(miss.message).toContain('switch_vault')
    // 这一句是整批说的，不是每个 key 说一遍
    expect(miss.message.match(/switch_vault/g)).toHaveLength(1)
    expect(miss.message).toContain('不要告诉用户「库里没有这些素材」')
  })

  it('全都在活跃库里就什么都不说 —— 正常路径不该多出一句话', async () => {
    const miss = await explainVaultMissBatch(['a'], (db) => db === DB.v_aigc)

    expect(miss.missing).toEqual([])
    expect(miss.message).toBe('')
  })

  it('只有一部分不在：只把缺的那几个算进去，别把整批说成没有', async () => {
    const miss = await explainVaultMissBatch(['a', 'ok'], (db, key) =>
      key === 'ok' ? db === DB.v_aigc : onlyInDefault(db, key)
    )

    expect(miss.missing).toEqual(['a'])
    expect(miss.message).toContain('有 1 个不在当前活跃的保管库')
  })

  it('哪个库都找不到：说 key 可能是旧的，而不是让人去切库', async () => {
    const miss = await explainVaultMissBatch(['ghost'], () => false)

    expect(miss.missing).toEqual(['ghost'])
    expect(miss.message).toContain('查不到')
    expect(miss.message).toContain('search_assets')
    expect(miss.message).not.toContain('switch_vault')
  })

  it('探库本身失败时当作没探到，调用方照常往下走', async () => {
    vaultManager.getAllVaults.mockImplementation(() => {
      throw new Error('注册表读不出来')
    })

    const miss = await explainVaultMissBatch(['a'], onlyInDefault)

    expect(miss.missing).toEqual([])
    expect(miss.message).toBe('')
  })
})
