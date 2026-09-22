/**
 * 全工程体检的判据验证 —— P2 决策闸。
 *
 * ## 为什么这一条值得验（前四条都死了）
 *
 * 因为它的**基线是坏的，而且坏得能量化**：
 *
 * - `ue_content_naming_audit` 在 BIKEOUT（19444 资产）上判违规 **16244 条
 *   （83.5%）**，还建议给 Epic 自带的 StarterContent 改名。一个标记 83.5%
 *   的规则等于没有规则。
 * - 「零引用」代码算得出（300 个），但「零引用 ⇒ 废料」是错的：11 个 World
 *   零引用，其中含默认地图 LAKETOWN（87MB）。关卡本来就没人引用。
 *
 * 两处缺的是同一种东西：**这资产是谁的、是干什么的**。而确定性办法试过了 ——
 * 按目录名认第三方内容只能覆盖 **3.1%**，因为 68% 的资产堆在一个叫
 * 「导入模型文件」的目录里，名字里没有任何线索。
 *
 * ## 两个问题，各自有明确的基线可比
 *
 * | 问题 | 今天的基线 | 基线错在哪 |
 * |---|---|---|
 * | `vendor` 这是买来的/引擎自带的吗 | 目录名正则 | 只认得出 3.1% |
 * | `disposable` 零引用的这个能删吗 | `refs == 0` | 把关卡也算进去了 |
 *
 * ## ground truth 是用户，不是我
 *
 * 这次不自己造真值 —— 前面栽过（`wall-replay` 的合成用例、
 * `asset-search-miss` 的时序 bug）。脚本产出一张**待复核清单**交给工程的
 * 主人抽检。判错的代价是「叫人删掉一个其实有用的资产」，这种判断只能由
 * 知道这个工程的人来做。
 *
 * ## 用法
 *
 *   node tests/manual/audit-probe.mjs --scan          # 只看本机数据分布
 *   node tests/manual/audit-probe.mjs --dry-run
 *   node tests/manual/audit-probe.mjs --run --limit=60
 *
 * 前置：先用 mcp-call.mjs 拉过 `.test/bikeout-assets.json`（见 README）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = join(APP_DIR, '.test')
const IN_FILE = join(OUT_DIR, 'bikeout-assets.json')
const OUT_FILE = join(OUT_DIR, 'audit-verdict.json')

const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')
const has = (name) => process.argv.includes(`--${name}`)

const MODE = has('run') ? 'run' : has('dry-run') ? 'dry-run' : 'scan'
const LIMIT = Number(arg('limit') || 60)
const CONCURRENCY = Number(arg('concurrency') || 8)
const ENDPOINT = process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1'
const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest'
const KEY = arg('key') || process.env.TYPESAFE_API_KEY
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000

/** 今天靠目录名能认出来的第三方内容。就这么多 —— 覆盖率 3.1% */
const VENDOR_FOLDER =
  /^(StarterContent|Twinmotion|UltraDynamicSky|ArtTools|Megascans|MSPresets|Bridge|Quixel|Paragon)$/i

/** 不该因为「零引用」就建议删的类型。关卡、数据表这些是入口，本来就没人引用 */
const ENTRY_CLASSES = new Set([
  'World',
  'DataTable',
  'UserDefinedEnum',
  'UserDefinedStruct',
  'MaterialParameterCollection',
  'LevelSequence'
])

if (!existsSync(IN_FILE)) {
  console.error(
    `缺 ${IN_FILE}。\n先把引擎里的资产清单拉下来 —— 见 tests/manual/README.md 的 audit-probe 一节。`
  )
  process.exit(1)
}

const rows = JSON.parse(readFileSync(IN_FILE, 'utf-8'))
const topFolder = (pkg) => pkg.split('/')[2] || '?'

// ==================== 分布 ====================

const folders = new Map()
for (const row of rows) {
  const key = topFolder(row.pkg)
  const bucket = folders.get(key) ?? { count: 0, size: 0, classes: new Map() }
  bucket.count++
  bucket.size += row.size
  bucket.classes.set(row.cls, (bucket.classes.get(row.cls) ?? 0) + 1)
  folders.set(key, bucket)
}

const zeroRef = rows.filter((r) => r.refs === 0)
const baselineVendor = rows.filter((r) => VENDOR_FOLDER.test(topFolder(r.pkg)))
const baselineDisposable = zeroRef.filter((r) => !ENTRY_CLASSES.has(r.cls))

console.log('── 工程数据 ──────────────────────────────')
console.log(`资产 ${rows.length}｜${(rows.reduce((s, r) => s + r.size, 0) / 1e9).toFixed(2)} GB`)
console.log(`顶层目录 ${folders.size} 个`)
console.log(
  `\n基线一 · 目录名认出的第三方内容  ${baselineVendor.length}（${((100 * baselineVendor.length) / rows.length).toFixed(1)}%）`
)
console.log(`基线二 · 零引用                  ${zeroRef.length}`)
console.log(
  `           扣掉入口类型后          ${baselineDisposable.length}` +
    `（扣掉的：${zeroRef.length - baselineDisposable.length} 个 ${[...new Set(zeroRef.filter((r) => ENTRY_CLASSES.has(r.cls)).map((r) => r.cls))].join('/')}）`
)

if (MODE === 'scan') {
  console.log('\n顶层目录：')
  for (const [name, bucket] of [...folders].sort((a, b) => b[1].count - a[1].count).slice(0, 20)) {
    const main = [...bucket.classes].sort((a, b) => b[1] - a[1])[0]
    console.log(
      `  ${String(bucket.count).padStart(6)}  ${(bucket.size / 1e9).toFixed(2)}GB  ` +
        `${name}  （主要是 ${main[0]}）`
    )
  }
  console.log('\n只看了本机数据，没有发出任何请求。')
  process.exit(0)
}

// ==================== 取样 ====================

/**
 * 分层取样。
 *
 * 两组各取一半：
 *   - 零引用的（要判 `disposable`）—— 判错的代价最大，必须覆盖到；
 *   - 按顶层目录分层的普通资产（要判 `vendor`）—— 每个目录至少一条，
 *     否则样本会被「导入模型文件」那 13243 条淹没，测不出跨目录的判别力。
 */
function sample(n) {
  const picked = []
  const half = Math.floor(n / 2)

  const zeros = [...zeroRef].sort((a, b) => b.size - a.size)
  picked.push(...zeros.slice(0, half))

  const byFolder = [...folders.keys()].sort()
  let index = 0
  while (picked.length < n && index < byFolder.length * 4) {
    const folder = byFolder[index % byFolder.length]
    const pool = rows.filter((r) => topFolder(r.pkg) === folder && !picked.includes(r))
    if (pool.length) picked.push(pool[Math.floor(index / byFolder.length) % pool.length])
    index++
  }
  return picked.slice(0, n)
}

const picked = sample(LIMIT)

// ==================== 判定 ====================

/**
 * state 只有引擎给的元数据 —— 路径、名字、类型、引用数、依赖数、大小。
 * 没有一个字来自用户对话。
 */
function buildState(row) {
  return {
    asset_path: row.pkg,
    asset_name: row.name,
    asset_class: row.cls,
    referenced_by_count: row.refs,
    depends_on_count: row.deps,
    size_bytes: row.size,
    top_level_folder: topFolder(row.pkg)
  }
}

/** 问题一律英文 —— judge-probe 的双臂实测，中文臂系统性更不确定且贵 8% */
const QUESTIONS = {
  vendor: {
    type: 'noul',
    instructions:
      'Is this asset third-party content that the project merely consumes — a marketplace pack, ' +
      'an engine sample, or a vendor library — rather than content this team authored for this game?',
    criteria: {
      true: 'Bought, bundled or imported from outside. Renaming or editing it would be undone by the next update of that pack. Folder and naming style usually look uniform and machine-generated.',
      false:
        'Content this team made for this specific game: levels, gameplay blueprints, and art authored in-house.'
    }
  },
  disposable: {
    type: 'noul',
    instructions:
      'Given `referenced_by_count` is the number of other assets that reference this one, ' +
      'would deleting this asset be safe?',
    criteria: {
      true: 'Nothing depends on it and nothing loads it directly. It is not an entry point.',
      false:
        'Something depends on it, OR it is an entry point that is loaded by name rather than by reference — a level/map, a data table, an enum, a struct, or a parameter collection. These always show zero referencers and must never be deleted on that basis.'
    }
  }
}

async function askJev(row) {
  const started = Date.now()
  const response = await fetch(`${ENDPOINT.replace(/\/+$/, '')}/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, state: buildState(row), questions: QUESTIONS }),
    signal: AbortSignal.timeout(30_000)
  })
  const ms = Date.now() - started
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.answers?.vendor) {
    throw new Error(body?.error?.message || body?.message || `HTTP ${response.status}`)
  }
  return {
    vendor: body.answers.vendor.noul,
    disposable: body.answers.disposable.noul,
    ms,
    tokens: body.usage?.input_tokens ?? 0
  }
}

if (MODE === 'dry-run') {
  console.log(`\n── 将要发送的内容（前 2 条，共 ${picked.length} 条）──────────\n`)
  for (const row of picked.slice(0, 2)) console.log(JSON.stringify(buildState(row), null, 2))
  console.log('\n问题（每条都一样，两个 noul 装在同一次调用里）：')
  console.log(JSON.stringify(QUESTIONS, null, 2).slice(0, 1200))
  process.exit(0)
}

if (!KEY) {
  console.error('\n缺 API Key。设 TYPESAFE_API_KEY，或者 --key=...')
  process.exit(1)
}

console.log(`\n── 判定 ${picked.length} 条（并发 ${CONCURRENCY}，每条 2 个问题一次发）──\n`)

const results = new Array(picked.length)
let cursor = 0
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, picked.length) }, async () => {
    while (cursor < picked.length) {
      const index = cursor++
      try {
        results[index] = { ok: true, value: await askJev(picked[index]) }
      } catch (error) {
        results[index] = { ok: false, error: String(error.message || error) }
      }
    }
  })
)

const records = picked.map((row, index) => ({
  path: row.pkg,
  name: row.name,
  cls: row.cls,
  refs: row.refs,
  sizeMB: +(row.size / 1e6).toFixed(2),
  folder: topFolder(row.pkg),
  baselineVendor: VENDOR_FOLDER.test(topFolder(row.pkg)),
  baselineDisposable: row.refs === 0 && !ENTRY_CLASSES.has(row.cls),
  result: results[index]
}))

const ok = records.filter((r) => r.result?.ok)
const tokens = ok.reduce((s, r) => s + r.result.value.tokens, 0)
const latencies = ok.map((r) => r.result.value.ms).sort((a, b) => a - b)

console.log('\n══ 结果 ══════════════════════════════════════════\n')

const jevVendor = ok.filter((r) => r.result.value.vendor >= 0.7)
console.log(`vendor（第三方内容）判为「是」的 ${jevVendor.length}/${ok.length}`)
console.log(`  目录名基线认得出的只有        ${ok.filter((r) => r.baselineVendor).length}`)
console.log(
  `  Jev 判是、基线认不出的        ${jevVendor.filter((r) => !r.baselineVendor).length} ← 这些要你抽检`
)
console.log(
  `  基线认得、Jev 判否的          ${ok.filter((r) => r.baselineVendor && r.result.value.vendor < 0.7).length} ← 这些是明显错判`
)

const zeros = ok.filter((r) => r.refs === 0)
const jevKeep = zeros.filter((r) => r.result.value.disposable < 0.5)
console.log(`\ndisposable（零引用能不能删）样本里零引用的 ${zeros.length} 条`)
console.log(`  Jev 说「别删」                ${jevKeep.length}`)
console.log(
  `    其中确实是入口类型          ${jevKeep.filter((r) => ENTRY_CLASSES.has(r.cls)).length}` +
    `（样本里入口类型共 ${zeros.filter((r) => ENTRY_CLASSES.has(r.cls)).length}）`
)
const wrongDelete = zeros.filter(
  (r) => r.result.value.disposable >= 0.5 && ENTRY_CLASSES.has(r.cls)
)
console.log(`  ⚠ 建议删掉入口类型的（危险错判） ${wrongDelete.length}`)
for (const item of wrongDelete.slice(0, 5)) console.log(`      ${item.cls}  ${item.path}`)

console.log('\n── 待你抽检：Jev 判为第三方、而目录名看不出来的 ──')
for (const item of jevVendor.filter((r) => !r.baselineVendor).slice(0, 18)) {
  console.log(
    `  ${item.result.value.vendor.toFixed(2)}  ${item.folder.padEnd(14)} ${item.cls.padEnd(24)} ${item.path}`
  )
}

console.log(
  `\n延迟 中位 ${latencies[Math.floor(latencies.length / 2)]}ms｜${tokens} tokens ≈ $${(tokens * USD_PER_INPUT_TOKEN).toFixed(6)}`
)
const failed = records.length - ok.length
if (failed) console.log(`✖ ${failed} 次失败`)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
  OUT_FILE,
  JSON.stringify({ model: MODEL, at: new Date().toISOString(), records }, null, 2),
  'utf-8'
)
console.log(`\n明细：${OUT_FILE}`)
