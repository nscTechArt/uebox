import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fileNameForTool, type ExperienceEntry } from './experienceFile'
import { ExperienceStore } from './store'
import { readTrail, TrailWriter } from './trail'

const entry: ExperienceEntry = {
  id: 'e-1',
  title: 't',
  tool: 'ue_save',
  errorPattern: 'cannot save',
  advice: 'a',
  expect: {},
  source: '',
  status: 'trial'
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uebox-exp-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ExperienceStore 读改写', () => {
  it('读失败（不是文件不存在）时不当成空写回去', async () => {
    const store = new ExperienceStore(dir)
    // 用同名目录模拟「文件在但读不了」：readFile 报 EISDIR，而不是 ENOENT
    await mkdir(join(dir, fileNameForTool('ue_save')))
    await expect(store.updateTool('ue_save', (list) => list)).rejects.toThrow()
  })

  it('空层第一次写入也拍快照，撤销回到空', async () => {
    const store = new ExperienceStore(join(dir, 'fresh'))
    const id = await store.snapshot(new Date('2026-09-30T00:00:00.000Z'))
    await store.updateTool('ue_save', () => [entry])
    expect(await store.listSnapshots()).toEqual([id])
    await store.restore(id)
    expect(await store.readAll()).toEqual([])
  })
})

describe('原始账按 header 分段', () => {
  it('会话中途换了工程，后面的调用归新 header', async () => {
    const base = { sessionId: 's1', skillLearning: 'auto' as const }
    await new TrailWriter(dir, { ...base, projectRoot: 'D:/A', engineVersion: '5.5' }).record({
      agent: 'main',
      i: 0,
      tool: 'ue_save',
      ok: false,
      args: '{}'
    })
    await new TrailWriter(dir, { ...base, projectRoot: 'D:/B', engineVersion: '5.6' }).record({
      agent: 'main',
      i: 1,
      tool: 'ue_save',
      ok: true,
      args: '{}'
    })
    const trail = await readTrail(dir, 's1')
    expect(trail?.header.projectRoot).toBe('D:/A')
    expect(trail?.headers.map((h) => h.projectRoot)).toEqual(['D:/A', 'D:/B'])
  })
})
