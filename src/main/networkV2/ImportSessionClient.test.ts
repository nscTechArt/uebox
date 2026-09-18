import * as http from 'http'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ImportSessionClient } from './ImportSessionClient'

type TestServer = {
  url: string
  close: () => Promise<void>
}

const servers: TestServer[] = []

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(payload))
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port')
  }

  const testServer = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
  servers.push(testServer)
  return testServer
}

function drainRequest(req: http.IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on('data', () => {})
    req.on('error', reject)
    req.on('end', resolve)
  })
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('ImportSessionClient uploads', () => {
  it('uploads file streams by manifest path digest instead of raw URL path', async () => {
    let observedUrl = ''
    const remotePath =
      '解锁移动雕像/3-后期工程/AE工程/ZRR-解锁移动雕像-AE工程/(素材)/03-图片特效/jimeng-2025-12-16-8692-让女性正看向镜头，背景改为绿色，保持她的金色短发、黄色外套、黑色内衣、黄金AK-....png'
    const expectedDigest = createHash('sha256').update(remotePath, 'utf-8').digest('hex')
    const server = await startServer(async (req, res) => {
      observedUrl = req.url || ''
      await drainRequest(req)
      sendJson(res, 200, {
        success: true,
        data: {
          path: remotePath,
          size: 4
        }
      })
    })
    const client = new ImportSessionClient({
      serverUrl: server.url,
      vaultId: 'vault-a',
      clientId: 'test-client'
    })

    const result = await client.uploadFileStream(
      'session-a',
      remotePath,
      Readable.from([Buffer.from('data')]),
      4
    )

    expect(result.path).toBe(remotePath)
    expect(observedUrl).toBe(
      `/api/v2/vaults/vault-a/import-sessions/session-a/files-by-digest/${expectedDigest}`
    )
    expect(observedUrl).not.toContain(encodeURIComponent(remotePath))
    expect(observedUrl).not.toContain('黄金AK')
  })

  it('uploads an import manifest to the session manifest route', async () => {
    let observedMethod = ''
    let observedUrl = ''
    let observedBody = ''
    const server = await startServer(async (req, res) => {
      observedMethod = req.method || ''
      observedUrl = req.url || ''
      observedBody = await readRequestBody(req)
      sendJson(res, 200, {
        success: true,
        data: {
          uploaded: true,
          files: 1,
          uniqueFiles: 1,
          duplicateFiles: 0,
          thumbnails: 0,
          uniqueThumbnails: 0,
          duplicateThumbnails: 0
        }
      })
    })
    const client = new ImportSessionClient({
      serverUrl: server.url,
      vaultId: 'vault-a',
      clientId: 'test-client'
    })

    const manifest = {
      files: [{ remotePath: 'Folder/a.txt', size: 2 }],
      thumbnails: [],
      includeMissingPaths: true
    }
    const result = await client.uploadManifest('session-a', manifest)

    expect(result.uploaded).toBe(true)
    expect(observedMethod).toBe('PUT')
    expect(observedUrl).toBe('/api/v2/vaults/vault-a/import-sessions/session-a/manifest')
    expect(JSON.parse(observedBody)).toEqual(manifest)
  })

  it('reads import preflight checks before uploading', async () => {
    let observedMethod = ''
    let observedUrl = ''
    let observedKey: string | undefined
    const server = await startServer(async (req, res) => {
      observedMethod = req.method || ''
      observedUrl = req.url || ''
      observedKey = req.headers['x-api-key'] as string | undefined
      await drainRequest(req)
      sendJson(res, 200, {
        success: true,
        data: {
          ready: true,
          status: 'ready',
          userMessage: 'NAS V2 服务器状态正常，可以开始导入',
          capabilities: {
            importSession: true,
            manifestRequired: true,
            preflight: true
          },
          checks: {
            storage: { ok: true, diskFreeBytes: 4096 }
          }
        }
      })
    })
    const client = new ImportSessionClient({
      serverUrl: server.url,
      vaultId: 'vault-a',
      clientId: 'test-client',
      apiKey: 'admin-key'
    })

    const result = await client.getImportPreflight('folder-a', 2048)

    expect(result.ready).toBe(true)
    expect(observedMethod).toBe('GET')
    expect(observedUrl).toBe(
      '/api/v2/vaults/vault-a/import-sessions/preflight?targetFolderKey=folder-a&expectedUploadBytes=2048'
    )
    expect(observedKey).toBe('admin-key')
  })

  it('exposes Retry-After from busy import responses', async () => {
    const server = await startServer(async (req, res) => {
      await drainRequest(req)
      sendJson(
        res,
        429,
        {
          success: false,
          error: 'busy',
          errorCode: 'IMPORT_BUSY'
        },
        { 'Retry-After': '7' }
      )
    })
    const client = new ImportSessionClient({
      serverUrl: server.url,
      vaultId: 'vault-a',
      clientId: 'test-client'
    })

    await expect(
      client.uploadManifest('session-a', { files: [], thumbnails: [] })
    ).rejects.toMatchObject({
      errorCode: 'IMPORT_BUSY',
      retryAfter: '7'
    })
  })

  it('sends standalone API key on JSON and stream import requests', async () => {
    const observedKeys: Array<string | undefined> = []
    const server = await startServer(async (req, res) => {
      observedKeys.push(req.headers['x-api-key'] as string | undefined)
      await drainRequest(req)
      sendJson(res, 200, {
        success: true,
        data: req.url?.includes('/files-by-digest/')
          ? { path: 'Folder/a.txt', size: 2 }
          : { uploaded: true, files: 1, uniqueFiles: 1, duplicateFiles: 0, thumbnails: 0 }
      })
    })
    const client = new ImportSessionClient({
      serverUrl: server.url,
      vaultId: 'vault-a',
      clientId: 'test-client',
      apiKey: 'admin-key'
    })

    await client.uploadManifest('session-a', { files: [], thumbnails: [] })
    await client.uploadFileStream(
      'session-a',
      'Folder/a.txt',
      Readable.from([Buffer.from('ok')]),
      2
    )

    expect(observedKeys).toEqual(['admin-key', 'admin-key'])
  })

  it('does not send standalone API key on regular import session reads', async () => {
    let observedKey: string | undefined
    const server = await startServer(async (req, res) => {
      observedKey = req.headers['x-api-key'] as string | undefined
      await drainRequest(req)
      sendJson(res, 200, {
        success: true,
        data: {
          sessionId: 'session-a',
          vaultId: 'vault-a',
          status: 'committed'
        }
      })
    })
    const client = new ImportSessionClient({
      serverUrl: server.url,
      vaultId: 'vault-a',
      clientId: 'test-client',
      apiKey: 'admin-key'
    })

    await client.getSession('session-a')

    expect(observedKey).toBeUndefined()
  })
})
