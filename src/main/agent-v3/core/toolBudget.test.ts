/**
 * 一轮请求「开口之前就要付」的前缀预算门禁。
 *
 * ## 这道门禁替换了什么，为什么
 *
 * 老门禁在 `tools/registry.test.ts` 里，用 `序列化字符数 / 3.6` 估算、只量
 * `buildAllTools()`，阈值 60,000。2026-09-17 拿真 tokenizer 和真机实测复核，
 * 它在**三个方向上同时是错的**：
 *
 * 1. **换算错**。`/3.6` 是个统一比率，而工具描述里 49% 是中文、参数里只有 15%。
 *    中文在 BPE 下远不止 3.6 个字符一个 token，于是这个估算器**系统性低估中文**。
 *    实测：门禁报 59,898，真实 cl100k 是 110,475 —— **低估 1.84 倍**。
 *
 * 2. **范围错**。`buildAllTools()` 不含 skill 工具、`task`、`ask_user` /
 *    `voice_report` / 浏览器（这些在 `resolveAgentTools` 里现造），也不含
 *    系统提示词。量的是子集，报出来的当然小。
 *
 * 3. **方向错，这条最要命**。因为低估只发生在中文上，偏差在工具之间**不均匀**：
 *    实测单工具偏差 1.33x ~ 2.15x，偏得最狠的恰恰是中文描述最长的那批
 *    （`ue_screenshot` 2.11x、`generate_image` 2.15x）。也就是说它不只是个偏小的
 *    数，它是一张**会说谎的排行榜** —— 把「参数结构复杂」的工具排在前面，把
 *    「中文描述很长」的藏在后面。照它的排名去瘦身，砍的正好是错的那一批。
 *
 * ## 为什么用真 tokenizer 而不是继续估
 *
 * `src/shared/tokenBudget.ts` 那个 `estimateTokens` 是**运行时**用的，它要在
 * 每次组上下文时跑、不能背一份词表，估个量级就够（而且它一律往多了估，
 * 代价是少送一点内容）。这道门禁不一样：它一天跑几次、在开发机上跑、
 * 而且它要回答的是「真实成本是多少」——**这里估错的代价是几个月后才发现
 * 产品塞不进主流模型的上下文窗口**。所以这里背得起词表，也必须背。
 *
 * ## 为什么取两种编码的最大值
 *
 * `cl100k` 对着真机实测校准过：一句「你好」连着引擎，deepseek-flash 实测 112k，
 * cl100k 估 113,956（差 2%）。`o200k` 在同一批内容上只有 92,120 —— 两家对中文的
 * 词表效率不一样，而盒子是多厂商的，用户手上是哪个模型我们不知道。
 * 取 max 是唯一诚实的选择：**门禁要守的是最坏的那台机器**。
 *
 * ## 为什么是棘轮，而不是一个固定阈值
 *
 * 固定阈值只能回答「超没超」，回答不了「谁在涨」。而实测下来，2026-09-02 到
 * 09-17 这两周里总量从 59,398 涨到 112,000（+89%），工具数只从 138 到 169（+22%）
 * —— **主要不是「工具变多」，是「工具变胖」**（人均 430 → 640）。一个总量阈值
 * 对这种涨法是瞎的：它只会在某天突然变红，而那时已经胖了半年。
 *
 * 所以逐工具记账、逐工具棘轮。另外总量也是棘轮：**要加新工具，先腾地方**。
 * 这不是刁难 —— 前缀是每一轮、每一个用户、不管用不用得上都要全额付的东西，
 * 它本来就该是零和的。真要打破零和，那是工具搜索（延迟加载）该解决的问题，
 * 不是把这个数字调大能解决的问题。
 *
 * 用法：
 *   pnpm test:run src/main/agent-v3/core/toolBudget.test.ts   校验
 *   pnpm tool-budget:update                                   收紧基线（只准变小）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { electronMock, servicesMock, targetContextMock } from '../testSupport/toolMocks'

// 理由见 testSupport/toolMocks.ts 文件头
vi.mock('electron', () => electronMock())
vi.mock('../../services', () => servicesMock())
vi.mock('../../agent-v3/core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import cl100k from 'gpt-tokenizer/encoding/cl100k_base'
import o200k from 'gpt-tokenizer/encoding/o200k_base'

import { buildSystemPrompt, resolveAgentTools, type SessionContext } from './createAgent'
import { discoverEnabledSkills } from '../capabilities/skills'
import type { UnrealAgentTool } from '../tools/defineTool'

const BASELINE = join(process.cwd(), 'scripts', 'tool-budget.baseline.json')

/** 系统提示词在基线里占的键名。用非法工具名，不会和真工具撞 */
const SYSTEM_PROMPT_KEY = '(system-prompt)'

interface Baseline {
  total: number
  entries: Record<string, number>
}

/**
 * 一段文本的真实 token 数，取两家编码的最大值。
 *
 * 不做平均：平均数在「某一家特别贵」的时候会把它摊平，而我们要守的正是那一家。
 */
function tokensOf(text: string): number {
  return Math.max(cl100k.encode(text).length, o200k.encode(text).length)
}

/**
 * 一个工具在请求里的真实体积。
 *
 * 按厂商实际发的形状算：`name` + `description` + JSON Schema。信封（每个工具外面
 * 那层 `{"type":"function","function":{...}}`）各家不一样，没算进来 —— 那部分是
 * 每个工具几十 token 的固定开销，量级上不影响判断，而把它算进来就得为每家厂商
 * 维护一份信封格式。
 */
function toolText(tool: UnrealAgentTool<never>): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  })
}

/**
 * 装配**最坏情况**下的一轮前缀。
 *
 * 每一个开关都往「给得最多」的方向拨：引擎连着、截图开着、有 shell。
 * 门禁守的是上限，不是平均值 —— 按平均值守会让「某些用户的会话塞不下」
 * 这件事永远不进门禁。
 *
 * 第三方 MCP 工具**不算**：那是用户自己接的，不是我们的账。
 */
async function measure(): Promise<Record<string, number>> {
  const ctx = {
    sessionId: 'budget',
    ueConnected: true,
    editorScreenshotEnabled: true,
    shellAvailable: true,
    project: { name: 'BudgetProbe', engineVersion: '5.5', path: 'D:/UE/BudgetProbe' }
  } as SessionContext

  const skills = await discoverEnabledSkills()

  // `task` 的真身要引用尚未构造的 Agent 实例（见 createUnrealAgent），
  // 这里给一个同形状的壳：它的体积来自 name/description/schema，和闭包无关。
  const taskTool = {
    name: 'task',
    description: 'Run a sub agent on an isolated task and return its report.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        description: { type: 'string' }
      },
      required: ['prompt']
    },
    unrealBox: { namespace: 'builtin', risk: 'safe' }
  } as unknown as UnrealAgentTool<never>

  const tools = resolveAgentTools(ctx, skills, taskTool)
  const entries: Record<string, number> = {
    [SYSTEM_PROMPT_KEY]: tokensOf(buildSystemPrompt(ctx, skills))
  }
  for (const tool of tools) {
    // 撞名说明注册表出了更严重的问题，让它响而不是静默合并
    expect(entries[tool.name], `工具重名：${tool.name}`).toBeUndefined()
    entries[tool.name] = tokensOf(toolText(tool))
  }
  return entries
}

function readBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf-8')) as Baseline
  } catch {
    return null
  }
}

function sum(entries: Record<string, number>): number {
  return Object.values(entries).reduce((a, b) => a + b, 0)
}

describe('一轮请求的前缀预算', () => {
  it('逐项不得变大，总量不得变大', async () => {
    const entries = await measure()
    const total = sum(entries)
    const baseline = readBaseline()

    if (process.env.TOOL_BUDGET_UPDATE === '1') {
      // 棘轮只能往一个方向转。不拦住变大，任何卡在这道门禁上的人（尤其是 AI Agent）
      // 最省事的做法就是跑一下 update 把红灯刷成绿灯 —— 那这道门禁等于不存在。
      const grown = baseline
        ? Object.entries(entries)
            .filter(([name, n]) => n > (baseline.entries[name] ?? Infinity))
            .map(([name, n]) => `  ${name}: ${baseline.entries[name]} → ${n}`)
        : []
      if (grown.length > 0) {
        throw new Error(
          `棘轮只准变小，但这些项变大了：\n${grown.join('\n')}\n` +
            '要让某一项变大，说明它确实需要更多预算 —— 那就在别处腾出来，' +
            '或者把这次增长和理由写进 PR 说明，手改基线文件。'
        )
      }
      const sorted = Object.fromEntries(
        Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))
      )
      writeFileSync(BASELINE, `${JSON.stringify({ total, entries: sorted }, null, 2)}\n`, 'utf-8')
      return
    }

    expect(baseline, `基线文件缺失：${BASELINE}。首次生成跑 pnpm tool-budget:update`).not.toBeNull()
    const allowed = baseline as Baseline

    const grown = Object.entries(entries)
      .filter(([name, n]) => n > (allowed.entries[name] ?? Infinity))
      .map(
        ([name, n]) => `  ${name}: ${allowed.entries[name]} → ${n} (+${n - allowed.entries[name]})`
      )

    expect(
      grown,
      `这些工具的定义变大了：\n${grown.join('\n')}\n\n` +
        '前缀是每一轮、每个用户、不管用不用得上都要全额付的东西。' +
        '先看看变大的部分是不是重复的 schema 或者旧的兼容字段；' +
        '如果是真要讲的坑，考虑它能不能从「事前写进描述」改成「事后写进报错」。'
    ).toEqual([])

    const added = Object.keys(entries).filter((name) => !(name in allowed.entries))
    expect(
      total,
      `前缀总量 ${allowed.total} → ${total}（+${total - allowed.total}）。` +
        (added.length > 0 ? `新增项：${added.join('、')}。` : '') +
        '\n要加工具就得先腾地方 —— 前缀是零和的。' +
        '真要打破零和，那是工具搜索（延迟加载）要解决的问题，不是把这个数字调大。'
    ).toBeLessThanOrEqual(allowed.total)
  })
})
