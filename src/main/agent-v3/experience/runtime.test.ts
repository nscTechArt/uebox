import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ExperienceEntry } from './experienceFile'
import { createExperienceRuntime, type ExperienceRuntime, type ToolCallReport } from './runtime'
import { ExperienceStore } from './store'
import { readTrail, TrailWriter } from './trail'

const PY_ERROR =
  "ue_run_python_script 失败：Traceback (most recent call last): File \"<ua-script>\", line 5, in <module> AttributeError: 'Character' object has no attribute 'is_hidden'"

const entry: ExperienceEntry = {
  id: 'e-hidden',
  title: '角色没有 is_hidden',
  tool: 'ue_run_python_script',
  errorPattern: "has no attribute 'is_hidden'",
  advice: '用 is_hidden_ed()',
  expect: { param: 'script' },
  source: 'test',
  status: 'trial'
}

let root: string
let store: ExperienceStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'exp-runtime-'))
  store = new ExperienceStore(join(root, 'experience'))
  await store.updateTool(entry.tool, () => [entry])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function runtime(
  random: number,
  trail?: TrailWriter,
  layers: { global?: ExperienceStore; engine?: string; projectKey?: string } = {}
): ExperienceRuntime {
  return createExperienceRuntime({
    project: store,
    projectKey: layers.projectKey ?? 'p1',
    ...(layers.global ? { global: layers.global } : {}),
    ...(layers.engine ? { engine: layers.engine } : {}),
    agentId: 's1',
    isLearnableTool: (tool) => tool.startsWith('ue_'),
    random: () => random,
    ...(trail ? { trail } : {})
  })
}

describe('experience runtime', () => {
  it('报错对得上就挂经验；照着做了并且成了，记一次采纳成功', async () => {
    const rt = runtime(0.99)
    const note = await rt.after({
      tool: entry.tool,
      args: { script: 'a.is_hidden' },
      isError: true,
      text: PY_ERROR
    })
    expect(note).toContain('用 is_hidden_ed()')
    expect(note).toContain('may be outdated')

    await rt.after({
      tool: entry.tool,
      args: { script: 'a.is_hidden_ed()' },
      isError: false,
      text: 'ok'
    })
    await rt.flush()
    const stats = await store.statsFor(entry.id)
    expect(stats).toMatchObject({ shown: 1, shownOk: 1, adopted: 1, adoptedOk: 1 })
  })

  it('落进对照组时不挂经验，但照样记下随后成没成', async () => {
    const rt = runtime(0.01)
    expect(
      await rt.after({ tool: entry.tool, args: { script: 'x' }, isError: true, text: PY_ERROR })
    ).toBeUndefined()
    await rt.after({ tool: entry.tool, args: { script: 'y' }, isError: false, text: 'ok' })
    await rt.flush()
    expect(await store.statsFor(entry.id)).toMatchObject({ holdout: 1, holdoutOk: 1, shown: 0 })
  })

  it('环境类报错、非引擎工具、对不上的报错都不挂', async () => {
    const rt = runtime(0.99)
    expect(
      await rt.after({ tool: entry.tool, args: {}, isError: true, text: `请求超时 ${PY_ERROR}` })
    ).toBeUndefined()
    expect(
      await rt.after({ tool: 'read_local_file', args: {}, isError: true, text: PY_ERROR })
    ).toBeUndefined()
    expect(
      await rt.after({
        tool: entry.tool,
        args: {},
        isError: true,
        text: 'AttributeError: no attribute foo'
      })
    ).toBeUndefined()
  })

  it('照着做了还是同一个错，两次之后这条经验在盘上被标成退休', async () => {
    const rt = runtime(0.99)
    for (let i = 0; i < 2; i++) {
      await rt.after({ tool: entry.tool, args: { script: `v${i}` }, isError: true, text: PY_ERROR })
      await rt.after({ tool: entry.tool, args: { script: `w${i}` }, isError: true, text: PY_ERROR })
      await rt.flush()
    }
    expect((await store.readTool(entry.tool))[0].status).toBe('retired')
  })

  it('原始账只记引擎工具，报错归一化，出场的经验 id 也记下', async () => {
    const trailDir = join(root, 'trail')
    const trail = new TrailWriter(trailDir, {
      sessionId: 's1',
      projectRoot: root,
      skillLearning: 'ask'
    })
    const rt = runtime(0.99, trail)
    await rt.after({ tool: entry.tool, args: { script: 'x' }, isError: true, text: PY_ERROR })
    await rt.after({ tool: 'read_local_file', args: {}, isError: false, text: '' })
    await rt.flush()

    const read = await readTrail(trailDir, 's1')
    expect(read?.calls).toHaveLength(1)
    expect(read?.calls[0]).toMatchObject({
      agent: 's1',
      tool: entry.tool,
      ok: false,
      error: "attributeerror: 'character' object has no attribute 'is_hidden'",
      shown: [entry.id]
    })
  })
})

describe('两层经验', () => {
  const generalEntry: ExperienceEntry = {
    ...entry,
    id: 'e-general',
    advice: '通用做法：先 dir() 看有哪些属性',
    engines: ['5.5']
  }
  let global: ExperienceStore

  beforeEach(async () => {
    global = new ExperienceStore(join(root, 'global'))
    await global.updateTool(entry.tool, () => [generalEntry])
  })

  const fail = (script: string): ToolCallReport => ({
    tool: entry.tool,
    args: { script },
    isError: true,
    text: PY_ERROR
  })
  const pass = (script: string): ToolCallReport => ({
    tool: entry.tool,
    args: { script },
    isError: false,
    text: 'ok'
  })

  it('两层一起查，本工程的排前面；跨版本的通用经验注明没在这个版本上验证过', async () => {
    const rt = runtime(0.99, undefined, { global, engine: '5.6' })
    const note = (await rt.after(fail('a')))!
    expect(note.indexOf('用 is_hidden_ed()')).toBeLessThan(note.indexOf('通用做法'))
    expect(note).toContain('not yet confirmed on UE 5.6')
  })

  it('通用经验在新版本上照着做并且成了：这个版本加进适用列表', async () => {
    await store.updateTool(entry.tool, () => [])
    const rt = runtime(0.99, undefined, { global, engine: '5.6' })
    await rt.after(fail('a'))
    await rt.after(pass('b'))
    await rt.flush()
    expect((await global.readTool(entry.tool))[0].engines).toEqual(['5.5', '5.6'])
  })

  it('没验证过的版本上照着做了还是同一个错：记成这个版本不适用，不扣它的分，也不再出场', async () => {
    await store.updateTool(entry.tool, () => [])
    const rt = runtime(0.99, undefined, { global, engine: '5.7' })
    await rt.after(fail('a'))
    await rt.after(fail('b'))
    await rt.flush()

    const [saved] = await global.readTool(entry.tool)
    expect(saved.notFor).toEqual(['5.7'])
    expect(saved.status).toBe('trial')
    expect(await global.statsFor(saved.id)).toMatchObject({ adopted: 1, adoptedFail: 0 })
    expect(
      await runtime(0.99, undefined, { global, engine: '5.7' }).after(fail('c'))
    ).toBeUndefined()
  })

  it('工程经验在两个工程里都转正，自动升为通用', async () => {
    const empty = new ExperienceStore(join(root, 'global-empty'))
    for (const projectKey of ['p1', 'p2']) {
      // 同一个目录模拟两个工程：每轮重置成一条试用经验
      await store.updateTool(entry.tool, () => [{ ...entry, status: 'trial' }])
      await store.updateLedger(() => ({}))
      const rt = runtime(0.99, undefined, { global: empty, engine: '5.5', projectKey })
      for (let i = 0; i < 3; i++) {
        await rt.after(fail(`x${i}`))
        await rt.after(pass(`y${i}`))
        await rt.flush()
      }
      expect((await store.readTool(entry.tool))[0].status).toBe('proven')
      expect(await empty.readTool(entry.tool)).toHaveLength(projectKey === 'p1' ? 0 : 1)
    }
    const promoted = await empty.readTool(entry.tool)
    expect(promoted).toHaveLength(1)
    expect(promoted[0]).toMatchObject({
      status: 'proven',
      engines: ['5.5'],
      source: 'proven in 2 projects'
    })
  })
})
