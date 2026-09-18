/**
 * AssetServerWsAuth.test.ts — WebSocket 握手准入
 *
 * WS 握手**完全不受 CORS 约束** —— 修复前那个 Access-Control-Allow-Origin
 * 对这条路径从来没起过作用，任何网页都能直接连上订阅全部变更推送。
 * 这些用例对修复前的代码全部失败（那时 WS 升级零校验）。
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel } from '../sqliteDataBase/models/assetFolder'
import { AssetServer } from './AssetServer'

const READ_KEY = 'AAAA-BBBB-CCCC-DDDD'
const OTHER_KEY = 'MMMM-NNNN-PPPP-QQQQ'
const HOST_NAME = 'test-host'

let server: AssetServer
let port: number
let vaultDir: string

function makeVaultDb(): Database.Database {
  const db = new Database(':memory:')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  initAssetDataModel(db)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
  ).run()
  return db
}

interface ConnectResult {
  ok: boolean
  status?: number
}

function connect(headers: Record<string, string> = {}, vaultId = 'v1'): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const url =
      `ws://127.0.0.1:${port}/?vaultId=${encodeURIComponent(vaultId)}` + `&clientId=c1&hostname=h1`
    const ws = new WebSocket(url, { headers: { host: `${HOST_NAME}:${port}`, ...headers } })

    let settled = false
    const finish = (result: ConnectResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    ws.on('open', () => {
      ws.close()
      finish({ ok: true })
    })
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      finish({ ok: false, status: res.statusCode })
    })
    ws.on('error', () => finish({ ok: false }))
  })
}

beforeAll(async () => {
  vaultDir = mkdtempSync(join(tmpdir(), 'asset-server-ws-'))
  server = new AssetServer({ port: 0, allowedHostnames: [HOST_NAME] })
  server.registerVault('v1', 'V1', vaultDir, makeVaultDb(), { readKey: READ_KEY })
  server.registerVault('v2', 'V2', vaultDir, makeVaultDb(), { readKey: OTHER_KEY })
  port = await server.start()
})

afterAll(async () => {
  await server.stop()
  rmSync(vaultDir, { recursive: true, force: true })
})

describe('WebSocket 握手鉴权', () => {
  it('无凭据 → 握手 401，且没有进入广播列表（旧实现直接连上）', async () => {
    const result = await connect()
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(server.connectedClientCount).toBe(0)
  })

  it('错误凭据 → 401', async () => {
    const result = await connect({ 'x-api-key': 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  it('带 Origin 的浏览器连接即使凭据正确也拒 —— WS 不受 CORS 保护', async () => {
    const result = await connect({ 'x-api-key': READ_KEY, origin: 'http://evil.example' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  it('Host 是外部域名 → 403（DNS rebinding）', async () => {
    const result = await connect({ 'x-api-key': READ_KEY, host: 'rebind.evil.test' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  it('正确凭据 → 连接成功', async () => {
    const result = await connect({ 'x-api-key': READ_KEY })
    expect(result.ok).toBe(true)
  })

  it('拿 A 库的码连 B 库 → 401，凭据不跨库生效', async () => {
    const result = await connect({ 'x-api-key': READ_KEY }, 'v2')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  it('轮换访问码后，旧码再也连不上', async () => {
    const before = await connect({ 'x-api-key': OTHER_KEY }, 'v2')
    expect(before.ok).toBe(true)

    server.updateVaultKeys('v2', { readKey: 'RRRR-SSSS-TTTT-VVVV' })

    const after = await connect({ 'x-api-key': OTHER_KEY }, 'v2')
    expect(after.ok).toBe(false)
    expect(after.status).toBe(401)

    const withNew = await connect({ 'x-api-key': 'RRRR-SSSS-TTTT-VVVV' }, 'v2')
    expect(withNew.ok).toBe(true)
  })
})
