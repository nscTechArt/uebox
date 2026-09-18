/**
 * 技能路由的真机探针 —— 少量样本，验判定链路本身。
 *
 * ## 为什么走 HTTP 而不是 verify-real-model.mjs
 *
 * `verify-real-model.mjs` 那条路要 `playwright-core`，而它**从来没被声明过**：
 * 不在 `package.json`、不在 `pnpm-lock.yaml`、git 历史里也没有过，
 * 但有 8 个 `tests/manual/*.mjs` 在 import 它。也就是说那一整族脚手架
 * 在干净检出上**一次都跑不起来**。加依赖是要人点头的事（AGENTS.md §5 规则 7），
 * 所以这里换一条已经存在、且不需要新依赖的路。
 *
 * `/api/debug/agent` 跑的是**同一个** `createUnrealAgent`，同一套工具池、
 * 同一份系统提示词、同一个模型角色。它甚至比 IPC 那条路更安全：
 * `approvalMode: 'ask'` + 一个只放行引擎内操作的审批函数，
 * 动本机磁盘和跑命令一律拒绝并记账（见 server.ts 里那段注释，
 * 起因是一次真实事故：模型改掉了用户不在 git 下的 .uproject）。
 *
 * ## 用法
 *
 *   1. 盒子在跑（pnpm dev）
 *   2. node tests/manual/skill-routing-probe.mjs
 *
 * 会真的发 API 请求，产生费用。默认只跑不依赖引擎的只读用例。
 *
 * ## 这不是评测
 *
 * 每条只跑一次，样本量根本不够下任何结论。它要回答的只有一件事：
 * **判定链路在真机上是不是真的能把六种情况分开**。
 * 正式的 A/B 要按预登记来（见 docs/review/ 里的落地计划）。
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { sameProject } from './eval-project.mjs'
import { CASES as ALL_CASES } from './skill-routing-cases.mjs'
import {
  callsFromDebugAgent,
  classify,
  sampleValidity,
  summarize
} from './skill-routing-verdict.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..', '..')
const BASE = process.env.UNREAL_BOX_HTTP || 'http://127.0.0.1:8766'
const TIMEOUT_MS = 240_000

/**
 * 工具调用上限。跑飞的 agent 会一直转，而这一轮只关心它**开头怎么决策**。
 *
 * 12 不是随手取的：路由判定要看第一次 `load_skill` 和第一个业务调用，
 * 上限设得太小会把「还没来得及调」截断成 `not-read`，造出一个假的失败。
 * 第一轮真机里 deep-research 一口气调了 9 次（3 次搜 + 6 次读页），
 * 所以留到 12 才有余量。
 */
const MAX_TOOL_CALLS = 12

/**
 * 用例来自 `skill-routing-cases.mjs`，这里**只跑不依赖引擎的那些**。
 *
 * 原来这个文件里内联着三条自己写的用例。共享之后两条好处：用例的
 * 「不许逐字抄触发词」那条规矩由 `skill-routing-cases.test.ts` 统一守住；
 * 两个入口跑的是同一批题，结果才对得起来。
 *
 * HTTP 这条路连不上引擎，所以 UE 类用例在这里跑不了 —— 不是跳过，
 * 是它们本来就该走 `verify-real-model.mjs` 那条（真机 + 一次性副本）。
 */
// 依赖引擎的用例默认**不跑**：它们会真的改工程。要跑得带 `--engine`，
// 而且脚本会先核对引擎连着的确实是那个一次性副本（`eval-project.mjs` 的判据），
// 核不上就直接拒绝 —— 旁边常年连着两三个真实工程。
const ALLOW_ENGINE = process.argv.includes('--engine')
const CASES = ALL_CASES.filter((c) => ALLOW_ENGINE || !c.needsEngine)

async function runCase(testCase, index) {
  const sessionId = `probe-${Date.now()}-${index}-${testCase.tag}`
  let json
  try {
    const res = await fetch(`${BASE}/api/debug/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        prompt: testCase.say,
        timeoutMs: TIMEOUT_MS,
        maxToolCalls: MAX_TOOL_CALLS,
        // 被测形态由环境变量给，默认沿用盒子设置。开着工具搜索时这条探针问的
        // 是另一个问题：**领域工具被折叠之后**，模型还会不会主动去读技能 ——
        // 那正是「技能带组」这条主路径成不成立的关键。
        ...(process.env.TOOL_SEARCH === '1' ? { toolSearchEnabled: true } : {}),
        ...(process.env.TOOL_SEARCH === '0' ? { toolSearchEnabled: false } : {}),
        ...(process.env.THINKING ? { thinkingLevel: process.env.THINKING } : {})
      })
    })
    json = await res.json()
  } catch (error) {
    json = { success: false, errors: [String(error)] }
  }

  const calls = callsFromDebugAgent(json.toolCalls ?? [])
  const result = classify(calls, testCase)

  // 撞到我们自己设的工具调用上限**不等于样本无效，也不等于样本有效**——
  // 要看这条判定断言的是「发生过」还是「没发生过」。
  //
  // 端点到顶时 `agent.abort()`，于是 `success: false` + "This operation was aborted"，
  // 和「模型压根没跑起来」长得一模一样，得先把这两者分开。分开之后还有一层：
  // `same-response` 这类断言「已经观察到」的判定，证据在手里，截断不影响；
  // 而 `not-read` / `no-skill-ok` 断言的是「整轮都没发生」，被半路叫停的话，
  // 模型本来完全可能在后面才去加载技能 —— 这种结论必须整轮正常结束才作数。
  const truncated = json.hitToolCap === true
  const validity = sampleValidity({
    execResult: {
      success: json.success === true || truncated,
      error: json.errors?.[0] ?? json.error
    },
    calls,
    sessionId,
    truncated,
    verdict: result.verdict,
    requiredCompeting: testCase.requiredCompeting,
    toolNames: json.toolNames ?? null
  })
  return { case: testCase.tag, sessionId, json, calls, validity, result }
}

const health = await fetch(`${BASE}/api/health`).catch(() => null)
if (!health?.ok) {
  console.log(`✖ 连不上 ${BASE} —— 先跑 pnpm dev 把盒子起起来。`)
  process.exit(1)
}

if (ALLOW_ENGINE) {
  const project = process.env.SKILL_EVAL_UE_PROJECT || ''
  if (!project) {
    console.log('✖ --engine 需要 SKILL_EVAL_UE_PROJECT 指向那个一次性副本。')
    process.exit(2)
  }
  const res = await fetch(`${BASE}/api/debug/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ue_session_health', args: {} })
  }).catch(() => null)
  const conns = (await res?.json().catch(() => null))?.data?.details?.connections ?? []
  const opts = {
    resolve: (x) => path.resolve(x),
    dirname: (x) => path.dirname(x),
    isWindows: process.platform === 'win32'
  }
  const matched = conns.filter((c) => sameProject(c.project_path, project, opts))
  if (matched.length !== 1) {
    console.log(`✖ 连着 ${conns.length} 个工程，其中 ${matched.length} 个是声明的一次性副本：`)
    for (const c of conns) console.log(`    ${c.project_name}  ${c.project_path}`)
    console.log(`  期望正好 1 个匹配 ${project} —— 拒绝在这种状态下跑写操作用例。`)
    process.exit(3)
  }
  console.log(`引擎核对通过：${matched[0].project_name}（${matched[0].connection_id}）`)
}

// ── 命令行 ────────────────────────────────────────────────────────────────
//
// --reps=N      每条用例重复几次（0-7 试跑要 5；缺省 1）
// --only=a,b    只跑这几个 tag
// --tag=NAME    给这次运行起个名字，写进结果文件名
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const REPS = Number(argOf('reps', '1'))
const ONLY = argOf('only', '').split(',').filter(Boolean)
const RUN_TAG = argOf('tag', 'probe')

const selected = ONLY.length ? CASES.filter((c) => ONLY.includes(c.tag)) : CASES
if (selected.length === 0) {
  console.log(`✖ --only 没选中任何用例；可选：${CASES.map((c) => c.tag).join(', ')}`)
  process.exit(2)
}

console.log(`探针目标：${BASE}`)
console.log(`用例 ${selected.length} 条 × 重复 ${REPS} 次 = ${selected.length * REPS} 次会话\n`)

const samples = []
const startedAll = Date.now()
let n = 0
for (let rep = 0; rep < REPS; rep++) {
  for (const c of selected) {
    const t0 = Date.now()
    const s = await runCase(c, n++)
    s.rep = rep
    s.elapsedMs = Date.now() - t0
    s.at = new Date().toISOString()
    samples.push(s)

    const verdict = s.validity.ok ? s.result.verdict : `无效:${s.validity.reason}`
    const mark = s.validity.ok ? (s.result.pass ? '✅' : '✖') : '—'
    console.log(
      `[${String(n).padStart(3)}/${selected.length * REPS}] ${c.tag} #${rep}  ` +
        `${mark} ${verdict}  ${Math.round(s.elapsedMs / 1000)}s  ` +
        `调用 ${s.calls.length}${s.json.hitToolCap ? '(触顶)' : ''}`
    )
  }
}

// ── 逐用例波动：同一条跑 N 次出现几种判定 ────────────────────────────────
//
// 预登记 §5 把它列为 0-7 的头号产出之一。方差本身是指标：
// 5 次跑出 5 种解读，说明这条用例问得不够稳，不该进正式实验。
console.log('\n── 逐用例（判定分布 / 耗时中位数）──')
const byCase = new Map()
for (const s of samples) {
  if (!byCase.has(s.case)) byCase.set(s.case, [])
  byCase.get(s.case).push(s)
}
const variance = []
for (const [tag, list] of byCase) {
  const verdicts = list.map((x) => (x.validity.ok ? x.result.verdict : `无效:${x.validity.reason}`))
  const distinct = [...new Set(verdicts)]
  const ms = list.map((x) => x.elapsedMs).sort((a, b) => a - b)
  const median = ms[Math.floor(ms.length / 2)]
  const passes = list.filter((x) => x.validity.ok && x.result.pass).length
  const valid = list.filter((x) => x.validity.ok).length
  variance.push({ tag, distinct: distinct.length, verdicts, medianMs: median, passes, valid })
  console.log(
    `  ${tag.padEnd(20)} ${distinct.length} 种  ${median / 1000}s  ` +
      `通过 ${passes}/${valid}  ${distinct.join(' | ')}`
  )
}

const s = summarize(samples)
console.log('\n── 小结 ──')
console.log(
  `  有效 ${s.valid}/${s.total}${s.invalid ? `  无效: ${JSON.stringify(s.invalidByReason)}` : ''}`
)
console.log(`  通过率 ${s.passRate ?? '—'}   混淆率 ${s.confusionRate ?? '—'}`)
console.log(`  同响应批量派发率 ${s.sameResponseRate ?? '—'}（诊断指标，分母 ${s.skipUsable}）`)
console.log(`  按判定分布: ${JSON.stringify(s.byVerdict)}`)
console.log(`  总耗时 ${Math.round((Date.now() - startedAll) / 1000)}s`)

// 预登记 §7：结果文件保留**原始逐样本记录**，不只保留汇总。
// 汇总藏得住的东西，原始记录藏不住。
const outFile = path.join(
  APP_DIR,
  '.test',
  `skill-routing-${RUN_TAG}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
)
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      runTag: RUN_TAG,
      at: new Date().toISOString(),
      path: 'http:/api/debug/agent',
      base: BASE,
      reps: REPS,
      maxToolCalls: MAX_TOOL_CALLS,
      model: samples[0]?.json?.model ?? null,
      caseSetSha256: createHash('sha256')
        .update(fs.readFileSync(path.join(APP_DIR, 'tests', 'manual', 'skill-routing-cases.mjs')))
        .digest('hex'),
      summary: s,
      variance,
      samples: samples.map((x) => ({
        case: x.case,
        rep: x.rep,
        at: x.at,
        elapsedMs: x.elapsedMs,
        sessionId: x.sessionId,
        verdict: x.result.verdict,
        pass: x.result.pass,
        validity: x.validity,
        hitToolCap: x.json.hitToolCap ?? false,
        toolCount: x.json.toolCount ?? null,
        ueConnected: x.json.ueConnected ?? null,
        steps: x.json.steps ?? null,
        calls: x.calls.map((cc) => ({ tool: cc.toolName, response: cc.response, args: cc.args }))
      }))
    },
    null,
    2
  ),
  'utf8'
)
console.log(`\n逐样本记录: ${outFile}`)
console.log('\n0-7 是方法试跑，不下任何关于描述好坏的结论（预登记 §5、§7）。')

// 分数低是正常结束；跑不成才是失败
process.exit(s.valid === 0 ? 1 : 0)
