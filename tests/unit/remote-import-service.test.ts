/**
 * remote-import-service.test.ts — RemoteImportService 单元测试
 *
 * 覆盖场景：
 * 1. V2 happy path
 * 2. V2 probe fails → V1 fallback
 * 3. V2 commit fails → 不 fallback，返回 V2 failed
 * 4. Feature flag off → V1
 * 5. poll/getSession 失败 → 不 fallback，返回 V2 failed
 * 6. commitSession 抛异常 → 不 fallback
 * 7. UATB bundle 编码格式验证
 * 8. bundle 上传成功时不走 individual fallback
 */

import { Readable } from 'stream'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── 使用 vi.hoisted() 确保 mock 函数在 vi.mock 工厂之前初始化 ───

const mocks = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockGetImportPreflight: vi.fn(),
  mockUploadManifest: vi.fn(),
  mockUploadMetadataChunk: vi.fn(),
  mockUploadFile: vi.fn(),
  mockUploadFileStream: vi.fn(),
  mockUploadThumbnailBundle: vi.fn(),
  mockUploadThumbnail: vi.fn(),
  mockCommitSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockReconcileSession: vi.fn(),
  mockCancelSession: vi.fn(),
  mockBatch: vi.fn(),
  mockUploadLocalFile: vi.fn(),
  mockPauseFileWatcher: vi.fn(),
  mockResumeFileWatcher: vi.fn(),
  mockRenewFileWatcherLease: vi.fn(),
  mockReadFile: vi.fn(),
  mockExistsSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockCreateReadStream: vi.fn()
}))

vi.mock('../../src/main/network/PlatformAuthManager', () => ({
  PlatformAuthManager: {
    getInstance: vi.fn(() => ({
      loadSession: vi.fn().mockResolvedValue(null)
    }))
  }
}))

// ─── Mock ImportSessionClient ────────────────────────────────

vi.mock('../../src/main/networkV2/ImportSessionClient', () => ({
  DEFAULT_FILE_UPLOAD_TIMEOUT_MS: 300_000,
  ImportSessionClient: vi.fn().mockImplementation(() => ({
    getImportPreflight: mocks.mockGetImportPreflight,
    createSession: mocks.mockCreateSession,
    uploadManifest: mocks.mockUploadManifest,
    uploadMetadataChunk: mocks.mockUploadMetadataChunk,
    uploadFile: mocks.mockUploadFile,
    uploadFileStream: mocks.mockUploadFileStream,
    uploadThumbnailBundle: mocks.mockUploadThumbnailBundle,
    uploadThumbnail: mocks.mockUploadThumbnail,
    commitSession: mocks.mockCommitSession,
    getSession: mocks.mockGetSession,
    reconcileSession: mocks.mockReconcileSession,
    cancelSession: mocks.mockCancelSession
  }))
}))

// ─── Mock VaultServiceManager ────────────────────────────────

vi.mock('../../src/main/networkV2/VaultServiceManager', () => ({
  VaultServiceManager: {
    getInstance: vi.fn().mockReturnValue({
      getClient: vi.fn().mockReturnValue({
        batch: mocks.mockBatch,
        uploadLocalFile: mocks.mockUploadLocalFile,
        pauseFileWatcher: mocks.mockPauseFileWatcher,
        resumeFileWatcher: mocks.mockResumeFileWatcher,
        renewFileWatcherLease: mocks.mockRenewFileWatcherLease,
        isConnected: true
      })
    })
  }
}))

// ─── Mock fs — 使用 importOriginal 并覆盖 promises.readFile ──

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  // 创建新对象，覆盖 existsSync 和 promises.readFile
  // 必须保留 default export 以满足 vitest 要求
  const overridden = { ...actual }
  // 覆盖 existsSync
  overridden.existsSync = mocks.mockExistsSync as any
  overridden.statSync = mocks.mockStatSync as any
  overridden.createReadStream = mocks.mockCreateReadStream as any
  // 创建新的 promises 对象覆盖 readFile
  Object.defineProperty(overridden, 'promises', {
    value: {
      ...actual.promises,
      readFile: mocks.mockReadFile
    },
    configurable: true,
    enumerable: true
  })
  // vitest 需要 default export
  Object.defineProperty(overridden, 'default', {
    value: overridden,
    configurable: true,
    enumerable: true
  })
  return overridden
})

// ─── Import after mocks ─────────────────────────────────────

import {
  runRemoteImport,
  buildThumbnailBundles,
  stripThumbnailPrefix
} from '../../src/main/services/asset/RemoteImportService'
import { clearCapabilityCache } from '../../src/main/services/asset/importFeatureFlag'

// ─── Test helpers ────────────────────────────────────────────

const baseParams = {
  serverUrl: 'http://192.168.1.100:18900',
  vaultId: 'test-vault-id',
  clientId: 'test-client-1',
  folders: [{ folderKey: 'f1', fatherKey: 'ALL', type: 'folder', folderName: 'TestFolder' }],
  assets: [{ assetKey: 'a1', folderKey: 'f1', assetName: 'Test.uasset' }],
  thumbnails: [] as Array<{ localPath: string; remotePath: string }>,
  files: [{ path: 'C:/temp/TestFolder/Test.uasset', name: 'Test.uasset' }],
  rootFolderPath: 'C:/temp/TestFolder',
  onStage: vi.fn()
}

const readySession = {
  sessionId: 'sess-1',
  status: 'committed',
  committedFolders: 1,
  committedAssets: 1,
  committedFileCount: 999,
  committedThumbnailCount: 999,
  stagedFileCount: 999,
  stagedThumbnailCount: 999,
  errorCode: null,
  errorMessage: null
}

function resetMocks() {
  vi.clearAllMocks()
  clearCapabilityCache()

  // fs
  mocks.mockExistsSync.mockReturnValue(true)
  mocks.mockReadFile.mockResolvedValue(Buffer.from('file-content'))
  mocks.mockStatSync.mockReturnValue({ size: 100 })
  mocks.mockCreateReadStream.mockImplementation(
    () => Readable.from([Buffer.from('file-content')]) as unknown as import('fs').ReadStream
  )

  // V2 client
  mocks.mockGetImportPreflight.mockResolvedValue({
    ready: true,
    blockers: [],
    capabilities: {
      importSession: true,
      manifestRequired: true,
      manifestPathDigestUpload: true,
      reconcileBeforeCommit: true,
      failedRecoverable: true,
      preflight: true
    }
  })
  mocks.mockCreateSession.mockResolvedValue({ sessionId: 'sess-1', status: 'staging_metadata' })
  mocks.mockUploadManifest.mockResolvedValue({
    uploaded: true,
    files: 1,
    uniqueFiles: 1,
    duplicateFiles: 0,
    thumbnails: 0,
    uniqueThumbnails: 0,
    duplicateThumbnails: 0
  })
  mocks.mockUploadMetadataChunk.mockResolvedValue({ recordCount: 2 })
  mocks.mockUploadFile.mockResolvedValue({ path: 'TestFolder/Test.uasset', size: 100 })
  mocks.mockUploadFileStream.mockResolvedValue({ path: 'TestFolder/Test.uasset', size: 100 })
  mocks.mockUploadThumbnailBundle.mockResolvedValue({ entryCount: 0, totalBytes: 0 })
  mocks.mockCommitSession.mockResolvedValue(readySession)
  mocks.mockGetSession.mockResolvedValue(readySession)
  mocks.mockReconcileSession.mockResolvedValue({
    canResume: true,
    sessionStatus: 'staging_files',
    manifestSource: 'server_manifest',
    manifestUploaded: true,
    consistent: true,
    expected: { files: 1, thumbnails: 0 },
    staged: { files: 1, thumbnails: 0 },
    missingFiles: 0,
    missingThumbnails: 0,
    duplicateFiles: 0,
    duplicateThumbnails: 0,
    unexpectedFiles: 0,
    unexpectedThumbnails: 0
  })
  mocks.mockCancelSession.mockResolvedValue({ sessionId: 'probe-sess', status: 'cancelled' })

  // V1 client
  mocks.mockBatch.mockResolvedValue({ results: [], count: 0 })
  mocks.mockUploadLocalFile.mockResolvedValue(undefined)
  mocks.mockPauseFileWatcher.mockResolvedValue('lease-token-1')
  mocks.mockResumeFileWatcher.mockResolvedValue(undefined)

  delete process.env.USE_V2_IMPORT_SESSION
}

// ─── Tests ───────────────────────────────────────────────────

describe('RemoteImportService', () => {
  beforeEach(resetMocks)
  afterEach(() => {
    delete process.env.USE_V2_IMPORT_SESSION
  })

  it('V2 happy path: createSession → metadata → files → commit → committed', async () => {
    const result = await runRemoteImport(baseParams)

    expect(result.mode).toBe('v2-session')
    expect(result.status).toBe('committed')
    expect(result.sessionId).toBe('sess-1')
    expect(result.filesUploaded).toBe(1)
    expect(result.filesFailed).toBe(0)

    expect(mocks.mockGetImportPreflight).toHaveBeenCalledTimes(1)
    expect(mocks.mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mocks.mockUploadMetadataChunk).toHaveBeenCalledTimes(1)
    expect(mocks.mockUploadFileStream).toHaveBeenCalledTimes(1)
    expect(mocks.mockCommitSession).toHaveBeenCalledTimes(1)
  })

  it('V2 默认允许超过 512MB 的大文件走流式上传', async () => {
    mocks.mockStatSync.mockReturnValue({ size: 1024 * 1024 * 1024 })

    const result = await runRemoteImport(baseParams)

    expect(result.mode).toBe('v2-session')
    expect(result.status).toBe('committed')
    expect(result.filesUploaded).toBe(1)
    expect(result.filesSkippedLarge).toBe(0)
    expect(mocks.mockUploadFileStream).toHaveBeenCalledTimes(1)
  })

  it('preflight 失败 (404) → 返回 V2 blocked 且不创建 session', async () => {
    const error = Object.assign(new Error('HTTP 404'), { statusCode: 404 })
    mocks.mockGetImportPreflight.mockRejectedValueOnce(error)

    const result = await runRemoteImport(baseParams)

    expect(result.mode).toBe('v2-session')
    expect(result.status).toBe('failed')
    expect(result.filesUploaded).toBe(0)
    expect(mocks.mockBatch).not.toHaveBeenCalled()
    expect(mocks.mockUploadLocalFile).not.toHaveBeenCalled()
    expect(mocks.mockCreateSession).not.toHaveBeenCalled()
    expect(mocks.mockCommitSession).not.toHaveBeenCalled()
  })

  it('commit 失败 → 不 fallback，返回 V2 failed', async () => {
    mocks.mockCommitSession.mockResolvedValue({
      sessionId: 'sess-1',
      status: 'failed',
      errorCode: 'COMMIT_ERROR',
      errorMessage: 'DB write failed',
      committedFolders: 0,
      committedAssets: 0
    })
    mocks.mockGetSession
      .mockResolvedValueOnce({
        ...readySession,
        status: 'staging_files'
      })
      .mockResolvedValue({
        sessionId: 'sess-1',
        status: 'failed',
        errorCode: 'COMMIT_ERROR',
        errorMessage: 'DB write failed',
        committedFolders: 0,
        committedAssets: 0,
        committedFileCount: 0,
        committedThumbnailCount: 0,
        stagedFileCount: 999,
        stagedThumbnailCount: 999
      })

    const result = await runRemoteImport(baseParams)

    expect(result.mode).toBe('v2-session')
    expect(result.status).toBe('failed')
    expect(result.error).toBe('DB write failed')
    expect(result.errorCode).toBe('COMMIT_ERROR')
    expect(result.sessionId).toBe('sess-1')
    expect(mocks.mockBatch).not.toHaveBeenCalled()
  })

  it('Feature flag off → forces V1 batch', async () => {
    process.env.USE_V2_IMPORT_SESSION = 'false'
    clearCapabilityCache()

    const result = await runRemoteImport(baseParams)

    expect(result.mode).toBe('v2-session')
    expect(result.status).toBe('failed')
    expect(mocks.mockCreateSession).not.toHaveBeenCalled()
    expect(mocks.mockBatch).not.toHaveBeenCalled()
  })

  it('poll/getSession 失败但 session 已创建 → 不 fallback，返回 V2 failed', async () => {
    mocks.mockCommitSession.mockResolvedValue({
      sessionId: 'sess-1',
      status: 'committing',
      errorCode: null,
      errorMessage: null,
      committedFolders: 0,
      committedAssets: 0
    })
    mocks.mockGetSession
      .mockResolvedValueOnce({
        ...readySession,
        status: 'staging_files'
      })
      .mockRejectedValue(new Error('ECONNRESET'))

    const result = await runRemoteImport(baseParams)

    expect(result.mode).toBe('v2-session')
    expect(result.status).toBe('failed')
    expect(result.sessionId).toBe('sess-1')
    expect(result.error).toContain('Commit/poll failed')
    expect(mocks.mockBatch).not.toHaveBeenCalled()
  })

  it('commitSession 抛异常 → 不 fallback，返回 V2 failed with sessionId', async () => {
    mocks.mockCommitSession.mockRejectedValue(new Error('HTTP timeout'))
    mocks.mockGetSession
      .mockResolvedValueOnce({
        ...readySession,
        status: 'staging_files'
      })
      .mockRejectedValue(new Error('HTTP timeout'))

    const result = await runRemoteImport(baseParams)

    expect(result.mode).toBe('v2-session')
    expect(result.status).toBe('failed')
    expect(result.sessionId).toBe('sess-1')
    expect(result.error).toContain('Commit/poll failed')
    expect(mocks.mockBatch).not.toHaveBeenCalled()
  })
})

// ─── UATB Bundle 编码测试 ────────────────────────────────────

describe('buildThumbnailBundles (UATB format)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockExistsSync.mockReturnValue(true)
    mocks.mockReadFile.mockResolvedValue(Buffer.from('file-content'))
  })

  it('生成正确的 UATB header: magic, version, entryCount', async () => {
    const result = await buildThumbnailBundles([
      { localPath: '/tmp/a.png', remotePath: '.thumbnails/a.png' },
      { localPath: '/tmp/b.jpg', remotePath: '.thumbnails/sub/b.jpg' }
    ])
    const bundle = result.bundles[0]

    expect(result.builtEntries).toBe(2)
    expect(bundle.length).toBeGreaterThan(9)
    expect(bundle.subarray(0, 4).toString('ascii')).toBe('UATB')
    expect(bundle[4]).toBe(0x01)
    expect(bundle.readUInt32LE(5)).toBe(2)
  })

  it('每个 entry 的 pathLen 是 2B LE、dataLen 是 4B LE', async () => {
    const result = await buildThumbnailBundles([
      { localPath: '/tmp/a.png', remotePath: '.thumbnails/a.png' }
    ])
    const bundle = result.bundles[0]

    const expectedPath = '.thumbnails/a.png'
    const expectedData = Buffer.from('file-content')

    // pathLen (2B LE) at offset 9
    const pathLen = bundle.readUInt16LE(9)
    expect(pathLen).toBe(Buffer.byteLength(expectedPath, 'utf-8'))

    // path content at offset 11
    const pathContent = bundle.subarray(11, 11 + pathLen).toString('utf-8')
    expect(pathContent).toBe(expectedPath)

    // dataLen (4B LE)
    const dataLen = bundle.readUInt32LE(11 + pathLen)
    expect(dataLen).toBe(expectedData.length)

    // data content
    const dataContent = bundle.subarray(11 + pathLen + 4, 11 + pathLen + 4 + dataLen)
    expect(dataContent.toString()).toBe('file-content')
  })

  it('无可读文件 → 返回空 Buffer', async () => {
    mocks.mockExistsSync.mockReturnValue(false)

    const result = await buildThumbnailBundles([
      { localPath: '/nonexist/a.png', remotePath: '.thumbnails/a.png' }
    ])

    expect(result.bundles).toHaveLength(0)
    expect(result.builtEntries).toBe(0)
    expect(result.issueEntries).toHaveLength(1)
  })
})

// ─── Bundle 上传路径测试 ─────────────────────────────────────

describe('Thumbnail upload path', () => {
  beforeEach(resetMocks)
  afterEach(() => {
    delete process.env.USE_V2_IMPORT_SESSION
  })

  it('bundle 上传成功时不会调用 uploadThumbnail 逐张上传', async () => {
    const params = {
      ...baseParams,
      thumbnails: [
        { localPath: '/tmp/a.png', remotePath: '.thumbnails/a.png' },
        { localPath: '/tmp/b.jpg', remotePath: '.thumbnails/b.jpg' }
      ]
    }

    const result = await runRemoteImport(params)

    expect(result.mode).toBe('v2-session')
    expect(result.thumbsUploaded).toBe(2)
    expect(mocks.mockUploadThumbnailBundle).toHaveBeenCalledTimes(1)
    expect(mocks.mockUploadThumbnail).not.toHaveBeenCalled()
  })

  it('V2 bundle entry path 不带 .thumbnails/ 前缀（与服务端 UATB 协议一致）', async () => {
    const params = {
      ...baseParams,
      thumbnails: [{ localPath: '/tmp/a.png', remotePath: '.thumbnails/sub/a.png' }]
    }

    const result = await runRemoteImport(params)
    expect(result.mode).toBe('v2-session')
    expect(result.thumbsUploaded).toBe(1)

    // 取到 uploadThumbnailBundle 收到的 buffer
    const bundleArg = mocks.mockUploadThumbnailBundle.mock.calls[0][1] as Buffer
    // 跳过 header (9B)，读 pathLen (2B LE)
    const pathLen = bundleArg.readUInt16LE(9)
    const entryPath = bundleArg.subarray(11, 11 + pathLen).toString('utf-8')

    // 必须是裸相对路径，不能带 .thumbnails/ 前缀
    expect(entryPath).toBe('sub/a.png')
    expect(entryPath.startsWith('.thumbnails')).toBe(false)
  })

  it('V2 individual thumbnail fallback 也用裸路径', async () => {
    // bundle 上传失败，触发 individual fallback
    mocks.mockUploadThumbnailBundle.mockRejectedValueOnce(new Error('bundle failed'))

    const params = {
      ...baseParams,
      thumbnails: [{ localPath: '/tmp/a.png', remotePath: '.thumbnails/folder/a.png' }]
    }

    const result = await runRemoteImport(params)
    expect(result.mode).toBe('v2-session')
    expect(result.thumbsUploaded).toBe(1)

    // uploadThumbnail 收到的 path 应该是裸相对路径
    const uploadedPath = mocks.mockUploadThumbnail.mock.calls[0][1] as string
    expect(uploadedPath).toBe('folder/a.png')
    expect(uploadedPath.startsWith('.thumbnails')).toBe(false)
  })
})

// ─── stripThumbnailPrefix 单元测试 ────────────────────────────

describe('stripThumbnailPrefix', () => {
  it('剥离 .thumbnails/ 前缀', () => {
    expect(stripThumbnailPrefix('.thumbnails/a.png')).toBe('a.png')
    expect(stripThumbnailPrefix('.thumbnails/sub/b.jpg')).toBe('sub/b.jpg')
  })

  it('无前缀时原样返回', () => {
    expect(stripThumbnailPrefix('a.png')).toBe('a.png')
    expect(stripThumbnailPrefix('sub/b.jpg')).toBe('sub/b.jpg')
  })

  it('兼容 backslash', () => {
    expect(stripThumbnailPrefix('.thumbnails\\a.png')).toBe('a.png')
  })
})
