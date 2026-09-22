/**
 * 工具失败的普查 —— 离线，不调任何模型。
 *
 * ## 为什么做这个
 *
 * 前面五轮都在验「Jev 能不能接进来」，每一轮都是我先想出一个题目再去数据里
 * 找证据。五轮下来有个数一直摆在那儿没人拆：**11025 次工具调用里失败了
 * 2068 次 —— 18.8%**。它比我追过的任何一个数都大。
 *
 * 这次反过来：**先看数据长什么样，再决定有没有题目**。不预设任何解法，
 * 尤其不预设判定模型 —— 拆完可能根本轮不到它。
 *
 * ## 四个切法
 *
 * 1. **按工具** —— 失败集中在少数几个工具上，还是全面铺开？
 *    集中的话那是工具的问题，不是 agent 的问题。
 * 2. **按错误签名** —— 把错误正文归一化（抹掉路径、id、数字）后聚类。
 *    同一句话重复几百次说明是一个可修的具体缺陷，而不是「各种意外」。
 * 3. **失败之后发生了什么** —— 下一次同名调用成功了（自愈）、
 *    换了别的工具（绕路）、还是这一轮就结束了（放弃）。
 *    **这一刀最要紧**：自愈的失败是噪音，放弃的失败才是真的伤到用户。
 * 4. **按会话集中度** —— 2068 次失败是摊在 2326 个会话里，
 *    还是几十个会话贡献了大头？后者说明是特定场景炸，不是普遍质量问题。
 *
 * ## 隐私
 *
 * 只读工具调用和工具结果，用户消息和助手正文一个字不碰。错误正文归一化之后
 * 只留签名，明细里不落参数原文。
 *
 *   node tests/manual/failure-census.mjs [--tool=xxx] [--top=25]
 */
import { createReadStream, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = join(APP_DIR, '.test')
const OUT_FILE = join(OUT_DIR, 'failure-census.json')

const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')

const SESSION_DIR = arg('dir') || join(process.env.APPDATA || '', 'unreal-box', 'agent-v3-sessions')
const ONLY_TOOL = arg('tool')
const TOP = Number(arg('top') || 20)

/**
 * 把错误正文归一化成签名。
 *
 * 目标是让「同一个毛病的第 300 次」和第 1 次落进同一个桶。所以要抹掉所有
 * 每次都不一样的东西：路径、GUID、数字、引号里的名字。抹过头会把不同的毛病
 * 并成一个，抹不够则每条都是独立签名、一个都聚不起来 —— 宁可抹过头一点，
 * 桶太粗还能看样例，桶太碎就什么都看不出来。
 */
function signature(text) {
  return (
    String(text)
      .split('\n')
      .find((line) => line.trim()) || ''
  )
    .replace(/\/[A-Za-z0-9_一-鿿]+(?:\/[^\s"'，。）)]+)+/g, '<路径>')
    .replace(/[A-Za-z]:[\\/][^\s"'，。）)]+/g, '<路径>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{20,}\b/gi, '<id>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/["'「」『』]([^"'「」『』]{1,60})["'「」『』]/g, '<名字>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
}

/**
 * 这条「失败」其实是用户按了停止。
 *
 * **必须单独分出来，否则所有失败统计都是假的**：本机 2068 条 isError 里
 * 1500 条是 `Operation aborted`，占 72.5%。把它算进失败率，18.8% 里有
 * 13 个百分点是「用户自己中断」。
 *
 * `resume.ts` 的注释早就写明了这个口径 ——「中止是意图达成，不是故障」——
 * 但 toolResult 上那一位仍然是 `isError: true`，所以任何按 isError 统计的
 * 东西都会被它放大三倍多。
 *
 * （顺带查过：`loopBreaker` 也按 isError 计数，但它是 `createUnrealAgent`
 * 里建的、每条消息重建，而中断会结束整条消息，计数攒不起来 —— 不是 bug。）
 */
function isUserInterrupt(text) {
  return /Operation aborted|用户停止了这一轮|用户取消|This operation was aborted/i.test(text)
}

function textOf(message) {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

async function readSession(file) {
  const calls = []
  const pending = new Map()
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

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
        if (part?.type === 'toolCall') pending.set(part.id, part.name)
      }
      continue
    }
    if (message.role === 'toolResult' && pending.has(message.toolCallId)) {
      const name = pending.get(message.toolCallId)
      pending.delete(message.toolCallId)
      calls.push({
        name,
        isError: message.isError === true,
        interrupted: message.isError === true && isUserInterrupt(textOf(message)),
        sig: message.isError === true ? signature(textOf(message)) : ''
      })
    }
  }
  return calls
}

/**
 * 一次失败之后发生了什么。
 *
 * 往后看 6 步就够 —— 再远就跟这次失败没关系了。
 *   recovered  同名工具后来成功了 → agent 自己爬起来了
 *   detoured   同名工具再没出现，但换了别的工具继续干 → 绕过去了
 *   abandoned  这次失败之后整个会话再没有任何工具调用 → 这一轮就停在这儿
 */
function aftermath(calls, index) {
  const tool = calls[index].name
  const tail = calls.slice(index + 1, index + 7)
  if (tail.length === 0) return 'abandoned'
  if (tail.some((c) => c.name === tool && !c.isError)) return 'recovered'
  if (tail.some((c) => c.name !== tool)) return 'detoured'
  return 'stuck'
}

if (!existsSync(SESSION_DIR)) {
  console.error(`会话目录不存在：${SESSION_DIR}`)
  process.exit(1)
}

const files = readdirSync(SESSION_DIR).filter((name) => name.endsWith('.jsonl'))
console.log(`${files.length} 个会话，离线普查（不联网、不调模型）…\n`)

const byTool = new Map()
const bySig = new Map()
const after = { recovered: 0, detoured: 0, abandoned: 0, stuck: 0 }
const perSession = []
let total = 0
let failed = 0
let interrupted = 0

for (const file of files) {
  let calls
  try {
    calls = await readSession(join(SESSION_DIR, file))
  } catch {
    continue
  }
  if (ONLY_TOOL) calls = calls.filter((c) => c.name === ONLY_TOOL)

  let sessionFail = 0
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]
    total++
    const bucket = byTool.get(call.name) ?? { calls: 0, fails: 0 }
    bucket.calls++
    if (!call.isError) {
      byTool.set(call.name, bucket)
      continue
    }
    if (call.interrupted) {
      interrupted++
      byTool.set(call.name, bucket)
      continue
    }
    failed++
    sessionFail++
    bucket.fails++
    byTool.set(call.name, bucket)

    const sigBucket = bySig.get(call.sig) ?? { n: 0, tools: new Set() }
    sigBucket.n++
    sigBucket.tools.add(call.name)
    bySig.set(call.sig, sigBucket)

    after[aftermath(calls, i)]++
  }
  if (sessionFail) perSession.push({ session: file.slice(0, 8), fails: sessionFail })
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—')

console.log('── 总览 ──────────────────────────────')
console.log(`工具调用 ${total}`)
console.log(`  用户按停止   ${interrupted}（${pct(interrupted, total)}）← 不是失败`)
console.log(
  `  真的失败     ${failed}（占全部调用 ${pct(failed, total)}，占非中断调用 ${pct(failed, total - interrupted)}）`
)

console.log('\n── 一、失败之后发生了什么 ──────────────')
console.log(
  `  recovered  同名工具后来成功了   ${String(after.recovered).padStart(5)}  ${pct(after.recovered, failed)}`
)
console.log(
  `  detoured   换别的工具继续干     ${String(after.detoured).padStart(5)}  ${pct(after.detoured, failed)}`
)
console.log(
  `  stuck      还在同一个工具上打转 ${String(after.stuck).padStart(5)}  ${pct(after.stuck, failed)}`
)
console.log(
  `  abandoned  会话到此为止         ${String(after.abandoned).padStart(5)}  ${pct(after.abandoned, failed)}`
)

console.log('\n── 二、按工具（失败数 × 失败率）──────────')
const tools = [...byTool].filter(([, v]) => v.fails > 0).sort((a, b) => b[1].fails - a[1].fails)
console.log('    失败   调用   失败率  工具')
for (const [name, v] of tools.slice(0, TOP)) {
  console.log(
    `  ${String(v.fails).padStart(6)} ${String(v.calls).padStart(6)}  ${pct(v.fails, v.calls).padStart(6)}  ${name}`
  )
}
const head = tools.slice(0, 5).reduce((s, [, v]) => s + v.fails, 0)
console.log(`\n  前 5 个工具占全部失败的 ${pct(head, failed)}`)

console.log('\n── 三、错误签名 Top ──────────────────')
const sigs = [...bySig].sort((a, b) => b[1].n - a[1].n)
console.log(`  共 ${sigs.length} 种签名`)
for (const [sig, v] of sigs.slice(0, TOP)) {
  console.log(`  ${String(v.n).padStart(5)}  [${[...v.tools].slice(0, 2).join(',')}]`)
  console.log(`         ${sig}`)
}
const headSig = sigs.slice(0, 10).reduce((s, [, v]) => s + v.n, 0)
console.log(`\n  前 10 种签名占全部失败的 ${pct(headSig, failed)}`)

console.log('\n── 四、会话集中度 ────────────────────')
perSession.sort((a, b) => b.fails - a.fails)
const top20 = perSession.slice(0, 20).reduce((s, x) => s + x.fails, 0)
console.log(`  有失败的会话 ${perSession.length} 个（共 ${files.length}）`)
console.log(`  失败最多的 20 个会话贡献了 ${top20}（${pct(top20, failed)}）`)
console.log(`  单个会话最多失败 ${perSession[0]?.fails ?? 0} 次`)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      total,
      failed,
      after,
      tools: tools.map(([name, v]) => ({ name, ...v })),
      signatures: sigs.slice(0, 60).map(([sig, v]) => ({ sig, n: v.n, tools: [...v.tools] }))
    },
    null,
    2
  ),
  'utf-8'
)
console.log(`\n明细：${OUT_FILE}`)
