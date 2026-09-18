/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

// @ts-expect-error —— 评测脚手架是 .mjs，没有类型声明；这里只测它的纯函数
import {
  analyzeToolChoice,
  buildToolIndex,
  formatToolChoiceReport,
  summarizeToolChoice,
  toolCallExecuted
} from './tool-selection-metrics.mjs'

/**
 * 这套指标是用来决定"要不要动工具池架构"的依据。
 *
 * 指标本身算错的话，比不量更糟 —— 会拿着一个假数字去改架构。
 * 所以每条判据都要有测试钉住，尤其是"什么**不**算错"那几条。
 */
const index = buildToolIndex([
  { name: 'blueprint_describe', namespace: 'ue.blueprint' },
  { name: 'blueprint_apply_graph', namespace: 'ue.blueprint' },
  { name: 'material_create', namespace: 'ue.material' },
  { name: 'ue_spawn_actor', namespace: 'ue.actor' },
  { name: 'ue_get_actor', namespace: 'ue.actor' },
  { name: 'ue_get_project_info', namespace: 'ue.editor' },
  { name: 'ue_run_python_script', namespace: 'ue.system' },
  { name: 'run_shell_command', namespace: 'local.shell' },
  { name: 'search_assets', namespace: 'asset' }
])

const call = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  args: {},
  ...extra
})

describe('analyzeToolChoice', () => {
  it('必需工具全调到才算命中', () => {
    const spec = { expectTools: ['blueprint_describe', 'blueprint_apply_graph'] }

    expect(
      analyzeToolChoice([call('blueprint_describe'), call('blueprint_apply_graph')], spec, index)
        .hit
    ).toBe(true)

    const partial = analyzeToolChoice([call('blueprint_describe')], spec, index)
    expect(partial.hit).toBe(false)
    expect(partial.missing).toEqual(['blueprint_apply_graph'])
  })

  /**
   * 没声明期望的用例不该被算进命中率的分母 —— 否则"还没标注"
   * 会被读成"模型没选对"。
   */
  it('没声明必需工具时不参与命中统计', () => {
    const stat = analyzeToolChoice([call('blueprint_describe')], {}, index)
    expect(stat.hasExpectation).toBe(false)
    expect(stat.hit).toBe(false)
  })

  it('调了 scope 之外命名空间的工具算离题', () => {
    const stat = analyzeToolChoice(
      [call('blueprint_apply_graph'), call('material_create')],
      { scope: ['ue.blueprint'] },
      index
    )
    expect(stat.offScope).toEqual(['material_create'])
  })

  /**
   * 开工前问一句「现在开的是哪个工程」是正常的。
   * 把定位类调用算成离题，指标会一片红，真正的误选反而看不见。
   */
  it('定位类工具不算离题', () => {
    const stat = analyzeToolChoice(
      [call('ue_get_project_info'), call('search_assets'), call('blueprint_apply_graph')],
      { scope: ['ue.blueprint'] },
      index
    )
    expect(stat.offScope).toEqual([])
  })

  it('没声明 scope 就不判离题', () => {
    const stat = analyzeToolChoice([call('material_create')], {}, index)
    expect(stat.offScope).toEqual([])
  })

  /** 索引里没有的工具（第三方 MCP）不知道属于哪一类，不该被指控 */
  it('索引外的工具不判离题', () => {
    const stat = analyzeToolChoice(
      [call('mcp_something_unknown')],
      { scope: ['ue.blueprint'] },
      index
    )
    expect(stat.offScope).toEqual([])
  })

  /** scope 写父命名空间时，子命名空间要算在内 */
  it('scope 匹配到子命名空间', () => {
    const stat = analyzeToolChoice(
      [call('run_shell_command')],
      { scope: ['local'], allowFallback: true },
      buildToolIndex([{ name: 'run_shell_command', namespace: 'local.shell' }])
    )
    expect(stat.offScope).toEqual([])
  })

  it('有专用工具却改用 Python / shell 记为兜底', () => {
    const stat = analyzeToolChoice(
      [call('ue_run_python_script'), call('run_shell_command')],
      { scope: ['ue.blueprint'] },
      index
    )
    expect(stat.fallbacks).toEqual(['ue_run_python_script', 'run_shell_command'])
  })

  /**
   * 兜底调用天然也在 scope 之外，两个桶都记的话数字会重叠，
   * 读报告的人既加不起来，也分不清「翻错抽屉」和「绕过工具自己写代码」。
   */
  it('兜底调用不再重复计入离题', () => {
    const stat = analyzeToolChoice(
      [call('material_create'), call('ue_run_python_script')],
      { scope: ['ue.blueprint'] },
      index
    )
    expect(stat.offScope).toEqual(['material_create'])
    expect(stat.fallbacks).toEqual(['ue_run_python_script'])
  })

  it('用例明确允许时兜底不计入', () => {
    const stat = analyzeToolChoice(
      [call('ue_run_python_script')],
      { scope: ['ue.system'], allowFallback: true },
      index
    )
    expect(stat.fallbacks).toEqual([])
  })

  it('同名同参调两次以上记为原地重复', () => {
    const same = { name: 'blueprint_describe', args: { blueprint_path: '/Game/BP' } }
    const stat = analyzeToolChoice([same, same, same], {}, index)
    // 第二次时记一笔，第三次不再重复计数
    expect(stat.repeats).toEqual(['blueprint_describe'])
  })

  it('同名不同参不算重复', () => {
    const stat = analyzeToolChoice(
      [
        { name: 'blueprint_describe', args: { blueprint_path: '/Game/A' } },
        { name: 'blueprint_describe', args: { blueprint_path: '/Game/B' } }
      ],
      {},
      index
    )
    expect(stat.repeats).toEqual([])
  })

  it('统计失败调用数', () => {
    const stat = analyzeToolChoice(
      [call('blueprint_apply_graph', { isError: true }), call('blueprint_apply_graph')],
      {},
      index
    )
    expect(stat.total).toBe(2)
    expect(stat.failed).toBe(1)
  })

  it('空调用列表不炸', () => {
    expect(analyzeToolChoice(undefined, { expectTools: ['x'] }, index).total).toBe(0)
  })
})

describe('summarizeToolChoice', () => {
  const results = [
    {
      id: 'A1',
      scope: ['ue.blueprint'],
      expectTools: ['blueprint_describe'],
      attempts: [
        { run: { toolCalls: [call('blueprint_describe'), call('material_create')] } },
        { run: { toolCalls: [call('ue_run_python_script')] } }
      ]
    }
  ]

  it('把每次运行摊平后汇总', () => {
    const { rows, totals } = summarizeToolChoice(results, index)
    expect(rows).toHaveLength(2)
    expect(totals.withExpectation).toBe(2)
    expect(totals.hits).toBe(1)
    expect(totals.offScope).toBe(1)
    expect(totals.fallbacks).toBe(1)
  })

  /**
   * 环境中断那几次没有可分析的调用。混进来会把分母做大，
   * 让工具选择看起来比实际差 —— 和通过率那边扣除 envDown 是同一个道理。
   */
  it('环境中断的运行不进分母', () => {
    const withEnvDown = [{ ...results[0], attempts: [...results[0].attempts, { envDown: true }] }]
    expect(summarizeToolChoice(withEnvDown, index).rows).toHaveLength(2)
  })

  it('没有运行时报告不报错', () => {
    expect(formatToolChoiceReport(summarizeToolChoice([], index))).toContain('没有可分析的运行')
  })

  /**
   * 没有工具索引时离题一律判不出来。这时候打印「0/4」会读成满分，
   * 而真相是一次都没检查过 —— 报告必须说自己判不了。
   */
  it('没有工具索引时，离题指标报告为判不了而不是 0', () => {
    const summary = summarizeToolChoice(results, new Map())
    expect(summary.scopeMeasurable).toBe(false)

    const report = formatToolChoiceReport(summary)
    expect(report).toContain('判不了')
    expect(report).not.toContain('离题调用 0/')
  })

  it('有索引时正常报数字', () => {
    const report = formatToolChoiceReport(summarizeToolChoice(results, index))
    expect(report).toContain('离题调用 1/')
    expect(report).not.toContain('判不了')
  })
})

describe('formatToolChoiceReport', () => {
  it('列出选错的明细，指名道姓', () => {
    const report = formatToolChoiceReport(
      summarizeToolChoice(
        [
          {
            id: 'B2',
            scope: ['ue.blueprint'],
            expectTools: ['blueprint_apply_graph'],
            attempts: [{ run: { toolCalls: [call('material_create')] } }]
          }
        ],
        index
      )
    )

    expect(report).toContain('B2')
    expect(report).toContain('blueprint_apply_graph')
    expect(report).toContain('material_create')
  })
})

/**
 * 判定「过程中动了本地磁盘」时，只能算**真的跑起来**的调用。
 *
 * 真机上 D2「把引擎升级到 UE5.6」因此被误判：那次 run_shell_command 被审批门
 * 拦住了，磁盘没被碰，模型随后也正确拒绝了越界请求 —— 判定却把护栏生效
 * 记成了闯祸。评测惩罚正确行为，比不评测更糟。
 */
describe('toolCallExecuted', () => {
  it('正常返回的调用算执行了', () => {
    expect(toolCallExecuted({ name: 'run_shell_command', result: 'total 12 foo' })).toBe(true)
  })

  it('被审批门拦下的不算', () => {
    expect(
      toolCallExecuted({
        name: 'run_shell_command',
        result: '用户拒绝执行 run_shell_command。不要重试这个操作。'
      })
    ).toBe(false)
  })

  it('执行报错的不算 —— 炸了就没有副作用', () => {
    expect(toolCallExecuted({ name: 'write_local_file', isError: true, result: 'EACCES' })).toBe(
      false
    )
  })

  it('没有 result 字段时按执行了处理，不放过真正的写操作', () => {
    expect(toolCallExecuted({ name: 'edit_local_file' })).toBe(true)
  })

  it('空值不炸', () => {
    expect(toolCallExecuted(null)).toBe(false)
    expect(toolCallExecuted(undefined)).toBe(false)
  })
})
