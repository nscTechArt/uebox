/**
 * 和官网共享库通信。只在用户主动安装或分享时调用，地址从 endpoint.ts 拿。
 *
 * 安装不要账户；分享要账户：用设备授权领到的 API Key（`Authorization: Bearer`），服务端按 Key
 * 认出是哪个 UEBox 账户，技能就发布在这个账户名下。接口在 uebox-token-plan 的 share/routes.ts。
 *
 * 服务端返回的内容一律当作陌生人写的东西：先过 shareRules 的同一套检查再交给界面和磁盘，
 * 不信任服务端已经查过。
 */

import { SHARE_API } from './endpoint'
import { checkBundle, type ShareFile } from './shareRules'

const TIMEOUT_MS = 15_000
/** 256 KB 正文加上 JSON 转义和元数据的余量 */
const MAX_RESPONSE_BYTES = 600 * 1024

export interface SharedSkill {
  id: string
  description: string
  author: string
  version: number
  updatedAt: string
  installs: number
  files: ShareFile[]
}

export type ShareErrorCode = 'not-found' | 'network' | 'invalid' | 'not-connected' | 'rejected'

export class ShareError extends Error {
  constructor(
    message: string,
    readonly code: ShareErrorCode = 'network'
  ) {
    super(message)
  }
}

/** 发布被拒时服务端给的原因代号（error.param）→ 给用户看的话。没列到的用服务端原句 */
const REJECT_REASONS: Record<string, string> = {
  name_taken: '这个名字已经被别的账户用了。请改 SKILL.md 里的 name 后再分享。',
  file_not_allowed: '有不符合要求的文件：只能分享 SKILL.md 和 references/、assets/ 下的文本文件。',
  missing_skill_md: '缺少 SKILL.md。',
  no_frontmatter: 'SKILL.md 开头缺少 --- 包裹的 name 和 description。',
  bad_name: '技能名只能包含小写字母、数字和连字符，最长 64 个字符。',
  reserved_name: '技能名不能包含 anthropic 或 claude。',
  bad_description: 'description 不能为空，最长 1024 个字符，且不能包含尖括号。',
  too_large: '文件合计超过 256 KB。',
  too_many_files: '文件数超过 20 个。',
  bom: 'SKILL.md 带有 BOM，请保存为无 BOM 的 UTF-8。'
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
  if (res.status === 404)
    throw new ShareError(`共享技能库里没有 ${id}，它可能已经下架。`, 'not-found')
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
    throw new ShareError(
      `技能内容的名字 ${check.name} 与请求的 ${id} 不一致，已拒绝安装。`,
      'invalid'
    )
  }

  const author = data.author as { name?: unknown } | undefined
  return {
    id,
    description: check.description,
    author: str(author?.name),
    version: typeof data.version === 'number' ? data.version : 1,
    updatedAt: str(data.updated_at),
    installs: typeof data.installs === 'number' ? data.installs : 0,
    files
  }
}

export interface PublishResult {
  id: string
  version: number
  /** pending：新账户的第一份，等管理员看过才公开 */
  status: 'published' | 'pending'
  url: string
}

/** 以 apiKey 对应的账户发布（同名就是更新自己的那一份） */
export async function publishSharedSkill(
  apiKey: string,
  files: ShareFile[]
): Promise<PublishResult> {
  const res = await request('/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ files })
  })
  const data = await readJson(res).catch(() => ({}) as Record<string, unknown>)
  if (res.status === 401) {
    throw new ShareError('UEBox 账户的连接已失效，请重新连接后再分享。', 'not-connected')
  }
  if (!res.ok) {
    const err = (data.error ?? {}) as { param?: unknown; message?: unknown }
    const reason = REJECT_REASONS[str(err.param)]
    throw new ShareError(
      reason ?? (str(err.message) || `共享技能服务出错（HTTP ${res.status}）。`),
      'rejected'
    )
  }
  return {
    id: str(data.id),
    version: typeof data.version === 'number' ? data.version : 1,
    status: data.status === 'pending' ? 'pending' : 'published',
    url: str(data.url)
  }
}
