import { describe, expect, it, vi } from 'vitest'

// 依赖是注入的，但静态 import 仍会把 editorPython → services → electron 整条拉进来
vi.mock('./editorPython', () => ({ runEditorPython: vi.fn() }))
vi.mock('../tools/defineUeTool', () => ({
  callUeRaw: vi.fn().mockRejectedValue(new Error('没有连接的虚幻引擎'))
}))

import { callUeRaw } from '../tools/defineUeTool'
import {
  compileErrorText,
  normalizeReviewTargets,
  parseEngineFindings,
  reviewChanges,
  reviewNaming
} from './reviewChanges'

describe('normalizeReviewTargets', () => {
  it('只留引擎内资产路径 —— Actor 名和本地文件在编辑器里查不了', () => {
    const targets = normalizeReviewTargets([
      { path: '/Game/A/M_Wood', action: 'created' },
      { path: 'Cube', action: 'modified' },
      { path: 'D:/proj/说明.html', action: 'modified' },
      { path: '', action: 'modified' }
    ])

    expect(targets.map((t) => t.path)).toEqual(['/Game/A/M_Wood'])
  })

  it('对象路径归一成包名 —— 资产注册表只认后者，传前者会安静地查不出依赖', () => {
    const targets = normalizeReviewTargets([
      { path: '/Game/A/M_Wood.M_Wood', action: 'modified' },
      { path: '/Game/A/M_Wood', action: 'modified' }
    ])

    expect(targets).toHaveLength(1)
    expect(targets[0].path).toBe('/Game/A/M_Wood')
  })

  it('截断在 40 个 —— 每个都要 load 一次，再多会把编辑器卡住', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      path: `/Game/A/M_${i}`,
      action: 'modified' as const
    }))

    expect(normalizeReviewTargets(many)).toHaveLength(40)
  })
})

describe('reviewNaming', () => {
  it('新建的材质没有 M_ 前缀时给建议', () => {
    const findings = reviewNaming([{ path: '/Game/A/Wood', action: 'created', kind: 'material' }])

    expect(findings).toEqual([
      { target: '/Game/A/Wood', code: 'naming', severity: 'info', detail: 'M_ / MI_' }
    ])
  })

  it('材质实例的 MI_ 也算合规', () => {
    expect(
      reviewNaming([{ path: '/Game/A/MI_Wood', action: 'created', kind: 'material' }])
    ).toEqual([])
  })

  it('只对新建的提 —— 用户工程里原有的资产叫什么不是这一轮的事', () => {
    expect(reviewNaming([{ path: '/Game/A/Wood', action: 'modified', kind: 'material' }])).toEqual(
      []
    )
  })

  it('认不出类别就不提，宁可漏报也不要挑错刺', () => {
    expect(reviewNaming([{ path: '/Game/A/Wood', action: 'created' }])).toEqual([])
    expect(reviewNaming([{ path: '/Game/A/Wood', action: 'created', kind: 'level' }])).toEqual([])
  })
})

describe('parseEngineFindings', () => {
  it('按 code 定级', () => {
    const { findings } = parseEngineFindings({
      findings: [
        { target: '/Game/A/BP_X', code: 'compile-error', detail: '' },
        { target: '/Game/A/M_Y', code: 'unsaved', detail: '' }
      ]
    })

    expect(findings).toEqual([
      { target: '/Game/A/BP_X', code: 'compile-error', severity: 'error' },
      { target: '/Game/A/M_Y', code: 'unsaved', severity: 'warning' }
    ])
  })

  it('认不出的 code 丢掉 —— 界面上少一行，好过多一行空白', () => {
    const { findings } = parseEngineFindings({
      findings: [{ target: '/Game/A/M_Y', code: 'whatever' }, { code: 'unsaved' }]
    })

    expect(findings).toEqual([])
  })

  it('引擎什么都没回时不炸', () => {
    expect(parseEngineFindings(undefined).findings).toEqual([])
    expect(parseEngineFindings({}).findings).toEqual([])
  })
})

describe('reviewChanges', () => {
  it('没有可查的目标时不去打扰引擎', async () => {
    const runPython = vi.fn()
    const result = await reviewChanges([{ path: 'Cube', action: 'modified' }], { runPython })

    expect(runPython).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, checked: 0, findings: [], engineChecked: false })
  })

  it('引擎没连上时静态那一半照常出，并明说另一半没跑', async () => {
    const runPython = vi.fn().mockResolvedValue({
      success: false,
      error: '没有连接的虚幻引擎项目'
    })

    const result = await reviewChanges(
      [{ path: '/Game/A/Wood', action: 'created', kind: 'material' }],
      { runPython }
    )

    expect(result.engineChecked).toBe(false)
    expect(result.engineError).toBe('没有连接的虚幻引擎项目')
    expect(result.findings.map((f) => f.code)).toEqual(['naming'])
  })

  it('引擎结果和命名建议合并，按严重程度排序', async () => {
    const runPython = vi.fn().mockResolvedValue({
      success: true,
      output: {
        findings: [
          { target: '/Game/A/Wood', code: 'unsaved' },
          { target: '/Game/A/BP_Z', code: 'compile-error' }
        ]
      }
    })

    const result = await reviewChanges(
      [
        { path: '/Game/A/Wood', action: 'created', kind: 'material' },
        { path: '/Game/A/BP_Z', action: 'modified', kind: 'blueprint' }
      ],
      { runPython }
    )

    expect(result.engineChecked).toBe(true)
    expect(result.checked).toBe(2)
    expect(result.findings.map((f) => f.code)).toEqual(['compile-error', 'unsaved', 'naming'])
  })

  it('脚本本身抛出来时不让整次调用炸掉', async () => {
    const runPython = vi.fn().mockRejectedValue(new Error('管道断了'))

    const result = await reviewChanges([{ path: '/Game/A/M_W', action: 'modified' }], { runPython })

    expect(result.success).toBe(true)
    expect(result.engineChecked).toBe(false)
    expect(result.engineError).toBe('管道断了')
  })

  it('脚本里带着目标清单和依赖开关 —— 5.2 起不显式传就查不出依赖', async () => {
    const runPython = vi.fn().mockResolvedValue({ success: true, output: { findings: [] } })

    await reviewChanges([{ path: '/Game/A/M_W', action: 'deleted' }], { runPython })

    const script = String(runPython.mock.calls[0][0])
    expect(script).toContain('/Game/A/M_W')
    expect(script).toContain('include_hard_package_references=True')
    expect(script).toContain('get_referencers')
  })
})

describe('蓝图编译报错原文', () => {
  const brokenBlueprint = (count = 1): ReturnType<typeof vi.fn> =>
    vi.fn().mockResolvedValue({
      success: true,
      output: {
        findings: Array.from({ length: count }, (_, i) => ({
          target: `/Game/A/BP_${i}`,
          code: 'compile-error'
        }))
      }
    })

  it('红灯的蓝图重编一次，把报错原文挂进 detail', async () => {
    const compileBlueprint = vi.fn().mockResolvedValue({
      ok: false,
      diagnostics: [
        { type: 'Warning', message: '变量没用上' },
        { type: 'Error', message: 'Accessed None 引脚没连' },
        { type: 'Error', message: '找不到函数 Foo' }
      ]
    })

    const result = await reviewChanges([{ path: '/Game/A/BP_0', action: 'modified' }], {
      runPython: brokenBlueprint(),
      compileBlueprint
    })

    expect(compileBlueprint).toHaveBeenCalledWith('/Game/A/BP_0')
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'compile-error',
        detail: 'Accessed None 引脚没连\n找不到函数 Foo'
      })
    ])
  })

  it('重编通过说明红灯过期了，这条撤掉 —— 不能再说它是坏的', async () => {
    const result = await reviewChanges([{ path: '/Game/A/BP_0', action: 'modified' }], {
      runPython: brokenBlueprint(),
      compileBlueprint: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    })

    expect(result.findings).toEqual([])
  })

  it('取原文失败时保留原来那条，不让整次审查炸掉', async () => {
    const result = await reviewChanges([{ path: '/Game/A/BP_0', action: 'modified' }], {
      runPython: brokenBlueprint(),
      compileBlueprint: vi.fn().mockRejectedValue(new Error('超时'))
    })

    expect(result.findings).toEqual([
      { target: '/Game/A/BP_0', code: 'compile-error', severity: 'error' }
    ])
  })

  it('最多重编三个 —— 编译跑在游戏线程上，多了会卡住编辑器', async () => {
    const compileBlueprint = vi.fn().mockResolvedValue({ ok: false, diagnostics: [] })
    const targets = Array.from({ length: 5 }, (_, i) => ({
      path: `/Game/A/BP_${i}`,
      action: 'modified' as const
    }))

    const result = await reviewChanges(targets, { runPython: brokenBlueprint(5), compileBlueprint })

    expect(compileBlueprint).toHaveBeenCalledTimes(3)
    expect(result.findings).toHaveLength(5)
  })

  it('好好的蓝图一个都不编', async () => {
    const compileBlueprint = vi.fn()
    await reviewChanges([{ path: '/Game/A/BP_0', action: 'modified' }], {
      runPython: vi.fn().mockResolvedValue({ success: true, output: { findings: [] } }),
      compileBlueprint
    })

    expect(compileBlueprint).not.toHaveBeenCalled()
  })

  it('默认实现必须带 save:false —— 插件默认会存盘，后台检查不能替用户保存', async () => {
    vi.mocked(callUeRaw).mockResolvedValueOnce({ ok: false, diagnostics: [] })

    await reviewChanges([{ path: '/Game/A/BP_0', action: 'modified' }], {
      runPython: brokenBlueprint()
    })

    expect(callUeRaw).toHaveBeenCalledWith(
      'blueprint.compile',
      { blueprint_path: '/Game/A/BP_0', save: false },
      expect.anything()
    )
  })

  it('原文只取报错、去重、每个蓝图最多三条、过长截断', () => {
    const long = 'x'.repeat(400)
    const text = compileErrorText({
      diagnostics: [
        { type: 'Error', message: 'A' },
        { type: 'Error', message: 'A' },
        { type: 'Info', message: 'I' },
        { type: 'Error', message: long },
        { type: 'Error', message: 'B' },
        { type: 'Error', message: 'C' }
      ]
    })

    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('A')
    expect(lines[1]).toHaveLength(301)
    expect(lines[2]).toBe('B')
  })
})
