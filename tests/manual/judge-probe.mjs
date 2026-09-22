/**
 * 结构化判定（Jev）的真机探针。
 *
 * ## 用法
 *
 *   set TYPESAFE_API_KEY=...        （或用 --key=）
 *   node tests/manual/judge-probe.mjs
 *
 * 默认跑双臂（问题用英文写 / 问题用中文写，state 两边完全一样）。
 * 只想跑一条臂：`--lang=en` 或 `--lang=zh`。只跑某一种形态：`--form=3`。
 * 只跑一条用例：`--case=wall-reworded`。
 *
 * 结果落 `.test/judge-verdict.json`（那个目录在 .gitignore 里）。
 *
 * ## 为什么不走 judge.ts
 *
 * `judge.ts` 要 `store.ts`，而 `store.ts` 要 electron 的 `app` —— 拉一个
 * Electron 进程起来只为发几个 HTTP 请求不值当。这里直接打同一个端点、
 * 发同一个线格式（`judge.test.ts` 断言的就是这个形状），验的是**判据本身
 * 站不站得住**，不是那层 TypeScript 包装。
 *
 * ## 这不是评测
 *
 * 每条每臂只跑一次。Jev 不保证确定性，样本量也根本不够下结论。
 * 它要回答的只有一件事：**这四种形态的判据，在中文 UE state 上是不是
 * 明显不成立**。明显不成立就别接；看着成立也只说明值得做正式的 A/B。
 *
 * 真正要看的是三列，不是那个对错：
 *
 * - **原始概率**：判对但 0.52，和判对且 0.97，是两回事。阈值从这一列里选。
 * - **两臂差异**：厂商说 CJK 不如英文可靠。中文臂明显更差就说明问题一律
 *   用英文写（问题是我们自己写的，不面向用户，改成英文零成本）。
 * - **input_tokens**：`distill-door-graph` 一次问 6 个，拿它和单问题的用例
 *   比，验证「同一份 state 多问几个几乎不加钱」到底成不成立。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CASES, renderArm } from './judge-cases.mjs'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = join(APP_DIR, '.test')
const OUT_FILE = join(OUT_DIR, 'judge-verdict.json')

const ENDPOINT = process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1'
const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest'
/** 探针是人盯着等的，给宽一点 —— 这里要区分「判错」和「网络慢」 */
const TIMEOUT_MS = 30_000
/** $0.042 / 1M input tokens，输出不计费 */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000

const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')
const KEY = arg('key') || process.env.TYPESAFE_API_KEY
const ONLY_CASE = arg('case')
const ONLY_FORM = arg('form')
const LANGS = arg('lang') ? [arg('lang')] : ['en', 'zh']

if (!KEY) {
  console.error(
    '缺 API Key。设 TYPESAFE_API_KEY 环境变量，或者 --key=...\n' +
      '（设完环境变量要开一个新终端，setx 不影响当前这个）'
  )
  process.exit(1)
}

async function ask(state, questions) {
  const started = Date.now()
  const response = await fetch(`${ENDPOINT.replace(/\/+$/, '')}/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, state, questions }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const ms = Date.now() - started
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.answers) {
    const reason = body?.error?.message || body?.error || body?.message || `HTTP ${response.status}`
    throw new Error(String(reason))
  }
  return { ...body, ms }
}

/**
 * 一个答案对不对。
 *
 * noul 按 0.5 判方向 —— **不是**在建议用 0.5 当阈值，真实阈值该按后果定。
 * score 的返回值是概率加权的，可能是小数，四舍五入到档位再比。
 */
function grade(answer, expected) {
  if (!answer) return { pass: false, got: '(缺答案)', raw: null }
  if (answer.type === 'noul') {
    return {
      pass: answer.noul >= 0.5 === expected,
      got: `${expected ? '是' : '否'}? → ${answer.noul.toFixed(3)}`,
      raw: answer.noul,
      // 0.35~0.65 这一带不管对错都不该拿来做自动决策
      decisive: answer.noul >= 0.65 || answer.noul <= 0.35
    }
  }
  if (answer.type === 'choice') {
    return {
      pass: answer.choice === expected,
      got: `${answer.choice}  (conf ${answer.confidence.toFixed(3)})`,
      raw: answer.confidence,
      decisive: answer.confidence >= 0.8
    }
  }
  if (answer.type === 'score') {
    return {
      pass: Math.round(answer.score) === expected,
      got: `档 ${answer.score.toFixed(2)} / 期望 ${expected}  (conf ${answer.confidence.toFixed(3)})`,
      raw: answer.score,
      decisive: answer.confidence >= 0.8
    }
  }
  return { pass: false, got: `未知答案类型 ${answer.type}`, raw: null }
}

const selected = CASES.filter(
  (c) => (!ONLY_CASE || c.id === ONLY_CASE) && (!ONLY_FORM || String(c.form) === ONLY_FORM)
)

if (selected.length === 0) {
  console.error('没有用例命中筛选条件。')
  process.exit(1)
}

const FORM_NAME = {
  1: '形态一 · 探测折叠',
  2: '形态二 · 返回值裁剪',
  3: '形态三 · 前置闸',
  4: '形态四 · 停机判定'
}

const records = []
let totalTokens = 0

console.log(
  `模型 ${MODEL}｜${selected.length} 条用例 × ${LANGS.length} 臂（${LANGS.join(' / ')}）\n`
)

let currentForm = null
for (const testCase of selected) {
  if (testCase.form !== currentForm) {
    currentForm = testCase.form
    console.log(`\n── ${FORM_NAME[currentForm]} ────────────────────────────────`)
  }
  console.log(`\n${testCase.id}  ${testCase.title}`)

  for (const lang of LANGS) {
    const questions = renderArm(testCase.questions, lang)
    let result
    try {
      result = await ask(testCase.state, questions)
    } catch (error) {
      console.log(`  ${lang}  ✖ 请求失败：${error.message}`)
      records.push({ case: testCase.id, lang, error: String(error.message) })
      continue
    }

    totalTokens += result.usage?.input_tokens ?? 0

    const graded = Object.entries(testCase.expect).map(([key, expected]) => ({
      key,
      ...grade(result.answers[key], expected)
    }))
    const passed = graded.filter((g) => g.pass).length
    const shaky = graded.filter((g) => g.pass && g.decisive === false)

    const mark = passed === graded.length ? '✓' : '✖'
    console.log(
      `  ${lang}  ${mark} ${passed}/${graded.length}` +
        `｜${result.ms}ms｜${result.usage?.input_tokens ?? '?'} tok` +
        (shaky.length ? `｜⚠ ${shaky.length} 条判对但不够笃定` : '')
    )
    for (const g of graded) {
      console.log(`       ${g.pass ? ' ' : '✖'} ${g.key}: ${g.got}`)
    }

    records.push({
      case: testCase.id,
      form: testCase.form,
      lang,
      ms: result.ms,
      model: result.model,
      inputTokens: result.usage?.input_tokens ?? null,
      passed,
      total: graded.length,
      answers: result.answers,
      graded
    })
  }
}

// ── 汇总 ──
console.log('\n\n══ 汇总 ══════════════════════════════════════════\n')

for (const lang of LANGS) {
  const mine = records.filter((r) => r.lang === lang && !r.error)
  if (mine.length === 0) continue
  const pass = mine.reduce((sum, r) => sum + r.passed, 0)
  const total = mine.reduce((sum, r) => sum + r.total, 0)
  const shaky = mine.reduce((s, r) => s + r.graded.filter((g) => g.pass && !g.decisive).length, 0)
  const p50 = mine.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(mine.length / 2)]
  console.log(
    `${lang} 臂（问题用${lang === 'en' ? '英文' : '中文'}写）：` +
      `${pass}/${total} 判对，其中 ${shaky} 条不够笃定｜中位 ${p50}ms`
  )
}

const errors = records.filter((r) => r.error)
if (errors.length) console.log(`\n✖ ${errors.length} 次请求失败`)

console.log(
  `\n合计 ${totalTokens} input tokens ≈ $${(totalTokens * USD_PER_INPUT_TOKEN).toFixed(6)}（输出不计费）`
)
console.log(
  '\n提醒：每条每臂只跑一次，这不是评测。' +
    '「判对但不够笃定」的那几条比判错的更值得看 —— 它们在真实调用里会走回落，' +
    '等于这条判据没起作用。'
)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
  OUT_FILE,
  JSON.stringify({ model: MODEL, at: new Date().toISOString(), records }, null, 2),
  'utf-8'
)
console.log(`\n明细：${OUT_FILE}`)
