/**
 * 工具预检索（Tool RAG）三臂台架 —— A/C1/C2 跑这一个脚本。
 *
 * 预登记：`docs/review/工具预检索A-B预登记-2026-09-11.md`。跑第一条样本之后
 * 那份的第 2～6 节不许改。
 *
 * | 臂 | 模型看见的工具 |
 * |---|---|
 * | A  | 现状，全给（约 155 + 会话现造的） |
 * | C1 | 常驻 36 + 台架按题面 BM25 取的前 K 个延迟工具 |
 * | C2 | 常驻 36 + 台架按题面选出的前 G 组的全部延迟工具 |
 *
 * 和上一轮（finder）唯一的差别：**谁来找**。上一轮是模型自己决定要不要调
 * finder，97% 的失败是它压根没调；这一轮找的动作在 harness 里做完，模型拿到手
 * 的就是收窄后的清单。
 *
 * 用法：
 *   1. 盒子在跑：`pnpm dev:ue-verify`
 *   2. `node tests/manual/tool-rag-bench.mjs --recall`            只算离线召回，不花钱
 *   3. `node tests/manual/tool-rag-bench.mjs --repeats 1 --only bp-door,mat-red,r-project`
 *   4. `node tests/manual/tool-rag-bench.mjs --repeats 3`
 *
 * 三臂成组相邻跑，组内顺序由固定种子排定并随机化，跑完不许重排。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

import { CASES, NEUTRAL_TOOLS } from './tool-choice-cases.mjs'
import { acceptNames, judge, pairedDiff, summarizeArm } from './tool-choice-verdict.mjs'
import { buildIndex, offlineRecall } from './tool-rag-retriever.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..', '..')
const BASE = process.env.UNREAL_BOX_HTTP || 'http://127.0.0.1:8766'
const TIMEOUT_MS = 180_000
const MAX_TOOL_CALLS = 5
/** 钉死的模型（预登记 §2）。界面上换模型不影响这批样本 */
const MODEL = { providerId: 'deepseek', modelId: 'deepseek-flash' }
export const SEED = 20260912
export const ARMS = ['A', 'C1', 'C2']

/** K / G 的候选，按预登记 §3 的规则从离线召回里选 */
const K_CANDIDATES = [5, 8, 10, 12, 15, 20]
const G_CANDIDATES = [1, 2]
const RECALL_FLOOR = 0.9

function parseArgs(argv) {
  const out = {
    repeats: 3,
    only: null,
    out: null,
    recallOnly: false,
    k: null,
    g: null,
    bm25Only: false,
    arms: ['A', 'C1', 'C2']
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repeats') out.repeats = Number(argv[++i])
    else if (argv[i] === '--only') out.only = argv[++i].split(',').map((s) => s.trim())
    else if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--recall') out.recallOnly = true
    else if (argv[i] === '--bm25') out.bm25Only = true
    else if (argv[i] === '--arms') out.arms = argv[++i].split(',').map((s) => s.trim())
    else if (argv[i] === '--k') out.k = Number(argv[++i])
    else if (argv[i] === '--g') out.g = Number(argv[++i])
  }
  return out
}

/** 题面里的事实：资产路径、本机路径、带下划线的资产/Actor 名。桩的返回里回显 */
export function factsFrom(say) {
  const found = new Set()
  for (const re of [
    /\/Game\/[\w/.-]+/g,
    /[A-Za-z]:\/[\w/.-]+/g,
    /\b[A-Z][A-Za-z]*_[A-Za-z0-9_]+\b/g
  ]) {
    for (const m of String(say).matchAll(re)) found.add(m[0])
  }
  return [...found]
}

/** 三臂顺序：六种排列里按种子随机取一种。平衡靠样本量，不靠强制交替 */
export function schedule(caseCount, repeats, seed = SEED) {
  let state = seed >>> 0
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
  const perms = [
    ['A', 'C1', 'C2'],
    ['A', 'C2', 'C1'],
    ['C1', 'A', 'C2'],
    ['C1', 'C2', 'A'],
    ['C2', 'A', 'C1'],
    ['C2', 'C1', 'A']
  ]
  const plan = []
  for (let i = 0; i < caseCount; i++) {
    for (let r = 0; r < repeats; r++) {
      plan.push({ caseIndex: i, repeat: r, order: perms[Math.floor(next() * 6)] })
    }
  }
  return plan
}

async function embedViaBox(inputs, task) {
  const res = await fetch(`${BASE}/api/debug/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs, task })
  })
  const body = await res.json()
  if (!body?.success) throw new Error(`向量化失败：${body?.error ?? res.status}`)
  return body.data
}

async function fetchTools() {
  const res = await fetch(`${BASE}/api/debug/tools`)
  const body = await res.json()
  const list = Array.isArray(body?.data) ? body.data : []
  if (list.length === 0) throw new Error('没拿到工具目录（/api/debug/tools 为空）')
  return list
}

async function runOnce(spec, arm, repeat, hideTools) {
  const sessionId = `toolrag-${arm}-${spec.tag}-${repeat}-${Date.now()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const neutral = NEUTRAL_TOOLS.filter((n) => !acceptNames(spec).includes(n))
  try {
    const res = await fetch(`${BASE}/api/debug/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: spec.say,
        sessionId,
        maxToolCalls: MAX_TOOL_CALLS,
        timeoutMs: TIMEOUT_MS,
        model: MODEL,
        stubTools: true,
        assumeUeConnected: true,
        haltOnFirstDomainCall: true,
        neutralTools: neutral,
        facts: factsFrom(spec.say),
        hideTools
      }),
      signal: controller.signal
    })
    const run = await res.json()
    run.toolMode = arm === 'A' ? 'all' : 'retrieval'
    return run
  } catch (error) {
    return { benchDown: true, success: false, errors: [String(error?.message ?? error)] }
  } finally {
    clearTimeout(timer)
  }
}

/** 判一次；C 臂的检索缺口按「答案在不在可见池里」判，不再看 finder */
function judgeRun(run, spec, arm, toolIndex) {
  const neutral = NEUTRAL_TOOLS.filter((n) => !acceptNames(spec).includes(n))
  const row = judge(run, spec, arm, toolIndex, neutral)
  if (arm !== 'A') {
    const pool = new Set(run?.toolNames ?? [])
    const names = acceptNames(spec)
    const absent = names.length > 0 && !names.some((n) => pool.has(n))
    // 答案不在池里就是检索缺口 —— 不管模型最后是选了别的还是干脆没出手：
    // 冒烟里 mat-red 在 C 臂搜了两次找不到材质工具就停了，那正是这条路线的失败形状
    row.retrievalGap = !row.hit && absent
    row.confusionGap = !row.hit && !row.noDomainCall && !absent
    row.acceptVisible = !absent
  } else {
    row.acceptVisible = true
  }
  row.visibleCount = run?.toolCount ?? null
  row.model = run?.model ?? null
  return row
}

/** McNemar：精确二项 p（双侧）+ 配对差的 Wald 95% CI */
export function mcnemar(diff) {
  const b = diff.bOnly
  const a = diff.aOnly
  const n = diff.pairs
  const m = a + b
  let p = 1
  if (m > 0) {
    const k = Math.min(a, b)
    let cum = 0
    for (let i = 0; i <= k; i++) cum += binom(m, i)
    p = Math.min(1, 2 * cum * Math.pow(0.5, m))
  }
  const d = n > 0 ? (b - a) / n : 0
  const se = n > 0 ? Math.sqrt(Math.max(0, b + a - ((b - a) * (b - a)) / n)) / n : 0
  return { p, diffPp: d * 100, lowPp: (d - 1.96 * se) * 100, highPp: (d + 1.96 * se) * 100 }
}

function binom(n, k) {
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return r
}

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '-')

function report(arms, diffs, recall, chosen) {
  const L = []
  L.push(`工具预检索 三臂（A 全给 / C1 工具级 top-K / C2 组级 top-G）· 检索 ${chosen.mode ?? ''}`)
  L.push(
    `  检索参数：K=${chosen.k}（离线召回 ${pct(recall.k.hit, recall.k.n)}）` +
      `，G=${chosen.g}（离线召回 ${pct(recall.g.hit, recall.g.n)}）`
  )
  L.push('')
  L.push('                     A            C1           C2')
  const row = (label, ...vals) =>
    L.push(`  ${label.padEnd(16)} ${vals.map((v) => String(v).padEnd(12)).join(' ')}`)
  const s = ARMS.map((a) => arms[a])
  row('有效样本', ...s.map((x) => x.n))
  row('无效样本', ...s.map((x) => x.invalid))
  row('领域路由命中', ...s.map((x) => `${x.hits} (${pct(x.hits, x.n)})`))
  row('  检索缺口', ...s.map((x) => x.retrieval))
  row('  混淆缺口', ...s.map((x) => x.confusion))
  row('  一手都没出', ...s.map((x) => x.noDomainCall))
  row('  名对action错', ...s.map((x) => x.actionMismatch ?? 0))
  row('兜底调用', ...s.map((x) => x.fallbacks))
  row('离题调用', ...s.map((x) => x.offScope))
  row('模型响应次数', ...s.map((x) => x.steps))
  row('工具调用次数', ...s.map((x) => x.toolCalls))
  row('可见工具(均)', ...s.map((x) => x.visibleAvg))
  L.push('')
  L.push('  token（合计）')
  row('  未缓存 input', ...s.map((x) => x.input))
  row('  缓存读', ...s.map((x) => x.cacheRead))
  row('  缓存写', ...s.map((x) => x.cacheWrite))
  L.push('')
  for (const arm of ['C1', 'C2']) {
    const d = diffs[arm]
    const m = mcnemar(d)
    L.push(`配对分析 ${arm} vs A（同一条用例自己跟自己比）`)
    L.push(
      `  成对 ${d.pairs}，都对 ${d.both}，都错 ${d.neither}，只有 ${arm} 对 ${d.bOnly}，只有 A 对 ${d.aOnly} —— 不一致对 ${d.discordant}`
    )
    L.push(
      `  配对差 ${m.diffPp >= 0 ? '+' : ''}${m.diffPp.toFixed(1)} pp，95% CI [${m.lowPp.toFixed(1)}, ${m.highPp.toFixed(1)}]，McNemar 精确 p = ${m.p.toFixed(3)}`
    )
    L.push('')
  }
  const reasons = {}
  for (const x of s)
    for (const [k, v] of Object.entries(x.invalidReasons ?? {})) reasons[k] = (reasons[k] ?? 0) + v
  if (Object.keys(reasons).length) {
    L.push('  无效样本的原因（不许静默剔除）：')
    for (const [k, v] of Object.entries(reasons)) L.push(`    ${k}: ${v}`)
  }
  return L.join('\n')
}

function summarize(rows) {
  const s = summarizeArm(rows)
  const valid = rows.filter((r) => !r.invalid)
  s.visibleAvg = valid.length
    ? Math.round(valid.reduce((a, r) => a + (r.visibleCount ?? 0), 0) / valid.length)
    : 0
  s.acceptVisible = valid.filter((r) => r.acceptVisible).length
  return s
}

/** 按预登记 §3 选 K / G：离线召回 ≥ 90% 的最小值；都不到就取最大候选 */
export async function chooseParams(index, cases, override = {}) {
  const table = { k: {}, g: {} }
  for (const k of K_CANDIDATES)
    table.k[k] = await offlineRecall(index, cases, (say) => index.topTools(say, k))
  for (const g of G_CANDIDATES)
    table.g[g] = await offlineRecall(
      index,
      cases,
      async (say) => (await index.topGroups(say, g)).tools
    )
  const k =
    override.k ?? K_CANDIDATES.find((k) => table.k[k].recall >= RECALL_FLOOR) ?? K_CANDIDATES.at(-1)
  const g =
    override.g ?? G_CANDIDATES.find((g) => table.g[g].recall >= RECALL_FLOOR) ?? G_CANDIDATES.at(-1)
  return { k, g, table }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cases = args.only ? CASES.filter((c) => args.only.includes(c.tag)) : CASES
  if (cases.length === 0) {
    console.error('没有匹配的用例')
    process.exit(1)
  }

  try {
    const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
    if (!health.ok) throw new Error(`HTTP ${health.status}`)
  } catch (error) {
    console.error(`连不上盒子（${BASE}）：${error?.message ?? error}`)
    console.error('要用带调试接口的那个：pnpm dev:ue-verify')
    process.exit(1)
  }

  const tools = await fetchTools()
  const toolIndex = Object.fromEntries(tools.map((t) => [t.name, t.namespace ?? '']))
  const index = await buildIndex(tools, {
    embed: args.bm25Only ? undefined : embedViaBox,
    cacheFile: path.join(APP_DIR, '.test', 'rag', 'embeddings.json')
  })
  // K/G 永远按**全部 53 条**选，--only 只影响跑哪些，不影响检索参数
  const chosen = await chooseParams(index, CASES, { k: args.k, g: args.g })

  console.log(
    `工具目录 ${tools.length} 个：常驻 ${index.resident.length}，延迟 ${index.deferred.length}，检索 ${index.mode}`
  )
  console.log('离线召回（不花钱）：')
  for (const k of K_CANDIDATES) {
    const r = chosen.table.k[k]
    console.log(
      `  工具级 K=${String(k).padStart(2)}  ${pct(r.hit, r.n)}  漏: ${r.misses.join(',') || '-'}`
    )
  }
  for (const g of G_CANDIDATES) {
    const r = chosen.table.g[g]
    console.log(`  组级   G=${g}   ${pct(r.hit, r.n)}  漏: ${r.misses.join(',') || '-'}`)
  }
  console.log(`选定：K=${chosen.k}，G=${chosen.g}`)
  if (args.recallOnly) return

  const plan = schedule(cases.length, args.repeats)
  console.log('')
  console.log(
    `臂 ${args.arms.join('/')}：${cases.length} 条 × ${args.repeats} 次 × ${args.arms.length} 臂 = ${plan.length * args.arms.length} 次会话，种子 ${SEED}，模型 ${MODEL.providerId}/${MODEL.modelId}`
  )
  console.log('')

  const rows = { A: [], C1: [], C2: [] }
  let done = 0
  for (const step of plan) {
    const spec = cases[step.caseIndex]
    for (const arm of step.order.filter((a) => args.arms.includes(a))) {
      let hideTools = []
      let picked = null
      if (arm === 'C1') {
        picked = await index.topTools(spec.say, chosen.k)
        hideTools = index.hiddenFor(picked)
      } else if (arm === 'C2') {
        const g = await index.topGroups(spec.say, chosen.g)
        picked = g.tools
        hideTools = index.hiddenFor(picked)
        spec._groups = g.groups
      }
      const run = await runOnce(spec, arm, step.repeat, hideTools)
      const row = { ...judgeRun(run, spec, arm, toolIndex), repeat: step.repeat }
      if (arm === 'C2') row.pickedGroups = spec._groups
      if (picked) row.pickedCount = picked.length
      rows[arm].push(row)
      done++
      const mark = row.invalid
        ? `✗ ${row.invalid}`
        : row.hit
          ? '✓'
          : row.actionMismatch
            ? '≈'
            : row.retrievalGap
              ? '⌀'
              : '·'
      const move = row.firstDomainCall ?? '(一手都没出)'
      process.stdout.write(
        `[${String(done).padStart(4)}/${plan.length * args.arms.length}] ${arm.padEnd(2)} ${spec.tag.padEnd(16)} ${mark.padEnd(3)} ${move.padEnd(28)} 可见 ${String(row.visibleCount ?? '?').padStart(3)}` +
          (arm === 'C2' ? ` 组 ${spec._groups.join('+')}` : '') +
          '\n'
      )
      if (run?.model && run.model !== `${MODEL.providerId}/${MODEL.modelId}`) {
        console.error(`⚠ 模型不是钉死的那个：${run.model}`)
      }
    }
  }

  const arms = { A: summarize(rows.A), C1: summarize(rows.C1), C2: summarize(rows.C2) }
  const diffs = { C1: pairedDiff(rows.A, rows.C1), C2: pairedDiff(rows.A, rows.C2) }
  const recall = { k: chosen.table.k[chosen.k], g: chosen.table.g[chosen.g] }

  console.log('')
  if (args.arms.length === 3)
    console.log(report(arms, diffs, recall, { ...chosen, mode: index.mode }))
  else {
    for (const a of args.arms) {
      const x = arms[a]
      console.log(
        `${a}: 有效 ${x.n} 无效 ${x.invalid} 命中 ${x.hits} (${pct(x.hits, x.n)}) 一手都没出 ${x.noDomainCall} 名对action错 ${x.actionMismatch} 兜底 ${x.fallbacks} 离题 ${x.offScope}`
      )
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = args.out ?? path.join(APP_DIR, '.test', `tool-rag-${stamp}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        base: BASE,
        model: MODEL,
        seed: SEED,
        repeats: args.repeats,
        maxToolCalls: MAX_TOOL_CALLS,
        casesHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex').slice(0, 16),
        toolCount: tools.length,
        resident: index.resident.map((t) => t.name),
        retrieval: index.mode,
        chosen: { k: chosen.k, g: chosen.g },
        recallTable: chosen.table,
        arms,
        diffs,
        mcnemar: { C1: mcnemar(diffs.C1), C2: mcnemar(diffs.C2) },
        rows
      },
      null,
      2
    )
  )
  console.log('')
  console.log(`原始记录：${file}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
