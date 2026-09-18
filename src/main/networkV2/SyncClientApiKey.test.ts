import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { SyncClient, type SyncClientConfig } from './SyncClient'

function createHttpOnlyClient(config: SyncClientConfig): SyncClient {
  const client = Object.create(SyncClient.prototype) as SyncClient
  ;(client as unknown as { config: SyncClientConfig }).config = {
    checksumIntervalMs: 30 * 60 * 1000,
    httpTimeoutMs: 10_000,
    ...config
  }
  return client
}

function drainRequest(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on('data', () => {})
    req.on('end', resolve)
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const raw = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(raw)
  })
  res.end(raw)
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      sendJson(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server failed to listen')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

describe('SyncClient standalone API key', () => {
  it('sends standalone API key on JSON and stream writes', async () => {
    const observedKeys: Array<string | undefined> = []
    const server = await startServer(async (req, res) => {
      observedKeys.push(req.headers['x-api-key'] as string | undefined)
      await drainRequest(req)
      sendJson(res, 200, { success: true, data: { ok: true } })
    })
    const tempDir = mkdtempSync(join(tmpdir(), 'sync-client-key-'))
    const filePath = join(tempDir, 'asset.uasset')
    writeFileSync(filePath, 'ok')

    try {
      const client = createHttpOnlyClient({
        serverUrl: server.url,
        vaultId: 'test-vault',
        clientId: 'test-client',
        hostname: 'test-host',
        apiKey: 'admin-key'
      })

      await client.createAsset({ assetKey: 'asset-key' })
      await client.uploadLocalFile(filePath, 'Folder/asset.uasset')

      expect(observedKeys).toEqual(['admin-key', 'admin-key'])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      await server.close()
    }
  })

  it('updates standalone API key on a running client', async () => {
    const observedKeys: Array<string | undefined> = []
    const server = await startServer(async (req, res) => {
      observedKeys.push(req.headers['x-api-key'] as string | undefined)
      await drainRequest(req)
      sendJson(res, 200, { success: true, data: { ok: true } })
    })

    try {
      const client = createHttpOnlyClient({
        serverUrl: server.url,
        vaultId: 'test-vault',
        clientId: 'test-client',
        hostname: 'test-host'
      })

      client.setStandaloneApiKey('next-key')
      await client.createFolder({ folderKey: 'folder-key', folderName: 'Folder' })

      expect(observedKeys).toEqual(['next-key'])
    } finally {
      await server.close()
    }
  })

  // v3 起服务端读操作也要鉴权，所以读请求必须带码。
  // 这条用例原来断言的是相反行为（`does not send ... on regular reads`）——
  // 那等于把「读接口对全网开放」这个漏洞固化成了预期行为。
  it('sends the access key on reads too (v3: server authenticates reads)', async () => {
    const observedKeys: Array<string | undefined> = []
    const server = await startServer(async (req, res) => {
      observedKeys.push(req.headers['x-api-key'] as string | undefined)
      await drainRequest(req)
      sendJson(res, 200, { success: true, data: { list: [], total: 0 } })
    })

    try {
      const client = createHttpOnlyClient({
        serverUrl: server.url,
        vaultId: 'test-vault',
        clientId: 'test-client',
        hostname: 'test-host',
        apiKey: 'admin-key'
      })

      await client.getDeletedAssets()

      expect(observedKeys).toEqual(['admin-key'])
    } finally {
      await server.close()
    }
  })
})
