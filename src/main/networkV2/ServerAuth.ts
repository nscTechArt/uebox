import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { IncomingMessage } from 'http'

import type { PermissionLevel } from './SyncProtocol'

/**
 * ServerAuth — 内嵌资产服务器的凭据与请求准入。
 *
 * 背景：AssetServer 监听 0.0.0.0，但过去**从头到尾没有校验过任何凭据** ——
 * 客户端明明在发 X-API-Key（SyncClient.getStandaloneApiKeyHeader），服务端
 * 一个都不读。唯一的门是按来源 IP 查权限表，而那张表只管写操作，读对全网开放。
 * 同一局域网（或同一咖啡厅 Wi-Fi）上任何设备几条 GET 就能把整库元数据和原始
 * 文件拖走，主机端无日志、无告警。
 *
 * 设计要点：
 *  1. 凭据是「每个 Vault 一对随机码」：readKey → 只读，writeKey → 读写。
 *     客户端只保存自己拿到的那一把，服务端按命中哪把来决定权限等级。
 *     这同时解开了「服务端默认只读且没有任何界面能改」那个死结 ——
 *     权限不再挂在没人能填的 IP 表上，而是挂在「你出示了哪把码」。
 *  2. 走 X-API-Key 头 —— 与 standalone 资产服务器、现有 SyncClient 完全一致，
 *     不新造 header，也不落到 query string（query 会进 access log、崩溃报告
 *     和进程列表）。
 *  3. 比较用 SHA-256 摘要 + timingSafeEqual：长度恒定，杜绝长度侧信道。
 *  4. 本文件不 import electron，可以直接单测。
 */

/** Crockford Base32：去掉 I L O U，手抄不会认错 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 16 × 5 bit = 80 bit 熵。局域网在线爆破不可行，且有限流兜底 */
const CODE_LENGTH = 16

/** 凭据头名（小写 —— Node 的 req.headers 一律小写） */
export const ACCESS_KEY_HEADER = 'x-api-key'

export type AuthErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'AUTH_RATE_LIMITED'
  | 'BROWSER_ORIGIN_REJECTED'
  | 'HOST_NOT_ALLOWED'
  | 'PERMISSION_DENIED'

// ─────────────────────────── 访问码 ───────────────────────────

/** 生成一枚配对码，形如 7K3M-9QRT-0XZ2-8VNB */
export function generateAccessKey(): string {
  // 256 % 32 === 0，所以 byte % 32 是均匀的，不需要 rejection sampling
  let code = ''
  for (const byte of randomBytes(CODE_LENGTH)) code += CODE_ALPHABET[byte % 32]
  return code.replace(/(.{4})(?=.)/g, '$1-')
}

/** 归一化用户手抄的码：去分隔符、大写、纠正易混字符 */
export function normalizeAccessKey(raw: string | undefined | null): string {
  if (!raw) return ''
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
}

function digestOf(normalizedKey: string): Buffer {
  return createHash('sha256').update(normalizedKey, 'utf-8').digest()
}

function digestEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

// ─────────────────────── 单个 Vault 的凭据 ───────────────────────

export interface VaultAccessKeys {
  /** 只读访问码（配对码）。必填 —— 没有它服务器不该注册这个库 */
  readKey: string
  /** 读写访问码（管理码）。不配置 = 全网只能读 */
  writeKey?: string
}

export class VaultCredentials {
  private readonly readDigest: Buffer
  private readonly writeDigest: Buffer | null

  constructor(keys: VaultAccessKeys) {
    const read = normalizeAccessKey(keys.readKey)
    if (!read) throw new Error('VaultCredentials: readKey 不能为空')
    this.readDigest = digestOf(read)
    const write = normalizeAccessKey(keys.writeKey)
    this.writeDigest = write ? digestOf(write) : null
  }

  /** @param normalizedKey 已经过 normalizeAccessKey 的值 */
  match(normalizedKey: string): PermissionLevel | null {
    if (!normalizedKey) return null
    const presented = digestOf(normalizedKey)
    // 先比写码：两把码被配成同一个值时应给高权限
    if (this.writeDigest && digestEquals(presented, this.writeDigest)) return 'readwrite'
    if (digestEquals(presented, this.readDigest)) return 'readonly'
    return null
  }
}

// ─────────────────────────── 请求准入 ───────────────────────────

export function readAccessKeyHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers[ACCESS_KEY_HEADER]
  return Array.isArray(raw) ? raw[0] : raw
}

/**
 * 合法客户端一律是 Electron 主进程的 Node http 客户端，**永远不带**
 * Origin / Sec-Fetch-Site。带了就说明是浏览器页面发来的 —— 直接拒。
 *
 * 这一条对 WebSocket 尤其关键：**WS 握手根本不受 CORS 约束**，
 * Access-Control-Allow-Origin 对它一点作用都没有，任何网页都能
 * `new WebSocket('ws://192.168.1.5:18900/?vaultId=...')` 订阅全部变更推送。
 */
export function isBrowserOriginated(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) return true
  const site = req.headers['sec-fetch-site']
  return typeof site === 'string' && site.length > 0
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * DNS rebinding 防护：Host 必须是 IP 字面量 / localhost / 本机名。
 *
 * rebinding 场景下页面的 origin 是 http://evil.com，DNS 重绑到内网 IP，
 * 于是请求变成同源 —— CORS、预检、Origin 检查全部失效。但浏览器发出的
 * Host 仍然是 evil.com，所以这道检查能把这条路径堵死。
 */
export function isHostHeaderAllowed(
  hostHeader: string | undefined,
  allowedHostnames: readonly string[]
): boolean {
  if (!hostHeader) return false // HTTP/1.1 强制要求 Host
  const raw = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0]
  const bare = raw.replace(/^\[|\]$/g, '').toLowerCase()
  if (!bare) return false
  if (bare === 'localhost' || bare === '::1') return true
  if (IPV4.test(bare)) return true
  if (bare.includes(':')) return true // IPv6 字面量
  const short = bare.split('.')[0]
  return allowedHostnames.some((name) => name.toLowerCase().split('.')[0] === short)
}

// ─────────────────────────── 失败限流 ───────────────────────────

/**
 * 按来源 IP 的认证失败限流。
 *
 * 80 bit 的码本来就爆不动，这里主要是防日志刷屏和低速探测。
 */
export class AuthThrottle {
  private records = new Map<string, { count: number; firstAt: number; lockedUntil: number }>()

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxFailures = 10,
    private readonly lockMs = 60_000
  ) {}

  isLocked(ip: string, now = Date.now()): boolean {
    const record = this.records.get(ip)
    return Boolean(record && record.lockedUntil > now)
  }

  recordFailure(ip: string, now = Date.now()): void {
    const record = this.records.get(ip)
    if (!record || now - record.firstAt > this.windowMs) {
      this.records.set(ip, { count: 1, firstAt: now, lockedUntil: 0 })
      return
    }
    record.count += 1
    if (record.count >= this.maxFailures) {
      record.lockedUntil = now + this.lockMs
      record.count = 0
      record.firstAt = now
    }
    // 防止长跑进程无限增长
    if (this.records.size > 1000) {
      for (const [key, value] of this.records) {
        if (value.lockedUntil <= now && now - value.firstAt > this.windowMs) {
          this.records.delete(key)
        }
      }
    }
  }

  reset(ip: string): void {
    this.records.delete(ip)
  }
}
