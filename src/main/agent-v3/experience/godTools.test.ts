/**
 * 上帝工具（Python、控制台命令）的学法：API 钥匙、脚本改了哪一行、执行前提醒。
 */

import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { avoidFromDiff, curateSession, preferFromDiff, scriptDiff } from './curator'
import { normalizeError } from './errorSignature'
import type { ExperienceEntry } from './experienceFile'
import { findAvoided, formatPrecheck } from './precheck'
import { buildProbeScript, probeTarget, readProbeVerdict, type ProbeVerdict } from './probe'
import { matchEntries, type LayeredEntry } from './recall'
import { createExperienceRuntime } from './runtime'
import { consoleSymbol, pythonSymbol } from './specificity'
import { ExperienceStore, experienceDir } from './store'
import type { TrailCall, TrailHeader } from './trail'

const py = (exception: string): string =>
  normalizeError(
    `ue_run_python_script 失败：Traceback (most recent call last): File "<ua-script>", line 5, in <module> ${exception}`
  )
const HIDDEN = py("AttributeError: 'Character' object has no attribute 'is_hidden'")

describe('API 钥匙', () => {
  it('从真实报错的几种形状里认出说的是哪个 API', () => {
    expect(pythonSymbol(HIDDEN)).toBe('character.is_hidden')
    expect(
      pythonSymbol(py("AttributeError: module 'unreal' has no attribute 'LevelEditorPlaySettings'"))
    ).toBe('unreal.leveleditorplaysettings')
    expect(
      pythonSymbol(
        py(
          "TypeError: AssetRegistry: Failed to convert parameter 'class_path_name' when calling function 'AssetRegistry.GetAssetsByClass' on 'AssetRegistryImpl_0'"
        )
      )
    ).toBe('assetregistry.getassetsbyclass(class_path_name)')
    expect(
      pythonSymbol(
        py("TypeError: get_preview_mesh() required argument 'source_or_target' (pos 1) not found")
      )
    ).toBe('get_preview_mesh(source_or_target)')
    expect(
      pythonSymbol(
        py("Exception: Material: Failed to find property 'used_with_landscape' for attribute 'x'")
      )
    ).toBe('material.used_with_landscape')
    expect(pythonSymbol(py('TypeError: must be real number, not NoneType'))).toBeUndefined()
    expect(consoleSymbol('  r.ScreenPercentage 50')).toBe('r.screenpercentage')
  })

  it('召回：说的不是同一个 API，片段再像也不出场', () => {
    const entry: LayeredEntry = {
      id: 'e',
      title: 't',
      tool: 'ue_run_python_script',
      errorPattern: "object has no attribute 'is_hidden'",
      advice: 'a',
      expect: { param: 'script' },
      source: '',
      status: 'trial',
      layer: 'global',
      symbol: 'character.is_hidden'
    }
    const pawn = py("AttributeError: 'Pawn' object has no attribute 'is_hidden'")
    expect(
      matchEntries([entry], entry.tool, HIDDEN, undefined, 'character.is_hidden')
    ).toHaveLength(1)
    expect(matchEntries([entry], entry.tool, pawn, undefined, 'pawn.is_hidden')).toEqual([])
  })
})

describe('脚本改了哪一行', () => {
  const before = 'import unreal\nactor = get()\nif actor.is_hidden:\n    print(1)\n'
  const after = 'import unreal\nactor = get()\nif actor.is_hidden_ed():\n    print(1)\n'

  it('行级比对只留改动的行', () => {
    expect(scriptDiff(before, after)).toEqual({
      removed: ['if actor.is_hidden:'],
      added: ['if actor.is_hidden_ed():']
    })
  })

  it('错误写法：失败那次删掉、成功那次没有；`.is_hidden` 不会误认 `.is_hidden_ed`', () => {
    expect(avoidFromDiff('character.is_hidden', scriptDiff(before, after))).toBe('.is_hidden')
    // 改的是别处：抽不出来，就不做执行前提醒
    expect(
      avoidFromDiff('character.is_hidden', scriptDiff('a.is_hidden\nx = 1', 'a.is_hidden\nx = 2'))
    ).toBeUndefined()
    expect(
      avoidFromDiff('get_preview_mesh(source_or_target)', scriptDiff(before, after))
    ).toBeUndefined()
  })
})

describe('执行前提醒', () => {
  const proven: LayeredEntry = {
    id: 'e-hidden',
    title: '角色没有 is_hidden',
    tool: 'ue_run_python_script',
    errorPattern: "object has no attribute 'is_hidden'",
    advice: '改用 is_hidden_ed()',
    expect: { param: 'script' },
    source: '',
    status: 'proven',
    layer: 'global',
    symbol: 'character.is_hidden',
    avoid: '.is_hidden',
    engines: ['5.5']
  }

  it('只看已验证的、本版本没标不适用的；单词边界不误伤', () => {
    expect(findAvoided('if a.is_hidden:', [proven], '5.5')).toHaveLength(1)
    expect(findAvoided('if a.is_hidden_ed():', [proven], '5.5')).toEqual([])
    expect(findAvoided('if a.IS_HIDDEN:', [proven], '5.5')).toHaveLength(1)
    expect(findAvoided('if a.is_hidden:', [{ ...proven, status: 'trial' }], '5.5')).toEqual([])
    expect(findAvoided('if a.is_hidden:', [{ ...proven, notFor: ['5.6'] }], '5.6')).toEqual([])
    expect(formatPrecheck([proven], '5.5')).toContain('send the exact same code again')
  })

  let root: string
  let global: ExperienceStore
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'exp-god-'))
    global = new ExperienceStore(join(root, 'global'))
    // 盘上的经验不带 layer（那是读出来时按目录补上的）
    const entry: ExperienceEntry & { layer?: string } = { ...proven }
    delete entry.layer
    await global.updateTool(proven.tool, () => [entry])
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function runtime(): ReturnType<typeof createExperienceRuntime> {
    return createExperienceRuntime({
      project: new ExperienceStore(join(root, 'project')),
      global,
      projectKey: 'p',
      engine: '5.5',
      agentId: 's',
      isLearnableTool: () => true,
      random: () => 0.99
    })
  }

  it('拦一次；改了脚本并且成了，记一次采纳成功', async () => {
    const rt = runtime()
    const bad = { tool: proven.tool, args: { script: 'a.is_hidden' } }
    expect(await rt.before(bad)).toContain('not executed')
    const good = { tool: proven.tool, args: { script: 'a.is_hidden_ed()' } }
    expect(await rt.before(good)).toBeUndefined()
    await rt.after({ ...good, isError: false, text: 'ok' })
    await rt.flush()
    expect(await global.statsFor(proven.id)).toMatchObject({ shown: 1, adopted: 1, adoptedOk: 1 })
    expect((await global.readTool(proven.tool))[0].status).toBe('proven')
  })

  it('原样再发就放行；真跑成了说明拦错了，降回试用、不再拦', async () => {
    const rt = runtime()
    const bad = { tool: proven.tool, args: { script: 'b.is_hidden' } }
    expect(await rt.before(bad)).toBeDefined()
    expect(await rt.before(bad)).toBeUndefined()
    await rt.after({ ...bad, isError: false, text: 'ok' })
    await rt.flush()
    expect((await global.readTool(proven.tool))[0].status).toBe('trial')
    expect(
      await runtime().before({ tool: proven.tool, args: { script: 'c.is_hidden' } })
    ).toBeUndefined()
  })

  it('普通工具不做执行前提醒', async () => {
    expect(
      await runtime().before({ tool: 'ue_save', args: { script: 'a.is_hidden' } })
    ).toBeUndefined()
  })
})

describe('整理员：上帝工具的经验带上 API 钥匙和错误写法，默认进通用层', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'exp-god-cur-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('整理员没说是引擎层，也照样按 API 钥匙进通用层；交给模型的是改动的行', async () => {
    const header: TrailHeader = {
      kind: 'header',
      sessionId: 'sess-1',
      projectRoot: join(root, 'Game'),
      engineVersion: '5.5',
      skillLearning: 'ask',
      startedAt: ''
    }
    const longHead = Array.from({ length: 60 }, (_, i) => `x${i} = ${i}`).join('\n')
    const failCode = `${longHead}\nif actor.is_hidden:\n    pass`
    const fixCode = `${longHead}\nif actor.is_hidden_ed():\n    pass`
    const calls: TrailCall[] = [
      {
        kind: 'call',
        agent: 's',
        i: 1,
        tool: 'ue_run_python_script',
        ok: false,
        args: JSON.stringify({ script: failCode }),
        error: HIDDEN,
        fp: HIDDEN.slice(0, 120),
        code: failCode
      },
      {
        kind: 'call',
        agent: 's',
        i: 2,
        tool: 'ue_run_python_script',
        ok: true,
        args: JSON.stringify({ script: fixCode }),
        code: fixCode
      }
    ]
    const complete = vi.fn(
      async () =>
        '[{"index":0,"title":"角色没有 is_hidden","errorPattern":"object has no attribute \'is_hidden\'","advice":"改用 is_hidden_ed()"}]'
    )
    const globalDir = join(root, 'home')
    const result = await curateSession({
      header,
      calls,
      complete,
      knownTools: new Set(['ue_run_python_script']),
      globalDir
    })
    const prompt = (complete.mock.calls[0] as unknown as [string, string])[1]
    expect(prompt).toContain('- if actor.is_hidden:')
    expect(prompt).not.toContain('x30 = 30')
    expect(result.written).toMatchObject([
      {
        layer: 'global',
        symbol: 'character.is_hidden',
        avoid: '.is_hidden',
        expect: { param: 'script' }
      }
    ])
    expect(await new ExperienceStore(experienceDir(header.projectRoot)!).readAll()).toEqual([])
  })
})

describe('控制台命令', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'exp-console-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('插件带回「命令不存在」之后，能学到命令名的正确写法，并在执行前拦住旧写法', async () => {
    const error = normalizeError(
      "ue_run_console_command 失败：控制台指令执行失败：Command not recognized: 'r.ScreenPercentag'（错误码 500）"
    )
    const header: TrailHeader = {
      kind: 'header',
      sessionId: 'sess-c',
      projectRoot: join(root, 'Game'),
      engineVersion: '5.5',
      skillLearning: 'ask',
      startedAt: ''
    }
    const call = (i: number, command: string, failed: boolean): TrailCall => ({
      kind: 'call',
      agent: 's',
      i,
      tool: 'ue_run_console_command',
      ok: !failed,
      args: JSON.stringify({ command }),
      code: command,
      ...(failed ? { error, fp: error.slice(0, 120) } : {})
    })
    const result = await curateSession({
      header,
      calls: [call(1, 'r.ScreenPercentag 50', true), call(2, 'r.ScreenPercentage 50', false)],
      complete: async () =>
        `[{"index":0,"title":"屏幕百分比变量名","errorPattern":"command not recognized: 'r.screenpercentag'","advice":"变量名是 r.ScreenPercentage"}]`,
      knownTools: new Set(['ue_run_console_command']),
      globalDir: join(root, 'home')
    })
    const [entry] = result.written
    expect(entry).toMatchObject({
      layer: 'global',
      symbol: 'r.screenpercentag',
      avoid: 'r.screenpercentag',
      expect: { param: 'command' }
    })

    const proven = { ...entry, status: 'proven' as const }
    expect(findAvoided('r.ScreenPercentag 75', [proven], '5.5')).toHaveLength(1)
    expect(findAvoided('r.ScreenPercentage 75', [proven], '5.5')).toEqual([])
  })

  it('命令名没错、只是参数不对：不拦命令名', () => {
    expect(
      avoidFromDiff(
        'r.screenpercentage',
        scriptDiff('r.ScreenPercentage abc', 'r.ScreenPercentage 50'),
        'ue_run_console_command'
      )
    ).toBeUndefined()
  })
})

describe('到引擎里验真', () => {
  it('探针要查的东西、新写法、读回结论', () => {
    expect(probeTarget('character.is_hidden')).toEqual({ owner: 'character', member: 'is_hidden' })
    expect(probeTarget('get_preview_mesh(source_or_target)')).toBeUndefined()
    expect(preferFromDiff(scriptDiff('a.is_hidden', 'a.is_hidden_ed()'))).toBe('is_hidden_ed')
    // 加上的成员不止一个：说不清是哪个，不猜
    expect(preferFromDiff(scriptDiff('a.is_hidden', 'a.b.is_hidden_ed()'))).toBeUndefined()
    expect(readProbeVerdict({ verdict: 'confirmed' })).toBe('confirmed')
    expect(readProbeVerdict(undefined)).toBe('unknown')
    const script = buildProbeScript({
      owner: 'character',
      member: 'is_hidden',
      prefer: 'is_hidden_ed'
    })
    expect(script).toContain('dir(unreal)')
    expect(script).toContain('is_hidden_ed')
    expect(script).not.toMatch(/set_editor_property|save|delete/)
  })

  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'exp-probe-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function curateWith(
    verdict: ProbeVerdict
  ): Promise<{ written: LayeredEntry[]; probe: ReturnType<typeof vi.fn> }> {
    const probe = vi.fn(async () => verdict)
    const failCode = 'if actor.is_hidden:\n    pass'
    const fixCode = 'if actor.is_hidden_ed():\n    pass'
    const result = await curateSession({
      header: {
        kind: 'header',
        sessionId: 'sess-p',
        projectRoot: join(root, verdict, 'Game'),
        engineVersion: '5.5',
        skillLearning: 'ask',
        startedAt: ''
      },
      calls: [
        {
          kind: 'call',
          agent: 's',
          i: 1,
          tool: 'ue_run_python_script',
          ok: false,
          args: JSON.stringify({ script: failCode }),
          error: HIDDEN,
          fp: HIDDEN.slice(0, 120),
          code: failCode
        },
        {
          kind: 'call',
          agent: 's',
          i: 2,
          tool: 'ue_run_python_script',
          ok: true,
          args: JSON.stringify({ script: fixCode }),
          code: fixCode
        }
      ],
      complete: async () =>
        '[{"index":0,"title":"t","errorPattern":"object has no attribute \'is_hidden\'","advice":"改用 is_hidden_ed()"}]',
      knownTools: new Set(['ue_run_python_script']),
      // 每种结论用各自的目录：同一条经验写过一次，下次就算已有、不再交给模型
      globalDir: join(root, verdict, 'home'),
      probe
    })
    return { written: result.written, probe }
  }

  it('引擎否定了就不写；确认了就注明核实过；问不出来照旧写', async () => {
    const refuted = await curateWith('refuted')
    expect(refuted.written).toEqual([])
    expect(refuted.probe).toHaveBeenCalledWith({
      projectRoot: join(root, 'refuted', 'Game'),
      owner: 'character',
      member: 'is_hidden',
      prefer: 'is_hidden_ed'
    })
    expect((await curateWith('confirmed')).written[0].source).toContain('checked in editor')
    expect((await curateWith('unknown')).written[0].source).not.toContain('checked in editor')
  })
})
