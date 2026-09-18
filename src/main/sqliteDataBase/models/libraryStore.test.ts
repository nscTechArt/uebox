import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  applyLibraryStorePatch,
  initLibraryStoreModel,
  loadLibraryStore,
  migrateLibraryStoreFromLocal,
  type LibraryStoreRecord
} from './libraryStore'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  initLibraryStoreModel(db)
  return db
}

function record(id: string, data: unknown, sortIndex = 0): LibraryStoreRecord {
  return { kind: 'entry', id, data: JSON.stringify(data), sortIndex }
}

describe('libraryStore model', () => {
  it('空库读出来是空的，界面偏好为 null', () => {
    const db = createTestDb()

    expect(loadLibraryStore(db, 'blueprint')).toEqual({
      records: [],
      ui: null,
      migratedFromLocal: false
    })
  })

  it('增量写入只影响传进来的行', () => {
    const db = createTestDb()

    applyLibraryStorePatch(db, 'blueprint', {
      upserts: [record('bp-1', { name: 'A' }, 0), record('bp-2', { name: 'B' }, 1)]
    })
    applyLibraryStorePatch(db, 'blueprint', { upserts: [record('bp-2', { name: 'B2' }, 1)] })

    const loaded = loadLibraryStore(db, 'blueprint')
    expect(loaded.records.map((item) => JSON.parse(item.data).name)).toEqual(['A', 'B2'])
  })

  it('删除只删指定的行', () => {
    const db = createTestDb()

    applyLibraryStorePatch(db, 'blueprint', {
      upserts: [record('bp-1', { name: 'A' }, 0), record('bp-2', { name: 'B' }, 1)]
    })
    applyLibraryStorePatch(db, 'blueprint', { deletes: [{ kind: 'entry', id: 'bp-1' }] })

    expect(loadLibraryStore(db, 'blueprint').records.map((item) => item.id)).toEqual(['bp-2'])
  })

  it('两个库互不干扰', () => {
    const db = createTestDb()

    applyLibraryStorePatch(db, 'blueprint', { upserts: [record('bp-1', { name: 'A' })], ui: '{}' })
    applyLibraryStorePatch(db, 'material', { upserts: [record('mat-1', { name: 'M' })], ui: '{}' })

    expect(loadLibraryStore(db, 'blueprint').records.map((item) => item.id)).toEqual(['bp-1'])
    expect(loadLibraryStore(db, 'material').records.map((item) => item.id)).toEqual(['mat-1'])
  })

  it('只写记录不带 ui 时，已存的界面偏好不被抹掉', () => {
    const db = createTestDb()

    applyLibraryStorePatch(db, 'blueprint', { ui: '{"sortType":"name"}' })
    applyLibraryStorePatch(db, 'blueprint', { upserts: [record('bp-1', { name: 'A' })] })

    expect(loadLibraryStore(db, 'blueprint').ui).toBe('{"sortType":"name"}')
  })

  // 迁移之后的普通存盘不能把「已迁移」标记洗掉，否则下次启动会拿旧的
  // localStorage 数据再盖一遍，用户这中间做的改动全没了。
  it('普通存盘不会清掉已迁移标记', () => {
    const db = createTestDb()

    migrateLibraryStoreFromLocal(db, 'blueprint', {
      records: [record('bp-1', { name: 'A' })],
      ui: '{}'
    })
    applyLibraryStorePatch(db, 'blueprint', { ui: '{"sortType":"name"}' })

    expect(loadLibraryStore(db, 'blueprint').migratedFromLocal).toBe(true)
  })

  it('迁移是幂等的，第二次直接返回 false 且不覆盖新数据', () => {
    const db = createTestDb()

    expect(
      migrateLibraryStoreFromLocal(db, 'blueprint', {
        records: [record('bp-1', { name: '旧数据' })],
        ui: '{}'
      })
    ).toBe(true)

    applyLibraryStorePatch(db, 'blueprint', { upserts: [record('bp-1', { name: '用户改过了' })] })

    expect(
      migrateLibraryStoreFromLocal(db, 'blueprint', {
        records: [record('bp-1', { name: '旧数据' })],
        ui: '{}'
      })
    ).toBe(false)
    expect(JSON.parse(loadLibraryStore(db, 'blueprint').records[0].data).name).toBe('用户改过了')
  })

  it('保留条目顺序', () => {
    const db = createTestDb()

    applyLibraryStorePatch(db, 'blueprint', {
      upserts: [record('c', {}, 2), record('a', {}, 0), record('b', {}, 1)]
    })

    expect(loadLibraryStore(db, 'blueprint').records.map((item) => item.id)).toEqual([
      'a',
      'b',
      'c'
    ])
  })
})
