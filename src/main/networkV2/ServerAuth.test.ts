import { describe, expect, it } from 'vitest'

import {
  AuthThrottle,
  VaultCredentials,
  generateAccessKey,
  isBrowserOriginated,
  isHostHeaderAllowed,
  normalizeAccessKey
} from './ServerAuth'

import type { IncomingMessage } from 'http'

const fakeReq = (headers: Record<string, string>): IncomingMessage =>
  ({ headers }) as unknown as IncomingMessage

describe('访问码生成与归一化', () => {
  it('生成 16 位 Crockford Base32，四位一组', () => {
    expect(generateAccessKey()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
  })

  it('大量生成不重复', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateAccessKey()))
    expect(set.size).toBe(200)
  })

  it('容忍手抄错误：小写 / 空格 / 分隔符 / I-L-O-U', () => {
    expect(normalizeAccessKey(' 7k3m-9qrt ')).toBe('7K3M9QRT')
    expect(normalizeAccessKey('IL0U')).toBe('110V')
    expect(normalizeAccessKey(undefined)).toBe('')
  })
})

describe('VaultCredentials', () => {
  const creds = new VaultCredentials({
    readKey: 'AAAA-BBBB-CCCC-DDDD',
    writeKey: 'EEEE-FFFF-GGGG-HHHH'
  })

  it('读码 → readonly，写码 → readwrite', () => {
    expect(creds.match(normalizeAccessKey('aaaa bbbb cccc dddd'))).toBe('readonly')
    expect(creds.match(normalizeAccessKey('EEEEFFFFGGGGHHHH'))).toBe('readwrite')
  })

  it('错码 / 空码 → null', () => {
    expect(creds.match(normalizeAccessKey('ZZZZ-ZZZZ-ZZZZ-ZZZZ'))).toBeNull()
    expect(creds.match('')).toBeNull()
  })

  it('只配读码时，写码不存在', () => {
    const readOnly = new VaultCredentials({ readKey: 'AAAA-BBBB-CCCC-DDDD' })
    expect(readOnly.match(normalizeAccessKey('AAAABBBBCCCCDDDD'))).toBe('readonly')
    expect(readOnly.match(normalizeAccessKey('EEEEFFFFGGGGHHHH'))).toBeNull()
  })

  it('readKey 为空时构造失败（fail-closed）', () => {
    expect(() => new VaultCredentials({ readKey: '' })).toThrow()
  })
})

describe('Host 头白名单（DNS rebinding 防护）', () => {
  const allowed = ['nas-01']

  it.each([
    ['192.168.1.5:18900', true],
    ['127.0.0.1:18900', true],
    ['localhost:18900', true],
    ['[::1]:18900', true],
    ['nas-01:18900', true],
    ['nas-01.local:18900', true],
    ['evil.com:18900', false],
    ['rebind.attacker.test', false]
  ])('%s → %s', (host, expected) => {
    expect(isHostHeaderAllowed(host, allowed)).toBe(expected)
  })

  it('缺 Host 头直接拒（HTTP/1.1 强制要求）', () => {
    expect(isHostHeaderAllowed(undefined, allowed)).toBe(false)
  })
})

describe('浏览器来源识别', () => {
  it('带 Origin 判为浏览器', () => {
    expect(isBrowserOriginated(fakeReq({ origin: 'http://evil.com' }))).toBe(true)
  })

  it('带 Sec-Fetch-Site 判为浏览器', () => {
    expect(isBrowserOriginated(fakeReq({ 'sec-fetch-site': 'cross-site' }))).toBe(true)
  })

  it('Node 客户端（两个头都不带）判为非浏览器', () => {
    expect(isBrowserOriginated(fakeReq({ host: '192.168.1.5:18900' }))).toBe(false)
  })
})

describe('AuthThrottle', () => {
  it('窗口内失败到上限后锁定，过期自动解锁', () => {
    const throttle = new AuthThrottle(60_000, 10, 60_000)
    for (let i = 0; i < 9; i++) throttle.recordFailure('1.2.3.4', 1_000)
    expect(throttle.isLocked('1.2.3.4', 1_000)).toBe(false)

    throttle.recordFailure('1.2.3.4', 1_000)
    expect(throttle.isLocked('1.2.3.4', 1_000)).toBe(true)
    expect(throttle.isLocked('1.2.3.4', 70_000)).toBe(false)
  })

  it('认证成功一次即清零', () => {
    const throttle = new AuthThrottle(60_000, 3, 60_000)
    throttle.recordFailure('1.2.3.4', 0)
    throttle.recordFailure('1.2.3.4', 0)
    throttle.reset('1.2.3.4')
    throttle.recordFailure('1.2.3.4', 0)
    expect(throttle.isLocked('1.2.3.4', 0)).toBe(false)
  })

  it('不同 IP 互不影响', () => {
    const throttle = new AuthThrottle(60_000, 2, 60_000)
    throttle.recordFailure('1.1.1.1', 0)
    throttle.recordFailure('1.1.1.1', 0)
    expect(throttle.isLocked('1.1.1.1', 0)).toBe(true)
    expect(throttle.isLocked('2.2.2.2', 0)).toBe(false)
  })
})
