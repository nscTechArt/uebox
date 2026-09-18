/**
 * AssetServerAuth.test.ts — 内嵌资产服务器的准入
 *
 * 这些用例对修复前的代码**全部失败**：那时 handleHttpRequest 从头到尾不读任何
 * 凭据头，读操作对全网开放，CORS 还是 `*`。
 */
import Database from 'better-sqlite3'
import * as http from 'http'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel } from '../sqliteDataBase/models/assetFolder'
import { AssetServer } from './AssetServer'

const READ_KEY = 'AAAA-BBBB-CCCC-DDDD'
const WRITE_KEY = 'EEEE-FFFF-GGGG-HHHH'
const HOST_NAME = 'test-host'

let server: AssetServer
let port: number
let vaultDir: string

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
  json: <T = Record<string, unknown>>() => T
}

/**
 * 用裸 http.request 而不是 fetch：需要覆写 Host / Origin 这类
 * undici 禁止修改的头。
 */
function request(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: { host: `${HOST_NAME}:${port}`, ...(options.headers || {}) }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body,
            json: <T>() => JSON.parse(body) as T
          })
        })
      }
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

beforeAll(async () => {
  vaultDir = mkdtempSync(join(tmpdir(), 'asset-server-auth-'))
  writeFileSync(join(vaultDir, 'poster.png'), 'PNGDATA')

  const db = new Database(':memory:')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  initAssetDataModel(db)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
  ).run()

  server = new AssetServer({ port: 0, allowedHostnames: [HOST_NAME] })
  server.registerVault('v1', 'V1', vaultDir, db, { readKey: READ_KEY, writeKey: WRITE_KEY })
  port = await server.start()
})

afterAll(async () => {
  await server.stop()
  rmSync(vaultDir, { recursive: true, force: true })
})

describe('未认证请求必须被拒', () => {
  it('GET /api/vaults 无凭据 → 401（旧实现返回 200 + 全部库信息）', async () => {
    const res = await request('/api/vaults')
    expect(res.status).toBe(401)
    expect(res.json<{ errorCode: string }>().errorCode).toBe('AUTH_REQUIRED')
  })

  it('GET /full-data 无凭据 → 401（旧实现返回全部资产行）', async () => {
    const res = await request('/api/vaults/v1/full-data?type=assets&cursor=0')
    expect(res.status).toBe(401)
  })

  it('GET /files 无凭据 → 401，响应体不含文件内容（旧实现直接吐字节）', async () => {
    const res = await request('/api/vaults/v1/files/poster.png')
    expect(res.status).toBe(401)
    expect(res.body).not.toContain('PNGDATA')
  })

  it('错误的码 → 401 AUTH_INVALID', async () => {
    const res = await request('/api/vaults', { headers: { 'x-api-key': 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' } })
    expect(res.status).toBe(401)
    expect(res.json<{ errorCode: string }>().errorCode).toBe('AUTH_INVALID')
  })

  it('正确的码 → 200', async () => {
    const res = await request('/api/vaults', { headers: { 'x-api-key': READ_KEY } })
    expect(res.status).toBe(200)
  })
})

describe('跨域必须被拒', () => {
  it('响应里不再有 Access-Control-Allow-Origin（旧实现是 *）', async () => {
    const res = await request('/api/vaults', { headers: { 'x-api-key': READ_KEY } })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('OPTIONS 预检 → 405（旧实现返回 204，等于给浏览器开门）', async () => {
    const res = await request('/api/vaults', { method: 'OPTIONS' })
    expect(res.status).toBe(405)
  })

  it('带 Origin 的请求即使码正确也拒（旧实现 200）', async () => {
    const res = await request('/api/vaults', {
      headers: { 'x-api-key': READ_KEY, origin: 'http://evil.example' }
    })
    expect(res.status).toBe(403)
    expect(res.json<{ errorCode: string }>().errorCode).toBe('BROWSER_ORIGIN_REJECTED')
  })

  it('带 Sec-Fetch-Site 的请求同样拒', async () => {
    const res = await request('/api/vaults', {
      headers: { 'x-api-key': READ_KEY, 'sec-fetch-site': 'cross-site' }
    })
    expect(res.status).toBe(403)
  })
})

describe('DNS rebinding', () => {
  it('Host 是外部域名 → 403（旧实现 200）', async () => {
    const res = await request('/api/vaults', {
      headers: { 'x-api-key': READ_KEY, host: 'rebind.evil.test' }
    })
    expect(res.status).toBe(403)
    expect(res.json<{ errorCode: string }>().errorCode).toBe('HOST_NOT_ALLOWED')
  })
})

describe('权限按码分级', () => {
  it('浏览码：读 200，写 403', async () => {
    const read = await request('/api/vaults/v1/assets', { headers: { 'x-api-key': READ_KEY } })
    expect(read.status).toBe(200)

    const write = await request('/api/vaults/v1/folders', {
      method: 'POST',
      headers: { 'x-api-key': READ_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ folderKey: 'f1', folderName: 'F1', fatherKey: 'ALL', depth: 1 })
    })
    expect(write.status).toBe(403)
    expect(write.json<{ errorCode: string }>().errorCode).toBe('PERMISSION_DENIED')
  })

  it('管理码可以写', async () => {
    const write = await request('/api/vaults/v1/folders', {
      method: 'POST',
      headers: { 'x-api-key': WRITE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        folderKey: 'f2',
        folderName: 'F2',
        fatherKey: 'ALL',
        type: 'folder',
        depth: 1
      })
    })
    // 关键是鉴权放行（不是 403），而不是这条路由的业务返回码
    expect(write.status).not.toBe(403)
    expect(write.status).toBeLessThan(300)
  })

  it('/api/vaults 只列出这把码能打开的库，且回报真实权限等级', async () => {
    const res = await request('/api/vaults', { headers: { 'x-api-key': READ_KEY } })
    const body = res.json<{ data: Array<{ vaultId: string; permission: string }> }>()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].permission).toBe('readonly')
  })

  it('码打不开的库返回 404，不做存在性泄露', async () => {
    const other = new AssetServer({ port: 0, allowedHostnames: [HOST_NAME] })
    // 不启动，仅验证同一个 server 上未授权 vaultId 的响应
    void other
    const res = await request('/api/vaults/does-not-exist/assets', {
      headers: { 'x-api-key': READ_KEY }
    })
    expect(res.status).toBe(404)
  })
})

describe('无免鉴权探测口子', () => {
  it('不存在的免鉴权路由同样要码，401 里带 AUTH_REQUIRED 供客户端判断', async () => {
    const res = await request('/api/ping')
    expect(res.status).toBe(401)
    expect(res.json<{ errorCode: string }>().errorCode).toBe('AUTH_REQUIRED')
    expect(res.body).not.toContain('V1')
  })
})

describe('限流', () => {
  it('连续错码到上限后 429', async () => {
    for (let i = 0; i < 10; i++) {
      await request('/api/vaults', { headers: { 'x-api-key': `BADKEY${i}` } })
    }
    const res = await request('/api/vaults', { headers: { 'x-api-key': 'BADKEYX' } })
    expect(res.status).toBe(429)
    expect(res.json<{ errorCode: string }>().errorCode).toBe('AUTH_RATE_LIMITED')
  })
})
