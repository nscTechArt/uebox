/**
 * 连不上的时候说清楚是哪一种：用户要把这句话转给管理员，"网络出错"没人知道该做什么。
 *
 * - **port-blocked**：发出去没有任何回音（超时）—— 局域网里几乎总是防火墙把包丢了；
 * - **port-closed**：对方机器在，但这个端口没人听（ECONNREFUSED）—— 服务没启动或端口号不对；
 * - **host-not-found**：名字解析不出来；
 * - **host-unreachable**：路由不通（不在同一网络、VPN 没连）；
 * - **cert-name-mismatch**：证书是这家部署的，但上面没有你填的这个地址；
 * - **tls-handshake**：TCP 连上了，安全连接没建起来就被断开 —— 这个端口不是 HTTPS，
 *   或者中间有防火墙 / 代理软件（常见的"全局代理 / TUN 模式"会接管局域网地址）把连接掐了。
 *
 * 只看错误码，不做额外探测：诊断本身不能再让人多等。
 */
import { CatalogHttpError } from './http'

export type NetProblemCode =
  | 'port-blocked'
  | 'port-closed'
  | 'host-not-found'
  | 'host-unreachable'
  | 'cert-name-mismatch'
  | 'tls-handshake'

export interface NetProblem {
  code: NetProblemCode
  /** 给文案用的对象：主机:端口，或"地址 ↔ 证书上的名字" */
  detail: string
}

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED'])
const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME'])
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN'])

function errnoOf(error: unknown): string {
  if (error instanceof CatalogHttpError) return error.errno ?? ''
  return String((error as { code?: unknown } | null)?.code ?? '')
}

/** target 是 "主机:端口"；证书名字对不上时要带上证书里的名字（从错误原文里取） */
export function diagnoseConnectError(error: unknown, target: string): NetProblem | null {
  const errno = errnoOf(error)
  const message = error instanceof Error ? error.message : String(error)
  const host = target.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (
    errno === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    /altnames|does not match certificate/i.test(message)
  ) {
    const names = /(?:cert's altnames|certificate's altnames):\s*(.+)$/i.exec(message)?.[1]
    return {
      code: 'cert-name-mismatch',
      detail: names ? `${host} ↔ ${names.replace(/(?:DNS|IP Address):/g, '').trim()}` : host
    }
  }
  if (errno === 'ECONNREFUSED') return { code: 'port-closed', detail: target }
  if (
    /disconnected before secure TLS connection|wrong version number|EPROTO/i.test(message) ||
    errno === 'EPROTO'
  )
    return { code: 'tls-handshake', detail: target }
  if (NOT_FOUND_CODES.has(errno)) return { code: 'host-not-found', detail: host }
  if (UNREACHABLE_CODES.has(errno)) return { code: 'host-unreachable', detail: target }
  if (
    TIMEOUT_CODES.has(errno) ||
    (error instanceof CatalogHttpError && error.code === 'timeout') ||
    /No TLS answer|No answer within/i.test(message)
  )
    return { code: 'port-blocked', detail: target }
  return null
}

/** 地址里的 "主机:端口"（没写端口时按协议补上），诊断文案里用 */
export function targetOf(url: string): string {
  try {
    const parsed = new URL(url)
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    return `${parsed.hostname}:${port}`
  } catch {
    return url
  }
}
