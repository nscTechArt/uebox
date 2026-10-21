/**
 * 共享技能的内容规则。官网服务端收稿时查一遍（uebox-website/server/share/rules.mjs），
 * 盒子装之前、分享之前再各查一遍 —— 三处规则必须一致，改一处记得同步另外两处。
 *
 * 为什么只收纯文本、不收 scripts/：技能是给 Agent 的指令，装的人要能读懂全文才能判断
 * 要不要装。一段 .py 夹在里面，审核和用户都很难一眼看出它会做什么。
 */

import { SHARE_HOST } from './endpoint'

export const MAX_FILES = 20
export const MAX_TOTAL_BYTES = 256 * 1024
export const ALLOWED_DIRS = ['references', 'assets'] as const
export const ALLOWED_EXT = ['.md', '.txt', '.json', '.yaml', '.yml', '.csv'] as const
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface ShareFile {
  path: string
  content: string
}

export type BundleCheck =
  | { ok: true; name: string; description: string }
  | { ok: false; error: string }

/** 这个相对路径能不能进共享包。只看路径，不看内容 */
export function isShareablePath(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  if (p === 'SKILL.md') return true
  const parts = p.split('/')
  if (parts.length !== 2) return false
  const [dir, file] = parts
  if (!(ALLOWED_DIRS as readonly string[]).includes(dir) || !file || file.startsWith('.'))
    return false
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  return (ALLOWED_EXT as readonly string[]).includes(ext)
}

function frontmatter(text: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return null
  const out: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export function checkBundle(files: readonly ShareFile[]): BundleCheck {
  if (files.length === 0) return { ok: false, error: '共享包里没有文件。' }
  if (files.length > MAX_FILES) return { ok: false, error: `文件数超过上限 ${MAX_FILES} 个。` }

  let total = 0
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.path)) return { ok: false, error: `文件重复：${file.path}` }
    seen.add(file.path)
    if (!isShareablePath(file.path)) {
      return {
        ok: false,
        error: `不支持的文件：${file.path}。只能包含 SKILL.md 和 references/、assets/ 下的文本文件。`
      }
    }
    total += Buffer.byteLength(file.content, 'utf8')
  }
  if (total > MAX_TOTAL_BYTES) return { ok: false, error: '文件合计超过 256 KB。' }

  const main = files.find((f) => f.path === 'SKILL.md')
  if (!main) return { ok: false, error: '缺少 SKILL.md。' }
  if (main.content.charCodeAt(0) === 0xfeff) {
    return { ok: false, error: 'SKILL.md 带有 BOM，请保存为无 BOM 的 UTF-8。' }
  }
  const fm = frontmatter(main.content)
  if (!fm) return { ok: false, error: 'SKILL.md 开头缺少 --- 包裹的 name 和 description。' }
  const name = fm.name ?? ''
  const description = fm.description ?? ''
  if (!NAME_RE.test(name) || name.length > 64) {
    return { ok: false, error: '技能名只能包含小写字母、数字和连字符，最长 64 个字符。' }
  }
  if (/anthropic|claude/.test(name)) {
    return { ok: false, error: '技能名不能包含 anthropic 或 claude。' }
  }
  if (!description || description.length > 1024 || /[<>]/.test(description)) {
    return { ok: false, error: 'description 不能为空，最长 1024 个字符，且不能包含尖括号。' }
  }
  return { ok: true, name, description }
}

/**
 * 从用户给的东西里认出技能 id。认得这几种写法：
 *   ue-level-organize
 *   uebox.ai/s/ue-level-organize（带不带 https://、www.、末尾斜杠都行）
 *   unrealbox://install-skill?id=ue-level-organize
 * 认不出返回 null —— 不去猜，也不请求别的网址。
 */
export function parseShareRef(raw: string): string | null {
  const ref = raw.trim()
  if (NAME_RE.test(ref) && ref.length <= 64) return ref

  const deep = /^unrealbox:\/\/install-skill\/?\?(.*)$/i.exec(ref)
  if (deep) {
    const id = new URLSearchParams(deep[1]).get('id') ?? ''
    return NAME_RE.test(id) && id.length <= 64 ? id : null
  }

  const host = SHARE_HOST.replace(/\./g, '\\.')
  const page = new RegExp(`^(?:https?://)?(?:www\\.)?${host}(?:/en)?/s/([a-z0-9-]+)/?$`, 'i').exec(
    ref
  )
  if (page && NAME_RE.test(page[1]) && page[1].length <= 64) return page[1]
  return null
}
