// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { Readable } from 'stream'

const clientCalls = vi.hoisted(() => ({
  createSession: vi.fn(),
  uploadManifest: vi.fn(),
  uploadMetadataChunk: vi.fn(),
  uploadFileStream: vi.fn(),
  getSession: vi.fn(),
  commitSession: vi.fn(),
  constructed: [] as Array<Record<string, unknown>>
}))

vi.mock('../../networkV2/ImportSessionClient', () => ({
  ImportSessionClient: class {
    constructor(config: Record<string, unknown>) {
      clientCalls.constructed.push(config)
    }
    createSession = clientCalls.createSession
    uploadManifest = clientCalls.uploadManifest
    uploadMetadataChunk = clientCalls.uploadMetadataChunk
    uploadFileStream = clientCalls.uploadFileStream
    getSession = clientCalls.getSession
    commitSession = clientCalls.commitSession
  }
}))

const readiness = vi.hoisted(() => ({ checkV2ImportReadiness: vi.fn() }))
vi.mock('./importFeatureFlag', () => ({
  checkV2ImportReadiness: readiness.checkV2ImportReadiness
}))

import {
  buildArchiveAssetKey,
  DEFAULT_EXCLUDED_DIR_NAMES,
  scanProjectFolder,
  uploadProjectArchive
} from './projectArchiveUpload'

async function drain(stream: Readable): Promise<number> {
  let total = 0
  for await (const chunk of stream) total += (chunk as Buffer).length
  return total
}

function makeProject(root: string): void {
  const write = (rel: string, size: number): void => {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, Buffer.alloc(size, 0x5a))
  }
  write('Demo.uproject', 120)
  write('Content/Maps/Lobby.umap', 5000)
  write('Content/Saved/NotACache.uasset', 10) // Content 下同名目录不是缓存，要保留
  write('Config/DefaultEngine.ini', 300)
  write('Intermediate/Build/junk.obj', 4000)
  write('Saved/Logs/Demo.log', 800)
  write('DerivedDataCache/ddc.udd', 900)
  write('Plugins/MyPlugin/MyPlugin.uplugin', 50)
  write('Plugins/MyPlugin/Intermediate/x.obj', 700)
  write('Plugins/MyPlugin/Binaries/Win64/x.dll', 60)
}

describe('scanProjectFolder', () => {
  it('drops engine caches at project level but keeps Content and plugin binaries', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const projectDir = path.join(root, 'Demo')
      makeProject(projectDir)
      const scan = scanProjectFolder(projectDir)
      const paths = scan.sources.map((s) => s.zipPath).sort()
      expect(paths).toEqual(
        [
          'Demo/Config/DefaultEngine.ini',
          'Demo/Content/Maps/Lobby.umap',
          'Demo/Content/Saved/NotACache.uasset',
          'Demo/Demo.uproject',
          'Demo/Plugins/MyPlugin/Binaries/Win64/x.dll',
          'Demo/Plugins/MyPlugin/MyPlugin.uplugin'
        ].sort()
      )
      expect(scan.excludedDirs.sort()).toEqual(
        ['DerivedDataCache', 'Intermediate', 'Plugins/MyPlugin/Intermediate', 'Saved'].sort()
      )
      expect(scan.totalBytes).toBe(120 + 5000 + 10 + 300 + 50 + 60)
      expect(scan.skippedSymlinks).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('excludes caches under category-nested plugins, where depth-based rules missed them', () => {
    // 引擎自带插件常摆成 Plugins/<分类>/<插件名>/，缓存目录落在第四级
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const projectDir = path.join(root, 'Demo')
      makeProject(projectDir)
      const nested = path.join(projectDir, 'Plugins', 'Runtime', 'Deep')
      mkdirSync(path.join(nested, 'Intermediate', 'Build'), { recursive: true })
      writeFileSync(path.join(nested, 'Deep.uplugin'), Buffer.alloc(40, 1))
      writeFileSync(path.join(nested, 'Intermediate', 'Build', 'junk.obj'), Buffer.alloc(9000, 1))

      const scan = scanProjectFolder(projectDir)
      expect(scan.excludedDirs).toContain('Plugins/Runtime/Deep/Intermediate')
      expect(scan.sources.map((s) => s.zipPath)).toContain('Demo/Plugins/Runtime/Deep/Deep.uplugin')
      expect(scan.sources.some((s) => s.zipPath.includes('Runtime/Deep/Intermediate'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops instead of hanging when a directory cycle sends the walk too deep', () => {
    // junction 指回上层时这段同步递归永远不返回，表现是主进程直接卡死
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const projectDir = path.join(root, 'Demo')
      makeProject(projectDir)
      // 用可调上限来试，不在磁盘上真挖 65 层（长路径在别的机器上会先炸）
      expect(() => scanProjectFolder(projectDir, DEFAULT_EXCLUDED_DIR_NAMES, 2)).toThrow(
        /目录层级超过 2 层/
      )
      // 默认上限下同一个工程要能正常扫完
      expect(scanProjectFolder(projectDir).sources.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits a directory entry for an empty folder so it survives the round trip', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const projectDir = path.join(root, 'Demo')
      makeProject(projectDir)
      mkdirSync(path.join(projectDir, 'Content', 'WIP', 'Deeper'), { recursive: true })

      const scan = scanProjectFolder(projectDir)
      const dirEntries = scan.sources.filter((s) => s.isDirectory)
      expect(dirEntries.map((s) => s.zipPath)).toEqual(['Demo/Content/WIP/Deeper/'])
      expect(dirEntries[0].size).toBe(0)
      expect(scan.totalBytes).toBe(120 + 5000 + 10 + 300 + 50 + 60)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('uploadProjectArchive', () => {
  beforeEach(() => {
    clientCalls.constructed.length = 0
    for (const fn of Object.values(clientCalls)) {
      if (typeof fn === 'function' && 'mockReset' in fn)
        (fn as ReturnType<typeof vi.fn>).mockReset()
    }
    readiness.checkV2ImportReadiness.mockReset()
    readiness.checkV2ImportReadiness.mockResolvedValue({ supported: true, ready: true })
    clientCalls.createSession.mockResolvedValue({ sessionId: 'sess-1', status: 'created' })
    clientCalls.uploadManifest.mockResolvedValue({})
    clientCalls.uploadMetadataChunk.mockResolvedValue({ recordCount: 2 })
    clientCalls.uploadFileStream.mockImplementation(
      async (_sid: string, _remotePath: string, stream: Readable, contentLength: number) => {
        const bytes = await drain(stream)
        if (bytes !== contentLength) throw new Error(`stream ${bytes} != declared ${contentLength}`)
        return { path: _remotePath, size: bytes }
      }
    )
    clientCalls.getSession.mockResolvedValue({
      sessionId: 'sess-1',
      status: 'staging',
      stagedFileCount: 1
    })
    clientCalls.commitSession.mockResolvedValue({
      sessionId: 'sess-1',
      status: 'committed',
      stagedFileCount: 1
    })
  })

  it('packs the folder into one zip whose byte count matches the manifest and commits once', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const projectDir = path.join(root, 'Demo')
      makeProject(projectDir)
      const stages: string[] = []
      const bytes: Array<[number, number]> = []

      const result = await uploadProjectArchive({
        serverUrl: 'http://127.0.0.1:19911',
        vaultId: 'vault-1',
        clientId: 'test-client',
        apiKey: 'k',
        sourcePath: projectDir,
        targetFolderKey: 'f-projects',
        targetFolderPath: '工程库/2026',
        targetFolderRecord: { folderKey: 'f-projects', folderName: '2026', fatherKey: 'f-root' },
        onStage: (stage) => stages.push(stage),
        onBytes: (sent, total) => bytes.push([sent, total])
      })

      expect(result.status).toBe('committed')
      expect(result.archiveName).toBe('Demo.zip')
      expect(result.remotePath).toBe('工程库/2026/Demo.zip')
      expect(result.fileCount).toBe(6)
      expect(result.excludedDirs).toContain('Intermediate')
      expect(result.assetKey).toBe(buildArchiveAssetKey('工程库/2026/Demo.zip'))
      expect(result.uploadAttempts).toBe(1)

      // 清单里只有一个文件，大小就是整包的精确字节数
      const manifest = clientCalls.uploadManifest.mock.calls[0][1]
      expect(manifest.files).toEqual([
        { remotePath: '工程库/2026/Demo.zip', size: result.archiveBytes }
      ])
      expect(manifest.thumbnails).toEqual([])

      // 元数据：目标文件夹 + 一条整包资产
      const records = clientCalls.uploadMetadataChunk.mock.calls[0][2]
      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ _type: 'folder', folderKey: 'f-projects' })
      expect(records[1]).toMatchObject({
        _type: 'asset',
        assetKey: result.assetKey,
        folderKey: 'f-projects',
        assetName: 'Demo',
        filePath: '工程库/2026/Demo.zip',
        fileExtension: 'zip',
        fileSize: result.archiveBytes,
        assetType: 'ProjectArchive'
      })

      expect(clientCalls.uploadFileStream).toHaveBeenCalledTimes(1)
      expect(clientCalls.commitSession).toHaveBeenCalledTimes(1)
      expect(clientCalls.createSession).toHaveBeenCalledWith(1, 'f-projects')

      expect(stages[0]).toBe('scan')
      expect(stages).toContain('pack_upload')
      expect(stages[stages.length - 1]).toBe('commit')
      expect(bytes[bytes.length - 1]).toEqual([result.archiveBytes, result.archiveBytes])

      // 整包上传的空闲超时要比普通文件宽
      expect(clientCalls.constructed[0]).toMatchObject({ fileUploadTimeoutMs: 10 * 60 * 1000 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uploads an existing archive file as-is without repacking', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const rar = path.join(root, 'PNS-提交.rar')
      writeFileSync(rar, Buffer.alloc(12345, 1))
      const result = await uploadProjectArchive({
        serverUrl: 'http://127.0.0.1:19911',
        vaultId: 'vault-1',
        clientId: 'c',
        sourcePath: rar,
        targetFolderKey: 'ALL'
      })
      expect(result.status).toBe('committed')
      expect(result.archiveName).toBe('PNS-提交.rar')
      expect(result.remotePath).toBe('PNS-提交.rar')
      expect(result.archiveBytes).toBe(12345)
      expect(result.fileCount).toBe(1)
      const records = clientCalls.uploadMetadataChunk.mock.calls[0][2]
      expect(records).toHaveLength(1) // 根目录不用附带文件夹记录
      expect(records[0]).toMatchObject({
        folderKey: 'ALL',
        fileExtension: 'rar',
        assetName: 'PNS-提交'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retries a transient upload failure once and then succeeds', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const projectDir = path.join(root, 'Demo')
      makeProject(projectDir)
      let attempt = 0
      clientCalls.uploadFileStream.mockImplementation(
        async (_sid: string, remotePath: string, stream: Readable, contentLength: number) => {
          attempt++
          const bytes = await drain(stream)
          if (attempt === 1) throw new Error('socket hang up')
          expect(bytes).toBe(contentLength)
          return { path: remotePath, size: bytes }
        }
      )
      const result = await uploadProjectArchive({
        serverUrl: 'http://127.0.0.1:19911',
        vaultId: 'vault-1',
        clientId: 'c',
        sourcePath: projectDir
      })
      expect(result.status).toBe('committed')
      expect(result.uploadAttempts).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('reports failure without committing when the server rejects the archive', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const projectDir = path.join(root, 'Demo')
      makeProject(projectDir)
      clientCalls.uploadFileStream.mockImplementation(
        async (_s: string, _r: string, stream: Readable) => {
          await drain(stream)
          const err = new Error('Content-Length mismatch') as Error & {
            errorCode: string
            statusCode: number
          }
          err.errorCode = 'CONTENT_LENGTH_MISMATCH'
          err.statusCode = 409
          throw err
        }
      )
      const result = await uploadProjectArchive({
        serverUrl: 'http://127.0.0.1:19911',
        vaultId: 'vault-1',
        clientId: 'c',
        sourcePath: projectDir
      })
      expect(result.status).toBe('failed')
      expect(result.errorCode).toBe('CONTENT_LENGTH_MISMATCH')
      expect(clientCalls.commitSession).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('counts only real files, not the directory entries added for empty folders', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const projectDir = path.join(root, 'Demo')
      makeProject(projectDir)
      mkdirSync(path.join(projectDir, 'Content', 'WIP'), { recursive: true })

      const result = await uploadProjectArchive({
        serverUrl: 'http://127.0.0.1:19911',
        vaultId: 'vault-1',
        clientId: 'c',
        sourcePath: projectDir
      })
      // 6 个文件 + 1 条目录条目，报出去的应该还是 6，否则和取回侧对不上
      expect(result.fileCount).toBe(6)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves a failed result for scan errors instead of rejecting', async () => {
    // 别的阶段全都返回 ProjectArchiveUploadResult，扫描阶段也必须走同一条路，
    // 否则调用方要为它单独写一套 catch
    const result = await uploadProjectArchive({
      serverUrl: 'http://127.0.0.1:19911',
      vaultId: 'vault-1',
      clientId: 'c',
      sourcePath: path.join(tmpdir(), `does-not-exist-${Date.now()}`)
    })
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('SCAN_FAILED')
    expect(clientCalls.createSession).not.toHaveBeenCalled()
  })

  it('stops early when the preflight blocks the import', async () => {
    readiness.checkV2ImportReadiness.mockResolvedValue({
      supported: true,
      ready: false,
      errorCode: 'DISK_FULL',
      userMessage: '服务器剩余空间不足'
    })
    const root = mkdtempSync(path.join(tmpdir(), 'ual-proj-'))
    try {
      const projectDir = path.join(root, 'Demo')
      makeProject(projectDir)
      const result = await uploadProjectArchive({
        serverUrl: 'http://127.0.0.1:19911',
        vaultId: 'vault-1',
        clientId: 'c',
        sourcePath: projectDir
      })
      expect(result.status).toBe('failed')
      expect(result.errorCode).toBe('DISK_FULL')
      expect(result.error).toBe('服务器剩余空间不足')
      expect(clientCalls.createSession).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
