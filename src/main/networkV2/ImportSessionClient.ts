/**
 * ImportSessionClient — 最小 V2 Import Session 客户端
 *
 * 用于 Electron App 的 main 进程，通过 HTTP 与远端 asset-server 的 V2 API 交互。
 *
 * Phase 4 扩展：
 * - uploadThumbnail() — 单张缩略图上传
 * - uploadThumbnailBundle() — TLV bundle 批量上传
 *
 * Phase 5 稳健性增强：
 * - 支持 per-operation timeout（file upload / commit / poll 可独立配置）
 * - 默认 timeout 从 30s → 120s，适应 NAS 高负载场景
 * - 环境变量覆盖：V2_IMPORT_HTTP_TIMEOUT_MS
 * - 超时 / 错误信息增强，包含 method、path、bodySize，方便一眼定位
 */
import * as http from 'http'
import * as https from 'https'
import { createHash } from 'crypto'
import type { Readable } from 'stream'

// ─── 集中常量 ─────────────────────────────────────────────
// 可通过环境变量覆盖，避免后续调参到处改代码

/** 默认 HTTP 超时（ms）— 适用于 metadata / getSession 等轻量请求 */
export const DEFAULT_HTTP_TIMEOUT_MS =
  parseInt(process.env.V2_IMPORT_HTTP_TIMEOUT_MS || '', 10) || 120_000

/** 文件 / 缩略图上传超时（ms）— 大文件场景需更长 */
export const DEFAULT_FILE_UPLOAD_TIMEOUT_MS =
  parseInt(process.env.V2_IMPORT_FILE_UPLOAD_TIMEOUT_MS || '', 10) || 300_000

/** commit / poll 超时（ms） */
export const DEFAULT_COMMIT_TIMEOUT_MS =
  parseInt(process.env.V2_IMPORT_COMMIT_TIMEOUT_MS || '', 10) || 180_000

const DEFAULT_KEEP_ALIVE_MAX_SOCKETS =
  parseInt(process.env.V2_IMPORT_KEEPALIVE_MAX_SOCKETS || '', 10) || 8
const DEFAULT_KEEP_ALIVE_MAX_FREE_SOCKETS =
  parseInt(process.env.V2_IMPORT_KEEPALIVE_MAX_FREE_SOCKETS || '', 10) || 4
const DEFAULT_KEEP_ALIVE_MSECS = parseInt(process.env.V2_IMPORT_KEEPALIVE_MSECS || '', 10) || 15_000

const HTTP_KEEP_ALIVE_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: DEFAULT_KEEP_ALIVE_MSECS,
  maxSockets: DEFAULT_KEEP_ALIVE_MAX_SOCKETS,
  maxFreeSockets: DEFAULT_KEEP_ALIVE_MAX_FREE_SOCKETS,
  scheduling: 'lifo'
})

const HTTPS_KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: DEFAULT_KEEP_ALIVE_MSECS,
  maxSockets: DEFAULT_KEEP_ALIVE_MAX_SOCKETS,
  maxFreeSockets: DEFAULT_KEEP_ALIVE_MAX_FREE_SOCKETS,
  scheduling: 'lifo'
})

export interface ImportSessionClientConfig {
  /** Server HTTP base URL, e.g. http://192.168.1.100:18900 */
  serverUrl: string
  /** Vault ID */
  vaultId: string
  /** 本客户端唯一标识 */
  clientId: string
  /** HTTP 请求超时（ms）— 轻量请求默认值 */
  httpTimeoutMs?: number
  /** 文件 / 缩略图上传超时（ms） */
  fileUploadTimeoutMs?: number
  /** commit / poll 超时（ms） */
  commitTimeoutMs?: number
  /** Returns a fresh-enough token before starting non-replayable uploads. */
  /** Standalone server admin KEY used by temporary KEY-only write mode. */
  apiKey?: string
}

type ImportSessionRuntimeConfig = ImportSessionClientConfig &
  Required<
    Pick<ImportSessionClientConfig, 'httpTimeoutMs' | 'fileUploadTimeoutMs' | 'commitTimeoutMs'>
  >

// ─── 服务端响应类型 ──────────────────────────────────────

interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errorCode?: string
}

export interface ImportSessionData {
  sessionId: string
  vaultId: string
  status: string
  clientId: string
  metadataChunksExpected: number
  metadataChunksReceived: number
  targetFolderKey: string | null
  commitScope: string
  filesStaged: boolean
  thumbnailsStaged: boolean
  manifestUploaded?: boolean
  manifestFileCount?: number
  manifestUniqueFileCount?: number
  manifestThumbnailCount?: number
  manifestUniqueThumbnailCount?: number
  errorCode: string | null
  errorMessage: string | null
  committedFolders: number
  committedAssets: number
  // File staging stats
  stagedFileCount: number
  stagedBytes: number
  committedFileCount: number
  committedBytes: number
  // Thumbnail staging stats
  stagedThumbnailCount: number
  stagedThumbnailBytes: number
  committedThumbnailCount: number
  committedThumbnailBytes: number
  createdAt: string
  updatedAt: string
}

export interface ImportSessionReconcileEntry {
  remotePath: string
  size?: number | null
}

export interface ImportSessionReconcileRequest {
  files: ImportSessionReconcileEntry[]
  thumbnails: ImportSessionReconcileEntry[]
  includeMissingPaths?: boolean
}

export interface ImportSessionReconcileResult {
  canResume: boolean
  sessionStatus: string
  manifestSource?: 'server_manifest' | 'request'
  manifestUploaded?: boolean
  consistent?: boolean
  expected: {
    files: number
    uniqueFiles?: number
    thumbnails: number
    uniqueThumbnails?: number
  }
  staged: {
    files: number
    thumbnails: number
    fileBytes?: number
    thumbnailBytes?: number
  }
  missingFiles: number
  missingThumbnails: number
  sizeMismatchFiles?: number
  sizeMismatchThumbnails?: number
  duplicateFiles?: number
  duplicateThumbnails?: number
  unexpectedFiles?: number
  unexpectedThumbnails?: number
  missingFilePaths?: string[]
  missingThumbnailPaths?: string[]
  sizeMismatchFilePaths?: string[]
  sizeMismatchThumbnailPaths?: string[]
  repairFilePaths?: string[]
  repairThumbnailPaths?: string[]
  duplicateFileRemotePaths?: string[]
  duplicateThumbnailRemotePaths?: string[]
  unexpectedStagedFilePaths?: string[]
  unexpectedStagedThumbnailPaths?: string[]
  diagnostics?: Record<string, unknown> | null
}

export interface ImportSessionManifestResult {
  uploaded: boolean
  files: number
  uniqueFiles: number
  duplicateFiles: number
  thumbnails: number
  uniqueThumbnails: number
  duplicateThumbnails: number
  duplicateFileRemotePaths?: string[]
  duplicateThumbnailRemotePaths?: string[]
}

export interface ImportSessionCapabilities {
  protocol?: string
  importSession?: boolean
  manifestRequired?: boolean
  manifestCompleteMarker?: boolean
  manifestContentLengthCheck?: boolean
  manifestPathDigestUpload?: boolean
  reconcileBeforeCommit?: boolean
  failedRecoverable?: boolean
  resumableRepairPaths?: boolean
  retryAfter?: boolean
  preflight?: boolean
}

export interface ImportSessionPreflightResult {
  ready: boolean
  status: 'ready' | 'blocked' | string
  userMessage?: string
  serverVersion?: unknown
  vaultId?: string
  targetFolderKey?: string
  expectedUploadBytes?: number
  capabilities?: ImportSessionCapabilities
  checks?: Record<string, unknown>
  blockers?: string[]
}

// ─── Client ──────────────────────────────────────────────

export class ImportSessionClient {
  private config: ImportSessionRuntimeConfig

  constructor(config: ImportSessionClientConfig) {
    this.config = {
      httpTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      fileUploadTimeoutMs: DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
      commitTimeoutMs: DEFAULT_COMMIT_TIMEOUT_MS,
      ...config
    }
    console.log(
      `[ImportSessionClient] init: httpTimeout=${this.config.httpTimeoutMs}ms, ` +
        `fileUploadTimeout=${this.config.fileUploadTimeoutMs}ms, ` +
        `commitTimeout=${this.config.commitTimeoutMs}ms`
    )
  }

  /** 创建导入会话 */
  async createSession(
    metadataChunksExpected: number,
    targetFolderKey?: string | null
  ): Promise<ImportSessionData> {
    return this.httpRequest<ImportSessionData>('POST', this.basePath(), {
      clientId: this.config.clientId,
      metadataChunksExpected,
      targetFolderKey: targetFolderKey || 'ALL'
    })
  }

  /** 导入前体检：服务器在线、版本能力、权限/数据库/写入/空间等 */
  async getImportPreflight(
    targetFolderKey?: string | null,
    expectedUploadBytes?: number
  ): Promise<ImportSessionPreflightResult> {
    const query = new URLSearchParams()
    query.set('targetFolderKey', targetFolderKey || 'ALL')
    if (Number.isFinite(expectedUploadBytes) && (expectedUploadBytes || 0) > 0) {
      query.set('expectedUploadBytes', String(Math.ceil(expectedUploadBytes || 0)))
    }
    return this.httpRequest<ImportSessionPreflightResult>(
      'GET',
      `${this.basePath()}/preflight?${query.toString()}`
    )
  }

  /** 上传 metadata chunk（NDJSON 格式） */
  async uploadMetadataChunk(
    sessionId: string,
    index: number,
    records: Array<Record<string, unknown>>
  ): Promise<{ recordCount: number }> {
    const ndjson = records.map((r) => JSON.stringify(r)).join('\n')
    return this.httpRequestRaw<{ recordCount: number }>(
      'PUT',
      `${this.basePath()}/${sessionId}/metadata-chunks/${index}`,
      Buffer.from(ndjson, 'utf-8'),
      'text/plain'
    )
  }

  /** 上传服务端持久 manifest，作为后续 reconcile/commit 的事实源 */
  async uploadManifest(
    sessionId: string,
    body: ImportSessionReconcileRequest
  ): Promise<ImportSessionManifestResult> {
    return this.httpRequest<ImportSessionManifestResult>(
      'PUT',
      `${this.basePath()}/${sessionId}/manifest`,
      body,
      this.config.commitTimeoutMs
    )
  }

  /** 上传 staging 文件（使用 fileUploadTimeoutMs） */
  async uploadFile(
    sessionId: string,
    relativePath: string,
    data: Buffer
  ): Promise<{ path: string; size: number }> {
    const pathDigest = this.manifestPathDigest(relativePath)
    return this.httpRequestRaw<{ path: string; size: number }>(
      'PUT',
      `${this.basePath()}/${sessionId}/files-by-digest/${pathDigest}`,
      data,
      'application/octet-stream',
      this.config.fileUploadTimeoutMs
    )
  }

  /** 流式上传 staging 文件，避免整文件 Buffer 常驻内存 */
  async uploadFileStream(
    sessionId: string,
    relativePath: string,
    stream: Readable,
    contentLength: number,
    timeoutOverride?: number
  ): Promise<{ path: string; size: number }> {
    const pathDigest = this.manifestPathDigest(relativePath)
    return this.httpRequestStream<{ path: string; size: number }>(
      'PUT',
      `${this.basePath()}/${sessionId}/files-by-digest/${pathDigest}`,
      stream,
      contentLength,
      'application/octet-stream',
      timeoutOverride ?? this.config.fileUploadTimeoutMs
    )
  }

  /** 上传单张缩略图（使用 fileUploadTimeoutMs） */
  async uploadThumbnail(
    sessionId: string,
    relativePath: string,
    data: Buffer
  ): Promise<{ path: string; size: number }> {
    const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/')
    return this.httpRequestRaw<{ path: string; size: number }>(
      'PUT',
      `${this.basePath()}/${sessionId}/thumbnails/${encodedPath}`,
      data,
      'application/octet-stream',
      this.config.fileUploadTimeoutMs
    )
  }

  /** 上传缩略图 bundle（TLV 二进制格式，使用 fileUploadTimeoutMs） */
  async uploadThumbnailBundle(
    sessionId: string,
    bundle: Buffer,
    timeoutOverride?: number
  ): Promise<{ entryCount: number; totalBytes: number }> {
    return this.httpRequestRaw<{ entryCount: number; totalBytes: number }>(
      'PUT',
      `${this.basePath()}/${sessionId}/thumbnails-bundle`,
      bundle,
      'application/octet-stream',
      timeoutOverride ?? this.config.fileUploadTimeoutMs
    )
  }

  /** 提交会话（使用 commitTimeoutMs） */
  async commitSession(sessionId: string): Promise<ImportSessionData> {
    return this.httpRequest<ImportSessionData>(
      'POST',
      `${this.basePath()}/${sessionId}/commit`,
      {},
      this.config.commitTimeoutMs
    )
  }

  /** 查询会话状态 */
  async getSession(sessionId: string): Promise<ImportSessionData> {
    return this.httpRequest<ImportSessionData>('GET', `${this.basePath()}/${sessionId}`)
  }

  /** 对账导入会话，用于断点续传前计算缺失文件 / 缩略图 */
  async reconcileSession(
    sessionId: string,
    body: ImportSessionReconcileRequest
  ): Promise<ImportSessionReconcileResult> {
    return this.httpRequest<ImportSessionReconcileResult>(
      'POST',
      `${this.basePath()}/${sessionId}/reconcile`,
      body,
      this.config.commitTimeoutMs
    )
  }

  /** 取消会话 */
  async cancelSession(sessionId: string): Promise<ImportSessionData> {
    return this.httpRequest<ImportSessionData>('POST', `${this.basePath()}/${sessionId}/cancel`, {})
  }

  // ─── 端到端测试入口 ──────────────────────────────────

  /**
   * 测试整个 V2 import session 流程:
   * create → 2 chunks → commit → 查询 committed
   */
  async testImportSession(): Promise<{ success: boolean; session: ImportSessionData }> {
    console.log('[ImportSessionClient] 开始测试 V2 import session...')

    // 1. 创建 session（2 个 chunk）
    const session = await this.createSession(2)
    console.log(`[ImportSessionClient] 创建成功: ${session.sessionId}, status=${session.status}`)

    // 2. 上传 chunk 0（folder）
    const chunk0 = [
      {
        _type: 'folder',
        folderKey: 'test-folder-1',
        fatherKey: 'ALL',
        type: 'folder',
        folderName: 'TestFolder',
        fullPath: '/TestFolder',
        depth: 1
      }
    ]
    const r0 = await this.uploadMetadataChunk(session.sessionId, 0, chunk0)
    console.log(`[ImportSessionClient] chunk 0 上传成功: ${r0.recordCount} records`)

    // 3. 上传 chunk 1（asset）
    const chunk1 = [
      {
        _type: 'asset',
        assetKey: 'test-asset-1',
        folderKey: 'test-folder-1',
        assetName: 'TestAsset.uasset',
        assetType: 'UnrealAsset'
      }
    ]
    const r1 = await this.uploadMetadataChunk(session.sessionId, 1, chunk1)
    console.log(`[ImportSessionClient] chunk 1 上传成功: ${r1.recordCount} records`)

    // 3.5. 上传测试文件
    const testFileContent = Buffer.from('hello world - v2 client file', 'utf-8')
    const rFile = await this.uploadFile(session.sessionId, 'TestFolder/hello.txt', testFileContent)
    console.log(`[ImportSessionClient] 测试文件 上传成功: ${rFile.path} (${rFile.size} bytes)`)

    // 4. Commit
    const committed = await this.commitSession(session.sessionId)
    console.log(
      `[ImportSessionClient] commit 完成: status=${committed.status}, scope=${committed.commitScope}`
    )

    // 5. 查询确认
    const final = await this.getSession(session.sessionId)
    console.log(
      `[ImportSessionClient] 最终状态: status=${final.status}, folders=${final.committedFolders}, assets=${final.committedAssets}`
    )

    return { success: final.status === 'committed', session: final }
  }

  // ─── 内部工具 ─────────────────────────────────────────

  private basePath(): string {
    return `/api/v2/vaults/${encodeURIComponent(this.config.vaultId)}/import-sessions`
  }

  private manifestPathDigest(relativePath: string): string {
    return createHash('sha256').update(relativePath, 'utf-8').digest('hex')
  }

  private getHttpAgent(isHttps: boolean): http.Agent | https.Agent {
    return isHttps ? HTTPS_KEEP_ALIVE_AGENT : HTTP_KEEP_ALIVE_AGENT
  }

  private buildRequestOptions(
    method: string,
    url: URL,
    headers: Record<string, string | number>,
    timeout: number
  ): http.RequestOptions {
    return {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
      timeout,
      agent: this.getHttpAgent(url.protocol === 'https:')
    }
  }

  private getStandaloneApiKeyHeader(method: string, requestPath: string): Record<string, string> {
    if (method.toUpperCase() === 'GET' && !/\/import-sessions\/preflight$/.test(requestPath)) {
      return {}
    }
    const apiKey = this.config.apiKey?.trim()
    return apiKey ? { 'X-API-Key': apiKey } : {}
  }

  private decorateTransportError(
    message: string,
    res: http.IncomingMessage,
    rawBody: string
  ): Error {
    const err = new Error(
      `${message} (status=${res.statusCode || 0}, contentLength=${res.headers['content-length'] || '-'}, ` +
        `bodyPreview=${JSON.stringify(rawBody.slice(0, 200))})`
    )
    ;(err as any).statusCode = res.statusCode
    return err
  }

  private collectJsonResponse<T>(
    res: http.IncomingMessage,
    requestLabel: string,
    resolveOnce: (value: T) => void,
    rejectOnce: (err: unknown) => void
  ): void {
    const chunks: Buffer[] = []
    let responseEnded = false

    res.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    res.on('aborted', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      rejectOnce(
        this.decorateTransportError(
          `[INCOMPLETE_RESPONSE] ${requestLabel} response aborted`,
          res,
          raw
        )
      )
    })

    res.on('error', (err) => {
      rejectOnce(err)
    })

    res.on('end', () => {
      responseEnded = true
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw.trim()) {
        rejectOnce(
          this.decorateTransportError(
            `[EMPTY_RESPONSE] ${requestLabel} returned empty body`,
            res,
            raw
          )
        )
        return
      }
      try {
        const json = JSON.parse(raw) as ApiResponse<T>
        if (json.success) {
          resolveOnce(json.data as T)
          return
        }
        const err = new Error(json.error || `HTTP ${res.statusCode}`)
        ;(err as any).errorCode = json.errorCode
        ;(err as any).statusCode = res.statusCode
        ;(err as any).retryAfter = res.headers['retry-after']
        rejectOnce(err)
      } catch (err) {
        rejectOnce(
          this.decorateTransportError(
            `[INVALID_JSON_RESPONSE] ${requestLabel} failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
            res,
            raw
          )
        )
      }
    })

    res.on('close', () => {
      if (responseEnded || res.complete) return
      const raw = Buffer.concat(chunks).toString('utf-8')
      rejectOnce(
        this.decorateTransportError(
          `[INCOMPLETE_RESPONSE] ${requestLabel} closed before complete body`,
          res,
          raw
        )
      )
    })
  }

  private httpRequest<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    timeoutOverride?: number
  ): Promise<T> {
    return this.sendHttpRequest<T>(method, urlPath, body, timeoutOverride)
  }

  private sendHttpRequest<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    timeoutOverride?: number
  ): Promise<T> {
    const effectiveTimeout = timeoutOverride ?? this.config.httpTimeoutMs
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this.config.serverUrl)
      const isHttps = url.protocol === 'https:'
      const lib = isHttps ? https : http

      const bodyStr = body ? JSON.stringify(body) : undefined
      const options = this.buildRequestOptions(
        method,
        url,
        {
          'Content-Type': 'application/json',
          'X-Client-Id': encodeURIComponent(this.config.clientId),
          ...this.getStandaloneApiKeyHeader(method, url.pathname),
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
        },
        effectiveTimeout
      )

      let settled = false
      const rejectOnce = (err: unknown): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      const resolveOnce = (value: T): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const req = lib.request(options, (res) => {
        this.collectJsonResponse(res, `${method} ${url.pathname}`, resolveOnce, rejectOnce)
      })

      req.on('socket', (socket) => socket.setNoDelay(true))
      req.on('error', rejectOnce)
      req.on('timeout', () => {
        req.destroy()
        rejectOnce(
          new Error(
            `[CLIENT TIMEOUT] ${method} ${url.pathname} timed out after ${effectiveTimeout}ms ` +
              `(bodySize=${bodyStr ? Buffer.byteLength(bodyStr) : 0})`
          )
        )
      })
      if (bodyStr) req.write(bodyStr)
      req.end()
    })
  }

  private httpRequestRaw<T>(
    method: string,
    urlPath: string,
    rawBody: Buffer,
    contentType: string,
    timeoutOverride?: number
  ): Promise<T> {
    return this.sendHttpRequestRaw<T>(method, urlPath, rawBody, contentType, timeoutOverride)
  }

  private sendHttpRequestRaw<T>(
    method: string,
    urlPath: string,
    rawBody: Buffer,
    contentType: string,
    timeoutOverride?: number
  ): Promise<T> {
    const effectiveTimeout = timeoutOverride ?? this.config.httpTimeoutMs
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this.config.serverUrl)
      const isHttps = url.protocol === 'https:'
      const lib = isHttps ? https : http

      const options = this.buildRequestOptions(
        method,
        url,
        {
          'Content-Type': contentType,
          'Content-Length': rawBody.length,
          'X-Client-Id': encodeURIComponent(this.config.clientId),
          ...this.getStandaloneApiKeyHeader(method, url.pathname)
        },
        effectiveTimeout
      )

      let settled = false
      const rejectOnce = (err: unknown): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      const resolveOnce = (value: T): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const req = lib.request(options, (res) => {
        this.collectJsonResponse(res, `${method} ${url.pathname}`, resolveOnce, rejectOnce)
      })

      req.on('socket', (socket) => socket.setNoDelay(true))
      req.on('error', rejectOnce)
      req.on('timeout', () => {
        req.destroy()
        rejectOnce(
          new Error(
            `[CLIENT TIMEOUT] ${method} ${url.pathname} timed out after ${effectiveTimeout}ms ` +
              `(bodySize=${rawBody.length})`
          )
        )
      })
      req.write(rawBody)
      req.end()
    })
  }

  private httpRequestStream<T>(
    method: string,
    urlPath: string,
    bodyStream: Readable,
    contentLength: number,
    contentType: string,
    timeoutOverride?: number
  ): Promise<T> {
    return this.sendHttpRequestStream<T>(
      method,
      urlPath,
      bodyStream,
      contentLength,
      contentType,
      timeoutOverride
    )
  }

  private sendHttpRequestStream<T>(
    method: string,
    urlPath: string,
    bodyStream: Readable,
    contentLength: number,
    contentType: string,
    timeoutOverride?: number
  ): Promise<T> {
    const effectiveTimeout = timeoutOverride ?? this.config.httpTimeoutMs
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this.config.serverUrl)
      const isHttps = url.protocol === 'https:'
      const lib = isHttps ? https : http

      let settled = false
      const rejectOnce = (err: unknown): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      const resolveOnce = (value: T): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const options = this.buildRequestOptions(
        method,
        url,
        {
          'Content-Type': contentType,
          'Content-Length': contentLength,
          'X-Client-Id': encodeURIComponent(this.config.clientId),
          ...this.getStandaloneApiKeyHeader(method, url.pathname)
        },
        effectiveTimeout
      )

      const req = lib.request(options, (res) => {
        this.collectJsonResponse(res, `${method} ${url.pathname}`, resolveOnce, rejectOnce)
      })

      req.on('socket', (socket) => socket.setNoDelay(true))
      req.on('error', (err) => {
        bodyStream.destroy(err)
        rejectOnce(err)
      })
      req.on('timeout', () => {
        const err = new Error(
          `[CLIENT TIMEOUT] ${method} ${url.pathname} timed out after ${effectiveTimeout}ms ` +
            `(bodySize=${contentLength})`
        )
        bodyStream.destroy(err)
        req.destroy(err)
        rejectOnce(err)
      })

      bodyStream.on('error', (err) => {
        req.destroy(err)
        rejectOnce(err)
      })

      bodyStream.pipe(req)
    })
  }
}
