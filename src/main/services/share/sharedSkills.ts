/**
 * 共享技能在本机的那一半：装进用户技能目录、把自己的技能打成共享包、记住署名和修改码。
 *
 * ## 装到哪
 *
 * 只装用户技能目录（所有工程可用）。工程技能目录（`<工程>/.uebox/skills`）目前在技能页里
 * 看不到、也删不掉，装进去用户就管不了它了。
 *
 * ## 怎么认出「这是从共享库装的」
 *
 * 技能文件夹里放一个 `.share.json`（id、版本、作者）。加载器只读 SKILL.md、子资源只开放
 * references/scripts/assets 三个目录，所以模型看不到这个文件；技能页靠它显示来源和版本。
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { app } from 'electron'

import {
  discoverSkillsOnDisk,
  isUserSkillPath,
  userSkillsDir
} from '../../agent-v3/capabilities/skills'
import { isShareablePath, MAX_FILES, type ShareFile } from './shareRules'
import type { SharedSkill } from './shareClient'
import type { SharedSkillConflict, SharedSkillOrigin } from '../../../shared/share'
import type { SkillMetadata } from '../../agent-v3/capabilities/skillsService/SkillsService'

export const SHARE_META_FILE = '.share.json'

export interface ShareMeta {
  id: string
  version: number
  author: string
  installedAt: string
}

export async function readShareMeta(skillDir: string): Promise<ShareMeta | null> {
  try {
    const data = JSON.parse(await readFile(join(skillDir, SHARE_META_FILE), 'utf8')) as ShareMeta
    return typeof data.id === 'string' && typeof data.version === 'number' ? data : null
  } catch {
    return null
  }
}

/**
 * 装之前本机已有的同名技能。确认框据此提示「更新」还是「覆盖」：
 * - `update`：之前从共享库装过这一个
 * - `own`：用户目录里有一份同名的，不是从共享库来的（可能是他自己写的）
 * - `builtin`：内置或插件带的同名技能，装上之后会用共享的这份代替它
 */
export type InstallConflict = SharedSkillConflict

export async function findInstallConflict(id: string): Promise<InstallConflict> {
  const existing = (await discoverSkillsOnDisk()).filter((s) => s.name === id)
  const user = existing.find((s) => isUserSkillPath(s.path))
  if (user) {
    const meta = await readShareMeta(user.path)
    return meta && meta.id === id ? { kind: 'update', fromVersion: meta.version } : { kind: 'own' }
  }
  return existing.length > 0 ? { kind: 'builtin' } : { kind: 'none' }
}

function insideUserSkills(target: string): boolean {
  const root = resolve(userSkillsDir())
  const full = resolve(target)
  return full !== root && full.startsWith(root + sep)
}

/**
 * 把共享技能写进用户技能目录。
 *
 * 先写到旁边的临时目录，写完再换掉旧的：中途失败不会留下半个技能，更新时旧版本里
 * 有、新版本删掉的文件也不会残留。
 */
export async function installSharedSkill(skill: SharedSkill): Promise<{ path: string }> {
  const existing = (await discoverSkillsOnDisk()).find(
    (s) => s.name === skill.id && isUserSkillPath(s.path)
  )
  const target = existing?.path ?? join(userSkillsDir(), skill.id)
  // 临时目录放在技能目录外面：万一残留，也不会被当成一个技能扫出来
  const staging = join(app.getPath('userData'), 'share', 'staging', skill.id)
  if (!insideUserSkills(target)) {
    throw new Error(`技能 ${skill.id} 的安装路径超出了用户技能目录。`)
  }

  await rm(staging, { recursive: true, force: true })
  try {
    for (const file of skill.files) {
      // 路径已经过 isShareablePath（只有 SKILL.md 和两个子目录下一层），这里再兜一次
      const out = join(staging, file.path)
      if (!resolve(out).startsWith(resolve(staging) + sep))
        throw new Error(`非法路径：${file.path}`)
      await mkdir(join(out, '..'), { recursive: true })
      await writeFile(out, file.content, 'utf8')
    }
    const meta: ShareMeta = {
      id: skill.id,
      version: skill.version,
      author: skill.author,
      installedAt: new Date().toISOString()
    }
    await writeFile(join(staging, SHARE_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    await rm(target, { recursive: true, force: true })
    // 新装的盒子还没有用户技能目录，rename 不会替你建父目录
    await mkdir(join(target, '..'), { recursive: true })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return { path: target }
}

/** 技能页的来源标记：用户目录里哪些技能是从共享库装的 */
export async function sharedSkillOrigins(
  skills: readonly SkillMetadata[]
): Promise<Map<string, SharedSkillOrigin>> {
  const out = new Map<string, SharedSkillOrigin>()
  await Promise.all(
    skills
      .filter((s) => isUserSkillPath(s.path))
      .map(async (s) => {
        const meta = await readShareMeta(s.path)
        if (meta && meta.id === s.name)
          out.set(s.name, { version: meta.version, author: meta.author })
      })
  )
  return out
}

// ── 分享 ────────────────────────────────────────────────────────────────

export interface PackedSkill {
  name: string
  files: ShareFile[]
  /** 不符合共享要求、没有打进包里的文件（相对路径），界面上要列给用户看 */
  skipped: string[]
}

export class PackError extends Error {}

/**
 * 把用户目录里的一个技能打成共享包。只收 SKILL.md 和 references/、assets/ 下一层的文本文件，
 * 其余文件列进 skipped。内置和插件带的技能不能分享 —— 那不是用户写的。
 */
export async function packUserSkill(name: string): Promise<PackedSkill> {
  const skill = (await discoverSkillsOnDisk()).find((s) => s.name === name)
  if (!skill || !isUserSkillPath(skill.path)) {
    throw new PackError(`只能分享你自己的技能，${name} 是内置或插件带的技能。`)
  }

  const meta = await readShareMeta(skill.path)
  if (meta && !(await readShareState()).published.includes(meta.id)) {
    throw new PackError(
      `${name} 是从共享库安装的技能，作者是 ${meta.author}，不能以你的名义再次分享。`
    )
  }

  const files: ShareFile[] = []
  const skipped: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (path === SHARE_META_FILE) continue
      if (entry.isDirectory()) {
        // 只往下看一层：允许的文件只在 references/ 和 assets/ 下一层
        if (!rel) await walk(join(dir, entry.name), path)
        else skipped.push(`${path}/`)
        continue
      }
      if (isShareablePath(path) && files.length < MAX_FILES) {
        files.push({ path, content: await readFile(join(dir, entry.name), 'utf8') })
      } else skipped.push(path)
    }
  }
  await walk(skill.path, '')
  return { name, files, skipped }
}

// ── 分享过哪些 ─────────────────────────────────────────────────────────

/**
 * 记在 `<userData>/share/state.json`：这台机器以自己账户分享过的技能名。
 *
 * 只用来放行一种情况：自己分享过、又从共享库装回来的技能（文件夹里有 .share.json），
 * 还可以继续更新。真正的归属由服务端按账户判断（名字被别的账户占了会被拒），这里只是少拦一次。
 */
export interface ShareState {
  published: string[]
}

const statePath = (): string => join(app.getPath('userData'), 'share', 'state.json')

export async function readShareState(): Promise<ShareState> {
  try {
    const data = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<ShareState>
    return {
      published: Array.isArray(data.published)
        ? data.published.filter((x): x is string => typeof x === 'string')
        : []
    }
  } catch {
    return { published: [] }
  }
}

export async function rememberPublished(id: string): Promise<void> {
  const state = await readShareState()
  if (state.published.includes(id)) return
  await mkdir(join(statePath(), '..'), { recursive: true })
  await writeFile(
    statePath(),
    JSON.stringify({ published: [...state.published, id] }, null, 2),
    'utf8'
  )
}
