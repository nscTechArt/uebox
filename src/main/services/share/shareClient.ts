/**
 * 和官网共享库通信。只在用户主动安装或分享时调用，地址从 endpoint.ts 拿。
 *
 * 服务端返回的内容一律当作陌生人写的东西：先过 shareRules 的同一套检查再交给界面和磁盘，
 * 不信任服务端已经查过。
 */

import { SHARE_API, submissionStatusUrl } from './endpoint'
import { checkBundle, type ShareFile } from './shareRules'

const TIMEOUT_MS = 15_000
/** 256 KB 正文加上 JSON 转义和元数据的余量 */
const MAX_RESPONSE_BYTES = 600 * 1024

export interface SharedSkill {
  id: string
  description: string
  author: string
  authorLink: string
  version: number
  updatedAt: string
  installs: number
  files: ShareFile[]
}

export class ShareError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'network' | 'invalid' | 'name-taken' | 'rejected' = 'network'
  ) {
    super(message)
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new ShareError('服务器返回的内容过大。', 'invalid')
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new ShareError('服务器返回的内容无法解析。', 'invalid')
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${SHARE_API}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    throw new ShareError(`无法连接共享技能服务：${(error as Error).message}`)
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 取一个技能的完整内容（安装用）。服务端按这个请求计安装次数 */
export async function fetchSharedSkill(id: string): Promise<SharedSkill> {
  const res = await request(`/skills/${encodeURIComponent(id)}/bundle`)
  if (res.status === 404) throw new ShareError(`共享技能库里没有 ${id}，它可能已经下架。`, 'not-found')
  if (!res.ok) throw new ShareError(`共享技能服务出错（HTTP ${res.status}）。`)
  const data = await readJson(res)

  const files: ShareFile[] = Array.isArray(data.files)
    ? data.files.map((f: { path?: unknown; content?: unknown }) => ({
        path: str(f?.path),
        content: str(f?.content)
      }))
    : []
  const check = checkBundle(files)
  if (!check.ok) throw new ShareError(`技能内容不符合要求，已拒绝安装：${check.error}`, 'invalid')
  if (check.name !== id) {
    throw new ShareError(`技能内容的名字 ${check.name} 与请求的 ${id} 不一致，已拒绝安装。`, 'invalid')
  }

  return {
    id,
    description: check.description,
    author: str(data.author),
    authorLink: str(data.authorLink),
    version: typeof data.version === 'number' ? data.version : 1,
    updatedAt: str(data.updatedAt),
    installs: typeof data.installs === 'number' ? data.installs : 0,
    files
  }
}

export interface SubmitInput {
  author: string
  authorLink?: string
  note?: string
  editKey?: string
  files: ShareFile[]
}

export interface SubmitResult {
  sid: string
  id: string
  editKey: string
  statusUrl: string
}

export async function submitSharedSkill(input: SubmitInput): Promise<SubmitResult> {
  const res = await request('/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  const data = await readJson(res).catch(() => ({}) as Record<string, unknown>)
  if (!res.ok) {
    const message = str(data.error) || `共享技能服务出错（HTTP ${res.status}）。`
    throw new ShareError(message, data.code === 'name-taken' ? 'name-taken' : 'rejected')
  }
  const sid = str(data.sid)
  return { sid, id: str(data.id), editKey: str(data.editKey), statusUrl: submissionStatusUrl(sid) }
}
