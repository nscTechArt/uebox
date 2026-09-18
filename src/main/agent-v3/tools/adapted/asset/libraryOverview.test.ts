/**
 * @vitest-environment node
 *
 * 素材库概览工具。
 *
 * 用真数据库而不是打桩：这个工具的价值全在「数字是精确的」，
 * 拿假数据测等于只测了拼字符串。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { initAssetFolderModel } from '../../../../sqliteDataBase/models/assetFolder'
import { initAssetDataModel } from '../../../../sqliteDataBase/models/assetData'
import { initAssetTagModel } from '../../../../sqliteDataBase/models/assetTag'
import { initAssetFavoriteModel } from '../../../../sqliteDataBase/models/assetFavorite'
import { initAssetSearchIndexModel } from '../../../../sqliteDataBase/models/assetSearchIndex'

let vaultDb: Database.Database
let publicDb: Database.Database

/** 这台机器上只有一个保管库。跨库合并的用例见文件末尾。 */
const ONLY_VAULT = { id: 'system_vault_default', name: '默认保管库' }
let vaults: Array<{ id: string; name: string }> = [ONLY_VAULT]
let dbByVault: Record<string, Database.Database> = {}

const vaultManager = {
  getAllVaults: () => vaults,
  getCurrentVault: () => vaults[0] ?? null,
  withVaultDatabase: async (id: string, op: (db: Database.Database) => unknown) =>
    await op(dbByVault[id] ?? vaultDb)
}

vi.mock('../../../../sqliteDataBase', () => ({
  getVaultDatabase: () => vaultDb,
  getPublicDatabase: () => publicDb,
  getDatabaseManager: () => ({ getVaultManager: () => vaultManager })
}))

const { createLibraryOverviewTool } = await import('./libraryOverview')

const tool = createLibraryOverviewTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

function insertAsset(
  key: string,
  name: string,
  folderKey: string,
  type: string,
  size: number
): void {
  vaultDb
    .prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, folderName, assetType, fileExtension, size, isDelete)
       VALUES (?, ?, ?, ?, ?, 'uasset', ?, 0)`
    )
    .run(key, folderKey, name, folderKey, type, size)
}

beforeEach(() => {
  vaults = [ONLY_VAULT]
  dbByVault = {}
  vaultDb = new Database(':memory:')
  initAssetFolderModel(vaultDb)
  initAssetDataModel(vaultDb)
  initAssetTagModel(vaultDb)
  initAssetFavoriteModel(vaultDb)
  initAssetSearchIndexModel(vaultDb)
  vaultDb
    .prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
    )
    .run()
  for (const [key, path] of [
    ['k_role', '/角色'],
    ['k_env', '/场景']
  ]) {
    vaultDb
      .prepare(
        `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
         VALUES (?, 'ALL', 'folder', ?, ?, '[]', 1, '[]', 0)`
      )
      .run(key, path.slice(1), path)
  }

  publicDb = new Database(':memory:')
  publicDb.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT, group_id INTEGER)')
})

describe('library_overview', () => {
  it('回的是精确总数和分布，不受返回条数限制', async () => {
    for (let i = 0; i < 300; i += 1) {
      insertAsset(`a${i}`, `SM_Rock_${i}`, 'k_env', 'StaticMesh', 1024)
    }
    insertAsset('t1', 'T_Rock_D', 'k_env', 'Texture2D', 2048)

    const r = await run({})

    expect(r.total).toBe(301)
    expect(r.by_type).toMatchObject({
      StaticMesh: '300 个 / 300 KB',
      Texture2D: '1 个 / 2.0 KB'
    })
  })

  it('文件夹分布按顶层切', async () => {
    insertAsset('a1', 'SM_Hero', 'k_role', 'StaticMesh', 100)
    insertAsset('a2', 'SM_Rock', 'k_env', 'StaticMesh', 100)

    const r = await run({})

    expect(r.by_folder).toMatchObject({ 角色: '1 个 / 100 B', 场景: '1 个 / 100 B' })
  })

  it('folder 收窄之后统计跟着变', async () => {
    insertAsset('a1', 'SM_Hero', 'k_role', 'StaticMesh', 100)
    insertAsset('a2', 'SM_Rock', 'k_env', 'StaticMesh', 100)

    const r = await run({ folder: '角色' })

    expect(r.total).toBe(1)
    expect(r.scope).toContain('角色')
  })

  it('标签名库里没有就报错，不能假装筛过了', async () => {
    insertAsset('a1', 'SM_Hero', 'k_role', 'StaticMesh', 100)

    const r = await run({ tags: ['不存在的标签'] })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('不存在的标签')
  })

  it('标签筛得动，标签名换得回来', async () => {
    insertAsset('a1', 'SM_Hero', 'k_role', 'StaticMesh', 100)
    insertAsset('a2', 'SM_Rock', 'k_env', 'StaticMesh', 100)
    publicDb.prepare('INSERT INTO tags (id, name) VALUES (7, ?)').run('主角')
    vaultDb.prepare('INSERT INTO asset_tags (assetKey, tagId) VALUES (?, ?)').run('a1', 7)

    const all = await run({})
    expect(all.by_tag).toMatchObject({ 主角: '1 个' })

    const scoped = await run({ tags: ['主角'] })
    expect(scoped.total).toBe(1)
  })

  it('列不下的取值合成一行，加起来还是总数', async () => {
    for (let i = 0; i < 20; i += 1) {
      insertAsset(`a${i}`, `A_${i}`, 'k_env', `Type${i}`, 10)
    }

    const r = await run({})
    const byType = r.by_type as Record<string, string>
    const rollup = Object.keys(byType).find((k) => k.startsWith('（其余'))

    expect(rollup).toBeDefined()
    expect(byType[rollup!]).toBe('8 个')
    expect(Object.keys(byType)).toHaveLength(13)
  })

  it('最占地方的排前面', async () => {
    insertAsset('a1', 'small', 'k_env', 'StaticMesh', 10)
    insertAsset('a2', 'huge', 'k_env', 'StaticMesh', 9_000_000)

    const r = await run({ largest: 1 })

    expect(r.largest).toEqual(['huge（8.6 MB，在 k_env）'])
  })

  it('空库直说没有，不编分布', async () => {
    const r = await run({})

    expect(r.total).toBe(0)
    expect(r.by_type).toBeUndefined()
    expect(String(r.message)).toContain('一个资产也没有')
  })
})

/**
 * 用户的资产分散在多个保管库里。只统计当前活跃的那个，就会给出
 * **真的但错的**答案 —— 真机上量到过：用户站在 AIGC 库里问「我库里有什么」，
 * 工具如实回「共 59 个资产」，而他的 776 个素材在默认保管库里。
 */
describe('跨保管库统计', () => {
  const SECOND_VAULT = { id: 'system_vault_aigc', name: 'AIGC 资产库' }
  let secondDb: Database.Database

  /** 再挂一个库上来，里面按 (名字, 类型, 大小) 建资产 */
  const attachSecondVault = (rows: Array<[string, string, number]>): void => {
    secondDb = new Database(':memory:')
    initAssetFolderModel(secondDb)
    initAssetDataModel(secondDb)
    initAssetTagModel(secondDb)
    initAssetFavoriteModel(secondDb)
    initAssetSearchIndexModel(secondDb)
    secondDb
      .prepare(
        `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
         VALUES ('AIGC', NULL, 'folder', 'AIGC', '/AIGC', '[]', 0, '[]', 0)`
      )
      .run()
    for (const [name, type, size] of rows) {
      secondDb
        .prepare(
          `INSERT INTO assetData (assetKey, folderKey, assetName, folderName, assetType, fileExtension, size, isDelete)
           VALUES (?, 'AIGC', ?, 'AIGC', ?, 'png', ?, 0)`
        )
        .run(`s_${name}`, name, type, size)
    }

    vaults = [ONLY_VAULT, SECOND_VAULT]
    dbByVault = { [ONLY_VAULT.id]: vaultDb, [SECOND_VAULT.id]: secondDb }
  }

  it('总数和体积是所有库精确相加', async () => {
    insertAsset('a1', 'SM_Chair', 'k_env', 'StaticMesh', 100)
    attachSecondVault([
      ['gen_1.png', 'AIGC', 50],
      ['gen_2.png', 'AIGC', 50]
    ])

    const r = await run({})

    expect(r.total).toBe(3)
    expect(r.total_size).toBe('200 B')
  })

  it('by_vault 说清楚各库各有多少，并要求汇报时讲明是合起来的', async () => {
    insertAsset('a1', 'SM_Chair', 'k_env', 'StaticMesh', 100)
    attachSecondVault([['gen_1.png', 'AIGC', 50]])

    const r = await run({})

    expect(r.by_vault).toEqual({
      默认保管库: '1 个 / 100 B',
      'AIGC 资产库': '1 个 / 50 B'
    })
    expect(String(r.message)).toContain('所有保管库合起来的')
  })

  it('同一个类型出现在两个库里时数字要合并，不是各报各的', async () => {
    insertAsset('a1', 'SM_A', 'k_env', 'StaticMesh', 100)
    insertAsset('a2', 'SM_B', 'k_env', 'StaticMesh', 100)
    attachSecondVault([['SM_C', 'StaticMesh', 100]])

    const r = await run({})

    expect(r.by_type).toMatchObject({ StaticMesh: '3 个 / 300 B' })
  })

  it('vault 填库名时只统计那一个', async () => {
    insertAsset('a1', 'SM_Chair', 'k_env', 'StaticMesh', 100)
    attachSecondVault([['gen_1.png', 'AIGC', 50]])

    const r = await run({ vault: 'AIGC 资产库' })

    expect(r.total).toBe(1)
    expect(r.by_vault).toBeUndefined()
    expect(r.searched_vaults).toEqual(['AIGC 资产库'])
  })

  it('一个库统计不了不拖垮其余的，但必须说出来是哪个', async () => {
    insertAsset('a1', 'SM_Chair', 'k_env', 'StaticMesh', 100)
    attachSecondVault([['gen_1.png', 'AIGC', 50]])
    secondDb.close() // 模拟库文件打不开

    const r = await run({})

    expect(r.success).toBe(true)
    expect(r.total).toBe(1)
    expect(String((r.unsearched_vaults as string[])[0])).toContain('AIGC 资产库')
  })
})
