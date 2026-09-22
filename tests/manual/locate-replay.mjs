/**
 * 「探测折叠」判据的离线回放 —— P4 决策闸。
 *
 * ## 它要回答什么
 *
 * 今天 agent 找一个资产要走好几个来回：`ue_content_search` 拿一批候选 →
 * 模型看一眼 → 再 describe 几条 → 才挑中一个。每一个来回都是一次完整的
 * 模型请求。「探测折叠」想把中间那几步压掉：搜索工具内部直接定位到那一条。
 *
 * 这条值得先验，理由是量：`ue_content_search` 736 次 + `search_assets` 284 次
 * + 蓝图/材质节点搜索 190 次 = **1215 次，占全部工具调用的 10.7%**。
 * 对比网页检索只有 1.74%、破坏性操作 0.63%。
 *
 * ## ground truth 从哪来
 *
 * 不靠人工标注，也不靠「哪个才是对的」这种主观判断 —— 用 revealed preference：
 *
 *   一次搜索返回 N 条候选 → 之后 agent 在某次工具调用的**参数**里
 *   用上了其中一条的 path → **那一条就是它自己选的答案**
 *
 * 这个真值的好处是它问的正是我们要替换的东西：**Jev 能不能一步到位地
 * 给出 agent 绕几圈才给出的那个答案。** 我们不需要论证 Jev 更聪明，
 * 只需要它**一样**，省下的来回就是净收益。
 *
 * P1（语义撞墙）翻车的教训在这里被直接采纳了：那次我问的「是不是同一个
 * 尝试」是真正关心的东西（「会不会再失败」）的**代理**，代理断了判据就断了。
 * 这次问的就是本体 —— agent 后来用了哪条。
 *
 * ## 三个必须说在前面的上限
 *
 * 1. **Jev 拿到的信息比 agent 少。** agent 有整轮对话，Jev 只有 query 和
 *    候选表。所以这是个**下界**：过了说明 query 本身就够；没过则不能断定
 *    「加上任务上下文也不行」。不把对话正文发出去是硬约束（见 wall-replay）。
 * 2. **agent 选的不等于对的。** 它可能也选错了。这里测的是「能不能少绕几圈
 *    得到同一个结论」，不是「谁更准」。
 * 3. **枚举型搜索全部排除。** `query: "*"` + `limit: 200` 那种是「把所有资产
 *    列出来」，不是定位，折叠它没有意义。
 *
 * ## 用法
 *
 *   node tests/manual/locate-replay.mjs                # 只扫描，不联网
 *   node tests/manual/locate-replay.mjs --dry-run
 *   node tests/manual/locate-replay.mjs --run --limit=150
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = join(APP_DIR, '.test')
const OUT_FILE = join(OUT_DIR, 'locate-replay.json')

const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')
const has = (name) => process.argv.includes(`--${name}`)

const SESSION_DIR = arg('dir') || join(process.env.APPDATA || '', 'unreal-box', 'agent-v3-sessions')
const MODE = has('run') ? 'run' : has('dry-run') ? 'dry-run' : 'scan'
const LIMIT = Number(arg('limit') || 150)
const CONCURRENCY = Number(arg('concurrency') || 8)

const ENDPOINT = process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1'
const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest'
const KEY = arg('key') || process.env.TYPESAFE_API_KEY
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000

const SEARCH_TOOLS = new Set(['ue_content_search', 'search_assets', 'library_search'])
/** Choice 上限 255；但 state 越大越不准，所以卡得更紧 */
const MAX_CANDIDATES = 40
/** 搜完之后往后看几次工具调用找「它到底用了哪条」。再远就跟这次搜索没关系了 */
const LOOKAHEAD = 8

// ==================== 一、读会话 ====================

function textOf(message) {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/** 从搜索结果里抽候选。details 优先（结构化），退回正文里解 JSON */
function candidatesOf(message) {
  const fromDetails = message.details?.results
  const raw = Array.isArray(fromDetails)
    ? fromDetails
    : (() => {
        try {
          const parsed = JSON.parse(textOf(message))
          return Array.isArray(parsed?.results) ? parsed.results : []
        } catch {
          return []
        }
      })()

  return raw
    .filter((item) => item && typeof item.path === 'string')
    .map((item) => ({
      path: item.path,
      name: typeof item.name === 'string' ? item.name : item.path.split('/').pop(),
      class: typeof item.class === 'string' ? item.class : undefined
    }))
}

async function readSession(file) {
  const events = []
  const pending = new Map()
  const stream = createReadStream(file, { encoding: 'utf-8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of lines) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const message = entry?.message
    if (!message) continue

    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== 'toolCall') continue
        pending.set(part.id, { name: part.name, args: part.arguments ?? {} })
      }
      continue
    }
    if (message.role === 'toolResult') {
      const call = pending.get(message.toolCallId)
      if (!call) continue
      pending.delete(message.toolCallId)
      events.push({
        name: call.name,
        args: call.args,
        isError: message.isError === true,
        candidates: SEARCH_TOOLS.has(call.name) && !message.isError ? candidatesOf(message) : []
      })
    }
  }
  return events
}

// ==================== 二、配对 ====================

/** 枚举型搜索：没有查询词、或者用通配符把整个库列出来。折叠它没有意义 */
function isEnumeration(args, candidateCount) {
  const query = String(args.query ?? args.keywords ?? args.q ?? '').trim()
  if (!query || query === '*' || query === '**') return true
  // 查询词只有通配符和路径分隔符，本质还是列目录
  if (!/[a-z0-9一-鿿]/i.test(query.replace(/\*/g, ''))) return true
  // 候选多到这个量级时，模型本来也不是在「挑一个」
  return candidateCount > MAX_CANDIDATES
}

const serialize = (value) => {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * 从一条事件流里抽出可判的定位样本。
 *
 * 真值：搜索之后 LOOKAHEAD 次调用之内，**第一条**在参数里出现的候选 path。
 * 只有恰好命中一条时才算 —— 一次调用同时用上多条（批量移动、批量删除）
 * 说明 agent 要的不是「其中一个」，那种样本对「定位」这个判断无效。
 */
function extractSamples(events, sessionId) {
  const samples = []

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (!SEARCH_TOOLS.has(event.name) || event.candidates.length < 2) continue
    if (isEnumeration(event.args, event.candidates.length)) continue

    const paths = new Set(event.candidates.map((c) => c.path))
    let chosen = null

    for (let j = i + 1; j < Math.min(events.length, i + 1 + LOOKAHEAD) && !chosen; j++) {
      const blob = serialize(events[j].args)
      if (!blob) continue
      const hits = [...paths].filter((p) => blob.includes(p))
      // 恰好一条才算数。零条 = 还没用上；多条 = 批量操作，不是在挑一个
      if (hits.length === 1) chosen = { path: hits[0], afterCalls: j - i, byTool: events[j].name }
    }

    if (!chosen) continue
    samples.push({
      sessionId,
      tool: event.name,
      query: String(event.args.query ?? event.args.keywords ?? event.args.q ?? ''),
      filterClass: event.args.filter_class ?? event.args.class ?? undefined,
      candidates: event.candidates,
      truth: chosen.path,
      // 从搜索到真正用上它，中间隔了几次工具调用 —— 折叠能省下的就是这些
      roundTrips: chosen.afterCalls,
      byTool: chosen.byTool
    })
  }

  return samples
}

// ==================== 三、判定 ====================

/**
 * state 只有查询词和候选表。
 *
 * **不带对话正文** —— 那是硬约束（社区版承诺本机模型不出机器，而用户目标、
 * 任务描述属于对话内容）。代价写在文件头第 1 条上限里：这是个下界。
 */
function buildState(sample) {
  return {
    search_query: sample.query,
    filter_class: sample.filterClass,
    candidates: sample.candidates.map((c) => ({
      path: c.path,
      name: c.name,
      class: c.class
    }))
  }
}

/** 问题用英文写 —— judge-probe 的双臂实测，中文臂一律更不确定且更贵 */
function buildQuestion(sample) {
  return {
    target: {
      type: 'choice',
      instructions:
        'An agent searched the project content browser with `search_query` and got `candidates`. ' +
        'It then went on to work with exactly one of them. Which one?',
      criteria: Object.fromEntries(sample.candidates.map((c) => [c.path, c.name || null]))
    }
  }
}

async function askJev(sample) {
  const started = Date.now()
  const response = await fetch(`${ENDPOINT.replace(/\/+$/, '')}/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      state: buildState(sample),
      questions: buildQuestion(sample)
    }),
    signal: AbortSignal.timeout(30_000)
  })
  const ms = Date.now() - started
  const body = await response.json().catch(() => null)
  const answer = body?.answers?.target
  if (!response.ok || !answer) {
    throw new Error(body?.error?.message || body?.message || `HTTP ${response.status}`)
  }
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    ms,
    tokens: body.usage?.input_tokens ?? 0
  }
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        try {
          results[index] = { ok: true, value: await worker(items[index]) }
        } catch (error) {
          results[index] = { ok: false, error: String(error.message || error) }
        }
        if ((index + 1) % 25 === 0) process.stdout.write(`  …${index + 1}/${items.length}\n`)
      }
    })
  )
  return results
}

// ==================== 四、跑 ====================

if (!existsSync(SESSION_DIR)) {
  console.error(`会话目录不存在：${SESSION_DIR}`)
  process.exit(1)
}

const files = readdirSync(SESSION_DIR).filter((name) => name.endsWith('.jsonl'))
console.log(`会话目录：${SESSION_DIR}`)
console.log(`${files.length} 个会话，扫描中（只读工具调用，不读对话正文）…\n`)

const all = []
let searches = 0
let enumerations = 0

for (const name of files) {
  let events
  try {
    events = await readSession(join(SESSION_DIR, name))
  } catch {
    continue
  }
  for (const event of events) {
    if (!SEARCH_TOOLS.has(event.name) || event.isError) continue
    searches++
    if (isEnumeration(event.args, event.candidates.length)) enumerations++
  }
  const samples = extractSamples(events, name.replace(/\.jsonl$/, ''))
  all.push(...samples)
}

const baseline = all.filter((s) => s.candidates[0].path === s.truth).length

console.log('── 本机数据 ──────────────────────────────')
console.log(`成功的资产搜索            ${searches}`)
console.log(`  其中枚举型（已排除）     ${enumerations}`)
console.log(`可判的定位样本            ${all.length}`)
console.log(
  `  「选第一条」这个笨办法就对 ${baseline}（${all.length ? ((100 * baseline) / all.length).toFixed(1) : '—'}%）← Jev 必须明显超过它才有意义`
)
if (all.length) {
  const trips = all.map((s) => s.roundTrips).sort((a, b) => a - b)
  console.log(
    `  从搜索到用上，中间隔的调用数 中位 ${trips[Math.floor(trips.length / 2)]}，p90 ${trips[Math.floor(trips.length * 0.9)]}`
  )
  const sizes = all.map((s) => s.candidates.length).sort((a, b) => a - b)
  console.log(
    `  候选数 中位 ${sizes[Math.floor(sizes.length / 2)]}，最多 ${sizes[sizes.length - 1]}`
  )
}

if (MODE === 'scan') {
  console.log('\n只扫描，没有发出任何请求。--dry-run 看内容，--run 真跑。')
  process.exit(0)
}

const sample = all.slice(0, LIMIT)
if (sample.length === 0) {
  console.error('\n没有可判的样本。')
  process.exit(1)
}

if (MODE === 'dry-run') {
  console.log(`\n── 将要发送的内容（前 2 条，共 ${sample.length} 条）──────────\n`)
  for (const item of sample.slice(0, 2)) {
    console.log(
      JSON.stringify({ state: buildState(item), questions: buildQuestion(item) }, null, 2).slice(
        0,
        1600
      )
    )
    console.log(`  （真值：${item.truth}）\n`)
  }
  process.exit(0)
}

if (!KEY) {
  console.error('\n缺 API Key。设 TYPESAFE_API_KEY，或者 --key=...')
  process.exit(1)
}

console.log(`\n── 判定 ${sample.length} 条（并发 ${CONCURRENCY}）──────────\n`)
const outcomes = await runPool(sample, askJev, CONCURRENCY)

const records = sample.map((item, index) => ({
  sessionId: item.sessionId,
  tool: item.tool,
  query: item.query,
  candidateCount: item.candidates.length,
  roundTrips: item.roundTrips,
  truth: item.truth,
  firstIsTruth: item.candidates[0].path === item.truth,
  result: outcomes[index]
}))

const ok = records.filter((r) => r.result?.ok)
const hit = ok.filter((r) => r.result.value.choice === r.truth)
const tokens = ok.reduce((sum, r) => sum + r.result.value.tokens, 0)
const latencies = ok.map((r) => r.result.value.ms).sort((a, b) => a - b)

console.log('\n\n══ 结果 ══════════════════════════════════════════\n')
console.log(`样本 ${ok.length} 条`)
console.log(
  `与 agent 自己的选择一致    ${hit.length}（${((100 * hit.length) / ok.length).toFixed(1)}%）`
)
const base = ok.filter((r) => r.firstIsTruth).length
console.log(
  `对照 · 无脑选第一条        ${base}（${((100 * base) / ok.length).toFixed(1)}%）← 没超过它就别做`
)

console.log('\n按 confidence 分档（只在够笃定时折叠，其余照走今天的路）：')
console.log('  阈值   折叠比例   折叠时的准确率   省下的调用数')
for (const threshold of [0.5, 0.7, 0.85, 0.9, 0.95]) {
  const acted = ok.filter((r) => r.result.value.confidence >= threshold)
  const right = acted.filter((r) => r.result.value.choice === r.truth)
  const saved = right.reduce((sum, r) => sum + r.roundTrips, 0)
  console.log(
    `  ${threshold.toFixed(2)}   ${String(acted.length).padStart(4)}/${ok.length}` +
      `   ${acted.length ? ((100 * right.length) / acted.length).toFixed(1) + '%' : '—'}`.padEnd(
        12
      ) +
      `   ${saved}`
  )
}

console.log(
  `\n延迟 中位 ${latencies[Math.floor(latencies.length / 2)]}ms / p95 ${latencies[Math.floor(latencies.length * 0.95)]}ms`
)
console.log(`${tokens} input tokens ≈ $${(tokens * USD_PER_INPUT_TOKEN).toFixed(6)}`)
const failed = records.length - ok.length
if (failed) console.log(`✖ ${failed} 次请求失败`)

console.log(
  '\n验收：折叠时的准确率要**明显高于**「无脑选第一条」，而且在够高的 confidence 上' +
    '\n还能折叠掉相当一部分样本 —— 只在 0.95 上折叠 3 条，等于没做。'
)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
  OUT_FILE,
  JSON.stringify({ model: MODEL, at: new Date().toISOString(), records }, null, 2),
  'utf-8'
)
console.log(`\n明细：${OUT_FILE}`)
