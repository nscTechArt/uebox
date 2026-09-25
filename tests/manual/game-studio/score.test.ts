/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import {
  electronMock,
  sentryMock,
  servicesMock,
  targetContextMock
} from '../../../src/main/agent-v3/testSupport/toolMocks'

vi.mock('electron', () => electronMock())
vi.mock('@sentry/electron/main', () => sentryMock())
vi.mock('../../../src/main/services', () => servicesMock())
vi.mock('../../../src/main/agent-v3/core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import { buildContinuationPrompt } from '../../../src/main/agent-v3/core/goalLoop'
import { buildAllTools } from '../../../src/main/agent-v3/tools/registry'
// @ts-expect-error —— 题库脚手架是 .mjs，没有类型声明
import { ENGINE_TOOLS } from './bench.mjs'
// @ts-expect-error —— 同上
import { CASES } from './cases.mjs'
import {
  bugScore,
  isGoalFollowUp,
  judgeBlueprints,
  judgeNewProject,
  judgeSmoke,
  parseScoreBlock,
  renderScoreSheet,
  replaceAutoSection,
  scoreRun,
  summarize,
  transcriptMetrics
  // @ts-expect-error —— 同上
} from './score.mjs'

/**
 * 这些数字要拿去决定下一步做什么。**判据算错比不量更糟**：
 * 一个「没评完」被算成 0 分，或者复核打回被数成真人插话，结论就跟着歪。
 */

const filled = (over: Record<string, string> = {}): string => {
  const v = {
    loop: '2',
    mechanics: '2',
    scene: '1',
    art: '1',
    numbers: '2',
    bugs_severe: '0',
    bugs_minor: '1',
    fun: '3',
    verdict: 'pass',
    ...over
  }
  return ['```score', ...Object.entries(v).map(([k, x]) => `${k}: ${x}`), '```'].join('\n')
}

describe('评分表', () => {
  it('新生成的评分表解析出来全是 null，而且不报错', () => {
    const sheet = renderScoreSheet({
      caseDef: CASES[0],
      runId: 'r1',
      arm: 'team',
      model: '',
      startedAt: 0
    })
    const { values, errors } = parseScoreBlock(sheet)
    expect(errors).toEqual([])
    expect(Object.values(values).every((v) => v === null)).toBe(true)
    expect(scoreRun(values).complete).toBe(false)
  })

  it('空着的项是「没评」，不是 0 分', () => {
    const { values } = parseScoreBlock(filled({ art: '' }))
    const scored = scoreRun(values)
    expect(scored.complete).toBe(false)
    expect(scored.total).toBeNull()
    expect(scored.pass).toBeNull()
  })

  it('填错的值报出来，不悄悄当成 0', () => {
    const { values, errors } = parseScoreBlock(filled({ loop: '3', verdict: 'ok' }))
    expect(values.loop).toBeNull()
    expect(errors.join()).toMatch(/完整游戏循环/)
    expect(errors.join()).toMatch(/verdict/)
  })

  it('行尾注释不算进值里', () => {
    const { values } = parseScoreBlock('```score\nloop: 2   # 完整游戏循环\n```')
    expect(values.loop).toBe(2)
  })
})

describe('打分', () => {
  it('bug：有严重的就是 0；一般的超过 2 个是 1', () => {
    expect(bugScore(1, 0)).toBe(0)
    expect(bugScore(0, 3)).toBe(1)
    expect(bugScore(0, 2)).toBe(2)
    expect(bugScore(null, 0)).toBeNull()
  })

  it('达标 = 没有 0 分项且总分 ≥ 9', () => {
    // 2+2+1+1+2+2 = 10
    expect(scoreRun(parseScoreBlock(filled()).values)).toMatchObject({ total: 10, pass: true })
    // 总分够但有一项 0 分：短板项不能被别的项补
    const zero = scoreRun(parseScoreBlock(filled({ art: '0', scene: '2' })).values)
    expect(zero.total).toBe(10)
    expect(zero.pass).toBe(false)
    // 没有 0 分但总分 8
    const low = scoreRun(parseScoreBlock(filled({ loop: '1', mechanics: '1' })).values)
    expect(low).toMatchObject({ total: 8, pass: false })
  })

  it('汇总单独数出「验收放行但没达标」', () => {
    const runs = [
      { runId: 'a', caseId: 'x', model: 'm', auto: null, score: parseScoreBlock(filled()) },
      {
        runId: 'b',
        caseId: 'x',
        model: 'm',
        auto: null,
        score: parseScoreBlock(filled({ bugs_severe: '2' }))
      }
    ]
    expect(summarize(runs)).toMatch(/达标 1\/2 · 验收放行但没达标 1 次（b）/)
  })
})

describe('会话记录', () => {
  const line = (message: unknown): string => JSON.stringify({ kind: 'message', message })

  it('认得出 /goal 复核员注入的那条消息（和 goalLoop 对表）', () => {
    const text = buildContinuationPrompt('做一个塔防游戏', '没有失败条件', 1)
    expect(isGoalFollowUp({ role: 'user', content: text })).toBe(true)
    expect(isGoalFollowUp({ role: 'user', content: [{ type: 'text', text }] })).toBe(true)
    expect(isGoalFollowUp({ role: 'user', content: '做一个塔防游戏' })).toBe(false)
  })

  it('复核打回不算真人消息；工具失败按 toolCallId 对上', () => {
    const jsonl = [
      JSON.stringify({ kind: 'header', version: 1, sessionId: 's1', createdAt: 0 }),
      line({ role: 'user', content: '做一个塔防游戏', timestamp: 1_000 }),
      line({
        role: 'assistant',
        provider: 'p',
        model: 'm',
        timestamp: 2_000,
        usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, cost: { total: 0 } },
        content: [
          { type: 'toolCall', id: 't1', name: 'ue_run_python_script' },
          { type: 'toolCall', id: 't2', name: 'task' }
        ]
      }),
      line({ role: 'toolResult', toolCallId: 't1', isError: true, content: 'boom' }),
      line({ role: 'toolResult', toolCallId: 't2', isError: false, content: 'ok' }),
      line({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't3', name: 'ue_playtest' }]
      }),
      // 用户按了停止：落盘是 isError，但不算失败
      line({ role: 'toolResult', toolCallId: 't3', isError: true, content: 'Operation aborted' }),
      line({
        role: 'user',
        content: buildContinuationPrompt('做一个塔防游戏', '不行', 1),
        timestamp: 3_000
      }),
      '{"kind":"message","message":{"role":"assis' // 追加写到一半的半行
    ].join('\n')

    const m = transcriptMetrics(jsonl)
    expect(m).toMatchObject({
      sessionId: 's1',
      userTurns: 1,
      goalFollowUps: 1,
      toolCalls: 3,
      toolErrors: 1,
      fallbackCalls: 1,
      subtasks: 1,
      models: ['p/m']
    })
    // 厂商没报价时是「不知道」，不是免费
    expect(m.cost).toBeNull()
  })

  it('工程取最后一次绑定的；路径里可以有空格', () => {
    const status = (name: string, path: string): unknown => ({
      role: 'user',
      content: `<runtime-status>\nsession_project: ${name} (UE 5.6.1-1+++UE5+Release-5.6), path_on_record ${path}\n</runtime-status>\n\n继续`
    })
    const m = transcriptMetrics(
      [status('Old', 'I:/UE Project/Old/'), status('TowerDef', 'D:/Games/TowerDef/')]
        .map(line)
        .join('\n')
    )
    expect(m.project).toEqual({ projectName: 'TowerDef', projectPath: 'D:/Games/TowerDef/' })
    expect(transcriptMetrics(line(status('A', 'I:/UE Project/A/'))).project.projectPath).toBe(
      'I:/UE Project/A/'
    )
  })
})

describe('引擎核验判定', () => {
  it('拿不到结果记「没验到」，不算通过也不算失败', () => {
    expect(judgeBlueprints(null).ok).toBeNull()
    expect(judgeSmoke(null).ok).toBeNull()
    expect(judgeNewProject(NaN, 0).ok).toBeNull()
  })

  it('冒烟：提前结束或有运行时错误都不过', () => {
    const base = { ran: true, ended_by: 'duration', error_count: 0, elapsed_seconds: 30 }
    expect(judgeSmoke(base).ok).toBe(true)
    expect(judgeSmoke({ ...base, ended_by: 'error' }).ok).toBe(false)
    expect(judgeSmoke({ ...base, error_count: 2, errors: ['Accessed None'] }).ok).toBe(false)
  })

  it('工程早于开跑时间 = 在已有工程里干的', () => {
    expect(judgeNewProject(500, 1_000).ok).toBe(false)
    expect(judgeNewProject(1_500, 1_000).ok).toBe(true)
  })

  it('自动核验段可以反复重写，不会越写越长', () => {
    const sheet = renderScoreSheet({
      caseDef: CASES[0],
      runId: 'r1',
      arm: 'team',
      model: '',
      startedAt: 0
    })
    const once = replaceAutoSection(sheet, 'A')
    expect(replaceAutoSection(once, 'B')).toBe(replaceAutoSection(sheet, 'B'))
  })
})

describe('题库与工具名', () => {
  it('题目 id 不重复，题面只有一句话', () => {
    const ids = CASES.map((c: { id: string }) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of CASES) expect(c.prompt).not.toMatch(/[。\n]/)
  })

  /** 名字写错不报错，只会让每次采集都安静地「没验到」 */
  it('引擎核验用到的工具都在注册表里', () => {
    const names = new Set(buildAllTools().map((t) => t.name))
    for (const name of Object.values(ENGINE_TOOLS)) expect(names.has(name as string)).toBe(true)
  })
})
