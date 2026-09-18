import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createNotebook, createNotebookSource, initNotebookModel } from '../models/notebook'
import { createNotebookIndexJob, initNotebookIndexJobModel } from '../models/notebookIndexJob'
import { listNotebookIndexJobStatuses } from './notebookIndexJobService'

const sqliteAvailable = (() => {
  try {
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
})()

const describeWithSqlite = sqliteAvailable ? describe : describe.skip

describeWithSqlite('notebookIndexJobService', () => {
  let db: Database.Database | null = null

  const createDb = (): Database.Database => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    initNotebookModel(db)
    initNotebookIndexJobModel(db)
    return db
  }

  afterEach(() => {
    db?.close()
    db = null
  })

  it('lists queue status views from real SQLite and filters by notebook', () => {
    const testDb = createDb()
    const notebookId = createNotebook(testDb, {
      notebookId: 'nb-queue-status',
      title: '队列状态测试'
    })
    const otherNotebookId = createNotebook(testDb, {
      notebookId: 'nb-other',
      title: '其他知识库'
    })
    const sourceId = createNotebookSource(testDb, {
      sourceId: 'src-queue-status',
      notebookId,
      title: '待索引来源',
      type: 'text',
      content: '这是一段需要补建索引的知识库内容。'
    })
    const otherSourceId = createNotebookSource(testDb, {
      sourceId: 'src-other',
      notebookId: otherNotebookId,
      title: '其他来源',
      type: 'text',
      content: '其他知识库内容。'
    })

    createNotebookIndexJob(testDb, {
      jobId: 'job-queue-status',
      notebookId,
      sourceId,
      targetContentHash: 'hash-queue-status',
      targetRevision: 2,
      status: 'pending',
      attemptCount: 1,
      nextRetryAt: null,
      lastError: null
    })
    createNotebookIndexJob(testDb, {
      jobId: 'job-other',
      notebookId: otherNotebookId,
      sourceId: otherSourceId,
      targetContentHash: 'hash-other',
      targetRevision: 1,
      status: 'succeeded',
      attemptCount: 0,
      nextRetryAt: null,
      lastError: null
    })

    const statuses = listNotebookIndexJobStatuses(testDb, notebookId)

    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({
      jobId: 'job-queue-status',
      notebookId,
      sourceId,
      targetRevision: 2,
      status: 'pending',
      attemptCount: 1,
      nextRetryAt: null,
      lastError: null
    })
    expect('targetContentHash' in statuses[0]).toBe(false)
  })
})
