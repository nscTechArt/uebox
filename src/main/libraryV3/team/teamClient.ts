/**
 * 对团队服务成员面发一次请求，把 `{error, code}` 翻成带码的错误。
 *
 * 目录服务那边的 CatalogHttp.json 只认状态码（404 空体 = 路由不存在），而成员面的 409 有七种意思
 * （frozen / not-pending / asked-recently / name-taken …），界面要按 `code` 选文案（契约 1.2），
 * 所以这里读原始响应自己解。
 */
import { CatalogHttpError, type CatalogHttp } from '../http'
import type { TeamRoute } from './teamOps'

export class TeamApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null = null
  ) {
    super(message)
    this.name = 'TeamApiError'
  }
}

/** 状态码 → 契约 1.2 的码（服务端没给 code 时用） */
export function codeForStatus(status: number): string {
  if (status === 400) return 'bad-request'
  if (status === 401) return 'signed-out'
  if (status === 403) return 'not-allowed'
  if (status === 404) return 'not-found'
  if (status === 405 || status === 501) return 'not-implemented'
  if (status === 409) return 'conflict'
  if (status === 410) return 'invite-expired'
  if (status === 423) return 'archived'
  if (status === 502 || status === 503 || status === 504) return 'lore-unavailable'
  return 'server'
}

export function parseTeamFailure(status: number, body: Buffer): TeamApiError {
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>
  } catch {
    parsed = null
  }
  // 404 空体：这台服务端还没有这条路由（老版本团队服务）→ 当作「还没做」
  if (status === 404 && parsed === null)
    return new TeamApiError('not-implemented', status, 'route missing')
  const code =
    parsed && typeof parsed.code === 'string' && parsed.code ? parsed.code : codeForStatus(status)
  const message =
    parsed && typeof parsed.error === 'string' ? parsed.error : `HTTP ${status} (${code})`
  return new TeamApiError(code, status, message, parsed)
}

export async function teamRequest<T>(http: CatalogHttp, route: TeamRoute): Promise<T> {
  let response
  try {
    response = await http.raw(route.path, {
      method: route.method,
      query: route.query,
      body: route.body
    })
  } catch (error) {
    if (error instanceof CatalogHttpError) {
      const code = ['network', 'timeout', 'tls', 'unavailable'].includes(error.code)
        ? 'unreachable'
        : error.code === 'unauthorized'
          ? 'signed-out'
          : error.code
      throw new TeamApiError(code, error.status, error.message)
    }
    throw error
  }
  if (response.status >= 200 && response.status < 300) {
    if (response.body.length === 0) return {} as T
    try {
      return JSON.parse(response.body.toString('utf8')) as T
    } catch {
      throw new TeamApiError('server', response.status, 'invalid JSON')
    }
  }
  throw parseTeamFailure(response.status, response.body)
}
