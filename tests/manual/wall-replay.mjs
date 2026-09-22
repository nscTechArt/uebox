/**
 * 语义撞墙判据的离线回放 —— P1 决策闸。
 *
 * ## 它要回答什么
 *
 * `loopBreaker.ts` 按 `工具名 + JSON.stringify(args)` 精确计数。它的注释把
 * 失败模式写成「模型改个无关紧要的措辞再调一次」—— 而精确匹配正好拦不住
 * 那个。合成用例上 Jev 分得很开（0.97 / 0.05），但用例是我们自己写的。
 *
 * 这里拿**真实历史会话**再问一遍，而且用的是一条能自动判对错的 ground truth。
 *
 * ## ground truth 从哪来（这是整个脚本成立的前提）
 *
 * 「这两次调用是不是同一个尝试」本身就是要判的东西，没法人工标注几千条。
 * 但有一类对**答案是数据自己给的**：
 *
 *   上一次调用失败了 → 下一次同名工具调用**成功了**
 *
 * 成功就说明这次换的东西起了作用，**按定义它就不是同一个尝试**。
 * Jev 在这类对上判「是」，就是一次确凿的误拦（false positive）——
 * 不需要任何人工判断。
 *
 * 这正好对上验收标准里最硬的那条：**误拦率必须接近零**。误拦的代价是
 * agent 被熔断器卡死在一个它本来能绕过去的地方，比漏拦严重得多。
 *
 * 另一侧（漏拦）没有同等干净的真值，只有一个结果代理：同名工具连续失败
 * 到底、整段再没成功过。脚本把这类单独报，但**不拿它算通过率** ——
 * 「一直没成功」不等于「每一次重试都是同一个尝试」。
 *
 * ## 隐私
 *
 * 只取 **工具名 + 参数 + 错误信息**。用户消息、助手正文、思考内容一律不读、
 * 不发。这条是硬的：社区版承诺「跑本机模型 AI 也不出机器」，会话正文属于
 * 那个承诺，工具参数是执行记录。
 *
 * 即便如此，参数里会有用户工程的资产路径。所以：
 *
 *   - `--scan` 是默认行为，**完全不联网**，只统计本机数据长什么样；
 *   - `--dry-run` 把将要发出去的 state 原样打印，看过了再决定；
 *   - 只有显式 `--run` 才会真的发请求。
 *
 * ## 用法
 *
 *   node tests/manual/wall-replay.mjs                 # 只扫描，不联网
 *   node tests/manual/wall-replay.mjs --dry-run       # 打印将要发送的内容
 *   node tests/manual/wall-replay.mjs --run --limit=200
 *
 * 结果落 `.test/wall-replay.json`。
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = join(APP_DIR, '.test')
const OUT_FILE = join(OUT_DIR, 'wall-replay.json')

const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')
const has = (name) => process.argv.includes(`--${name}`)

/** 会话目录。默认取本机安装的那份，可以指向拷贝出来的快照 */
const SESSION_DIR = arg('dir') || join(process.env.APPDATA || '', 'unreal-box', 'agent-v3-sessions')

const MODE = has('run') ? 'run' : has('dry-run') ? 'dry-run' : 'scan'
const LIMIT = Number(arg('limit') || 200)
/** 1200 req/min 的额度，8 路并发离它还很远 */
const CONCURRENCY = Number(arg('concurrency') || 8)

const ENDPOINT = process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1'
const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest'
const KEY = arg('key') || process.env.TYPESAFE_API_KEY
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000

/**
 * 判「同一个尝试」的阈值。
 *
 * 0.85 是从合成用例读的：正例 0.92~0.97，反例 ≤0.25。这次回放要验的正是
 * 这条线在真实数据上还站不站得住 —— 所以它是**被检验的对象**，不是已知值。
 * 脚本另外按 0.5 / 0.7 / 0.9 各算一遍误拦率，让曲线自己说话。
 */
const THRESHOLDS = [0.5, 0.7, 0.85, 0.9, 0.95]

// ==================== 一、读会话 ====================

/** 参数里可能有循环引用；序列化不了就退回工具名，和 loopBreaker 的口径一致 */
function callKey(name, args) {
  try {
    return `${name}::${JSON.stringify(args)}`
  } catch {
    return `${name}::<unserializable>`
  }
}

/** 工具结果的正文。只取文本，图片一律丢掉 */
function resultText(message) {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .slice(0, 600)
}

/**
 * 把一个会话读成**按时间排好的工具调用流**。
 *
 * 只读 assistant 消息里的 toolCall 和与之配对的 toolResult。
 * user / assistant 的正文一个字都不碰 —— 见文件头的隐私那段。
 */
async function readSession(file) {
  const calls = []
  const pending = new Map()

  const stream = createReadStream(file, { encoding: 'utf-8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of lines) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue // 崩溃时写了半行。跳过，不让一行坏数据废掉整个会话
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
      calls.push({
        name: call.name,
        args: call.args,
        key: callKey(call.name, call.args),
        isError: message.isError === true,
        text: message.isError === true ? resultText(message) : ''
      })
    }
  }

  return calls
}

// ==================== 二、配对 ====================

/**
 * 从一条调用流里抽出待判的对。
 *
 * 对的定义：**同名工具**的一次失败，和它之后最近的一次同名调用。
 * 跨工具不配对 —— `loopBreaker` 也是按工具名分桶的，跨工具比没有意义。
 *
 * 三类：
 *   - `exact`   参数一字不差。今天的精确匹配已经拦得住，拿来做一致性检查
 *   - `recovered` 后一次**成功了** → ground truth = 不是同一个尝试（误拦测试）
 *   - `persisted` 后一次也失败，参数不同 → 今天拦不住，没有硬真值（召回代理）
 */
function extractPairs(calls, sessionId) {
  const pairs = []
  const lastFailure = new Map()

  for (const call of calls) {
    const previous = lastFailure.get(call.name)
    if (previous) {
      const exact = previous.key === call.key
      pairs.push({
        sessionId,
        tool: call.name,
        kind: exact ? 'exact' : call.isError ? 'persisted' : 'recovered',
        previous: { args: previous.args, error: previous.text },
        current: { args: call.args },
        // 只有 recovered 这一类有硬真值：成功了就不是同一个尝试
        truth: !call.isError && !exact ? false : null
      })
    }
    if (call.isError) lastFailure.set(call.name, call)
    else lastFailure.delete(call.name)
  }

  return pairs
}

// ==================== 三、判定 ====================

/**
 * ## 为什么只发差异，不发参数全文
 *
 * 第一次 `--dry-run` 就发现两件事，而且是同一个修法：
 *
 * 1. **参数里装着用户正文。** `ue_run_python_script`、`write_file` 这些工具
 *    的参数里是整篇文案、旁白、脚本。「只发工具参数不发对话正文」这个区分
 *    实际上站不住 —— 参数里就装着对话正文的衍生物。
 * 2. **参数动辄上万字符。** jaggedness 明说「state 越大、无关内容越多，
 *    准确率越低」，官方给的解法就是「先在代码里筛，只发问题需要的字段」。
 *
 * 判「这两次是不是同一个尝试」需要的**只有差异**：哪些键没变（键名就够，
 * 值不用发）、哪些键变了、变成了什么。相同的大字段一个字都不用出机器。
 *
 * 这不是把判断做进代码里 —— 差异是纯机械的，难的那一半（「这个键从 X 变成
 * Y，会不会改变结果」）原样留给模型。
 */

/** 单个值的简写。长字符串只留头尾，中间的量用长度表示 */
function brief(value, limit = 160) {
  if (value === null || value === undefined) return value
  if (typeof value !== 'string') {
    const text = JSON.stringify(value)
    return text.length <= limit ? value : `<${typeof value}, ${text.length} 字符>`
  }
  if (value.length <= limit) return value
  return `<${value.length} 字符> ${value.slice(0, limit / 2)} … ${value.slice(-limit / 2)}`
}

/**
 * 长文本按行比。
 *
 * `ue_run_python_script` 是失败重试最多的工具（121 对），它的参数是一整段
 * 脚本 —— 整体比只会得到「从 <12000 字符> 变成 <12000 字符>」，等于没比。
 * 按行取集合差就够用了：改了哪几行才是判据，行序不是。
 */
function lineDiff(before, after, maxLines = 12) {
  const a = String(before).split('\n')
  const b = String(after).split('\n')
  const setA = new Set(a)
  const setB = new Set(b)
  return {
    removed: a
      .filter((line) => !setB.has(line) && line.trim())
      .slice(0, maxLines)
      .map((l) => brief(l)),
    added: b
      .filter((line) => !setA.has(line) && line.trim())
      .slice(0, maxLines)
      .map((l) => brief(l)),
    unchanged_line_count: a.filter((line) => setB.has(line)).length
  }
}

const sameValue = (a, b) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return a === b
  }
}

/** 把嵌套结构摊成 `路径 → 叶子值`。数组下标进路径，因为换了一项就是换了目标 */
function flatten(value, prefix = '', out = new Map()) {
  if (value === null || typeof value !== 'object') {
    out.set(prefix || '(root)', value)
    return out
  }
  if (out.size > 4000) return out // 防超大结构把内存吃光
  for (const [key, child] of Object.entries(value)) {
    const path = Array.isArray(value) ? `${prefix}[${key}]` : prefix ? `${prefix}.${key}` : key
    flatten(child, path, out)
  }
  return out
}

/**
 * 嵌套结构按路径比。
 *
 * 第二次 `--dry-run` 发现的问题：`storyboard` 这种对象参数只报成
 * 「从 <object, 2764 字符> 变成 <object, 2797 字符>」—— **Jev 一点可判的
 * 东西都没拿到**，问它也只能瞎猜。而这类参数在真实数据里很常见。
 *
 * 摊平成路径之后，「改了 `storyboard.scenes[3].title`」和「改了
 * `storyboard.projectDir`」是完全不同的两件事，这才是判据。
 */
function pathDiff(before, after, maxPaths = 15) {
  const a = flatten(before)
  const b = flatten(after)
  const changed = []
  const addedPaths = []
  const removedPaths = []

  for (const [path, value] of a) {
    if (!b.has(path)) removedPaths.push(path)
    else if (!sameValue(value, b.get(path)))
      changed.push({ path, from: brief(value, 80), to: brief(b.get(path), 80) })
  }
  for (const path of b.keys()) if (!a.has(path)) addedPaths.push(path)

  return {
    changed_paths: changed.slice(0, maxPaths),
    // 只报数量不报路径名：几百个新增路径的名字对判断没帮助，只会稀释 state
    added_path_count: addedPaths.length,
    removed_path_count: removedPaths.length,
    added_paths: addedPaths.slice(0, maxPaths),
    removed_paths: removedPaths.slice(0, maxPaths),
    total_changed_path_count: changed.length
  }
}

/**
 * 发给 Jev 的 state。**这就是全部会被发出去的内容** —— `--dry-run` 打的
 * 也是这个对象，看过了再决定跑不跑。
 */
function buildState(pair) {
  const prev = pair.previous.args ?? {}
  const cur = pair.current.args ?? {}
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(cur)])]

  const identical = []
  const changed = []
  const onlyInPrevious = []
  const onlyInThis = []

  for (const key of keys) {
    const inPrev = key in prev
    const inCur = key in cur
    if (inPrev && !inCur) onlyInPrevious.push(key)
    else if (!inPrev && inCur) onlyInThis.push(key)
    else if (sameValue(prev[key], cur[key])) identical.push(key)
    else if (
      typeof prev[key] === 'string' &&
      typeof cur[key] === 'string' &&
      (prev[key].length > 400 || cur[key].length > 400)
    ) {
      // 长文本（脚本、代码）：按行比，改了哪几行才是判据
      changed.push({ argument: key, line_diff: lineDiff(prev[key], cur[key]) })
    } else if (
      prev[key] !== null &&
      cur[key] !== null &&
      typeof prev[key] === 'object' &&
      typeof cur[key] === 'object'
    ) {
      // 嵌套结构：按路径比，改了哪个字段才是判据
      changed.push({ argument: key, ...pathDiff(prev[key], cur[key]) })
    } else {
      changed.push({ argument: key, from: brief(prev[key]), to: brief(cur[key]) })
    }
  }

  return {
    tool: pair.tool,
    // 错误原文是判据的一半（「这次的改动是不是在修这个错」），但有些工具会
    // 把收到的参数原样回显进报错里 —— 那正是我们刚筛掉的东西。300 字够看清
    // 错误类型，又不至于把回显的参数整段带出去
    previous_call_failed_with: brief(pair.previous.error, 300),
    arguments_identical: identical,
    arguments_changed: changed,
    arguments_only_in_previous_call: onlyInPrevious,
    arguments_only_in_this_call: onlyInThis
  }
}

/**
 * 问题用英文写。
 *
 * 不是偏好 —— `judge-probe.mjs` 的双臂实测：14 条用例里每一处差异都是
 * 中文臂更不确定（`distill n5` 0.82 → 0.66），方向单向，而且中文问题
 * 还贵 8%。问题是我们自己写的、不面向用户，改成英文零成本。
 */
const QUESTION = {
  same_attempt: {
    type: 'noul',
    instructions:
      'The agent called `tool`, it failed with `previous_call_failed_with`, and the agent is now calling the same tool again. ' +
      '`arguments_changed` lists every argument whose value differs this time. ' +
      'Is this second call essentially the same attempt, so that it would fail the same way?',
    criteria: {
      true:
        'Nothing meaningful changed. `arguments_changed` is empty, or the differences it lists cannot affect the outcome: ' +
        'whitespace, key order, casing, a reordered list, a comment, or a synonym that resolves to the same target.',
      false:
        'Something meaningful changed. The differences in `arguments_changed` could plausibly produce a different result: ' +
        'a different target, a corrected value, a different search term, or a fix that addresses `previous_call_failed_with`.'
    }
  }
}

async function askJev(pair) {
  const started = Date.now()
  const response = await fetch(`${ENDPOINT.replace(/\/+$/, '')}/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, state: buildState(pair), questions: QUESTION }),
    signal: AbortSignal.timeout(30_000)
  })
  const ms = Date.now() - started
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.answers?.same_attempt) {
    throw new Error(body?.error?.message || body?.message || `HTTP ${response.status}`)
  }
  return { noul: body.answers.same_attempt.noul, ms, tokens: body.usage?.input_tokens ?? 0 }
}

/** 固定并发跑一批，保持输入顺序 */
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
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
  await Promise.all(runners)
  return results
}

// ==================== 四、跑 ====================

if (!existsSync(SESSION_DIR)) {
  console.error(`会话目录不存在：${SESSION_DIR}\n用 --dir= 指定一份快照。`)
  process.exit(1)
}

const files = readdirSync(SESSION_DIR).filter((name) => name.endsWith('.jsonl'))
console.log(`会话目录：${SESSION_DIR}`)
console.log(`${files.length} 个会话，开始扫描（只读工具调用，不读对话正文）…\n`)

const allPairs = []
let totalCalls = 0
let failedCalls = 0

for (const name of files) {
  let calls
  try {
    calls = await readSession(join(SESSION_DIR, name))
  } catch {
    continue // 单个会话读不动不该让整轮停下
  }
  totalCalls += calls.length
  failedCalls += calls.filter((c) => c.isError).length
  allPairs.push(...extractPairs(calls, name.replace(/\.jsonl$/, '')))
}

const byKind = {
  exact: allPairs.filter((p) => p.kind === 'exact'),
  recovered: allPairs.filter((p) => p.kind === 'recovered'),
  persisted: allPairs.filter((p) => p.kind === 'persisted')
}

console.log('── 本机数据 ──────────────────────────────')
console.log(`工具调用总数        ${totalCalls}`)
console.log(`其中失败            ${failedCalls}`)
console.log(`「失败→再调同工具」对 ${allPairs.length}`)
console.log(`  exact      参数一字不差，今天已经拦得住        ${byKind.exact.length}`)
console.log(`  recovered  后一次成功了 → 有硬真值（误拦测试） ${byKind.recovered.length}`)
console.log(`  persisted  后一次也失败、参数不同 → 今天拦不住 ${byKind.persisted.length}`)

const topTools = Object.entries(
  allPairs.reduce((acc, p) => ({ ...acc, [p.tool]: (acc[p.tool] || 0) + 1 }), {})
)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
if (topTools.length) {
  console.log('\n失败重试最多的工具：')
  for (const [tool, count] of topTools) console.log(`  ${String(count).padStart(5)}  ${tool}`)
}

if (MODE === 'scan') {
  console.log(
    '\n只扫描，没有发出任何请求。' +
      '\n  --dry-run  看将要发送的内容' +
      '\n  --run      真的跑判定（需要 TYPESAFE_API_KEY）'
  )
  process.exit(0)
}

/** 采样：两类各取一半，`recovered` 优先 —— 它是唯一有硬真值的那类 */
const sample = [
  ...byKind.recovered.slice(0, Math.ceil(LIMIT * 0.6)),
  ...byKind.persisted.slice(0, Math.floor(LIMIT * 0.3)),
  ...byKind.exact.slice(0, Math.floor(LIMIT * 0.1))
]

if (sample.length === 0) {
  console.error('\n没有可判的对。')
  process.exit(1)
}

if (MODE === 'dry-run') {
  console.log(`\n── 将要发送的内容（前 3 条，共 ${sample.length} 条）──────────\n`)
  for (const pair of sample.slice(0, 3)) {
    console.log(`[${pair.kind}] ${pair.tool}`)
    console.log(JSON.stringify(buildState(pair), null, 2))
    console.log()
  }
  console.log('问题（每条都一样）：')
  console.log(JSON.stringify(QUESTION, null, 2))
  console.log('\n看过了就加 --run。')
  process.exit(0)
}

if (!KEY) {
  console.error('\n缺 API Key。设 TYPESAFE_API_KEY，或者 --key=...')
  process.exit(1)
}

console.log(`\n── 判定 ${sample.length} 条（并发 ${CONCURRENCY}）──────────\n`)
const outcomes = await runPool(sample, askJev, CONCURRENCY)

const records = sample.map((pair, index) => ({
  ...pair,
  previous: undefined, // 明细里不留参数原文，避免 .test/ 下落一份工程结构
  current: undefined,
  result: outcomes[index]
}))

const ok = records.filter((r) => r.result?.ok)
const failed = records.filter((r) => !r.result?.ok)
const tokens = ok.reduce((sum, r) => sum + r.result.value.tokens, 0)
const latencies = ok.map((r) => r.result.value.ms).sort((a, b) => a - b)

console.log('\n\n══ 结果 ══════════════════════════════════════════\n')

// —— 误拦率：唯一有硬真值的那条 ——
const truthed = ok.filter((r) => r.truth === false)
console.log(`误拦测试（recovered，真值 = 不是同一个尝试）：${truthed.length} 条\n`)
console.log('  阈值    误拦数   误拦率')
for (const threshold of THRESHOLDS) {
  const fp = truthed.filter((r) => r.result.value.noul >= threshold)
  const rate = truthed.length ? ((fp.length / truthed.length) * 100).toFixed(1) : '—'
  console.log(`  ${threshold.toFixed(2)}   ${String(fp.length).padStart(5)}   ${rate}%`)
}

// —— 召回代理：没有硬真值，单独报，不算通过率 ——
const persisted = ok.filter((r) => r.kind === 'persisted')
console.log(`\n召回代理（persisted，今天精确匹配拦不住）：${persisted.length} 条`)
for (const threshold of THRESHOLDS) {
  const hit = persisted.filter((r) => r.result.value.noul >= threshold)
  const rate = persisted.length ? ((hit.length / persisted.length) * 100).toFixed(1) : '—'
  console.log(
    `  ${threshold.toFixed(2)}   判「同一个尝试」 ${String(hit.length).padStart(5)}   ${rate}%`
  )
}
console.log('  ⚠ 这一列没有硬真值 —— 「一直没成功」不等于「每次重试都是同一个尝试」，只能当参考')

// —— 一致性：今天拦得住的，它也该认出来 ——
const exact = ok.filter((r) => r.kind === 'exact')
if (exact.length) {
  const agree = exact.filter((r) => r.result.value.noul >= 0.85)
  console.log(
    `\n一致性（exact，参数一字不差）：${agree.length}/${exact.length} 在 0.85 以上认出是同一个尝试`
  )
  console.log('  认不出说明判据本身有问题 —— 这类连人都不会看错')
}

console.log(
  `\n延迟 中位 ${latencies[Math.floor(latencies.length / 2)]}ms / p95 ${latencies[Math.floor(latencies.length * 0.95)]}ms`
)
console.log(`${tokens} input tokens ≈ $${(tokens * USD_PER_INPUT_TOKEN).toFixed(6)}`)
if (failed.length) console.log(`✖ ${failed.length} 次请求失败`)

console.log(
  '\n验收标准：**误拦率接近零**（误拦 = agent 被卡死在它本来能绕过去的地方），' +
    '\n且召回代理那一列在同一阈值下明显不为零 —— 否则这个判断白加。'
)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    { model: MODEL, at: new Date().toISOString(), sessionDir: SESSION_DIR, records },
    null,
    2
  ),
  'utf-8'
)
console.log(`\n明细：${OUT_FILE}（不含参数原文）`)
