/**
 * sharedFilePathCleanup.test.ts —— 重复导入共用同一个文件时的物理清理
 *
 * 同一个文件导入两遍会留下两条记录、两个 assetKey，但 filePath 是同一个。
 * 用户删掉其中一条（软删除）之后再「彻底删除 / 清空回收站」，两条清理路径
 * （hardDeleteMany / clearDeleted）以前会照着 filePath 直接 unlink，
 * **还活着的那条记录当场指向一个不存在的文件**。
 *
 * 这里跑的是真的 sqlite（内存库）+ 真的 SQL，只把「往磁盘上动手」的那一层
 * （services/vaultFileCleanup）换成假的，断言交给它的清单里到底有没有那个文件。
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAssetData, deleteAssetData, initAssetDataModel } from '../../models/assetData'
import { createAssetFolder, initAssetFolderModel } from '../../models/assetFolder'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  return {
    handlers,
    ipcHandle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }),
    currentDb: { value: null as Database.Database | null },
    scheduleVaultFileCleanup: vi.fn()
  }
})

vi.mock('electron', () => ({ ipcMain: { handle: mocks.ipcHandle } }))

vi.mock('../../index', () => ({
  getVaultDatabase: () => mocks.currentDb.value
}))

vi.mock('../../services/vaultFileCleanup', () => ({
  scheduleVaultFileCleanup: mocks.scheduleVaultFileCleanup
}))

vi.mock('../../../networkV2/currentRemoteHttpVault', () => ({
  getCurrentRemoteHttpVaultContext: () => null
}))

vi.mock('../../../networkV2/NetworkSyncBridge', () => ({
  pushAssetCreate: vi.fn(async () => ({ status: 'skipped' })),
  pushAssetUpdate: vi.fn(async () => ({ status: 'skipped' })),
  pushAssetDelete: vi.fn(async () => ({ status: 'skipped' })),
  pushBatchOperations: vi.fn(async () => ({ status: 'skipped' }))
}))

const SHARED = 'C:/vault/assetData/tree.uasset'
const LONELY = 'C:/vault/assetData/rock.uasset'

let db: Database.Database

/** 三条清理路径都会 DELETE 这两张连接表，缺了就直接抛 no such table */
function createTestDb(): Database.Database {
  const database = new Database(':memory:')
  initAssetFolderModel(database)
  initAssetDataModel(database)
  // 二次调用触发 ALTER TABLE 迁移，补齐后加的列
  initAssetDataModel(database)
  database.exec(`
    CREATE TABLE IF NOT EXISTS asset_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assetKey TEXT NOT NULL,
      tagId INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assetKey TEXT NOT NULL,
      itemType TEXT DEFAULT 'asset'
    );
  `)
  database
    .prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
    )
    .run()
  createAssetFolder(database, {
    folderKey: 'trees',
    fatherKey: 'ALL',
    type: 'folder',
    folderName: 'Trees'
  })
  return database
}

/**
 * imgLocalPath 和 customPoster 是两个独立的缩略图文件，清理必须都带上
 * —— 漏掉 customPoster 是「清空回收站不清缩略图」的真因。
 */
function addAsset(assetKey: string, filePath: string, imgLocalPath: string): void {
  createAssetData(db, {
    assetKey,
    folderKey: 'trees',
    assetName: assetKey,
    filePath,
    imgLocalPath,
    customPoster: imgLocalPath.replace('_thumb.png', '_poster.jpg')
  })
}

/**
 * 这一次交给清理层的清单。
 *
 * 清理都交给 scheduleVaultFileCleanup 排队（deleteVaultBackupAndThumbnail 那条
 * 直接调用的老路子已经没人走了）。断言的是「清单里有什么」，所以这里合成一份。
 */
type CleanupRef = {
  filePath?: string | null
  imgLocalPath?: string | null
  customPoster?: string | null
}
function cleanupRefs(): CleanupRef[] {
  return (mocks.scheduleVaultFileCleanup.mock.calls as unknown as Array<[CleanupRef[]]>).flatMap(
    (call) => call[0] ?? []
  )
}

/** setImmediate 里排的后台清理，等它跑过这一轮 */
const flushImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function callHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const { registerAssetDataCrudIPC } = await import('./crud')
  registerAssetDataCrudIPC()
  const handler = mocks.handlers.get(channel)
  expect(handler, `${channel} 没有注册`).toBeTypeOf('function')
  return handler?.({}, ...args)
}

describe('回收站清理不碰别人还在用的文件', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    db = createTestDb()
    mocks.currentDb.value = db
  })

  afterEach(() => {
    db.close()
  })

  it('hardDeleteMany：还有活着的记录指着同一个文件时，只删缩略图不删文件', async () => {
    addAsset('keep', SHARED, 'keep_thumb.png')
    addAsset('trashed', SHARED, 'trashed_thumb.png')
    deleteAssetData(db, 'trashed')

    const result = await callHandler('db:assetData:hardDeleteMany', ['trashed'])
    await flushImmediate()

    expect(result).toMatchObject({ success: true })
    // 数据库行照删
    expect(db.prepare(`SELECT COUNT(*) c FROM assetData WHERE assetKey = 'trashed'`).get()).toEqual(
      {
        c: 0
      }
    )
    // 文件留给幸存者，缩略图各是各的所以照删
    expect(cleanupRefs()).toContainEqual({
      filePath: null,
      imgLocalPath: 'trashed_thumb.png',
      customPoster: 'trashed_poster.jpg'
    })
  })

  it('hardDeleteMany：没人再用这个文件时照常删', async () => {
    addAsset('trashed', LONELY, 'trashed_thumb.png')
    deleteAssetData(db, 'trashed')

    await callHandler('db:assetData:hardDeleteMany', ['trashed'])
    await flushImmediate()

    expect(cleanupRefs()).toContainEqual({
      filePath: LONELY,
      imgLocalPath: 'trashed_thumb.png',
      customPoster: 'trashed_poster.jpg'
    })
  })

  it('hardDeleteMany：保留另一条回收站记录的文件，直到最后一个引用被彻底删除', async () => {
    addAsset('trashed_a', SHARED, 'a_thumb.png')
    addAsset('trashed_b', SHARED, 'b_thumb.png')
    deleteAssetData(db, 'trashed_a')
    deleteAssetData(db, 'trashed_b')

    await callHandler('db:assetData:hardDeleteMany', ['trashed_a'])
    await flushImmediate()

    expect(cleanupRefs()).toContainEqual({
      filePath: null,
      imgLocalPath: 'a_thumb.png',
      customPoster: 'a_poster.jpg'
    })
    expect(db.prepare(`SELECT isDelete FROM assetData WHERE assetKey = 'trashed_b'`).get()).toEqual(
      {
        isDelete: 1
      }
    )

    await callHandler('db:assetData:hardDeleteMany', ['trashed_b'])
    await flushImmediate()
    expect(cleanupRefs()).toContainEqual({
      filePath: SHARED,
      imgLocalPath: 'b_thumb.png',
      customPoster: 'b_poster.jpg'
    })
  })

  /**
   * 「排除本次要删的那些」这一条，批量路径上更容易写错：一批里的两条互相
   * 指着同一个文件，如果不排除，它们会把对方数成占用者 —— 于是谁都删不掉，
   * 文件永久残留在保管库里。
   */
  it('hardDeleteMany：同一批里的重复登记互相不算占用，文件该删', async () => {
    addAsset('trashed_a', SHARED, 'a_thumb.png')
    addAsset('trashed_b', SHARED, 'b_thumb.png')
    deleteAssetData(db, 'trashed_a')
    deleteAssetData(db, 'trashed_b')

    await callHandler('db:assetData:hardDeleteMany', ['trashed_a', 'trashed_b'])
    await flushImmediate()

    expect(cleanupRefs().every((ref) => ref.filePath === SHARED)).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) c FROM assetData`).get()).toEqual({ c: 0 })
  })

  it('clearDeleted：一次算完清理清单，被占着的那个文件不进清单', async () => {
    addAsset('keep', SHARED, 'keep_thumb.png')
    addAsset('trashed_twin', SHARED, 'twin_thumb.png')
    addAsset('trashed_only', LONELY, 'only_thumb.png')
    deleteAssetData(db, 'trashed_twin')
    deleteAssetData(db, 'trashed_only')

    const result = await callHandler('db:assetData:clearDeleted')

    expect(result).toMatchObject({ success: true })
    expect(mocks.scheduleVaultFileCleanup).toHaveBeenCalledTimes(1)
    const [files, tag] = mocks.scheduleVaultFileCleanup.mock.calls[0] as [
      Array<{
        filePath?: string | null
        imgLocalPath?: string | null
        customPoster?: string | null
      }>,
      string
    ]
    expect(tag).toBe('clearDeleted')
    expect(
      [...files].sort((a, b) => (a.imgLocalPath ?? '').localeCompare(b.imgLocalPath ?? ''))
    ).toEqual([
      { filePath: LONELY, imgLocalPath: 'only_thumb.png', customPoster: 'only_poster.jpg' },
      { filePath: null, imgLocalPath: 'twin_thumb.png', customPoster: 'twin_poster.jpg' }
    ])

    // 回收站清空了，活着的那条一条不少
    expect(db.prepare(`SELECT assetKey FROM assetData`).all()).toEqual([{ assetKey: 'keep' }])
  })

  it('clearDeleted：回收站里的重复登记互相不算占用，最后一条走时文件才真被删', async () => {
    addAsset('trashed_a', SHARED, 'a_thumb.png')
    addAsset('trashed_b', SHARED, 'b_thumb.png')
    deleteAssetData(db, 'trashed_a')
    deleteAssetData(db, 'trashed_b')

    await callHandler('db:assetData:clearDeleted')

    const [files] = mocks.scheduleVaultFileCleanup.mock.calls[0] as [
      Array<{ filePath?: string | null }>
    ]
    expect(files.every((f) => f.filePath === SHARED)).toBe(true)
  })
})
