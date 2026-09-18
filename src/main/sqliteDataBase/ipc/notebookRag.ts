import { ipcMain } from 'electron'
import { getPublicDatabase } from '../index'
import { indexNotebookRag, searchNotebookRag } from '../services/notebookRagService'
import {
  listNotebookIndexJobStatuses,
  queueNotebookIndexJobs,
  type NotebookIndexJobStatusView,
  type QueueNotebookIndexResult
} from '../services/notebookIndexJobService'
import { normalizeNotebookRagError } from '../services/notebookRagErrors'
import type { NotebookChunkSearchResult } from '../models/notebookRag'

export const registerNotebookRagIPC = (): void => {
  ipcMain.handle(
    'notebook:rag:index',
    async (
      _,
      params: { notebookId: string; sourceIds?: string[] }
    ): Promise<{ indexedSources: number; indexedChunks: number }> => {
      try {
        console.log('[NotebookRAG IPC] Index request received', {
          notebookId: params.notebookId,
          sourceIds: params.sourceIds ?? null
        })
        const db = getPublicDatabase()
        const result = await indexNotebookRag(db, params.notebookId, {
          sourceIds: params.sourceIds
        })
        console.log('[NotebookRAG IPC] Index request completed', {
          notebookId: params.notebookId,
          sourceIds: params.sourceIds ?? null,
          ...result
        })
        return result
      } catch (error) {
        const normalizedError = normalizeNotebookRagError(error, 'index')
        console.error('[NotebookRAG IPC] Index failed:', normalizedError)
        throw normalizedError
      }
    }
  )

  ipcMain.handle(
    'notebook:rag:queue-index',
    async (
      _,
      params: { notebookId: string; sourceIds?: string[] }
    ): Promise<QueueNotebookIndexResult> => {
      try {
        console.log('[NotebookRAG IPC] Queue index request received', {
          notebookId: params.notebookId,
          sourceIds: params.sourceIds ?? null
        })
        const db = getPublicDatabase()
        const result = await queueNotebookIndexJobs(db, params.notebookId, params.sourceIds)
        console.log('[NotebookRAG IPC] Queue index request completed', {
          notebookId: params.notebookId,
          sourceIds: params.sourceIds ?? null,
          ...result
        })
        return result
      } catch (error) {
        const normalizedError = normalizeNotebookRagError(error, 'index')
        console.error('[NotebookRAG IPC] Queue index failed:', normalizedError)
        throw normalizedError
      }
    }
  )

  ipcMain.handle(
    'notebook:rag:list-index-jobs',
    async (_, params?: { notebookId?: string }): Promise<NotebookIndexJobStatusView[]> => {
      try {
        const db = getPublicDatabase()
        return listNotebookIndexJobStatuses(db, params?.notebookId)
      } catch (error) {
        const normalizedError = normalizeNotebookRagError(error, 'index')
        console.error('[NotebookRAG IPC] List index jobs failed:', normalizedError)
        throw normalizedError
      }
    }
  )

  ipcMain.handle(
    'notebook:rag:search',
    async (
      _,
      params: { notebookId: string; query: string; limit?: number; sourceIds?: string[] }
    ): Promise<NotebookChunkSearchResult[]> => {
      try {
        console.log('[NotebookRAG IPC] Search request received', {
          notebookId: params.notebookId,
          queryLength: params.query?.length ?? 0,
          queryPreview: params.query?.replace(/\s+/g, ' ').trim().slice(0, 100) ?? '',
          limit: params.limit ?? null,
          sourceIds: params.sourceIds ?? null
        })
        const db = getPublicDatabase()
        const result = await searchNotebookRag(db, params.notebookId, params.query, {
          limit: params.limit,
          sourceIds: params.sourceIds
        })
        console.log('[NotebookRAG IPC] Search request completed', {
          notebookId: params.notebookId,
          resultCount: result.length
        })
        return result
      } catch (error) {
        const normalizedError = normalizeNotebookRagError(error, 'search')
        console.error('[NotebookRAG IPC] Search failed:', normalizedError)
        throw normalizedError
      }
    }
  )

  console.log('[NotebookRAG IPC] Registered')
}
