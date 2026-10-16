/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

import { electronMock, servicesMock, targetContextMock } from '../testSupport/toolMocks'

// 工厂要包一层箭头函数：`vi.mock` 提升到 import 之前，直接传引用会在初始化前访问它
vi.mock('electron', () => electronMock())
vi.mock('../../services', () => servicesMock())
vi.mock('../core/projectTargetContext', async (importOriginal) => targetContextMock(importOriginal))

import { BANNED_TERMS, scan, type Leaf } from '../../../shared/terminologyGuard'
import { createSkillTools } from '../capabilities/skills'
import {
  createBoardTool,
  createMessageTool,
  createTeamTools,
  TEAM_TOOL_NAMES
} from '../core/team/teamTools'
import type { TeamModels } from '../core/team/teamModels'
import { createStatusTool } from '../core/team/teamStatus'
import type { TeamSnapshots } from '../core/team/snapshots'
import type { TeamStore } from '../core/team/teamStore'
import { createAskUserTool } from './builtin/askUser'
import { createBrowserTools } from './builtin/browser'
import { createSetSessionProjectTool } from './builtin/setSessionProject'
import { createTaskTool } from './builtin/task'
import { createToolSearch } from './builtin/toolSearch'
import { createUpdatePlanTool, createWrapUpTool } from './builtin/turnReport'
import { createVoiceReportTool } from './builtin/voiceReport'
import { allToolNames, buildAllTools } from './registry'
import type { UnrealAgentTool } from './defineTool'

/**
 * 工具说明守卫：模型读到的自家工具说明里不许出现禁用词。
 *
 * 界面文案有 `renderer/src/i18n/terminologyGuard.test.ts` 兜着；工具说明是另一半 —
 * 模型把说明里的说法原样转告用户，上游写错一个词，界面说「对话」、AI 嘴里说「会话」。
 * 规则、词表、白名单语义与界面文案守卫完全同一份（`shared/terminologyGuard.ts`），
 * 零容忍，不设基线。
 *
 * ## 扫什么
 *
 * 模型能拿到的全部自家工具，分三个来源：
 *
 * 1. **工具注册表** `buildAllTools()`：带 sender 与两种知识库范围各造一遍 —
 *    依赖 sender 的笔记工具、绑了知识库才注册的来源工具，不这么造就漏扫。
 *    说明随范围变的那份（add_notebook_source 写进存入目的地）两种范围都收。
 * 2. **注册表外、但名字登记在 `allToolNames()` 里的工具**：装配时现造的那批 —
 *    技能加载（load_skill / read_skill_resource）、子任务（task）、工具搜索
 *    （search_tools）、浏览器工具、反问用户（ask_user）、换对话归属工程
 *    （set_session_project）、任务清单（update_plan）、收尾提问（wrap_up）。
 * 3. **注册表与 `allToolNames()` 都不管的工具 —— 下面手工列，改了要同步**：
 *    口头汇报（voice_report）、工作室模式的制作人工具（`createTeamTools`）
 *    与队员工具（team_board / team_message / team_status）。
 *
 * 每个工具扫两处：`description`（位置记 `工具名.description`）和参数 schema —
 * 递归收集键名为 `description` 且值为字符串的项（位置 `工具名.parameters.<键路径>`，
 * 数组带 `[i]` 下标）。参数名、enum / const / default / examples 是给模型的协议值，
 * 不扫 —— 改了协议会坏，文案约束管不到它们。
 *
 * ## 不扫什么
 *
 * 第三方 MCP 工具的说明（不是我们写的）、系统提示词（含 toolSearch.ts 的
 * `TOOL_SEARCH_RULES`）、工具返回值与报错（动态拼接的文字）、语音前台指令、
 * 应用内与 CLI 的技能文本、注释与日志。
 *
 * ## 已知缺口
 *
 * `generate_3d_model` 的参数 schema 与工具说明、`generate_video` 的工具说明会随绑定配置变化。
 * 这里只扫描测试默认配置下生成的版本，不保证覆盖全部配置分支。
 */
/** 桩只满足类型：说明是写死的常量，依赖只在执行时才被碰 */
const sender = { send: () => undefined } as unknown as WebContents
const store = {} as unknown as TeamStore
const snapshots = {
  save: async () => null,
  list: async () => [],
  rollback: async () => ''
} as unknown as TeamSnapshots

/**
 * 注册表外、名字登记在 `allToolNames()` 里的工具 —— 装配层现造的那批。
 * 造法照抄 createAgent / hostSession 的调用形状，依赖全是桩。
 */
function outOfRegistryTools(): UnrealAgentTool<never>[] {
  return [
    ...createSkillTools([{ name: 'fake-skill', description: '假技能', path: '/tmp/fake-skill' }]),
    createTaskTool({
      runSubAgent: async () => ({ text: '', messageCount: 0 }),
      getParentMessages: () => []
    }),
    createToolSearch([], () => []).tool,
    ...createBrowserTools(),
    createAskUserTool({
      sessionId: 's',
      request: async () => ({ action: 'cancel' as const })
    }),
    createSetSessionProjectTool({
      sessionId: 's',
      listProjects: () => [],
      onChange: () => undefined
    }),
    createUpdatePlanTool(),
    createWrapUpTool()
  ] as unknown as UnrealAgentTool<never>[]
}

/**
 * 注册表和 `allToolNames()` 都不管的工具 —— 新增一个就得往这里加一行，
 * 守卫本身发现不了漏网。制作人工具给全 sessionId / snapshots，否则
 * team_status / team_snapshot 不会造出来（teamTools.ts 按依赖裁剪）。
 */
function explicitlyListedTools(): UnrealAgentTool<never>[] {
  return [
    createVoiceReportTool({ sessionId: 's', report: () => undefined }),
    ...createTeamTools({
      store,
      objective: '测试目标',
      namespaces: ['ue.blueprint'],
      // 两个候选让模型选择分支的说明与参数也进入扫描。
      models: {
        candidates: [
          {
            providerId: 'test-provider',
            modelId: 'model-a',
            key: 'test-provider/model-a',
            name: 'Model A',
            providerName: 'Test provider',
            vision: false
          },
          {
            providerId: 'test-provider',
            modelId: 'model-b',
            key: 'test-provider/model-b',
            name: 'Model B',
            providerName: 'Test provider',
            vision: false
          }
        ],
        isAvailable: async () => true
      } satisfies TeamModels,
      runMember: async () => ({ text: '', messageCount: 0 }),
      runAcceptance: async () => '',
      sessionId: 's',
      snapshots
    }),
    // 队员侧的三个工具：与制作人那份同名、调用参数不同（队员名、不带 live）。
    // 目前说明与参数无关、去重后只剩一份；将来说明随参数变了，两份都会收
    createBoardTool(store),
    createMessageTool(store, '队员甲'),
    createStatusTool({ store, sessionId: 's' })
  ] as unknown as UnrealAgentTool<never>[]
}

function collectTools(): UnrealAgentTool<never>[] {
  return [
    ...buildAllTools({ sender, notebook: 'all' }),
    ...buildAllTools({ sender, notebook: { id: 'nb', title: '测试知识库' } }),
    ...outOfRegistryTools(),
    ...explicitlyListedTools()
  ]
}

// ── 叶子提取 ─────────────────────────────────────────────────────────────

/**
 * 这些 schema 关键字装的是协议值（枚举取值、默认值、示例），不是说明文字 ——
 * 不往里钻。参数名虽然也带这层风险（一个叫 `session` 的参数），但它出现在
 * `properties` 之类的「名单位置」下，那里按 NAME_CONTAINER_KEYS 走另一条路。
 */
const NON_TEXT_KEYS = new Set(['enum', 'const', 'default', 'examples'])

/**
 * 这几个关键字下面的子键是参数名 / 定义名，不是 schema 关键字 ——
 * 无条件下钻：一个叫 `default` 的参数，它自己的 description 照样要收。
 */
const NAME_CONTAINER_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions'])

function collectSchemaDescriptions(node: unknown, path: string, out: Leaf[]): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectSchemaDescriptions(item, `${path}[${index}]`, out))
    return
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const childPath = `${path}.${key}`
    if (key === 'description') {
      // 值为字符串是说明文字，收；是对象（参数叫 description）就当 schema 继续钻
      if (typeof value === 'string') out.push({ path: childPath, text: value })
      else collectSchemaDescriptions(value, childPath, out)
      continue
    }
    if (NON_TEXT_KEYS.has(key)) continue
    if (
      NAME_CONTAINER_KEYS.has(key) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        collectSchemaDescriptions(child, `${childPath}.${name}`, out)
      }
      continue
    }
    collectSchemaDescriptions(value, childPath, out)
  }
}

/** 一个工具的全部待扫叶子：说明 + 参数说明 */
function toolLeaves(tool: { name: string; description?: unknown; parameters?: unknown }): Leaf[] {
  const leaves: Leaf[] = []
  if (typeof tool.description === 'string') {
    leaves.push({ path: `${tool.name}.description`, text: tool.description })
  }
  collectSchemaDescriptions(tool.parameters, `${tool.name}.parameters`, leaves)
  return leaves
}

/** 同一个工具在两种知识库范围下会出现两次，按「位置 + 文字」去重后按位置排序 */
function collectLeaves(tools: UnrealAgentTool<never>[]): Leaf[] {
  const seen = new Set<string>()
  const leaves: Leaf[] = []
  for (const tool of tools) {
    for (const leaf of toolLeaves(tool)) {
      const key = `${leaf.path}\u0000${leaf.text}`
      if (seen.has(key)) continue
      seen.add(key)
      leaves.push(leaf)
    }
  }
  return leaves.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 白名单：完整位置 → 放行的禁用词条目。语义与界面文案守卫相同，每条必须写清理由。
 * 只收改写会丢失信息的正当用法（引擎功能名）。
 */
const WHITELIST = new Map<string, string[]>([
  // "Session Frontend" 是 UE 自带的性能分析工具名，改名模型会找不到它
  ['ue_capture_perf_trace.description', ['session']]
])

const TOOLS = collectTools()
const LEAVES = collectLeaves(TOOLS)

describe('工具说明守卫', () => {
  it('扫得到工具：注册表两种范围、注册表外、手工列出的三类来源都在', () => {
    expect(TOOLS.length).toBeGreaterThan(50)

    const collected = new Set(TOOLS.map((tool) => tool.name))
    for (const name of allToolNames()) {
      expect(collected.has(name), `${name} 在 allToolNames() 里但没被收到`).toBe(true)
    }
    // 手工列出的工具不在 allToolNames() 里，逐个点名：工厂按依赖裁剪时这里会红
    for (const name of ['voice_report', ...TEAM_TOOL_NAMES]) {
      expect(collected.has(name), `${name} 没被收到`).toBe(true)
    }
    // 说明是模型读的：空说明等于这个工具对模型隐身，连名字一起报出来
    for (const tool of TOOLS) {
      expect(typeof tool.description === 'string' && tool.description.length > 0, tool.name).toBe(
        true
      )
    }
    expect(LEAVES.map((leaf) => leaf.path)).toEqual(
      expect.arrayContaining([
        'team_hire.parameters.properties.model.description',
        'team_hire.parameters.properties.model_reason.description'
      ])
    )
  })

  describe('提取规则自证', () => {
    const toyTool = {
      name: 'toy',
      description: '玩具',
      parameters: {
        type: 'object',
        properties: {
          // 嵌套参数说明要收到，路径带完整键链
          outer: {
            type: 'object',
            description: '外层说明',
            properties: { inner: { type: 'string', description: '内层说明' } }
          },
          // 参数名叫 session / default / description：名是协议值，说明是文案
          session: { type: 'string', description: '叫 session 的参数' },
          default: { type: 'string', description: '叫 default 的参数' },
          description: { type: 'string', description: '叫 description 的参数' },
          // enum / const / default / examples 的值是协议值，不扫
          mode: { enum: ['session'], default: 'session', description: '模式说明' }
        }
      }
    }

    it('嵌套参数说明被收集，路径正确', () => {
      expect(toolLeaves(toyTool)).toEqual([
        { path: 'toy.description', text: '玩具' },
        { path: 'toy.parameters.properties.outer.description', text: '外层说明' },
        {
          path: 'toy.parameters.properties.outer.properties.inner.description',
          text: '内层说明'
        },
        { path: 'toy.parameters.properties.session.description', text: '叫 session 的参数' },
        { path: 'toy.parameters.properties.default.description', text: '叫 default 的参数' },
        {
          path: 'toy.parameters.properties.description.description',
          text: '叫 description 的参数'
        },
        { path: 'toy.parameters.properties.mode.description', text: '模式说明' }
      ])
    })

    it('description 不是字符串时不收说明叶子', () => {
      expect(toolLeaves({ name: 't', parameters: {} })).toEqual([])
    })
  })

  it('全部工具说明与参数说明零禁用词', () => {
    expect(scan(LEAVES, BANNED_TERMS, WHITELIST)).toEqual([])
  })

  it('白名单不悬空：每条都在收集结果里，且那片叶子确实命中它放行的条目', () => {
    const byPath = new Map(LEAVES.map((leaf) => [leaf.path, leaf]))
    const noWhitelist = new Map<string, string[]>()
    for (const [path, allowed] of WHITELIST) {
      const leaf = byPath.get(path)
      expect(leaf, `白名单位置 ${path} 没有对应的叶子`).toBeDefined()
      const hits = scan([leaf!], BANNED_TERMS, noWhitelist)
      expect(hits, `白名单位置 ${path} 的文字没有命中它放行的条目`).not.toEqual([])
      for (const word of allowed) {
        expect(
          hits.some((line) => line.includes(`命中「${word}」`)),
          `${path} 没有命中白名单放行的「${word}」`
        ).toBe(true)
      }
    }
  })
})
