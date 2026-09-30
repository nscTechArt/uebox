import { describe, expect, it } from 'vitest'

import { findLessonCandidates, validateLesson } from './curator'
import { normalizeError } from './errorSignature'
import type { ExperienceEntry } from './experienceFile'
import { matchEntries, type LayeredEntry } from './recall'
import { errorProblem, patternProblem } from './specificity'
import type { TrailCall } from './trail'

// 报错样本照 2026-09-30 真实会话里的形状写
const py = (exception: string): string =>
  normalizeError(
    `ue_run_python_script 失败：Traceback (most recent call last): File "<ua-script>", line 5, in <module> ${exception} 详情：{}`
  )

const HIDDEN = py("AttributeError: 'Character' object has no attribute 'is_hidden'")
const MOVEMENT = py("AttributeError: 'Character' object has no attribute 'get_character_movement'")
const CONVERT = py(
  "TypeError: AssetRegistry: Failed to convert parameter 'class_path_name' when calling function 'AssetRegistry.GetAssetsByClass' on 'AssetRegistryImpl_0'"
)

describe('patternProblem：上帝工具', () => {
  const tool = 'ue_run_python_script'

  it('带着名字、覆盖大半的片段可以', () => {
    expect(patternProblem(tool, "object has no attribute 'is_hidden'", HIDDEN)).toBeUndefined()
    expect(
      patternProblem(
        tool,
        "failed to convert parameter 'class_path_name' when calling function 'assetregistry.getassetsbyclass'",
        CONVERT
      )
    ).toBeUndefined()
  })

  it('只有通用词、没带名字、只占一小截 —— 太宽', () => {
    expect(patternProblem(tool, 'object has no attribute', HIDDEN)).toBe('generic')
    // 带了名字、也够长，但缺了报错在说的那个属性名：对角色的任何属性都成立
    expect(patternProblem(tool, "'character' object has no attribute", HIDDEN)).toBe('too-wide')
    expect(patternProblem(tool, "attribute 'is_hidden'", HIDDEN)).toBe('too-wide')
    expect(patternProblem(tool, 'failed to convert parameter', CONVERT)).toBe('generic')
  })

  it('脚本自己的 bug、不是 Python 异常的失败，都不学', () => {
    const typo = py("NameError: name 'rcmd' is not defined")
    expect(errorProblem(tool, typo)).toBe('script-bug')
    expect(patternProblem(tool, "name 'rcmd' is not defined", typo)).toBe('script-bug')
    expect(errorProblem(tool, normalizeError('ue_run_python_script 失败：主线程卡住了'))).toBe(
      'no-exception'
    )
  })
})

describe('patternProblem：普通工具', () => {
  it('短于 12 个字或全是通用词不行；有一个实词就行', () => {
    const save = normalizeError(
      'ue_save 失败：/Game/UI/WBP_Card：File is read-only on disk (checked out to someone else)'
    )
    expect(patternProblem('ue_save', 'not found', save)).toBe('too-short')
    expect(patternProblem('ue_save', 'file is read-only on disk', save)).toBeUndefined()
    const pin = normalizeError(
      "blueprint_apply_graph 失败：整批已回滚。 1. connections[3]: pin 'AsPlayer Controller' not found on 'castPC'"
    )
    expect(patternProblem('blueprint_apply_graph', 'not found on', pin)).toBe('generic')
    expect(
      patternProblem('blueprint_apply_graph', "pin 'asplayer controller' not found", pin)
    ).toBeUndefined()
  })
})

describe('召回兜底：旧的宽片段不再命中', () => {
  it('一条写成 has no attribute 的旧经验，对哪个属性错误都不出场', () => {
    const wide: LayeredEntry = {
      id: 'e-wide',
      title: '宽',
      tool: 'ue_run_python_script',
      errorPattern: "has no attribute '",
      advice: '先 dir()',
      expect: { param: 'script' },
      source: '',
      status: 'proven',
      layer: 'global'
    }
    const narrow: LayeredEntry = {
      ...wide,
      id: 'e-narrow',
      errorPattern: "object has no attribute 'is_hidden'"
    }
    expect(matchEntries([wide, narrow], wide.tool, HIDDEN).map((e) => e.id)).toEqual(['e-narrow'])
    // 换一个属性：窄的那条也不出场 —— 它说的是 is_hidden
    expect(matchEntries([wide, narrow], wide.tool, MOVEMENT)).toEqual([])
  })
})

describe('整理员：同一次会话里别的报错也对得上，就太宽', () => {
  const call = (i: number, over: Partial<TrailCall>): TrailCall => ({
    kind: 'call',
    agent: 's1',
    i,
    tool: 'ue_run_python_script',
    ok: true,
    args: '{}',
    ...over
  })
  const calls = [
    call(1, { ok: false, args: '{"script":"a"}', error: HIDDEN, fp: HIDDEN.slice(0, 120) }),
    call(2, { args: '{"script":"b"}' }),
    call(3, { ok: false, args: '{"script":"c"}', error: MOVEMENT, fp: MOVEMENT.slice(0, 120) })
  ]

  it('片段能同时对上 is_hidden 和 get_character_movement 两个错，丢掉', () => {
    const [candidate] = findLessonCandidates(calls, [] as ExperienceEntry[])
    expect(candidate.siblings).toEqual([MOVEMENT])
    const lesson = {
      index: 0,
      title: 't',
      advice: '先 dir() 看有哪些属性',
      expect: { param: 'script' }
    }
    expect(
      validateLesson(
        { ...lesson, errorPattern: "'character' object has no attribute '" },
        candidate,
        new Set()
      )
    ).toBeUndefined()
    expect(
      validateLesson(
        { ...lesson, errorPattern: "object has no attribute 'is_hidden'" },
        candidate,
        new Set()
      )
    ).toBeDefined()
  })

  it('脚本自己的 bug 连候选都进不去，不花模型调用', () => {
    const typo = py("NameError: name 'rcmd' is not defined")
    expect(
      findLessonCandidates(
        [
          call(1, { ok: false, args: '{"script":"a"}', error: typo, fp: typo }),
          call(2, { args: '{"script":"b"}' })
        ],
        []
      )
    ).toEqual([])
  })
})
