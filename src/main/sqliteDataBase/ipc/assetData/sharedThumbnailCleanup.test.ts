/**
 * sharedThumbnailCleanup.test.ts —— 多条记录共用同一张封面图时的物理清理
 *
 * 批量封面上传（BatchThumbnailUploadModal）会把**同一个文件名**同时写进一个
 * 文件夹的 img 和它下面 N 个资产的 customPoster。清理路径以前只对 filePath
 * 问过「还有没有别人用」，缩略图是无条件 unlink 的 —— 于是在回收站里彻底删掉
 * 其中一个资产，其余 N-1 个**还活着**的资产和那个文件夹的封面当场全变成裂图。
 *
 * 这里跑真的 sqlite（内存库），只把「往磁盘上动手」的那一层换成假的，
 * 断言交给它的清单里到底有没有那张图。
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

/** 批量封面上传出来的那一张：一个文件，很多个引用 */
const SHARED_POSTER = 'custom-cover-123.png'

let db: Database.Database

function createTestDb(): Database.Database {
  const database = new Database(':memory:')
  initAssetFolderModel(database)
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
    folderKey: 'props',
    fatherKey: 'ALL',
    type: 'folder',
    folderName: 'Props'
  })
  return database
}

function addAsset(
  assetKey: string,
  options: { imgLocalPath?: string; customPoster?: string } = {}
): void {
  createAssetData(db, {
    assetKey,
    folderKey: 'props',
    assetName: assetKey,
    filePath: `C:/vault/assetData/${assetKey}.uasset`,
    imgLocalPath: options.imgLocalPath,
    customPoster: options.customPoster
  })
}

const flushImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function callHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const { registerAssetDataCrudIPC } = await import('./crud')
  registerAssetDataCrudIPC()
  const handler = mocks.handlers.get(channel)
  expect(handler, `${channel} 没有注册`).toBeTypeOf('function')
  return handler?.({}, ...args)
}

/** 后台清理清单里，这一条的封面字段 */
function lastCleanupRef(): { imgLocalPath?: string | null; customPoster?: string | null } {
  const scheduled = mocks.scheduleVaultFileCleanup.mock.calls.at(-1) as
    | [Array<{ imgLocalPath?: string | null; customPoster?: string | null }>]
    | undefined
  return scheduled?.[0]?.[0] ?? {}
}

describe('彻底删除不碰别人还在用的封面图', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    db = createTestDb()
    mocks.currentDb.value = db
  })

  afterEach(() => {
    db.close()
  })

  it('hardDeleteMany：还活着的资产用着同一张封面时，不删这张图', async () => {
    addAsset('keep', { customPoster: SHARED_POSTER })
    addAsset('trashed', { customPoster: SHARED_POSTER })
    deleteAssetData(db, 'trashed')

    await callHandler('db:assetData:hardDeleteMany', ['trashed'])
    await flushImmediate()

    expect(lastCleanupRef().customPoster).toBeNull()
    // 数据库行照删 —— 留下的是文件，不是记录
    expect(db.prepare(`SELECT COUNT(*) c FROM assetData WHERE assetKey = 'trashed'`).get()).toEqual(
      {
        c: 0
      }
    )
  })

  it('hardDeleteMany：文件夹封面指着同一张图时，也不删', async () => {
    db.prepare(`UPDATE assetFolder SET img = ? WHERE folderKey = 'props'`).run(SHARED_POSTER)
    addAsset('trashed', { customPoster: SHARED_POSTER })
    deleteAssetData(db, 'trashed')

    await callHandler('db:assetData:hardDeleteMany', ['trashed'])
    await flushImmediate()

    expect(lastCleanupRef().customPoster).toBeNull()
  })

  it('hardDeleteMany：回收站里另一条也指着它 —— 那条还能恢复，图得留着', async () => {
    addAsset('trashed_a', { customPoster: SHARED_POSTER })
    addAsset('trashed_b', { customPoster: SHARED_POSTER })
    deleteAssetData(db, 'trashed_a')
    deleteAssetData(db, 'trashed_b')

    await callHandler('db:assetData:hardDeleteMany', ['trashed_a'])
    await flushImmediate()
    expect(lastCleanupRef().customPoster).toBeNull()

    // 最后一个引用也走了，这一次才真删
    await callHandler('db:assetData:hardDeleteMany', ['trashed_b'])
    await flushImmediate()
    expect(lastCleanupRef().customPoster).toBe(SHARED_POSTER)
  })

  it('hardDeleteMany：只有它一个人用，照删不误', async () => {
    addAsset('trashed', { imgLocalPath: 'thumbnail-trashed.jpg', customPoster: 'custom-only.png' })
    deleteAssetData(db, 'trashed')

    await callHandler('db:assetData:hardDeleteMany', ['trashed'])
    await flushImmediate()

    expect(lastCleanupRef()).toMatchObject({
      imgLocalPath: 'thumbnail-trashed.jpg',
      customPoster: 'custom-only.png'
    })
  })

  it('压缩图和原图是一对：别人用着 a.png，就不能因为这条存的是 a_thumb.jpg 而删掉', async () => {
    addAsset('keep', { customPoster: 'cover.png' })
    addAsset('trashed', { customPoster: 'cover_thumb.jpg' })
    deleteAssetData(db, 'trashed')

    await callHandler('db:assetData:hardDeleteMany', ['trashed'])
    await flushImmediate()

    expect(lastCleanupRef().customPoster).toBeNull()
  })

  it('外链封面不参与判断，也不会被拿去删同名的本地图', async () => {
    addAsset('trashed', { customPoster: 'https://example.com/cover.png' })
    deleteAssetData(db, 'trashed')

    await callHandler('db:assetData:hardDeleteMany', ['trashed'])
    await flushImmediate()

    // 原样带下去，由清理层按「http 开头的跳过」处理
    expect(lastCleanupRef().customPoster).toBe('https://example.com/cover.png')
  })

  it('clearDeleted：清空回收站也不碰活着的资产在用的封面', async () => {
    addAsset('keep', { customPoster: SHARED_POSTER })
    addAsset('trashed', { customPoster: SHARED_POSTER })
    addAsset('trashed_only', { customPoster: 'custom-lonely.png' })
    deleteAssetData(db, 'trashed')
    deleteAssetData(db, 'trashed_only')

    await callHandler('db:assetData:clearDeleted')

    const [files] = mocks.scheduleVaultFileCleanup.mock.calls[0] as [
      Array<{ customPoster?: string | null }>
    ]
    expect(files.map((file) => file.customPoster ?? 'RETAINED').sort()).toEqual([
      'RETAINED',
      'custom-lonely.png'
    ])
  })

  it('hardDeleteMany：整批一次算完，共用的那张留着，独用的那张删掉', async () => {
    addAsset('keep', { customPoster: SHARED_POSTER })
    addAsset('trashed_shared', { customPoster: SHARED_POSTER })
    addAsset('trashed_lonely', { customPoster: 'custom-lonely.png' })
    deleteAssetData(db, 'trashed_shared')
    deleteAssetData(db, 'trashed_lonely')

    const result = (await callHandler('db:assetData:hardDeleteMany', [
      'trashed_shared',
      'trashed_lonely'
    ])) as { success: boolean; data: { deleted: string[]; failed: unknown[] } }

    expect(result.success).toBe(true)
    expect(result.data.deleted.sort()).toEqual(['trashed_lonely', 'trashed_shared'])
    const [files] = mocks.scheduleVaultFileCleanup.mock.calls[0] as [
      Array<{ customPoster?: string | null }>
    ]
    expect(files.map((file) => file.customPoster ?? 'RETAINED').sort()).toEqual([
      'RETAINED',
      'custom-lonely.png'
    ])
    expect(db.prepare(`SELECT assetKey FROM assetData`).all()).toEqual([{ assetKey: 'keep' }])
  })

  it('hardDeleteMany：不在回收站里的那个如实报出来，不静默跳过', async () => {
    addAsset('alive')
    addAsset('trashed')
    deleteAssetData(db, 'trashed')

    const result = (await callHandler('db:assetData:hardDeleteMany', ['trashed', 'alive'])) as {
      data: { deleted: string[]; failed: Array<{ assetKey: string }> }
    }

    expect(result.data.deleted).toEqual(['trashed'])
    expect(result.data.failed).toEqual([{ assetKey: 'alive', error: '它不在回收站里' }])
    // 活着的那条一根汗毛都没动
    expect(db.prepare(`SELECT COUNT(*) c FROM assetData WHERE assetKey = 'alive'`).get()).toEqual({
      c: 1
    })
  })
})
