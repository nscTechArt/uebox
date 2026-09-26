// @vitest-environment node
/**
 * 成员会话（设计 3.8）：登录落盘刷新令牌；身份令牌到寿命 80% 换新，换新时刷新令牌轮换，
 * 新的先落盘；刷新被拒（被吊销、过期）就清掉凭据并要求重新登录。
 * 成员面由一个假的 team-service 扮演。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogHttp } from './http'
import { SecretStore } from './secrets'
import {
  CatalogSession,
  SignedOutError,
  decodeJwtClaims,
  expiresToMs,
  shouldRefresh
} from './session'
import { fakeCodec } from './fakeCatalog.testkit'

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`
}

let dir: string
let server: http.Server
let base: string
let issued = 0
let validRefresh = new Set<string>()
let refreshCalls = 0
let rejectRefresh = false

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'catalog-session-'))
  issued = 0
  refreshCalls = 0
  rejectRefresh = false
  validRefresh = new Set()
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        string
      >
      const grant = (): void => {
        issued += 1
        const refreshToken = `refresh-${issued}`
        validRefresh.add(refreshToken)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            identityToken: jwt({ sub: 'artist', n: issued }),
            refreshToken,
            // 秒：客户端要自己认出来
            expires: Math.floor(Date.now() / 1000) + 900
          })
        )
      }
      if (request.url === '/v1/auth/login') {
        if (body.member === 'artist' && body.password === 'pw') return grant()
        response.writeHead(401, { 'content-type': 'application/json' })
        return response.end(JSON.stringify({ error: 'bad credentials' }))
      }
      if (request.url === '/v1/auth/refresh') {
        refreshCalls += 1
        if (rejectRefresh || !validRefresh.has(body.refreshToken)) {
          response.writeHead(401, { 'content-type': 'application/json' })
          return response.end(JSON.stringify({ error: 'revoked' }))
        }
        validRefresh.delete(body.refreshToken)
        return grant()
      }
      if (request.url === '/v1/auth/logout') {
        validRefresh.delete(body.refreshToken)
        response.writeHead(204)
        return response.end()
      }
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function makeSession(
  now: () => number,
  mode: 'password' | 'token' = 'password'
): { session: CatalogSession; secrets: SecretStore } {
  const secrets = new SecretStore(join(dir, 'secrets.bin'), fakeCodec())
  const member = new CatalogHttp(base, { kind: 'loopback-http' })
  return { session: new CatalogSession('srv', mode, member, {}, secrets, 'test', now), secrets }
}

describe('CatalogSession', () => {
  it('stores the refresh token on sign-in and reuses the identity token until 80% of its life', async () => {
    let clock = Date.now()
    const { session, secrets } = makeSession(() => clock)
    expect(await session.signIn({ member: 'artist', password: 'pw' })).toBe('artist')
    expect((await secrets.get('srv'))?.refreshToken).toBe('refresh-1')
    const first = await session.identityToken()
    expect(decodeJwtClaims(first).sub).toBe('artist')
    clock += 5 * 60 * 1000
    expect(await session.identityToken()).toBe(first)
    expect(refreshCalls).toBe(0)
    clock += 8 * 60 * 1000
    const second = await session.identityToken()
    expect(second).not.toBe(first)
    expect(refreshCalls).toBe(1)
    // 轮换：新的刷新令牌落盘，旧的已经作废
    expect((await secrets.get('srv'))?.refreshToken).toBe('refresh-2')
    expect(validRefresh.has('refresh-1')).toBe(false)
  })

  it('coalesces concurrent refreshes into one request', async () => {
    let clock = Date.now()
    const { session } = makeSession(() => clock)
    await session.signIn({ member: 'artist', password: 'pw' })
    clock += 20 * 60 * 1000
    const tokens = await Promise.all([
      session.identityToken(),
      session.identityToken(),
      session.identityToken()
    ])
    expect(new Set(tokens).size).toBe(1)
    expect(refreshCalls).toBe(1)
  })

  it('signs out and forgets the refresh token when the server revokes it', async () => {
    let clock = Date.now()
    const { session, secrets } = makeSession(() => clock)
    await session.signIn({ member: 'artist', password: 'pw' })
    rejectRefresh = true
    clock += 20 * 60 * 1000
    await expect(session.identityToken()).rejects.toBeInstanceOf(SignedOutError)
    expect(await secrets.get('srv')).toBeNull()
    expect(await session.signedIn()).toBe(false)
  })

  it('rejects a wrong password without storing anything', async () => {
    const { session, secrets } = makeSession(() => Date.now())
    await expect(session.signIn({ member: 'artist', password: 'nope' })).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect(await secrets.get('srv')).toBeNull()
  })

  it('uses a pasted token until its exp and then asks for a new one', async () => {
    let clock = Date.now()
    const { session } = makeSession(() => clock, 'token')
    const token = jwt({ sub: 'lab-artist', exp: Math.floor(clock / 1000) + 60 })
    expect(await session.useIdentityToken(`Bearer ${token}`)).toBe('lab-artist')
    expect(await session.identityToken()).toBe(token)
    clock += 2 * 60 * 1000
    await expect(session.identityToken()).rejects.toBeInstanceOf(SignedOutError)
  })

  it('refuses to write credentials when secure storage is unavailable', async () => {
    const secrets = new SecretStore(join(dir, 'secrets.bin'), fakeCodec(false))
    await expect(secrets.set('srv', { refreshToken: 'x' })).rejects.toThrow(/Secure storage/)
  })
})

describe('token lifetime helpers', () => {
  it('reads expires in seconds or milliseconds', () => {
    expect(expiresToMs(1_800_000_000)).toBe(1_800_000_000_000)
    expect(expiresToMs(1_800_000_000_000)).toBe(1_800_000_000_000)
    expect(expiresToMs('nope')).toBeNull()
  })

  it('refreshes at 80% of the lifetime', () => {
    const issuedMs = 1_000_000
    const grant = { issuedMs, expiresMs: issuedMs + 1000 }
    expect(shouldRefresh(grant, issuedMs + 799)).toBe(false)
    expect(shouldRefresh(grant, issuedMs + 800)).toBe(true)
  })
})
