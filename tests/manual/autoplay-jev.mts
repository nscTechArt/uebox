/**
 * 试玩机器人 × 真 Jev —— 判定策略的第一次真调用。
 *
 * ## 用法
 *
 *   set TYPESAFE_API_KEY=...
 *   npx vite-node tests/manual/autoplay-jev.mts
 *   npx vite-node tests/manual/autoplay-jev.mts -- --part=loop   只跑 A
 *   npx vite-node tests/manual/autoplay-jev.mts -- --part=ui     只跑 B
 *   npx vite-node tests/manual/autoplay-jev.mts -- --part=objective --runs=3   只跑 C
 *
 * 结果落 `.test/autoplay-jev.json`（.gitignore 里）。
 *
 * ## 两部分，能回答的问题不一样
 *
 * **A. 闭环接入**：假世界里的完整试玩，策略换成「每个决策点真的去问 Jev」，和规则基线同场对照。
 * 回答的是**接入层面**的问题：线格式对不对、延迟放进循环里是多少、多少次因为不够笃定回落、
 * 选错了会不会把一局跑坏。**不回答**「Jev 选得比规则好不好」—— 假世界的场景是人想出来的。
 *
 * **B. 按钮语义**：一组照真实游戏常见菜单写的按钮表，只问「点哪个能进游戏」。
 * 这是三类决策点里唯一真正要读懂文字的一类，也是最可能轮到判定模型的地方。
 * 但它**同样是合成用例** —— commit b6860c9 的教训：自己写的用例上分离度 0.97/0.05，
 * 真实数据上塌成 0.14/0.17。这里过了只说明「值得在真实 trace 上再测」，不说明该接。
 *
 * 真正的判决要等真机跑出 `autoplay-traces/*.jsonl`，拿里面的决策点离线回放。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { WorldConfig } from '../../src/main/agent-v3/tools/adapted/ue-autoplay/fakeWorld'
import { playInFakeWorld } from '../../src/main/agent-v3/tools/adapted/ue-autoplay/fakeWorld'
import {
  createFlatJudgeBrain,
  createJudgeBrain,
  ruleBrain,
  type AskJudgeRaw
} from '../../src/main/agent-v3/tools/adapted/ue-autoplay/controller'
import {
  createJudgePolicy,
  type AskJudge,
  type JudgeEvent
} from '../../src/main/agent-v3/tools/adapted/ue-autoplay/judgePolicy'
import {
  isDeniedButton,
  rulePolicy
} from '../../src/main/agent-v3/tools/adapted/ue-autoplay/policy'
import type { AutoplayOptions } from '../../src/main/agent-v3/tools/adapted/ue-autoplay/runner'
import type {
  AutoplayPolicy,
  ButtonInfo,
  DecisionPoint
} from '../../src/main/agent-v3/tools/adapted/ue-autoplay/types'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const OUT_FILE = join(APP_DIR, '.test', 'autoplay-jev.json')
const ENDPOINT = process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1'
const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest'
const KEY = process.env.TYPESAFE_API_KEY
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000
const PART = process.argv.find((a) => a.startsWith('--part='))?.split('=')[1]

if (!KEY) {
  console.error('缺 TYPESAFE_API_KEY')
  process.exit(1)
}

let inputTokens = 0
let calls = 0
let failures = 0

/** 直连 HTTP，和 judge-probe.mjs 同一个线格式。探针给 30 秒，要分清「判错」和「网络慢」 */
const ask: AskJudge = async (state, questions) => {
  calls++
  try {
    const response = await fetch(`${ENDPOINT.replace(/\/+$/, '')}/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: AbortSignal.timeout(30_000)
    })
    const body = (await response.json().catch(() => null)) as {
      answers?: Record<string, unknown>
      model?: string
      usage?: { input_tokens?: number }
      error?: unknown
    } | null
    if (!response.ok || !body?.answers) {
      failures++
      console.warn(
        `  ⚠️ HTTP ${response.status}`,
        JSON.stringify(body?.error ?? body).slice(0, 200)
      )
      return null
    }
    inputTokens += body.usage?.input_tokens ?? 0
    return { answers: body.answers, model: body.model }
  } catch (error) {
    failures++
    console.warn('  ⚠️', error instanceof Error ? error.message : String(error))
    return null
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

// ---------------------------------------------------------------------------
// A. 闭环接入
// ---------------------------------------------------------------------------

const MENU: ButtonInfo[] = [
  { id: 'WBP_Menu_C_0/Btn_Settings', owner: 'WBP_Menu_C_0', text: '设置', enabled: true },
  { id: 'WBP_Menu_C_0/Btn_Credits', owner: 'WBP_Menu_C_0', text: '制作人员', enabled: true },
  { id: 'WBP_Menu_C_0/Btn_Delete', owner: 'WBP_Menu_C_0', text: '删除存档', enabled: true },
  { id: 'WBP_Menu_C_0/Btn_Start', owner: 'WBP_Menu_C_0', text: '开始游戏', enabled: true }
]

const SCENARIOS: Array<{ id: string; config: WorldConfig; options: Partial<AutoplayOptions> }> = [
  {
    id: 'menu-then-explore',
    config: { menu: MENU, navmesh: true },
    options: { durationSeconds: 15 }
  },
  {
    id: 'goal-door',
    config: {
      navmesh: true,
      actors: { BP_Door: { x: 1200, y: 400, z: 100 } },
      door: { x: 1200, y: 400, z: 100 }
    },
    options: {
      mode: 'goal',
      goal: { reach: { actor: 'BP_Door' }, press: 'IA_Interact', untilLog: 'DoorOpened' },
      durationSeconds: 30
    }
  },
  {
    id: 'low-wall',
    config: {
      actors: { Goal: { x: 1500, y: 0, z: 100 } },
      walls: [{ minX: 600, maxX: 650, minY: -2000, maxY: 2000, low: true }]
    },
    options: { mode: 'goal', goal: { reach: { actor: 'Goal' } }, durationSeconds: 30 }
  },
  {
    id: 'high-wall',
    config: {
      actors: { Goal: { x: 1500, y: 0, z: 100 } },
      walls: [{ minX: 600, maxX: 650, minY: -5000, maxY: 5000 }]
    },
    options: { mode: 'goal', goal: { reach: { actor: 'Goal' } }, durationSeconds: 30 }
  },
  {
    id: 'explore-pit',
    config: {
      pit: { minX: -1600, maxX: -1300, minY: -300, maxY: 300 },
      killZ: -1000,
      navmesh: true
    },
    options: { durationSeconds: 20 }
  }
]

async function partLoop(): Promise<unknown> {
  console.log('\n══ A. 闭环接入：假世界整局，规则 vs 真 Jev ══')
  const rows: unknown[] = []
  for (const scenario of SCENARIOS) {
    const events: JudgeEvent[] = []
    const comparisons: Array<{ kind: string; rule: string | null; judge: string | null }> = []
    // 三类都放开：这一部分要看的正是判定器在每一类上的表现
    const judgePolicy = createJudgePolicy({
      ask,
      onAnswer: (e) => events.push(e),
      kinds: ['ui', 'waypoint', 'unstick']
    })
    // 每个决策点同时问一遍规则，记下两边是否一致 —— 执行的是 Jev 的选择
    const recording: AutoplayPolicy = {
      name: 'judge',
      async choose(point: DecisionPoint) {
        const rule = rulePolicy.choose(point)
        const judged = await judgePolicy.choose(point)
        comparisons.push({ kind: point.kind, rule: rule.optionId, judge: judged.optionId })
        return judged
      }
    }

    const ruleRun = await playInFakeWorld(scenario.config, scenario.options, rulePolicy)
    const judgeRun = await playInFakeWorld(scenario.config, scenario.options, recording)

    const used = events.filter((e) => e.usedJudge)
    const latencies = events.filter((e) => e.ms > 0).map((e) => e.ms)
    const agree = comparisons.filter((c) => c.rule === c.judge).length
    const clickedDanger = judgeRun.world.clicked.some((id) =>
      isDeniedButton(MENU.find((b) => b.id === id)?.text ?? '')
    )
    const row = {
      scenario: scenario.id,
      rule: {
        outcome: ruleRun.result.outcome,
        decisions: ruleRun.result.decisions,
        cells: ruleRun.result.cellsVisited
      },
      judge: {
        outcome: judgeRun.result.outcome,
        decisions: judgeRun.result.decisions,
        cells: judgeRun.result.cellsVisited
      },
      judge_calls: latencies.length,
      judge_used: used.length,
      fallbacks: events.filter((e) => !e.usedJudge).map((e) => `${e.kind}:${e.fallbackReason}`),
      agreement: `${agree}/${comparisons.length}`,
      disagreements: comparisons.filter((c) => c.rule !== c.judge),
      latency_ms: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        max: Math.max(0, ...latencies)
      },
      confidences: used.map((e) => Number(e.answer?.confidence.toFixed(2))),
      clicked_dangerous: clickedDanger,
      clicked: judgeRun.world.clicked
    }
    rows.push(row)
    console.log(
      `\n${scenario.id}\n  规则 ${row.rule.outcome}（${row.rule.decisions} 决策 / ${row.rule.cells} 格）` +
        `  ·  Jev ${row.judge.outcome}（${row.judge.decisions} 决策 / ${row.judge.cells} 格）` +
        `\n  调用 ${row.judge_calls} 次，采纳 ${row.judge_used}，与规则一致 ${row.agreement}` +
        `，延迟 p50 ${row.latency_ms.p50}ms / p95 ${row.latency_ms.p95}ms / max ${row.latency_ms.max}ms` +
        (row.fallbacks.length ? `\n  回落：${[...new Set(row.fallbacks)].join('；')}` : '') +
        (row.disagreements.length
          ? `\n  分歧：${row.disagreements
              .map((d) => `${d.kind} 规则=${d.rule} Jev=${d.judge}`)
              .slice(0, 6)
              .join('；')}`
          : '') +
        (clickedDanger ? '\n  ❌ 点了危险按钮' : '')
    )
  }
  return rows
}

// ---------------------------------------------------------------------------
// B. 按钮语义
// ---------------------------------------------------------------------------

interface UiCase {
  id: string
  buttons: string[]
  /** 能接受的答案（按钮文字）。null = 应该一个都不点 */
  expect: string[] | null
  tried?: string[]
}

const UI_CASES: UiCase[] = [
  { id: 'zh-main', buttons: ['开始游戏', '设置', '制作人员', '退出游戏'], expect: ['开始游戏'] },
  {
    id: 'zh-main-save',
    buttons: ['继续游戏', '新游戏', '读取存档', '选项'],
    expect: ['继续游戏', '新游戏']
  },
  {
    id: 'en-main',
    buttons: ['New Game', 'Load Game', 'Options', 'Credits', 'Quit'],
    expect: ['New Game']
  },
  { id: 'en-pause', buttons: ['Resume', 'Options', 'Quit to Main Menu'], expect: ['Resume'] },
  { id: 'zh-pause', buttons: ['返回游戏', '设置', '返回主菜单'], expect: ['返回游戏'] },
  { id: 'zh-dialog', buttons: ['确定', '取消'], expect: ['确定'] },
  { id: 'zh-cutscene', buttons: ['跳过'], expect: ['跳过'] },
  { id: 'zh-levelselect', buttons: ['第一关', '第二关（未解锁）', '返回'], expect: ['第一关'] },
  // 规则的关键词表里没有这些词 —— 这几条才是判定器可能真比规则强的地方
  { id: 'zh-offwords', buttons: ['出发', '图鉴', '商店'], expect: ['出发'] },
  { id: 'en-offwords', buttons: ['Embark', 'Codex', 'Store'], expect: ['Embark'] },
  { id: 'zh-press-any', buttons: ['点击任意处开始'], expect: ['点击任意处开始'] },
  { id: 'en-deploy', buttons: ['Deploy', 'Loadout', 'Barracks'], expect: ['Deploy'] },
  { id: 'zh-ready', buttons: ['准备就绪', '更换角色', '好友'], expect: ['准备就绪'] },
  // 没有能进游戏的按钮
  { id: 'zh-none', buttons: ['画面', '音频', '按键设置'], expect: null },
  { id: 'en-none', buttons: ['Graphics', 'Audio', 'Controls'], expect: null },
  // 点过「开始」没反应，下一步该试别的
  {
    id: 'zh-tried',
    buttons: ['开始游戏', '继续游戏', '设置'],
    expect: ['继续游戏'],
    tried: ['开始游戏']
  }
]

function uiPoint(c: UiCase): DecisionPoint {
  return {
    kind: 'ui',
    state: {
      mode: 'goal',
      input: { viewport_ignores_input: true, show_mouse_cursor: true },
      tried: (c.tried ?? []).map((text) => `W/${text}`)
    },
    options: c.buttons.map((text) => ({
      id: `W/${text}`,
      label: text,
      features: { enabled: !/未解锁/.test(text), denied: isDeniedButton(text), owner: 'W' }
    }))
  }
}

function grade(c: UiCase, optionId: string | null): boolean {
  const text = optionId?.slice(2) ?? null
  if (c.expect === null) return text === null
  return text !== null && c.expect.includes(text)
}

async function partUi(): Promise<unknown> {
  console.log('\n══ B. 按钮语义：「点哪个能进游戏」（合成用例，只看方向）══')
  const rows: unknown[] = []
  let ruleOk = 0
  let judgeOk = 0
  let judgeAbstain = 0
  for (const c of UI_CASES) {
    const events: JudgeEvent[] = []
    const policy = createJudgePolicy({ ask, onAnswer: (e) => events.push(e), minConfidence: 0 })
    const rule = rulePolicy.choose(uiPoint(c))
    const judged = await policy.choose(uiPoint(c))
    const event = events[0]
    const rOk = grade(c, rule.optionId)
    const jOk = grade(c, judged.optionId)
    if (rOk) ruleOk++
    if (jOk) judgeOk++
    const confidence = event?.answer?.confidence ?? null
    if (confidence !== null && confidence < 0.5) judgeAbstain++
    rows.push({
      case: c.id,
      buttons: c.buttons,
      expect: c.expect,
      rule: rule.optionId?.slice(2) ?? null,
      rule_ok: rOk,
      judge: judged.optionId?.slice(2) ?? null,
      judge_ok: jOk,
      judge_used: event?.usedJudge ?? false,
      confidence,
      probabilities: event?.answer?.probabilities ?? null,
      ms: event?.ms ?? 0
    })
    console.log(
      `${jOk ? '✓' : '✗'} ${c.id.padEnd(16)} Jev→${String(judged.optionId?.slice(2) ?? '（不点）').padEnd(10)}` +
        ` conf ${confidence === null ? ' —  ' : confidence.toFixed(2)}  ${String(event?.ms ?? 0).padStart(4)}ms` +
        `   规则${rOk ? '✓' : '✗'}→${rule.optionId?.slice(2) ?? '（不点）'}` +
        (event && !event.usedJudge ? `   [${event.fallbackReason}]` : '')
    )
  }
  console.log(
    `\n  Jev ${judgeOk}/${UI_CASES.length}  ·  规则 ${ruleOk}/${UI_CASES.length}  ·  Jev confidence<0.5 的 ${judgeAbstain} 条`
  )
  return { rows, judge_correct: judgeOk, rule_correct: ruleOk, total: UI_CASES.length }
}

// ---------------------------------------------------------------------------
// C. 目标控制器：Jev 当每一步的决策者，看任务完成没有
// ---------------------------------------------------------------------------

interface ObjectiveTask {
  id: string
  objective: string
  untilLog: string
  world: WorldConfig
  /** 这条任务在考什么 */
  tests: string
}

const OBJECTIVE_TASKS: ObjectiveTask[] = [
  {
    id: 'chest-en',
    objective: 'Open the chest',
    untilLog: 'Chest opened',
    tests: '对照组：英文目标、名字直接对得上，规则基线应该能做到',
    world: {
      items: [
        {
          name: 'BP_Chest',
          class: 'BP_Chest_C',
          location: { x: 1200, y: 500, z: 100 },
          kind: 'chest'
        },
        {
          name: 'BP_Barrel',
          class: 'BP_Barrel_C',
          location: { x: -700, y: 300, z: 100 },
          kind: 'decor'
        }
      ]
    }
  },
  {
    id: 'key-door-zh',
    objective: '找到钥匙，然后用它把门打开',
    untilLog: 'DoorOpened',
    tests: '中文目标对英文名字；两步有先后（先拿钥匙再开门，直接开门会提示锁着）',
    world: {
      items: [
        { name: 'BP_Key', class: 'BP_Key_C', location: { x: 900, y: -800, z: 100 }, kind: 'key' },
        {
          name: 'BP_Door',
          class: 'BP_Door_C',
          location: { x: 1600, y: 700, z: 100 },
          kind: 'door'
        },
        {
          name: 'BP_Chest',
          class: 'BP_Chest_C',
          location: { x: -800, y: 600, z: 100 },
          kind: 'chest'
        },
        {
          name: 'BP_Barrel',
          class: 'BP_Barrel_C',
          location: { x: 300, y: 900, z: 100 },
          kind: 'decor'
        }
      ]
    }
  },
  {
    id: 'lever-gate-zh',
    objective: '拉下拉杆打开闸门，然后穿过闸门走到出口',
    untilLog: 'Reached BP_Exit',
    tests: '出口就在眼前但被闸门挡着；要先绕去拉杆那里',
    world: {
      walls: [{ minX: 1000, maxX: 1060, minY: -4000, maxY: 4000, gate: 'G1', name: 'BP_Gate' }],
      items: [
        {
          name: 'BP_Lever',
          class: 'BP_Lever_C',
          location: { x: -600, y: -700, z: 100 },
          kind: 'lever',
          opens: 'G1'
        },
        { name: 'BP_Exit', class: 'BP_Exit_C', location: { x: 1800, y: 0, z: 100 }, kind: 'goal' },
        {
          name: 'BP_Crate',
          class: 'BP_Crate_C',
          location: { x: 400, y: 600, z: 100 },
          kind: 'decor'
        }
      ]
    }
  }
]

OBJECTIVE_TASKS.push({
  id: 'opaque-names-zh',
  objective: '找到钥匙，然后用它把门打开',
  untilLog: 'DoorOpened',
  tests: '对象名字毫无意义（BP_Prop_01…），语义只在蓝图的父类、接口、事件名里',
  world: {
    items: [
      {
        name: 'BP_Prop_01',
        class: 'BP_Prop_01_C',
        location: { x: -900, y: 700, z: 100 },
        kind: 'chest',
        parents: ['BP_TreasureChest_C', 'Actor'],
        events: ['Interact', 'Open']
      },
      {
        name: 'BP_Prop_02',
        class: 'BP_Prop_02_C',
        location: { x: 1500, y: 600, z: 100 },
        kind: 'door',
        parents: ['BP_LockedDoor_C', 'Actor'],
        events: ['Interact', 'Unlock', 'OpenDoor']
      },
      {
        name: 'BP_Prop_03',
        class: 'BP_Prop_03_C',
        location: { x: 900, y: -900, z: 100 },
        kind: 'key',
        parents: ['BP_KeyPickup_C', 'Actor'],
        events: ['OnPickedUp']
      },
      {
        name: 'BP_Prop_04',
        class: 'BP_Prop_04_C',
        location: { x: 300, y: 1000, z: 100 },
        kind: 'decor',
        parents: ['BP_Bench_C', 'Actor'],
        events: []
      }
    ]
  }
})

OBJECTIVE_TASKS.push({
  id: 'hidden-key-zh',
  objective: '找到钥匙，然后用它把门打开',
  untilLog: 'DoorOpened',
  tests: '钥匙一开始在感知范围（25 米）外，得先探索；门就在旁边，直接去开会提示锁着',
  world: {
    items: [
      { name: 'BP_Door', class: 'BP_Door_C', location: { x: 900, y: 300, z: 100 }, kind: 'door' },
      { name: 'BP_Key', class: 'BP_Key_C', location: { x: -3200, y: 400, z: 100 }, kind: 'key' },
      {
        name: 'BP_Bench',
        class: 'BP_Bench_C',
        location: { x: 200, y: -900, z: 100 },
        kind: 'decor'
      }
    ]
  }
})

async function partObjective(): Promise<unknown> {
  console.log('\n══ C. 目标控制器：每一步由谁选动作，任务完成没有 ══')
  const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 2)
  const rows: unknown[] = []
  for (const task of OBJECTIVE_TASKS) {
    console.log(`\n${task.id} —— ${task.objective}\n  （${task.tests}）`)
    // jev = 拆开问 + 整关场景；jev-眼前 = 同一个大脑但只有射线和 25 米内的附近（老插件的情况）
    const brains = [
      { label: 'rule', brain: ruleBrain, runs: 1, scene: true },
      { label: 'jev-眼前', brain: createJudgeBrain(ask as AskJudgeRaw), runs, scene: false },
      { label: 'jev', brain: createJudgeBrain(ask as AskJudgeRaw), runs, scene: true }
    ]
    void createFlatJudgeBrain
    for (const { label, brain, runs: n, scene } of brains) {
      for (let i = 0; i < n; i++) {
        const { result, trace } = await playInFakeWorld(
          { ...task.world, scene },
          {
            mode: 'objective',
            objective: task.objective,
            brain,
            goal: { untilLog: task.untilLog },
            durationSeconds: 60
          },
          rulePolicy
        )
        const c = result.controller
        const lat = [...(c?.latencyMs ?? [])].sort((a, b) => a - b)
        const ticks = trace.records.filter((r) => r.type === 'tick')
        const row = {
          task: task.id,
          brain: label,
          run: i + 1,
          success: result.outcome === 'goal_reached',
          outcome: result.outcome,
          ticks: c?.ticks ?? 0,
          judge_decisions: c?.judgeDecisions ?? 0,
          latency_p50: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
          actions: c?.actionCounts,
          path: ticks.map((t) => t.chosen)
        }
        rows.push(row)
        console.log(
          `  ${row.success ? '✓' : '✗'} ${label.padEnd(4)} #${i + 1}  ${row.outcome.padEnd(20)} ${String(row.ticks).padStart(3)} 步` +
            (label !== 'rule' ? `  延迟中位 ${row.latency_p50}ms` : '') +
            `\n      ${row.path.slice(0, 14).join(' → ')}${row.path.length > 14 ? ' …' : ''}`
        )
      }
    }
  }
  return rows
}

// ---------------------------------------------------------------------------

const out: Record<string, unknown> = { model: MODEL, at: new Date().toISOString() }
if (!PART || PART === 'ui') out.ui = await partUi()
if (!PART || PART === 'loop') out.loop = await partLoop()
if (!PART || PART === 'objective') out.objective = await partObjective()
out.calls = calls
out.failures = failures
out.input_tokens = inputTokens
out.cost_usd = Number((inputTokens * USD_PER_INPUT_TOKEN).toFixed(5))

mkdirSync(join(APP_DIR, '.test'), { recursive: true })
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2))
console.log(
  `\n共 ${calls} 次调用，失败 ${failures}，输入 ${inputTokens} token ≈ $${out.cost_usd}\n结果：${OUT_FILE}`
)
