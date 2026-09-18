import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { getRootFolderKeysForRemoteDelete } from './assetFolder'

interface FolderRow {
  folderKey: string
  fatherKey: string | null
  folderName: string
  pathArray: string
  ancestorKeys: string
  isDelete: number
}

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly folders: Map<string, FolderRow>
  ) {}

  get(folderKey: string): FolderRow | undefined {
    if (/FROM assetFolder WHERE folderKey = \? AND isDelete = 0/.test(this.sql)) {
      const folder = this.folders.get(folderKey)
      return folder && folder.isDelete === 0 ? folder : undefined
    }
    throw new Error(`Unsupported fake get SQL: ${this.sql}`)
  }
}

class FakeDatabase {
  readonly folders = new Map<string, FolderRow>()

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this.folders)
  }
}

function createDb(): FakeDatabase {
  const db = new FakeDatabase()
  insertFolder(db, 'ALL', null, 'ALL', ['ALL'], [])
  return db
}

function asSqliteDb(db: FakeDatabase): Database.Database {
  return db as unknown as Database.Database
}

function insertFolder(
  db: FakeDatabase,
  folderKey: string,
  fatherKey: string | null,
  folderName: string,
  pathArray: string[],
  ancestorKeys: string[]
): void {
  db.folders.set(folderKey, {
    folderKey,
    fatherKey,
    folderName,
    pathArray: JSON.stringify(pathArray),
    ancestorKeys: JSON.stringify(ancestorKeys),
    isDelete: 0
  })
}

describe('getRootFolderKeysForRemoteDelete', () => {
  it('keeps only selected roots before sending remote folder deletes', () => {
    const db = createDb()
    insertFolder(db, 'folder-a', 'ALL', 'A', ['ALL', 'folder-a'], ['ALL'])
    insertFolder(
      db,
      'folder-a-child',
      'folder-a',
      'A child',
      ['ALL', 'folder-a', 'folder-a-child'],
      ['ALL', 'folder-a']
    )
    insertFolder(db, 'folder-b', 'ALL', 'B', ['ALL', 'folder-b'], ['ALL'])

    const roots = getRootFolderKeysForRemoteDelete(asSqliteDb(db), [
      'folder-a-child',
      'folder-a',
      'folder-b'
    ])

    expect(roots).toEqual(['folder-a', 'folder-b'])
  })

  it('ignores missing or deleted folders instead of sending unsafe remote deletes', () => {
    const db = createDb()
    insertFolder(db, 'folder-a', 'ALL', 'A', ['ALL', 'folder-a'], ['ALL'])
    insertFolder(db, 'folder-deleted', 'ALL', 'Deleted', ['ALL', 'folder-deleted'], ['ALL'])
    db.folders.get('folder-deleted')!.isDelete = 1

    const roots = getRootFolderKeysForRemoteDelete(asSqliteDb(db), [
      'folder-a',
      'folder-missing',
      'folder-deleted'
    ])

    expect(roots).toEqual(['folder-a'])
  })
})
