/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

// @ts-expect-error —— 评测脚手架是 .mjs，没有类型声明；这里只测它的纯函数
import {
  BatchAborted,
  VERDICT,
  assertBatchNotStuck,
  callsFromDebugAgent,
  classify,
  groupCalls,
  sampleValidity,
  summarize
} from './skill-routing-verdict.mjs'

/**
 * 这套判定是用来决定"要不要改 22 条技能描述"的依据。
 *
 * 判定本身漏判的话，比不量更糟 —— 会拿着一个假的"通过率"去改描述。
 * 评审已经复现出三个漏判，下面每一个都单独钉住：
 * 加载失败后动手、加载没返回就动手、同一次回答里同时派出加载和业务调用。
 */

/** 造事件流。`step` 是响应边界（`turn_end` 投的那条） */
const S = 'sess-1'
const call = (id: string, name: string, args?: unknown): Record<string, unknown> => ({
  type: 'tool-call',
  sessionId: S,
  toolCallId: id,
  toolName: name,
  args
})
const result = (id: string, name: string, isError = false, text = ''): Record<string, unknown> => ({
  type: 'tool-result',
  sessionId: S,
  toolCallId: id,
  toolName: name,
  isError,
  text
})
const step = (): Record<string, unknown> => ({ type: 'step', sessionId: S })
const load = (id: string, name: string): Record<string, unknown> => call(id, 'load_skill', { name })

describe('groupCalls：按 step 分组', () => {
  it('第一条 step 之前的调用属于响应 0，之后的属于响应 1', () => {
    const calls = groupCalls(
      [
        load('a', 'ue-sequencer'),
        result('a', 'load_skill'),
        step(),
        call('b', 'sequence_camera_keys'),
        result('b', 'sequence_camera_keys')
      ],
      S
    )
    expect(calls.map((c) => [c.toolName, c.response])).toEqual([
      ['load_skill', 0],
      ['sequence_camera_keys', 1]
    ])
  })

  it('同一次响应里派出的多个调用归到同一个响应序号', () => {
    const calls = groupCalls(
      [
        load('a', 'ue-sequencer'),
        call('b', 'sequence_camera_keys'),
        result('a', 'load_skill'),
        result('b', 'sequence_camera_keys'),
        step()
      ],
      S
    )
    expect(calls.every((c) => c.response === 0)).toBe(true)
  })

  it('只认属于本会话的事件 —— 串样不能被算进来', () => {
    const calls = groupCalls(
      [
        load('a', 'ue-sequencer'),
        { ...call('x', 'ue_spawn_actor'), sessionId: 'sess-OTHER' },
        result('a', 'load_skill')
      ],
      S
    )
    expect(calls.map((c) => c.toolName)).toEqual(['load_skill'])
  })
})

describe('classify：三个已复现的漏判必须判不通过', () => {
  const target = { expect: 'ue-sequencer', nearby: ['ue-ai-render-from-blockout'] }

  it('反例①：加载失败后照样动手', () => {
    const calls = groupCalls(
      [
        load('a', 'ue-sequencer'),
        result('a', 'load_skill', true, '技能不存在'),
        step(),
        call('b', 'sequence_camera_keys'),
        result('b', 'sequence_camera_keys')
      ],
      S
    )
    const r = classify(calls, target)
    expect(r.pass).toBe(false)
    expect(r.verdict).toBe(VERDICT.LOAD_FAILED)
    expect(r.reason).toBe('error')
  })

  it('反例②：加载没有配对结果就动手', () => {
    const calls = groupCalls(
      [load('a', 'ue-sequencer'), step(), call('b', 'sequence_camera_keys')],
      S
    )
    const r = classify(calls, target)
    expect(r.pass).toBe(false)
    expect(r.verdict).toBe(VERDICT.LOAD_FAILED)
    expect(r.reason).toBe('no-result')
  })

  it('反例③：同一次回答里同时派出加载和业务调用', () => {
    // 运行时依次执行，日志顺序完全正确 —— 旧判定看下标会判通过。
    // 但业务调用的参数在那一刻已经生成完了，模型没读到技能正文。
    const calls = groupCalls(
      [
        load('a', 'ue-sequencer'),
        call('b', 'sequence_camera_keys'),
        result('a', 'load_skill'),
        result('b', 'sequence_camera_keys'),
        step()
      ],
      S
    )
    const r = classify(calls, target)
    expect(r.pass).toBe(false)
    expect(r.verdict).toBe(VERDICT.SAME_RESPONSE)
    expect(r.firstBizTool).toBe('sequence_camera_keys')
  })
})

describe('classify：其余判据', () => {
  const target = { expect: 'ue-sequencer', nearby: ['ue-ai-render-from-blockout'] }

  it('先读对、下一次响应才动手 —— 唯一通过', () => {
    const calls = groupCalls(
      [
        load('a', 'ue-sequencer'),
        result('a', 'load_skill'),
        step(),
        call('b', 'sequence_camera_keys'),
        result('b', 'sequence_camera_keys'),
        step()
      ],
      S
    )
    const r = classify(calls, target)
    expect(r).toMatchObject({ verdict: VERDICT.READ_FIRST, pass: true, acted: true })
  })

  it('动完手才补读一次，不算成功', () => {
    const calls = groupCalls(
      [
        call('b', 'sequence_camera_keys'),
        result('b', 'sequence_camera_keys'),
        step(),
        load('a', 'ue-sequencer'),
        result('a', 'load_skill'),
        step()
      ],
      S
    )
    const r = classify(calls, target)
    expect(r.pass).toBe(false)
    expect(r.verdict).toBe(VERDICT.READ_LATE)
  })

  it('读错技能；命中邻域时单独记下混淆对象', () => {
    const calls = groupCalls(
      [load('a', 'ue-ai-render-from-blockout'), result('a', 'load_skill'), step()],
      S
    )
    const r = classify(calls, target)
    expect(r.verdict).toBe(VERDICT.WRONG_SKILL)
    expect(r.confusedWith).toBe('ue-ai-render-from-blockout')
  })

  it('读错技能但不是邻域，confusedWith 为空', () => {
    const calls = groupCalls([load('a', 'ue-cpp-workflow'), result('a', 'load_skill')], S)
    expect(classify(calls, target).confusedWith).toBeNull()
  })

  it('整轮没调 load_skill', () => {
    const calls = groupCalls([call('b', 'sequence_camera_keys'), result('b', 'x')], S)
    expect(classify(calls, target).verdict).toBe(VERDICT.NOT_READ)
  })

  it('读对了但没动手，仍算路由正确', () => {
    const calls = groupCalls([load('a', 'ue-sequencer'), result('a', 'load_skill')], S)
    expect(classify(calls, target)).toMatchObject({ verdict: VERDICT.READ_FIRST, pass: true })
  })

  it('无技能例：加载了任何技能都算违规', () => {
    const clean = groupCalls([call('b', 'web_search'), result('b', 'x')], S)
    expect(classify(clean, { expect: null }).pass).toBe(true)

    const dirty = groupCalls([load('a', 'ue-sequencer'), result('a', 'load_skill')], S)
    const r = classify(dirty, { expect: null })
    expect(r.pass).toBe(false)
    expect(r.loaded).toEqual(['ue-sequencer'])
  })

  it('read_skill_resource 不算动手', () => {
    const calls = groupCalls(
      [
        load('a', 'ue-sequencer'),
        call('r', 'read_skill_resource'),
        result('a', 'load_skill'),
        result('r', 'read_skill_resource'),
        step()
      ],
      S
    )
    expect(classify(calls, target)).toMatchObject({ verdict: VERDICT.READ_FIRST, pass: true })
  })
})

describe('sampleValidity：无效样本必须能被认出来，而不是算成好成绩', () => {
  const ok = { success: true }

  it('模型没跑起来 —— 不能被记成"没有误触发"', () => {
    const v = sampleValidity({ execResult: { success: false, error: '401' }, sessionId: S })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('model-not-run')
  })

  it('execute 压根没返回也算没跑起来', () => {
    expect(sampleValidity({ execResult: undefined, sessionId: S }).reason).toBe('model-not-run')
  })

  it('超时且没停住，比单纯超时更严重 —— 要能分开', () => {
    expect(sampleValidity({ timedOut: true, drained: true, sessionId: S }).reason).toBe('timeout')
    expect(sampleValidity({ timedOut: true, drained: false, sessionId: S }).reason).toBe(
      'timeout-not-drained'
    )
  })

  it('收到别的会话的事件 —— 串样', () => {
    const v = sampleValidity({
      execResult: ok,
      sessionId: S,
      events: [load('a', 'ue-sequencer'), { ...step(), sessionId: 'sess-OTHER' }]
    })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('cross-sample')
  })

  it('调用没有配对结果 —— 事件流不完整', () => {
    const v = sampleValidity({ execResult: ok, sessionId: S, events: [load('a', 'ue-sequencer')] })
    expect(v.reason).toBe('unpaired-call')
  })

  it('缺竞争工具：样本仍然有效，但不能用于"会不会跳过技能"', () => {
    const events = [load('a', 'ue-sequencer'), result('a', 'load_skill')]
    const v = sampleValidity({
      execResult: ok,
      sessionId: S,
      events,
      requiredCompeting: ['sequence_camera_keys'],
      toolNames: ['load_skill', 'web_search']
    })
    expect(v.ok).toBe(true)
    expect(v.usableFor).toEqual({ routing: true, skip: false })
    expect(v.reason).toBe('missing-competing-tools')
  })

  it('竞争工具齐了，两种结论都能用', () => {
    const events = [load('a', 'ue-sequencer'), result('a', 'load_skill')]
    const v = sampleValidity({
      execResult: ok,
      sessionId: S,
      events,
      requiredCompeting: ['sequence_camera_keys'],
      toolNames: ['load_skill', 'sequence_camera_keys']
    })
    expect(v.usableFor).toEqual({ routing: true, skip: true })
  })

  it('拿不到工具清单时，一律按"缺竞争工具"处理 —— 不假设它在', () => {
    const events = [load('a', 'ue-sequencer'), result('a', 'load_skill')]
    const v = sampleValidity({
      execResult: ok,
      sessionId: S,
      events,
      requiredCompeting: ['sequence_camera_keys'],
      toolNames: null
    })
    expect(v.usableFor.skip).toBe(false)
  })
})

describe('summarize：无效样本不进分母', () => {
  const sample = (
    pass: boolean,
    verdict: string,
    valid = true,
    skip = true
  ): Record<string, unknown> => ({
    result: { pass, verdict },
    validity: valid
      ? { ok: true, usableFor: { routing: true, skip } }
      : { ok: false, reason: 'model-not-run', usableFor: { routing: false, skip: false } }
  })

  it('通过率的分母只算有效样本', () => {
    const s = summarize([
      sample(true, VERDICT.READ_FIRST),
      sample(false, VERDICT.NOT_READ),
      sample(false, VERDICT.NOT_READ, false)
    ])
    expect(s).toMatchObject({ total: 3, valid: 2, invalid: 1, passRate: 0.5 })
    expect(s.invalidByReason).toEqual({ 'model-not-run': 1 })
  })

  it('同响应批量派发率的分母只算"确实有竞争工具"的样本', () => {
    const s = summarize([
      sample(false, VERDICT.SAME_RESPONSE),
      sample(true, VERDICT.READ_FIRST),
      // 缺竞争工具：既不能证明它会跳过，也不能证明它不会
      sample(true, VERDICT.READ_FIRST, true, false)
    ])
    expect(s.skipUsable).toBe(2)
    expect(s.sameResponseRate).toBe(0.5)
    expect(s.passRate).toBeCloseTo(2 / 3)
  })

  it('一个有效样本都没有时，比率是 null 而不是 0', () => {
    const s = summarize([sample(false, VERDICT.NOT_READ, false)])
    expect(s.passRate).toBeNull()
    expect(s.sameResponseRate).toBeNull()
  })
})

describe('callsFromDebugAgent：两条路进 classify 的形状必须一致', () => {
  it('带 response 的调用直接沿用，不重新分组', () => {
    const calls = callsFromDebugAgent([
      {
        name: 'load_skill',
        args: { name: 'ue-sequencer' },
        response: 0,
        isError: false,
        result: 'ok'
      },
      { name: 'sequence_camera_keys', args: {}, response: 1, isError: false, result: 'ok' }
    ])
    expect(calls.map((c) => [c.toolName, c.response])).toEqual([
      ['load_skill', 0],
      ['sequence_camera_keys', 1]
    ])
    expect(classify(calls, { expect: 'ue-sequencer' })).toMatchObject({
      verdict: VERDICT.READ_FIRST,
      pass: true
    })
  })

  it('同响应批量派发同样被认出来', () => {
    const calls = callsFromDebugAgent([
      { name: 'load_skill', args: { name: 'ue-sequencer' }, response: 0, isError: false },
      { name: 'sequence_camera_keys', args: {}, response: 0, isError: false }
    ])
    expect(classify(calls, { expect: 'ue-sequencer' }).verdict).toBe(VERDICT.SAME_RESPONSE)
  })

  it('没有 isError 字段 = 这次调用没有结果，不能当成成功', () => {
    const calls = callsFromDebugAgent([
      { name: 'load_skill', args: { name: 'ue-sequencer' }, response: 0 }
    ])
    expect(calls[0].result).toBeNull()
    expect(classify(calls, { expect: 'ue-sequencer' })).toMatchObject({
      verdict: VERDICT.LOAD_FAILED,
      reason: 'no-result'
    })
  })

  it('sampleValidity 收 calls 时不再要 events', () => {
    const calls = callsFromDebugAgent([
      { name: 'load_skill', args: { name: 'ue-sequencer' }, response: 0, isError: false }
    ])
    const v = sampleValidity({
      execResult: { success: true },
      calls,
      sessionId: 'probe-1',
      requiredCompeting: ['sequence_camera_keys'],
      toolNames: ['load_skill', 'sequence_camera_keys']
    })
    expect(v.ok).toBe(true)
    expect(v.usableFor.skip).toBe(true)
  })
})

describe('sampleValidity：缺结果的调用只有影响判定时才算无效', () => {
  const ok = { success: true }

  it('尾部调用被截断，判定已经做完 —— 样本仍然有效', () => {
    // 真机上撞到过：探针的工具调用上限把最后一次 web_search 截断在半路，
    // 而这条样本的路由决策在第一次响应里就做完了
    const calls = callsFromDebugAgent([
      { name: 'web_search', args: {}, response: 0, isError: false, result: 'ok' },
      { name: 'web_read', args: {}, response: 1, isError: false, result: 'ok' },
      { name: 'web_search', args: {}, response: 1 } // 被截断，没有结果
    ])
    const v = sampleValidity({ execResult: ok, calls, sessionId: 'p' })
    expect(v.ok).toBe(true)
    expect(classify(calls, { expect: 'deep-research' }).verdict).toBe(VERDICT.NOT_READ)
  })

  it('load_skill 自己缺结果 —— 必须判无效，它决定判定', () => {
    const calls = callsFromDebugAgent([
      { name: 'load_skill', args: { name: 'deep-research' }, response: 0 },
      { name: 'web_search', args: {}, response: 1, isError: false, result: 'ok' }
    ])
    expect(sampleValidity({ execResult: ok, calls, sessionId: 'p' }).reason).toBe('unpaired-call')
  })

  it('第一个业务调用缺结果 —— 同样判无效', () => {
    const calls = callsFromDebugAgent([
      { name: 'load_skill', args: { name: 'deep-research' }, response: 0, isError: false },
      { name: 'web_search', args: {}, response: 1 }
    ])
    expect(sampleValidity({ execResult: ok, calls, sessionId: 'p' }).reason).toBe('unpaired-call')
  })
})

describe('并发同名调用：结果必须按 ID 配，不能按工具名配', () => {
  it('两次 web_search 逆序完成，各自拿到自己的结果', () => {
    // pi 的工具执行默认 parallel，tool_execution_end 按**完成顺序**发。
    // 端点原来按工具名回填，总是命中最后一条同名调用：结果全写进同一条，
    // 另一条留下"没有结果"，被评测判成样本不完整。
    const calls = callsFromDebugAgent([
      {
        toolCallId: 'c1',
        name: 'web_search',
        args: { q: 'a' },
        response: 0,
        isError: false,
        result: 'A'
      },
      {
        toolCallId: 'c2',
        name: 'web_search',
        args: { q: 'b' },
        response: 0,
        isError: false,
        result: 'B'
      }
    ])
    expect(calls.map((c) => [c.toolCallId, c.result.text])).toEqual([
      ['c1', 'A'],
      ['c2', 'B']
    ])
    expect(sampleValidity({ execResult: { success: true }, calls, sessionId: 'p' }).ok).toBe(true)
  })

  it('适配器保留 toolCallId', () => {
    const calls = callsFromDebugAgent([
      {
        toolCallId: 'x9',
        name: 'load_skill',
        args: { name: 'deep-research' },
        response: 0,
        isError: false
      }
    ])
    expect(calls[0].toolCallId).toBe('x9')
  })
})

describe('截断：只作废「断言没发生过」的判定', () => {
  const ok = { success: true }
  const calls = callsFromDebugAgent([
    { toolCallId: 'c1', name: 'web_search', args: {}, response: 0, isError: false, result: 'A' }
  ])

  it('not-read 被截断 —— 后面本来可能加载技能，不能算数', () => {
    const v = sampleValidity({
      execResult: ok,
      calls,
      sessionId: 'p',
      truncated: true,
      verdict: VERDICT.NOT_READ
    })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('truncated-before-conclusion')
  })

  it('no-skill-ok 被截断 —— 同理', () => {
    const v = sampleValidity({
      execResult: ok,
      calls: [],
      sessionId: 'p',
      truncated: true,
      verdict: VERDICT.NO_SKILL_OK
    })
    expect(v.ok).toBe(false)
  })

  it('same-response 被截断 —— 证据已经在手里，仍然有效', () => {
    const v = sampleValidity({
      execResult: ok,
      calls,
      sessionId: 'p',
      truncated: true,
      verdict: VERDICT.SAME_RESPONSE
    })
    expect(v.ok).toBe(true)
  })

  // 这条原来把 wrong-skill / load-failed 也算成截断安全，是错的：
  // 读错技能、或加载失败之后**还没动手**就被截断时，继续跑完全可能读对再动手，
  // 最终变成 read-first。详见下面「截断安全清单」那组。
  it('read-late 被截断也仍然有效 —— 业务调用已经发生，相对位置定死了', () => {
    const v = sampleValidity({
      execResult: ok,
      calls,
      sessionId: 'p',
      truncated: true,
      verdict: VERDICT.READ_LATE
    })
    expect(v.ok).toBe(true)
  })

  it('没截断时 not-read 正常有效', () => {
    const v = sampleValidity({
      execResult: ok,
      calls,
      sessionId: 'p',
      truncated: false,
      verdict: VERDICT.NOT_READ
    })
    expect(v.ok).toBe(true)
  })
})

describe('截断安全清单：判定会不会被后续事件推翻', () => {
  const ok = { success: true }
  const withCall = callsFromDebugAgent([
    { toolCallId: 'c1', name: 'web_search', args: {}, response: 0, isError: false, result: 'A' }
  ])

  it('wrong-skill 被截断 —— 继续跑可能读对再动手，变成 read-first，不能算数', () => {
    const v = sampleValidity({
      execResult: ok,
      calls: withCall,
      sessionId: 'p',
      truncated: true,
      verdict: VERDICT.WRONG_SKILL
    })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('truncated-before-conclusion')
  })

  it('load-failed 被截断 —— 重试一次成功同样会变成 read-first', () => {
    const v = sampleValidity({
      execResult: ok,
      calls: withCall,
      sessionId: 'p',
      truncated: true,
      verdict: VERDICT.LOAD_FAILED
    })
    expect(v.ok).toBe(false)
  })

  it('稳定的三种：截断也仍然有效', () => {
    for (const verdict of [VERDICT.READ_FIRST, VERDICT.SAME_RESPONSE, VERDICT.READ_LATE]) {
      const v = sampleValidity({
        execResult: ok,
        calls: withCall,
        sessionId: 'p',
        truncated: true,
        verdict
      })
      expect(v.ok, verdict).toBe(true)
    }
  })

  it('不截断时 wrong-skill / load-failed 正常有效', () => {
    for (const verdict of [VERDICT.WRONG_SKILL, VERDICT.LOAD_FAILED]) {
      const v = sampleValidity({
        execResult: ok,
        calls: withCall,
        sessionId: 'p',
        truncated: false,
        verdict
      })
      expect(v.ok, verdict).toBe(true)
    }
  })
})

describe('加载失败后重试成功：判据锚在首次成功，不是首次调用', () => {
  const target = { expect: 'ue-sequencer' }
  const L = (id: string, response: number, isError: boolean): Record<string, unknown> => ({
    toolCallId: id,
    name: 'load_skill',
    args: { name: 'ue-sequencer' },
    response,
    isError,
    result: isError ? 'not found' : 'ok'
  })
  const B = (id: string, response: number): Record<string, unknown> => ({
    toolCallId: id,
    name: 'sequence_camera_keys',
    args: {},
    response,
    isError: false,
    result: 'ok'
  })

  it('失败@r0 → 成功@r1 → 业务@r2 —— 是 read-first，不是 load-failed', () => {
    const calls = callsFromDebugAgent([L('a', 0, true), L('b', 1, false), B('c', 2)])
    expect(classify(calls, target)).toMatchObject({ verdict: VERDICT.READ_FIRST, pass: true })
  })

  it('失败@r0 → 业务@r1 → 重试成功@r2 —— 动手在成功加载之前，是 read-late', () => {
    const calls = callsFromDebugAgent([L('a', 0, true), B('b', 1), L('c', 2, false)])
    expect(classify(calls, target)).toMatchObject({ verdict: VERDICT.READ_LATE, pass: false })
  })

  it('失败@r0 → 成功@r1 + 业务@r1 同一响应 —— 是 same-response', () => {
    const calls = callsFromDebugAgent([L('a', 0, true), L('b', 1, false), B('c', 1)])
    expect(classify(calls, target)).toMatchObject({ verdict: VERDICT.SAME_RESPONSE, pass: false })
  })

  it('全部尝试都失败才是 load-failed，并报出试了几次', () => {
    const calls = callsFromDebugAgent([L('a', 0, true), L('b', 1, true), B('c', 2)])
    expect(classify(calls, target)).toMatchObject({
      verdict: VERDICT.LOAD_FAILED,
      pass: false,
      reason: 'error',
      attempts: 2
    })
  })

  it('最后一次没有结果时，理由是 no-result', () => {
    const calls = callsFromDebugAgent([
      L('a', 0, true),
      { toolCallId: 'b', name: 'load_skill', args: { name: 'ue-sequencer' }, response: 1 }
    ])
    expect(classify(calls, target)).toMatchObject({
      verdict: VERDICT.LOAD_FAILED,
      reason: 'no-result'
    })
  })
})

describe('assertBatchNotStuck：没停住必须打断整批，不是只打断当前判定线', () => {
  it('停住了就放行', () => {
    expect(() =>
      assertBatchNotStuck({ sessionId: 's', timedOut: true, drained: true })
    ).not.toThrow()
    expect(() =>
      assertBatchNotStuck({ sessionId: 's', timedOut: false, drained: undefined })
    ).not.toThrow()
  })

  it('没停住就抛 BatchAborted', () => {
    expect(() => assertBatchNotStuck({ sessionId: 's', timedOut: true, drained: false })).toThrow(
      BatchAborted
    )
    // drained 缺失和 false 一样危险：都说明我们不知道它停没停
    expect(() =>
      assertBatchNotStuck({ sessionId: 's', timedOut: true, drained: undefined })
    ).toThrow(BatchAborted)
  })

  it('②③④ 各自超时没停住时也会打断后面的判定线', () => {
    // 评审复现的两个场景：`--only=2,4` 超时后又启动 2 次，`--only=3,4` 又启动 10 次。
    // 根因是中止判断只写在①的循环里。这里把共用入口包成 run()，模拟整批控制流。
    const started: string[] = []
    const run = (sessionId: string, stuck: boolean): void => {
      started.push(sessionId)
      assertBatchNotStuck({ sessionId, timedOut: stuck, drained: stuck ? false : true })
    }

    const runBatch = (): void => {
      try {
        run('line1', false)
        run('line2', true) // ② 自己超时没停住
        for (let i = 0; i < 10; i++) run(`line3-${i}`, false)
        run('line4', false)
      } catch (error) {
        if (!(error instanceof BatchAborted)) throw error
      }
    }
    runBatch()

    // ② 之后一次都不许再启动
    expect(started).toEqual(['line1', 'line2'])
  })

  it('中止之后收尾仍然要走 —— 已经跑出来的数据不能顺带丢掉', () => {
    const finished: string[] = []
    try {
      assertBatchNotStuck({ sessionId: 's', timedOut: true, drained: false })
    } catch (error) {
      if (!(error instanceof BatchAborted)) throw error
      finished.push('summary', 'write-json', 'exit-2')
    }
    expect(finished).toEqual(['summary', 'write-json', 'exit-2'])
  })
})
