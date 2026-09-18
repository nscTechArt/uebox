// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as http from 'http'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  readdirSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import type { Readable } from 'stream'
import { createZipStoreStream, planZipStore, type ZipStoreSource } from './zipStoreStream'
import { buildVaultFileUrl, encodeRemotePath, pullProjectArchive } from './projectArchivePull'

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const FILES: Record<string, Buffer> = {
  'Demo/Demo.uproject': Buffer.from('{"FileVersion":3}'),
  'Demo/Content/Maps/Lobby.umap': Buffer.alloc(300 * 1024, 0x42),
  'Demo/Config/DefaultEngine.ini': Buffer.from('[Core]\n')
}

let workDir: string
let archiveBytes: Buffer
let server: http.Server
let baseUrl: string
let lastHeaders: http.IncomingHttpHeaders = {}

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'ual-pull-'))
  const sources: ZipStoreSource[] = Object.entries(FILES).map(([zipPath, content]) => {
    const absPath = path.join(workDir, 'src', zipPath)
    mkdirSync(path.dirname(absPath), { recursive: true })
    writeFileSync(absPath, content)
    const st = statSync(absPath)
    return { absPath, zipPath, size: st.size, mtime: st.mtime }
  })
  archiveBytes = await collect(createZipStoreStream(planZipStore(sources)))

  server = http.createServer((req, res) => {
    lastHeaders = req.headers
    const url = req.url || ''
    if (url.endsWith('/files/%E5%B7%A5%E7%A8%8B%E5%BA%93/Demo.zip')) {
      res.writeHead(200, { 'Content-Length': String(archiveBytes.length) })
      res.end(archiveBytes)
      return
    }
    if (url.endsWith('/files/Tools.rar')) {
      res.writeHead(200, { 'Content-Length': '5' })
      res.end('RAR!!')
      return
    }
    if (url.endsWith('/files/truncated.zip')) {
      // 声明比实际多、然后直接掐断连接：模拟中途断线
      res.writeHead(200, { 'Content-Length': String(archiveBytes.length + 100) })
      res.write(archiveBytes, () => res.socket?.destroy())
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"success":false}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(workDir, { recursive: true, force: true })
})

describe('projectArchivePull', () => {
  it('encodes each path segment and keeps the vault id in the url', () => {
    expect(encodeRemotePath('工程库/2026/Demo.zip')).toBe(
      '%E5%B7%A5%E7%A8%8B%E5%BA%93/2026/Demo.zip'
    )
    expect(buildVaultFileUrl('http://nas:18900', 'vault_1', 'a b/c.zip')).toBe(
      'http://nas:18900/api/vaults/vault_1/files/a%20b/c.zip'
    )
  })

  it('downloads a zip, extracts it into the chosen folder, removes the archive and reports progress', async () => {
    const destDir = path.join(workDir, 'dest')
    const stages: string[] = []
    const percents: number[] = []
    const result = await pullProjectArchive({
      fileUrl: buildVaultFileUrl(baseUrl, 'vault_1', '工程库/Demo.zip'),
      headers: { 'X-API-Key': 'k' },
      fileName: 'Demo.zip',
      destDir,
      onStage: (stage) => stages.push(stage),
      onPercent: (p) => percents.push(p)
    })

    expect(lastHeaders['x-api-key']).toBe('k')
    expect(result.extracted).toBe(true)
    expect(result.fileCount).toBe(3)
    expect(result.archiveBytes).toBe(archiveBytes.length)
    expect(result.localPath).toBe(path.join(destDir, 'Demo'))
    for (const [zipPath, content] of Object.entries(FILES)) {
      expect(readFileSync(path.join(destDir, zipPath)).equals(content), zipPath).toBe(true)
    }
    // 压缩包和 .part 都不该留下
    expect(readdirSync(destDir)).toEqual(['Demo'])
    expect(stages[0]).toBe('download')
    expect(stages).toContain('extract')
    expect(percents[percents.length - 1]).toBe(100)
  })

  it('leaves rar archives as downloaded files', async () => {
    const destDir = path.join(workDir, 'dest-rar')
    const result = await pullProjectArchive({
      fileUrl: buildVaultFileUrl(baseUrl, 'vault_1', 'Tools.rar'),
      fileName: 'Tools.rar',
      destDir
    })
    expect(result.extracted).toBe(false)
    expect(result.localPath).toBe(path.join(destDir, 'Tools.rar'))
    expect(readFileSync(result.localPath, 'utf8')).toBe('RAR!!')
  })

  it('fails on a truncated transfer and cleans the partial file', async () => {
    const destDir = path.join(workDir, 'dest-trunc')
    await expect(
      pullProjectArchive({
        fileUrl: buildVaultFileUrl(baseUrl, 'vault_1', 'truncated.zip'),
        fileName: 'truncated.zip',
        destDir
      })
    ).rejects.toThrow(/下载不完整/)
    expect(existsSync(path.join(destDir, 'truncated.zip.part'))).toBe(false)
    expect(existsSync(path.join(destDir, 'truncated.zip'))).toBe(false)
  })

  it('surfaces HTTP errors from the server', async () => {
    await expect(
      pullProjectArchive({
        fileUrl: buildVaultFileUrl(baseUrl, 'vault_1', 'missing.zip'),
        fileName: 'missing.zip',
        destDir: path.join(workDir, 'dest-404')
      })
    ).rejects.toThrow(/HTTP 404/)
  })
})
