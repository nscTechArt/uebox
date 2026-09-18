import { app } from 'electron'
import { existsSync, mkdirSync, statSync } from 'fs'
import { promises as fs } from 'fs'
import { basename, join } from 'path'

import { getPublicDatabase } from '../../sqliteDataBase'
import {
  getImportRecoveryContextByDiagnosticId,
  getImportRecoveryContextByTaskId,
  listImportRecoveryContexts as listImportRecoveryContextRecords,
  type ImportRecoveryContextStatus,
  updateImportRecoveryContextStatus,
  upsertImportRecoveryContext
} from '../../sqliteDataBase/models/importRecoveryContext'
import type { ImportRecoveryContextRecord } from '../../sqliteDataBase/models/importRecoveryContext'

export interface ImportRecoveryFileEntry {
  path: string
  name: string
  remotePath: string
  size: number | null
}

export interface ImportRecoveryThumbnailEntry {
  localPath: string
  remotePath: string
  size: number | null
}

export interface ImportRecoveryContext {
  schemaVersion: 2
  createdAt: string
  taskId: string
  localVaultId: string
  serverUrl: string
  remoteVaultId: string
  sessionId: string
  rootFolderPath: string
  targetFolderKey?: string | null
  targetFolderPath?: string | null
  files: ImportRecoveryFileEntry[]
  thumbnails: ImportRecoveryThumbnailEntry[]
}

export interface ImportRecoveryContextSummary {
  taskId: string
  diagnosticId?: string | null
  vaultId: string
  sessionId: string
  status: ImportRecoveryContextRecord['status']
  lastError?: string | null
  contextPath: string
  createdAt?: string
  updatedAt?: string
  rootFolderPath?: string
  serverUrl?: string
  remoteVaultId?: string
  targetFolderKey?: string | null
  expectedFiles?: number
  expectedThumbnails?: number
  canResume: boolean
}

export interface BuildImportRecoveryContextParams {
  taskId: string
  localVaultId: string
  serverUrl: string
  remoteVaultId: string
  sessionId: string
  rootFolderPath: string
  targetFolderKey?: string | null
  targetFolderPath?: string | null
  files: Array<{ path: string; name: string }>
  thumbnails: Array<{ localPath: string; remotePath: string }>
}

const THUMBNAIL_PREFIX = '.thumbnails/'

function safeStatSize(filePath: string): number | null {
  try {
    return statSync(filePath).size
  } catch {
    return null
  }
}

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

function stripThumbnailPrefix(value: string): string {
  const normalized = normalizeRemotePath(value)
  return normalized.startsWith(THUMBNAIL_PREFIX)
    ? normalized.substring(THUMBNAIL_PREFIX.length)
    : normalized
}

export function computeImportRemotePath(
  file: { path: string; name: string },
  rootFolderPath: string,
  targetFolderPath?: string | null
): string {
  const normalizedRoot = rootFolderPath.replace(/\\/g, '/')
  const rootParent = normalizedRoot.substring(0, normalizedRoot.lastIndexOf('/'))
  const rootName = normalizedRoot.split('/').pop() || ''
  const normalizedTargetFolderPath = (targetFolderPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  const normalizedFilePath = file.path.replace(/\\/g, '/')
  let relativeRemotePath = file.name

  if (rootFolderPath !== 'ALL') {
    if (rootParent && normalizedFilePath.startsWith(rootParent + '/')) {
      relativeRemotePath = normalizedFilePath.substring(rootParent.length + 1)
    } else if (normalizedFilePath.startsWith(normalizedRoot + '/')) {
      relativeRemotePath = rootName + '/' + normalizedFilePath.substring(normalizedRoot.length + 1)
    } else {
      relativeRemotePath = rootName + '/' + file.name
    }
  }

  return normalizedTargetFolderPath
    ? normalizeRemotePath(`${normalizedTargetFolderPath}/${relativeRemotePath}`)
    : normalizeRemotePath(relativeRemotePath)
}

function recoveryDir(): string {
  return join(app.getPath('userData'), 'diagnostics', 'recovery')
}

function safeFileName(value: string): string {
  return (basename(value) || value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100)
}

export function buildImportRecoveryContext(
  params: BuildImportRecoveryContextParams
): ImportRecoveryContext {
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    taskId: params.taskId,
    localVaultId: params.localVaultId,
    serverUrl: params.serverUrl,
    remoteVaultId: params.remoteVaultId,
    sessionId: params.sessionId,
    rootFolderPath: params.rootFolderPath,
    targetFolderKey: params.targetFolderKey || null,
    targetFolderPath: params.targetFolderPath || null,
    files: params.files.map((file) => ({
      path: file.path,
      name: file.name,
      remotePath: computeImportRemotePath(file, params.rootFolderPath, params.targetFolderPath),
      size: safeStatSize(file.path)
    })),
    thumbnails: params.thumbnails.map((thumbnail) => ({
      localPath: thumbnail.localPath,
      remotePath: stripThumbnailPrefix(thumbnail.remotePath),
      size: safeStatSize(thumbnail.localPath)
    }))
  }
}

export async function saveImportRecoveryContext(
  context: ImportRecoveryContext,
  diagnosticId?: string | null
): Promise<string> {
  const dir = recoveryDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const contextPath = join(dir, `${safeFileName(context.taskId)}-${context.sessionId}.json`)
  await fs.writeFile(contextPath, JSON.stringify(context, null, 2), 'utf-8')

  const db = getPublicDatabase()
  upsertImportRecoveryContext(db, {
    taskId: context.taskId,
    diagnosticId: diagnosticId || null,
    vaultId: context.localVaultId,
    sessionId: context.sessionId,
    contextPath,
    status: 'ready',
    last_error: null
  })
  return contextPath
}

export function linkImportRecoveryDiagnostic(taskId: string, diagnosticId: string): void {
  const db = getPublicDatabase()
  updateImportRecoveryContextStatus(db, taskId, 'ready', null, diagnosticId)
}

export function markImportRecoveryContextStatus(
  ref: { taskId?: string; diagnosticId?: string },
  status: ImportRecoveryContextStatus,
  error?: string | null
): boolean {
  const db = getPublicDatabase()
  const record = ref.taskId
    ? getImportRecoveryContextByTaskId(db, ref.taskId)
    : ref.diagnosticId
      ? getImportRecoveryContextByDiagnosticId(db, ref.diagnosticId)
      : undefined
  if (!record?.taskId) return false
  return updateImportRecoveryContextStatus(
    db,
    record.taskId,
    status,
    error || null,
    ref.diagnosticId || null
  )
}

export function dismissImportRecoveryContext(ref: {
  taskId?: string
  diagnosticId?: string
}): boolean {
  return markImportRecoveryContextStatus(ref, 'dismissed', null)
}

export async function loadImportRecoveryContext(ref: {
  taskId?: string
  diagnosticId?: string
}): Promise<ImportRecoveryContext | null> {
  const db = getPublicDatabase()
  const record = ref.taskId
    ? getImportRecoveryContextByTaskId(db, ref.taskId)
    : ref.diagnosticId
      ? getImportRecoveryContextByDiagnosticId(db, ref.diagnosticId)
      : undefined
  if (!record?.contextPath || !existsSync(record.contextPath)) return null
  const raw = await fs.readFile(record.contextPath, 'utf-8')
  return JSON.parse(raw) as ImportRecoveryContext
}

export async function listImportRecoveryContexts(
  limit = 10
): Promise<ImportRecoveryContextSummary[]> {
  const db = getPublicDatabase()
  const records = listImportRecoveryContextRecords(db, ['ready', 'resuming'], limit)
  const summaries: ImportRecoveryContextSummary[] = []

  for (const record of records) {
    const contextExists = Boolean(record.contextPath && existsSync(record.contextPath))
    let context: ImportRecoveryContext | null = null
    if (contextExists) {
      try {
        const raw = await fs.readFile(record.contextPath, 'utf-8')
        context = JSON.parse(raw) as ImportRecoveryContext
      } catch {
        context = null
      }
    }

    summaries.push({
      taskId: record.taskId,
      diagnosticId: record.diagnosticId || null,
      vaultId: record.vaultId,
      sessionId: record.sessionId,
      status: record.status,
      lastError: record.last_error || null,
      contextPath: record.contextPath,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      rootFolderPath: context?.rootFolderPath,
      serverUrl: context?.serverUrl,
      remoteVaultId: context?.remoteVaultId,
      targetFolderKey: context?.targetFolderKey,
      expectedFiles: Array.isArray(context?.files) ? context.files.length : undefined,
      expectedThumbnails: Array.isArray(context?.thumbnails)
        ? context.thumbnails.length
        : undefined,
      canResume: contextExists && Boolean(context)
    })
  }

  return summaries
}
