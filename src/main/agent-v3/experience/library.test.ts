import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ExperienceEntry } from './experienceFile'
import {
  deleteExperience,
  listExperiences,
  parseExperienceRef,
  setExperiencePinned,
  undoLastCuration
} from './library'
import { ExperienceStore, experienceDir } from './store'

const base: ExperienceEntry = {
  id: 'e-1',
  title: 't',
  tool: 'ue_save',
  errorPattern: 'file is read-only on disk',
  advice: '先签出',
  expect: { tool: 'ue_checkout' },
  source: '',
  status: 'trial'
}

let root: string
let home: string
let projectPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'exp-lib-'))
  home = join(root, 'home')
  projectPath = join(root, 'Game')
  await new ExperienceStore(experienceDir(projectPath)!).updateTool('ue_save', () => [base])
  await new ExperienceStore(home).updateTool('ue_run_python_script', () => [
    { ...base, id: 'e-g', tool: 'ue_run_python_script', engines: ['5.5'] }
  ])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const projects = (): { name: string; path: string }[] => [{ name: 'Game', path: projectPath }]

describe('experience library', () => {
  it('两层一起列出，工程层带上工程名', async () => {
    const { entries } = await listExperiences(home, projects())
    expect(entries.map((e) => [e.layer, e.id, e.projectName])).toEqual([
      ['global', 'e-g', undefined],
      ['project', 'e-1', 'Game']
    ])
  })

  it('固定保留、取消、删除都落到盘上', async () => {
    const ref = { layer: 'project' as const, projectPath, tool: 'ue_save', id: 'e-1' }
    expect(await setExperiencePinned(home, projects(), ref, true)).toBe(true)
    expect((await listExperiences(home, projects())).entries[1].pinned).toBe(true)
    await setExperiencePinned(home, projects(), ref, false)
    expect((await listExperiences(home, projects())).entries[1].pinned).toBeUndefined()

    expect(await deleteExperience(home, projects(), ref)).toBe(true)
    expect((await listExperiences(home, projects())).entries).toHaveLength(1)
  })

  it('不在项目库里的工程路径不认', async () => {
    const ref = {
      layer: 'project' as const,
      projectPath: join(root, 'Other'),
      tool: 'ue_save',
      id: 'e-1'
    }
    expect(await deleteExperience(home, projects(), ref)).toBe(false)
    expect(parseExperienceRef({ layer: 'project', tool: 'ue_save', id: 'e-1' })).toBeUndefined()
    expect(parseExperienceRef({ layer: 'x', tool: 'a', id: 'b' })).toBeUndefined()
  })

  it('撤销上次整理：同一次整理的两层一起回去，摘要说清加了几条、淘汰了几条', async () => {
    const project = new ExperienceStore(experienceDir(projectPath)!)
    const global = new ExperienceStore(home)
    const at = new Date('2026-09-30T14:02:11.123Z')
    await project.snapshot(at)
    await global.snapshot(at)
    // 那次整理：工程层淘汰一条、加一条；通用层加一条
    await project.updateTool('ue_save', (list) => [
      ...list.map((e) => ({ ...e, status: 'retired' as const })),
      { ...base, id: 'e-new' }
    ])
    await global.updateTool('ue_save', () => [{ ...base, id: 'e-g2' }])

    const { lastCuration } = await listExperiences(home, projects())
    expect(lastCuration).toEqual({
      id: '2026-09-30T14-02-11-123Z',
      at: at.toISOString(),
      added: 2,
      retired: 1
    })

    await undoLastCuration(home, projects())
    const after = await listExperiences(home, projects())
    expect(after.entries.map((e) => e.id).sort()).toEqual(['e-1', 'e-g'])
    expect(after.entries.find((e) => e.id === 'e-1')?.status).toBe('trial')
    // 用过的快照删掉了，没有更早的就不再提供撤销
    expect(after.lastCuration).toBeUndefined()
  })
})
