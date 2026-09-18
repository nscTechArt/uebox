import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import {
  createNotebookIndexJob,
  getNextRunnableNotebookIndexAt,
  getNextRunnableNotebookIndexJob,
  getNotebookIndexJobByTarget,
  listNotebookIndexJobs,
  updateNotebookIndexJob,
  type NotebookIndexJobRecord,
  type NotebookIndexJobStatus
} from '../models/notebookIndexJob'
import { getNotebookSourcesForIndex, updateNotebookSourceIndexStatus } from '../models/notebookRag'
import { indexNotebookRag } from './notebookRagService'
import { normalizeNotebookRagError } from './notebookRagErrors'
import { computeNotebookSourceContentHash } from './notebookSourceHash'

const MAX_RETRY_ATTEMPTS = 3
const RETRY_DELAY_MS = 30_000
const MIN_POLL_DELAY_MS = 500

const normalizeDbDateMs = (value: string | null | undefined): number | null => {
  if (!value) return null
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 索引是不是已经追上内容。`keyword`（片段有了、向量没有）也算追上：
 * 向量缺是因为嵌入模型不可用，重试再多次也一样，不该把它当失败反复排队。
 * 模型配好之后，下一次训练会把这些来源补上向量。
 */
const isSourceIndexCurrent = (source: {
  contentHash: string | null
  contentRevision: number | null
  indexedContentHash: string | null
  indexedRevision: number | null
  indexStatus: string | null
}): boolean =>
  (source.indexStatus === 'indexed' || source.indexStatus === 'keyword') &&
  Boolean(source.contentHash) &&
  source.contentHash === source.indexedContentHash &&
  (source.contentRevision ?? null) === (source.indexedRevision ?? null)

const isSourceQueueable = (source: {
  content: string
  loading: number
  contentHash: string | null
  contentRevision: number | null
  indexedContentHash: string | null
  indexedRevision: number | null
  indexStatus: string | null
}): boolean => {
  if (source.loading === 1) return false
  if (!source.content || source.content.trim().length === 0) return false
  if (!source.contentHash || !source.contentRevision) return false
  return !isSourceIndexCurrent(source)
}

const ensureSourceContentFingerprint = (
  db: Database.Database,
  source: ReturnType<typeof getNotebookSourcesForIndex>[number]
): void => {
  if (source.contentHash && source.contentRevision) {
    return
  }

  if (!source.content || source.content.trim().length === 0) {
    return
  }

  source.contentHash = computeNotebookSourceContentHash(source.content)
  source.contentRevision = Math.max(1, source.contentRevision ?? 1)
  updateNotebookSourceIndexStatus(db, source.sourceId, {
    contentHash: source.contentHash,
    contentRevision: source.contentRevision
  })
}

export interface QueueNotebookIndexResult {
  queuedJobs: number
  skippedSources: number
  queuedSourceIds: string[]
}

export interface NotebookIndexJobStatusView {
  jobId: string
  notebookId: string
  sourceId: string
  targetRevision: number
  status: NotebookIndexJobStatus
  attemptCount: number
  nextRetryAt: string | null
  lastError: string | null
  createdAt: string | null
  updatedAt: string | null
  startedAt: string | null
  completedAt: string | null
}

const toNotebookIndexJobStatusView = (job: NotebookIndexJobRecord): NotebookIndexJobStatusView => ({
  jobId: job.jobId,
  notebookId: job.notebookId,
  sourceId: job.sourceId,
  targetRevision: job.targetRevision,
  status: job.status,
  attemptCount: job.attemptCount,
  nextRetryAt: job.nextRetryAt ?? null,
  lastError: job.lastError ?? null,
  createdAt: job.created_at ?? null,
  updatedAt: job.updated_at ?? null,
  startedAt: job.started_at ?? null,
  completedAt: job.completed_at ?? null
})

class NotebookIndexJobService {
  private db: Database.Database | null = null
  private processing = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false

  start(db: Database.Database): void {
    this.db = db
    if (this.started) return
    this.started = true
    this.resetInterruptedJobs()
    this.schedule(0)
  }

  async enqueue(
    db: Database.Database,
    notebookId: string,
    sourceIds?: string[]
  ): Promise<QueueNotebookIndexResult> {
    this.db = db
    this.start(db)

    const sources = getNotebookSourcesForIndex(db, notebookId, sourceIds)
    let queuedJobs = 0
    let skippedSources = 0
    const queuedSourceIds: string[] = []

    for (const source of sources) {
      ensureSourceContentFingerprint(db, source)

      if (!isSourceQueueable(source)) {
        skippedSources += 1
        continue
      }

      const existingJob = getNotebookIndexJobByTarget(db, source.sourceId, source.contentHash!)
      if (existingJob) {
        if (existingJob.status === 'failed' || existingJob.status === 'cancelled') {
          updateNotebookIndexJob(db, existingJob.jobId, {
            notebookId,
            targetRevision: source.contentRevision ?? 1,
            status: 'pending',
            attemptCount: 0,
            nextRetryAt: null,
            lastError: null,
            started_at: null,
            completed_at: null
          })
          queuedJobs += 1
          queuedSourceIds.push(source.sourceId)
        } else {
          skippedSources += 1
        }
        continue
      }

      createNotebookIndexJob(db, {
        jobId: `nb-index-${randomUUID()}`,
        notebookId,
        sourceId: source.sourceId,
        targetContentHash: source.contentHash!,
        targetRevision: source.contentRevision ?? 1,
        status: 'pending',
        attemptCount: 0,
        nextRetryAt: null,
        lastError: null
      })
      updateNotebookSourceIndexStatus(db, source.sourceId, {
        status: 'pending',
        error: null
      })
      queuedJobs += 1
      queuedSourceIds.push(source.sourceId)
    }

    if (queuedJobs > 0) {
      this.schedule(0)
    }

    return {
      queuedJobs,
      skippedSources,
      queuedSourceIds
    }
  }

  private resetInterruptedJobs(): void {
    if (!this.db) return

    this.db
      .prepare(
        `
        UPDATE notebook_index_jobs
        SET
          status = 'pending',
          next_retry_at = NULL,
          last_error = COALESCE(last_error, '索引任务在应用重启后恢复'),
          started_at = NULL,
          updated_at = datetime('now', 'localtime')
        WHERE status = 'running'
      `
      )
      .run()
  }

  private schedule(delayMs: number): void {
    if (this.timer || !this.db) return

    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, delayMs)
  }

  private async drain(): Promise<void> {
    if (this.processing || !this.db) {
      this.schedule(MIN_POLL_DELAY_MS)
      return
    }

    this.processing = true
    try {
      while (true) {
        const job = getNextRunnableNotebookIndexJob(this.db, new Date().toISOString())
        if (!job) break
        await this.processJob(job)
      }
    } finally {
      this.processing = false
      if (!this.db) return

      const nextRunnableAt = getNextRunnableNotebookIndexAt(this.db)
      if (nextRunnableAt) {
        const delay = Math.max(
          MIN_POLL_DELAY_MS,
          (normalizeDbDateMs(nextRunnableAt) ?? Date.now()) - Date.now()
        )
        this.schedule(delay)
      }
    }
  }

  private async processJob(job: {
    jobId: string
    notebookId: string
    sourceId: string
    targetContentHash: string
    targetRevision: number
    attemptCount: number
  }): Promise<void> {
    if (!this.db) return

    const currentSource = getNotebookSourcesForIndex(this.db, job.notebookId, [job.sourceId])[0]
    if (!currentSource) {
      updateNotebookIndexJob(this.db, job.jobId, {
        status: 'cancelled',
        lastError: '来源已不存在',
        completed_at: new Date().toISOString()
      })
      return
    }

    if (
      currentSource.contentHash !== job.targetContentHash ||
      (currentSource.contentRevision ?? null) !== job.targetRevision
    ) {
      updateNotebookIndexJob(this.db, job.jobId, {
        status: 'cancelled',
        lastError: '任务已被更新的来源版本取代',
        completed_at: new Date().toISOString()
      })
      return
    }

    if (isSourceIndexCurrent(currentSource)) {
      updateNotebookIndexJob(this.db, job.jobId, {
        status: 'succeeded',
        lastError: null,
        completed_at: new Date().toISOString()
      })
      return
    }

    updateNotebookIndexJob(this.db, job.jobId, {
      status: 'running',
      started_at: new Date().toISOString(),
      lastError: null
    })
    updateNotebookSourceIndexStatus(this.db, job.sourceId, {
      status: 'indexing',
      error: null
    })

    try {
      await indexNotebookRag(this.db, job.notebookId, { sourceIds: [job.sourceId] })

      const refreshedSource = getNotebookSourcesForIndex(this.db, job.notebookId, [job.sourceId])[0]
      if (!refreshedSource) {
        updateNotebookIndexJob(this.db, job.jobId, {
          status: 'cancelled',
          lastError: '来源在索引完成前已被删除',
          completed_at: new Date().toISOString()
        })
        return
      }

      if (
        refreshedSource.contentHash !== job.targetContentHash ||
        (refreshedSource.contentRevision ?? null) !== job.targetRevision
      ) {
        updateNotebookIndexJob(this.db, job.jobId, {
          status: 'cancelled',
          lastError: '索引过程中来源内容已变更',
          completed_at: new Date().toISOString()
        })
        return
      }

      if (!isSourceIndexCurrent(refreshedSource)) {
        throw new Error('Source index completed without matching indexed content hash')
      }

      updateNotebookIndexJob(this.db, job.jobId, {
        status: 'succeeded',
        lastError: null,
        completed_at: new Date().toISOString()
      })
    } catch (error) {
      const normalizedError = normalizeNotebookRagError(error, 'index')
      const nextAttemptCount = job.attemptCount + 1

      if (nextAttemptCount >= MAX_RETRY_ATTEMPTS) {
        updateNotebookIndexJob(this.db, job.jobId, {
          status: 'failed',
          attemptCount: nextAttemptCount,
          lastError: normalizedError.message,
          nextRetryAt: null,
          completed_at: new Date().toISOString()
        })
        updateNotebookSourceIndexStatus(this.db, job.sourceId, {
          status: 'error',
          error: normalizedError.message
        })
        return
      }

      updateNotebookIndexJob(this.db, job.jobId, {
        status: 'pending',
        attemptCount: nextAttemptCount,
        nextRetryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
        lastError: normalizedError.message,
        started_at: null
      })
      updateNotebookSourceIndexStatus(this.db, job.sourceId, {
        status: 'pending',
        error: normalizedError.message
      })
      this.schedule(RETRY_DELAY_MS)
    }
  }
}

const notebookIndexJobService = new NotebookIndexJobService()

export const resumeNotebookIndexJobs = (db: Database.Database): void => {
  notebookIndexJobService.start(db)
}

export const queueNotebookIndexJobs = async (
  db: Database.Database,
  notebookId: string,
  sourceIds?: string[]
): Promise<QueueNotebookIndexResult> => notebookIndexJobService.enqueue(db, notebookId, sourceIds)

export const listNotebookIndexJobStatuses = (
  db: Database.Database,
  notebookId?: string
): NotebookIndexJobStatusView[] =>
  listNotebookIndexJobs(db, notebookId).map(toNotebookIndexJobStatusView)
