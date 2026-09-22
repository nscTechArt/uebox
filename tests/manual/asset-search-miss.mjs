/**
 * 资产搜索零结果的离线复核 —— 追 `locate-replay.mjs` 挖出来的那条线索。
 *
 * ## 线索是什么
 *
 * 908 次成功的资产搜索里，**368 次（40%）返回零结果**，其中 100 次带着
 * 像模像样的查询词（`Sphere`、`Wood`、`face`、`M_Wood*`、`wasteland`），
 * 只有 6% 含中文 —— 不是中文分词的问题。
 *
 * 当时判断不了那些资产到底存不存在，所以只记成线索。这个脚本把它坐实或推翻。
 *
 * ## 怎么在不开引擎的情况下知道「工程里有没有」
 *
 * 不用开。**枚举型搜索自己把答案存下来了** —— 520 次 `query: "*"` 的调用
 * 各自 dump 了一份当时那个工程的资产清单。把同一个会话里的枚举结果并起来，
 * 就得到一份「这个工程至少有这些资产」的名单。
 *
 * 于是每一条零结果搜索都能复核：**它要找的东西，其实就躺在那份名单里吗？**
 *
 * ## 这是个下界，不是全貌
 *
 * 三处都只会让数字偏小，不会偏大：
 *
 * - 枚举有 `limit`（常见 100/200），名单本来就不全；
 * - 只有做过枚举的会话才有名单，其余会话的零结果一概跳过；
 * - 搜索可能带 `path` / `filter_class` 限定，这里一律按不限定复核，
 *   所以算出来的「本该搜到」可能有一小部分其实被限定条件合法地排除了。
 *
 * 也就是说：**报出来的漏检是真漏检的下限。**
 *
 * ## 完全离线
 *
 * 不联网，不调任何模型。这条线索跟 Jev 没关系 —— 零结果时没有候选，
 * 判定模型没有可判的东西，它不会检索。
 *
 *   node tests/manual/asset-search-miss.mjs
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = join(APP_DIR, '.test')
const OUT_FILE = join(OUT_DIR, 'asset-search-miss.json')

const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')

const SESSION_DIR = arg('dir') || join(process.env.APPDATA || '', 'unreal-box', 'agent-v3-sessions')
const SEARCH_TOOLS = new Set(['ue_content_search', 'search_assets'])

/** 查询词里有没有通配符。有和没有要分开统计 —— 这正是要验的那条假设 */
const hasWildcard = (query) => /[*?]/.test(query)

/** 通配符转正则。`*` 任意串、`?` 单字符，其余原样转义 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
}

/**
 * 一条资产「配不配得上」这个查询词。
 *
 * 两档，分开报：
 *   - `glob`      按通配符整体匹配名字（搜索工具看起来就是这么做的）
 *   - `substring` 名字里**包含**查询词（去掉通配符之后）
 *
 * 两档的差就是这条线索的全部：如果大量零结果在 `substring` 下有命中，
 * 说明问题出在匹配太严，而不是资产不存在。
 */
function matches(query, asset) {
  const name = String(asset.name || asset.path.split('/').pop() || '')
  const bare = query.replace(/[*?]/g, '').trim()
  if (!bare) return null
  const glob = hasWildcard(query)
    ? globToRegExp(query).test(name)
    : name.toLowerCase() === bare.toLowerCase()
  const substring = name.toLowerCase().includes(bare.toLowerCase())
  return { glob, substring, name, path: asset.path }
}

function assetsOf(message) {
  const results = message.details?.results
  if (!Array.isArray(results)) return []
  return results.filter((item) => item && typeof item.path === 'string')
}

async function readSession(file) {
  const enumerated = new Map() // path -> {name, path}
  const zeroHits = []
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
        if (part?.type === 'toolCall' && SEARCH_TOOLS.has(part.name)) {
          pending.set(part.id, part.arguments ?? {})
        }
      }
      continue
    }
    if (message.role !== 'toolResult' || !pending.has(message.toolCallId)) continue

    const args = pending.get(message.toolCallId)
    pending.delete(message.toolCallId)
    if (message.isError === true) continue

    const query = String(args.query ?? args.keywords ?? '').trim()
    const assets = assetsOf(message)

    // 顺序要紧：**先记零结果，再把这次看到的资产并进名单**。
    //
    // 反过来写会造出一批假的「漏检」—— agent 搜 `crate` 搜不到、于是导入了
    // `SM_Prop_Crate_Ammo_01`、之后再枚举就看见了。按整个会话攒名单的话，
    // 那条后来才存在的资产会被当成「当时就在、却没搜到」。
    // 第一版正是这么写的，25 条「确凿漏检」里绝大多数是这么来的。
    if (assets.length === 0 && query && query !== '*' && query !== '**') {
      zeroHits.push({
        query,
        filterClass: args.filter_class ?? args.class,
        path: args.path,
        // 只拿**这一刻之前**见过的资产复核
        universe: [...enumerated.values()]
      })
    }

    for (const asset of assets) enumerated.set(asset.path, asset)
  }

  return { enumerated, zeroHits }
}

// ==================== 跑 ====================

if (!existsSync(SESSION_DIR)) {
  console.error(`会话目录不存在：${SESSION_DIR}`)
  process.exit(1)
}

const files = readdirSync(SESSION_DIR).filter((name) => name.endsWith('.jsonl'))
console.log(`${files.length} 个会话，离线复核（不联网、不调模型）…\n`)

let zeroTotal = 0
let checkable = 0
const findings = []
const stats = {
  wildcard: { checked: 0, substringHit: 0, globHit: 0 },
  bare: { checked: 0, substringHit: 0, globHit: 0 }
}

for (const name of files) {
  let session
  try {
    session = await readSession(join(SESSION_DIR, name))
  } catch {
    continue
  }
  zeroTotal += session.zeroHits.length

  for (const miss of session.zeroHits) {
    // 这次搜索**之前**没见过任何资产就复核不了。跳过，不猜
    const universe = miss.universe
    if (universe.length === 0) continue

    checkable++
    const bucket = hasWildcard(miss.query) ? stats.wildcard : stats.bare
    bucket.checked++

    const hits = universe.map((asset) => matches(miss.query, asset)).filter(Boolean)
    const substringHits = hits.filter((h) => h.substring)
    const globHits = hits.filter((h) => h.glob)

    if (substringHits.length) bucket.substringHit++
    if (globHits.length) bucket.globHit++

    if (substringHits.length && !globHits.length) {
      findings.push({
        session: name.replace(/\.jsonl$/, '').slice(0, 8),
        query: miss.query,
        filterClass: miss.filterClass,
        universeSize: universe.length,
        scopedByPath: miss.path,
        scopedByClass: miss.filterClass,
        wouldHaveFound: substringHits.slice(0, 4).map((h) => h.name)
      })
    }
  }
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—')

console.log('── 零结果复核 ──────────────────────────────')
console.log(`带真实查询词的零结果搜索      ${zeroTotal}`)
console.log(`其中所在会话攒出了资产名单    ${checkable}  ← 只有这些能复核`)
console.log()
console.log('               复核数   名单里有「包含该词」的资产')
console.log(
  `  带通配符       ${String(stats.wildcard.checked).padStart(5)}   ` +
    `${stats.wildcard.substringHit}（${pct(stats.wildcard.substringHit, stats.wildcard.checked)}）`
)
console.log(
  `  不带通配符     ${String(stats.bare.checked).padStart(5)}   ` +
    `${stats.bare.substringHit}（${pct(stats.bare.substringHit, stats.bare.checked)}）`
)
console.log(
  `\n确凿漏检（子串能搜到、当时返回零）：${findings.length}（占可复核的 ${pct(findings.length, checkable)}）`
)

if (findings.length) {
  console.log('\n样例：')
  for (const item of findings.slice(0, 14)) {
    console.log(
      `  「${item.query}」${item.filterClass ? ` [${item.filterClass}]` : ''}` +
        ` → 名单里有 ${item.wouldHaveFound.join(', ')}` +
        `（该会话名单 ${item.universeSize} 条）`
    )
  }
}

console.log(
  '\n注意这是**下界**：枚举有 limit、没枚举过的会话一概跳过、' +
    '复核时忽略了 path/class 限定。真实漏检只会比这个多。'
)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
  OUT_FILE,
  JSON.stringify({ at: new Date().toISOString(), zeroTotal, checkable, stats, findings }, null, 2),
  'utf-8'
)
console.log(`\n明细：${OUT_FILE}`)
