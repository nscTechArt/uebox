import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { buildRemoteHttpMovePlan } from './dragMove'

interface FolderRow {
  folderKey: string
  fatherKey: string | null
  folderName: string
  isDelete: number
}

interface AssetRow {
  assetKey: string
  folderKey: string
  assetName: string
  isDelete: number
}

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly folders: Map<string, FolderRow>,
    private readonly assets: Map<string, AssetRow>
  ) {}

  get(...args: unknown[]): unknown {
    if (/FROM assetFolder WHERE folderKey = \? AND isDelete = 0/.test(this.sql)) {
      const folder = this.folders.get(String(args[0]))
      return folder && folder.isDelete === 0 ? folder : undefined
    }

    if (/FROM assetData WHERE assetKey = \? AND isDelete = 0/.test(this.sql)) {
      const asset = this.assets.get(String(args[0]))
      return asset && asset.isDelete === 0 ? asset : undefined
    }

    if (/SELECT 1 FROM folder_path WHERE folderKey = \?/.test(this.sql)) {
      const targetFolderId = String(args[0])
      const sourceFolderId = String(args[1])
      return this.isAncestorOfTarget(sourceFolderId, targetFolderId) ? { 1: 1 } : undefined
    }

    if (/COUNT\(\*\) AS count FROM assetData WHERE folderKey IN/.test(this.sql)) {
      const folderKeys = new Set(args.map(String))
      const count = [...this.assets.values()].filter(
        (asset) => asset.isDelete === 0 && folderKeys.has(asset.folderKey)
      ).length
      return { count }
    }

    throw new Error(`Unsupported fake get SQL: ${this.sql}`)
  }

  all(...args: unknown[]): unknown[] {
    if (
      /WITH RECURSIVE folder_tree/.test(this.sql) &&
      /SELECT folderKey FROM folder_tree/.test(this.sql)
    ) {
      return this.collectSubtree(String(args[0])).map((folderKey) => ({ folderKey }))
    }

    throw new Error(`Unsupported fake all SQL: ${this.sql}`)
  }

  run(): void {
    throw new Error(`Unsupported fake run SQL: ${this.sql}`)
  }

  private isAncestorOfTarget(sourceFolderId: string, targetFolderId: string): boolean {
    let current = this.folders.get(targetFolderId)
    while (current?.fatherKey) {
      if (current.fatherKey === sourceFolderId) return true
      current = this.folders.get(current.fatherKey)
    }
    return false
  }

  private collectSubtree(rootFolderId: string): string[] {
    const result: string[] = []
    const visit = (folderKey: string): void => {
      const folder = this.folders.get(folderKey)
      if (!folder || folder.isDelete !== 0) return
      result.push(folderKey)
      for (const child of this.folders.values()) {
        if (child.fatherKey === folderKey) visit(child.folderKey)
      }
    }
    visit(rootFolderId)
    return result
  }
}

class FakeDatabase {
  readonly folders = new Map<string, FolderRow>()
  readonly assets = new Map<string, AssetRow>()

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this.folders, this.assets)
  }
}

function createTestDb(): FakeDatabase {
  const db = new FakeDatabase()
  db.folders.set('ALL', {
    folderKey: 'ALL',
    fatherKey: null,
    folderName: 'ALL',
    isDelete: 0
  })
  return db
}

function asSqliteDb(db: FakeDatabase): Database.Database {
  return db as unknown as Database.Database
}

function insertFolder(
  db: FakeDatabase,
  folderKey: string,
  fatherKey: string,
  folderName: string
): void {
  db.folders.set(folderKey, { folderKey, fatherKey, folderName, isDelete: 0 })
}

function insertAsset(db: FakeDatabase, assetKey: string, folderKey: string): void {
  db.assets.set(assetKey, { assetKey, folderKey, assetName: assetKey, isDelete: 0 })
}

describe('buildRemoteHttpMovePlan', () => {
  it('builds remote-first asset move operations without mutating local rows', () => {
    const db = createTestDb()
    insertFolder(db, 'folder-a', 'ALL', 'A')
    insertFolder(db, 'folder-b', 'ALL', 'B')
    insertAsset(db, 'asset-a', 'folder-a')

    const plan = buildRemoteHttpMovePlan(
      asSqliteDb(db),
      [{ id: 'asset-a', type: 'file' }],
      'folder-b'
    )

    expect(plan.success).toBe(true)
    expect(plan.operations).toEqual([
      {
        type: 'update',
        table: 'assetData',
        data: expect.objectContaining({ assetKey: 'asset-a', folderKey: 'folder-b' })
      }
    ])
    expect(plan.movedItems).toEqual({ folders: 0, files: 1 })
    expect(db.assets.get('asset-a')?.folderKey).toBe('folder-a')
  })

  it('builds one structural folder update and counts the moved subtree', () => {
    const db = createTestDb()
    insertFolder(db, 'folder-a', 'ALL', 'A')
    insertFolder(db, 'folder-b', 'ALL', 'B')
    insertFolder(db, 'folder-a-child', 'folder-a', 'A child')
    insertAsset(db, 'asset-a', 'folder-a')
    insertAsset(db, 'asset-child', 'folder-a-child')

    const plan = buildRemoteHttpMovePlan(
      asSqliteDb(db),
      [{ id: 'folder-a', type: 'folder' }],
      'folder-b'
    )

    expect(plan.success).toBe(true)
    expect(plan.operations).toEqual([
      {
        type: 'update',
        table: 'assetFolder',
        data: expect.objectContaining({ folderKey: 'folder-a', fatherKey: 'folder-b' })
      }
    ])
    expect(plan.movedItems).toEqual({ folders: 2, files: 2 })
  })

  it('rejects invalid remote folder moves before building operations', () => {
    const db = createTestDb()
    insertFolder(db, 'folder-a', 'ALL', 'A')
    insertFolder(db, 'folder-a-child', 'folder-a', 'A child')

    const descendantPlan = buildRemoteHttpMovePlan(
      asSqliteDb(db),
      [{ id: 'folder-a', type: 'folder' }],
      'folder-a-child'
    )
    const rootPlan = buildRemoteHttpMovePlan(
      asSqliteDb(db),
      [{ id: 'ALL', type: 'folder' }],
      'folder-a'
    )

    expect(descendantPlan.success).toBe(false)
    expect(descendantPlan.operations).toEqual([])
    expect(rootPlan.success).toBe(false)
    expect(rootPlan.operations).toEqual([])
  })
})
