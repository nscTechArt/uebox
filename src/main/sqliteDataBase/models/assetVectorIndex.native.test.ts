/** @vitest-environment node */
import Database from 'better-sqlite3'
import { load } from 'sqlite-vec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sqliteVec', () => ({
  ensureSqliteVecLoaded: () => true
}))

import {
  commitVectors,
  enableAssetVectorIndex,
  getAssetVectorStatus,
  searchAssetVectors,
  VECTOR_DIRTY_TABLE,
  VECTOR_TABLE
} from './assetVectorIndex'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  load(db)
  db.exec(`
    CREATE TABLE vault_metadata (key TEXT PRIMARY KEY, value TEXT, type TEXT, updated_at TEXT);
    CREATE TABLE assetData (id INTEGER PRIMARY KEY, assetKey TEXT, isDelete INTEGER DEFAULT 0);
    CREATE TABLE asset_tags (assetKey TEXT, tagId INTEGER);
    INSERT INTO assetData (id, assetKey) VALUES (1, 'chair'), (2, 'table');
  `)
  expect(enableAssetVectorIndex(db, 2)).toEqual({ ok: true })
})

afterEach(() => db.close())

describe('asset vectors with the native sqlite-vec extension', () => {
  it('writes numeric asset IDs and retrieves the closest assets', () => {
    commitVectors(db, [
      { id: 1, embedding: [1, 0] },
      { id: 2, embedding: [0, 1] }
    ])

    expect(getAssetVectorStatus(db)).toMatchObject({ indexed: 2, pending: 0, ready: true })
    expect(searchAssetVectors(db, [1, 0], 2)).toEqual([1, 2])
  })

  it('replaces existing vectors and removes deleted assets from the index', () => {
    commitVectors(db, [{ id: 1, embedding: [1, 0] }])
    commitVectors(db, [{ id: 1, embedding: [0, 1] }])
    const row = db
      .prepare(`SELECT vec_to_json(embedding) AS vector FROM ${VECTOR_TABLE} WHERE rowid = 1`)
      .get() as { vector: string }
    expect(JSON.parse(row.vector)).toEqual([0, 1])

    db.exec('DELETE FROM assetData WHERE id = 1')
    commitVectors(db, [{ id: 1, embedding: null }])
    expect(getAssetVectorStatus(db)).toMatchObject({ indexed: 0, pending: 1 })
    expect(db.prepare(`SELECT assetId FROM ${VECTOR_DIRTY_TABLE}`).all()).toEqual([{ assetId: 2 }])
  })

  it('keeps the batch queued after failure and allows a successful retry', () => {
    expect(() =>
      commitVectors(db, [
        { id: 1, embedding: [1, 0] },
        { id: 2, embedding: [0, 1, 0] }
      ])
    ).toThrow(/dimension/i)
    expect(getAssetVectorStatus(db)).toMatchObject({ indexed: 0, pending: 2 })

    commitVectors(db, [
      { id: 1, embedding: [1, 0] },
      { id: 2, embedding: [0, 1] }
    ])
    expect(getAssetVectorStatus(db)).toMatchObject({ indexed: 2, pending: 0, ready: true })
  })
})
