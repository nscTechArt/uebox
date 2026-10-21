import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'uebox-shared-skills-'))

vi.mock('electron', () => ({
  app: {
    getPath: (): string => root,
    getAppPath: (): string => root,
    isPackaged: false
  }
}))
vi.mock('../../agent-v3/capabilities/plugins/registry', () => ({
  enabledPluginSkillDirs: async (): Promise<string[]> => []
}))

import {
  findInstallConflict,
  installSharedSkill,
  packUserSkill,
  readShareMeta,
  sharedSkillOrigins,
  rememberPublished
} from './sharedSkills'
import { discoverSkillsOnDisk } from '../../agent-v3/capabilities/skills'
import type { SharedSkill } from './shareClient'

const userDir = join(root, 'skills')
const builtinDir = join(root, 'resources', 'skills')

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: Does ${name}. Use when needed.\n---\n\nBody of ${name}\n`

function shared(id: string, version: number, extra: SharedSkill['files'] = []): SharedSkill {
  return {
    id,
    description: `Does ${id}.`,
    author: '作者甲',
    version,
    updatedAt: '2026-10-21T00:00:00.000Z',
    installs: 0,
    files: [{ path: 'SKILL.md', content: skillMd(id) }, ...extra]
  }
}

function writeSkill(dir: string, name: string, files: Record<string, string> = {}): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), skillMd(name))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, path, '..'), { recursive: true })
    writeFileSync(join(dir, name, path), content)
  }
}

beforeEach(() => {
  rmSync(userDir, { recursive: true, force: true })
  rmSync(builtinDir, { recursive: true, force: true })
  rmSync(join(root, 'share'), { recursive: true, force: true })
  mkdirSync(userDir, { recursive: true })
  mkdirSync(builtinDir, { recursive: true })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('installSharedSkill', () => {
  it('装进用户技能目录，带上来源标记，能被发现', async () => {
    await installSharedSkill(
      shared('rename-assets', 1, [{ path: 'references/a.md', content: 'A' }])
    )

    const dir = join(userDir, 'rename-assets')
    expect(readFileSync(join(dir, 'references', 'a.md'), 'utf8')).toBe('A')
    expect(await readShareMeta(dir)).toMatchObject({
      id: 'rename-assets',
      version: 1,
      author: '作者甲'
    })
    expect((await discoverSkillsOnDisk()).map((s) => s.name)).toContain('rename-assets')
    // 临时目录不在技能目录里，也不会残留
    expect(existsSync(join(root, 'share', 'staging', 'rename-assets'))).toBe(false)
  })

  it('新装的盒子还没有用户技能目录也能装', async () => {
    rmSync(userDir, { recursive: true, force: true })
    await installSharedSkill(shared('rename-assets', 1))
    expect(existsSync(join(userDir, 'rename-assets', 'SKILL.md'))).toBe(true)
  })

  it('更新时整份替换：新版删掉的文件不残留', async () => {
    await installSharedSkill(
      shared('rename-assets', 1, [{ path: 'references/old.md', content: 'old' }])
    )
    await installSharedSkill(
      shared('rename-assets', 2, [{ path: 'references/new.md', content: 'new' }])
    )

    const dir = join(userDir, 'rename-assets')
    expect(existsSync(join(dir, 'references', 'old.md'))).toBe(false)
    expect(readFileSync(join(dir, 'references', 'new.md'), 'utf8')).toBe('new')
    expect((await readShareMeta(dir))?.version).toBe(2)
  })
})

describe('findInstallConflict', () => {
  it('分得清：没有、更新、自己写的同名、内置同名', async () => {
    expect(await findInstallConflict('rename-assets')).toEqual({ kind: 'none' })

    await installSharedSkill(shared('rename-assets', 3))
    expect(await findInstallConflict('rename-assets')).toEqual({ kind: 'update', fromVersion: 3 })

    writeSkill(userDir, 'my-own')
    expect(await findInstallConflict('my-own')).toEqual({ kind: 'own' })

    writeSkill(builtinDir, 'ue-level-organize')
    expect(await findInstallConflict('ue-level-organize')).toEqual({ kind: 'builtin' })
  })
})

describe('sharedSkillOrigins', () => {
  it('只标出从共享库装的用户技能', async () => {
    await installSharedSkill(shared('rename-assets', 2))
    writeSkill(userDir, 'my-own')
    const origins = await sharedSkillOrigins(await discoverSkillsOnDisk())
    expect([...origins.entries()]).toEqual([['rename-assets', { version: 2, author: '作者甲' }]])
  })
})

describe('packUserSkill', () => {
  it('只打包允许的文本文件，其余列进 skipped', async () => {
    writeSkill(userDir, 'my-own', {
      'references/a.md': 'A',
      'assets/b.json': '{}',
      'scripts/run.py': 'print(1)',
      'notes.txt': 'x'
    })
    const pack = await packUserSkill('my-own')
    expect(pack.files.map((f) => f.path).sort()).toEqual([
      'SKILL.md',
      'assets/b.json',
      'references/a.md'
    ])
    expect(pack.skipped.sort()).toEqual(['notes.txt', 'scripts/run.py'])
  })

  it('内置技能不能分享', async () => {
    writeSkill(builtinDir, 'ue-level-organize')
    await expect(packUserSkill('ue-level-organize')).rejects.toThrow(/只能分享你自己的技能/)
  })

  it('别人分享的技能不能以自己的名义再分享；自己分享过的可以', async () => {
    await installSharedSkill(shared('rename-assets', 1))
    await expect(packUserSkill('rename-assets')).rejects.toThrow(/从共享库安装/)

    await rememberPublished('rename-assets')
    const pack = await packUserSkill('rename-assets')
    // 来源标记文件不进共享包
    expect(pack.files.map((f) => f.path)).toEqual(['SKILL.md'])
  })
})
