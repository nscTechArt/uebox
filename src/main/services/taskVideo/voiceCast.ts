import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 项目的角色音色表：`<工程根>/.uebox/voices.json`，试听放在旁边的 `voices/` 里。
 *
 * 角色属于游戏，不属于盒子 —— 放进工程，跟着工程拷走、进版本库，换台机器还在
 * （AGENTS.md 第 5 节第 10 条）。和 `.uebox/skills`、`.uebox/experience` 同一个目录。
 *
 * 每个角色最多两条：`adopted` 是用户听过、点了同意的；`candidate` 是刚设计出来
 * 等用户试听的。配音只认 `adopted` —— 没被人认可的音色，AI 用不了。
 */

export interface VoiceCastEntry {
  voiceId: string
  /** 设计时绑的来源和模型。音色绑死在模型上，合成必须用这一对 */
  providerId: string
  modelId: string
  description: string
  previewText: string
  /** 试听 WAV 的绝对路径 */
  preview: string
  createdAt: string
}

export interface VoiceCastRole {
  adopted?: VoiceCastEntry
  candidate?: VoiceCastEntry
}

interface VoiceCastFile {
  version: 1
  roles: Record<string, VoiceCastRole>
}

/** 工程根 → `.uebox`。给的可以是 `.uproject` 路径，判据同 `projectSkillsDir` */
export function voiceCastDir(projectRoot?: string): string | undefined {
  if (!projectRoot) return undefined
  const root = projectRoot.toLowerCase().endsWith('.uproject') ? dirname(projectRoot) : projectRoot
  if (!root || basename(root) === '') return undefined
  return join(root, '.uebox')
}

export function normalizeRole(role: string): string {
  const name = role.trim()
  if (!name || Array.from(name).length > 40) throw new Error('角色名要 1 到 40 个字。')
  return name
}

export async function readVoiceCast(dir: string): Promise<Record<string, VoiceCastRole>> {
  let raw: string
  try {
    raw = await fs.readFile(join(dir, 'voices.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const file = JSON.parse(raw) as Partial<VoiceCastFile>
  return file.roles && typeof file.roles === 'object' ? file.roles : {}
}

export async function writeVoiceCast(
  dir: string,
  roles: Record<string, VoiceCastRole>
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, 'voices.json')
  const body: VoiceCastFile = { version: 1, roles }
  // 先写临时文件再改名：写到一半崩了，原来那份表还在
  await fs.writeFile(`${file}.tmp`, JSON.stringify(body, null, 2) + '\n')
  await fs.rename(`${file}.tmp`, file)
}

/** 试听文件名：角色名里文件系统不认的字符换掉，带上音色 ID 的尾巴免得重名覆盖 */
export function previewPath(dir: string, role: string, voiceId: string): string {
  const safe = role.replace(/[<>:"/\\|?*\s]+/g, '_')
  return join(dir, 'voices', `${safe}-${voiceId.slice(-8)}.wav`)
}
