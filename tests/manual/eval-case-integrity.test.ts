/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import {
  electronMock,
  sentryMock,
  servicesMock,
  targetContextMock
} from '../../src/main/agent-v3/testSupport/toolMocks'

vi.mock('electron', () => electronMock())
vi.mock('@sentry/electron/main', () => sentryMock())
vi.mock('../../src/main/services', () => servicesMock())
vi.mock('../../src/main/agent-v3/core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import { buildAllTools } from '../../src/main/agent-v3/tools/registry'
// @ts-expect-error —— 评测脚手架是 .mjs，没有类型声明
import { buildHardCases } from './ue-task-eval-hard.mjs'
// @ts-expect-error —— 同上
import { ORIENTATION_TOOLS, FALLBACK_TOOLS } from './tool-selection-metrics.mjs'

/**
 * 评测用例里写死的工具名，必须真的存在于注册表。
 *
 * ## 为什么值得一道门禁
 *
 * 真机跑完才发现 A2 连着两次判失败，原因是判定代码里写的是
 * `level_query_assets`，而那个工具已经改名成 `ue_find_heavy_assets`。
 * 模型其实调对了。
 *
 * 这类错**不会报错**：`toolCalls.some(c => c.name === '不存在的名字')` 只会
 * 安静地返回 false，然后把一次成功记成失败。评测结果本身是用来做架构决策的，
 * 它说谎的代价比代码里少个分号大得多。
 *
 * 用例是 .mjs、判定要连引擎，所以这里只做静态检查：把 buildHardCases 用空壳
 * 依赖调出来，读它声明的字段，不执行任何 check。
 */
const toolNames = new Set(buildAllTools().map((t) => t.name))

/**
 * `core` 命名空间的工具（task / load_skill / read_skill_resource）不在注册表里，
 * 是 createAgent 直接加进池子的，但用例可以合法地引用它们。
 */
const CORE_TOOLS = ['task', 'load_skill', 'read_skill_resource']

const noop = async (): Promise<null> => null
const hardCases = buildHardCases({
  ue: noop,
  tool: noop,
  assetExists: noop,
  deleteAsset: noop
}) as Array<{ id: string; scope?: string[]; expectTools?: string[] }>

const namespaces = new Set(buildAllTools().map((t) => t.unrealBox.namespace))

describe('评测用例引用的工具名', () => {
  const declared = hardCases.flatMap((c) =>
    (c.expectTools ?? []).map((name) => ({ id: c.id, name }))
  )

  it('用例确实声明了 expectTools（否则命中率没有分母）', () => {
    expect(declared.length).toBeGreaterThan(0)
  })

  it.each(declared)('$id 的 $name 存在于工具池', ({ name }) => {
    expect(toolNames.has(name) || CORE_TOOLS.includes(name)).toBe(true)
  })

  /**
   * scope 写错命名空间的后果和上面一样隐蔽：所有调用都会被判成「离题」，
   * 报告里出现一片红，而真正的原因是标注写错了。
   */
  it.each(hardCases.flatMap((c) => (c.scope ?? []).map((ns) => ({ id: c.id, ns }))))(
    '$id 的 scope "$ns" 是真实存在的命名空间',
    ({ ns }) => {
      expect([...namespaces].some((n) => n === ns || n.startsWith(`${ns}.`))).toBe(true)
    }
  )
})

describe('度量模块里写死的工具名', () => {
  it.each(FALLBACK_TOOLS as string[])('兜底工具 %s 存在', (name) => {
    expect(toolNames.has(name)).toBe(true)
  })

  /**
   * 定位类工具删掉或改名后，这份名单会静默失效 —— 那些调用会重新被算成离题，
   * 指标一夜之间变差，而工具集其实没变。
   */
  it.each(ORIENTATION_TOOLS as string[])('定位工具 %s 存在', (name) => {
    expect(toolNames.has(name) || CORE_TOOLS.includes(name)).toBe(true)
  })
})
