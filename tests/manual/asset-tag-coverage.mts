/**
 * 资产库标签覆盖率 —— 「给资产打标签」这条的决策闸。
 *
 * ## 它要回答什么
 *
 * 今天的自动标签是 `smartTags.ts`：**按文件名后缀匹配**（`_D` → Diffuse、
 * `_N` → NormalMap）。和 `searchRelevance` 的字面重合、`NAMING_RULES` 的前缀表
 * 是同一个形状 —— 明知有损的字符串规则，因为当时判断太贵。
 *
 * 本机库里 6333 个资产、20 个标签、约 552 个标签关联，也就是**至多 8.7% 的
 * 资产有任何标签**。缺口是真的。
 *
 * 但缺口大不等于判定模型补得上。真正要量的是这三档各占多少：
 *
 * | 档 | 含义 | 谁能补 |
 * |---|---|---|
 * | A 规则已覆盖 | `smartTags` 打得出标签 | 已经有了，不用补 |
 * | B **名字有语义、规则打不出** | `CorgiHouse` / `CatGirl_Hoodie` | **这一档才是增量** |
 * | C 名字零信息 | `18138f1f…mp3` / `Mesh_001` | 谁都补不上（要看图，而 Jev 不吃图） |
 *
 * **B 档的大小就是这条线的天花板。** 它小，这条和前面五条一个下场。
 *
 * ## 为什么是 .mts
 *
 * 要直接调 `computeSmartTags` 本尊，而不是照它的规则表再抄一遍 ——
 * 抄一遍就等于在量「我抄得准不准」。用 `vite-node` 跑：
 *
 *   npx vite-node tests/manual/asset-tag-coverage.mts
 *
 * 前置：盒子在跑（走 MCP 拿资产清单，见 `mcp-call.mjs`）。全程离线不调模型。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { computeSmartTags } from '../../src/main/services/asset/smartTags'
// @ts-expect-error —— 传输层是 .mjs，没有类型声明
import { callTool } from './mcp-call.mjs'

const OUT_DIR = join(resolve(import.meta.dirname, '..', '..'), '.test')
const PAGE = 500

interface Asset {
  name: string
  type?: string
  assetType?: string
  vault?: string
  size?: number
}

/** 翻页拉全量。`assets` 才是结果字段（`results` 不存在，踩过一次） */
async function fetchAll(): Promise<Asset[]> {
  const all: Asset[] = []
  let offset = 0
  for (;;) {
    const raw = await callTool('search_assets', { query: '', limit: PAGE, offset })
    const body = JSON.parse(raw.text)
    const page: Asset[] = body.assets ?? []
    all.push(...page)
    process.stdout.write(`  拉到 ${all.length} / ${body.count}\n`)
    if (!body.hasMore || page.length === 0) break
    offset = body.nextOffset ?? offset + page.length
  }
  return all
}

const NAME_EXT = /\.[a-z0-9]{2,5}$/i
const HASH_NAME = /^[0-9a-f]{24,}$/i
/** 拆词：下划线、连字符、点、空格，外加 camelCase 的边界 */
const SPLIT = /[_\-. ]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)/

/**
 * 名字里还剩多少「人能看懂的词」。
 *
 * 判 C 档（零信息）用的就是它。故意宽松 —— 宁可把可疑的算进 B 档让人去看，
 * 也不要把有信息的误判成零信息，那样会把天花板算低。
 */
function meaningfulWords(rawName: string): string[] {
  const stem = rawName.replace(NAME_EXT, '')
  if (HASH_NAME.test(stem)) return []
  return stem
    .split(SPLIT)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w))
    .filter((w) => !/^(01|02|03|orig|legacy|mesh|new|tmp|copy)$/i.test(w))
}

const assets = await fetchAll()
console.log(`\n共 ${assets.length} 个资产\n`)

const buckets = { A: [] as Asset[], B: [] as Asset[], C: [] as Asset[] }
const bTagless: Array<{ name: string; type?: string; words: string[] }> = []

for (const asset of assets) {
  const tags = computeSmartTags(asset.name)
  if (tags.length > 0) {
    buckets.A.push(asset)
    continue
  }
  const words = meaningfulWords(asset.name)
  if (words.length === 0) {
    buckets.C.push(asset)
    continue
  }
  buckets.B.push(asset)
  bTagless.push({ name: asset.name, type: asset.type ?? asset.assetType, words })
}

const pct = (n: number): string => `${((100 * n) / assets.length).toFixed(1)}%`

console.log('── 三档分布 ──────────────────────────────')
console.log(
  `  A 规则已覆盖（smartTags 打得出）   ${String(buckets.A.length).padStart(5)}  ${pct(buckets.A.length)}`
)
console.log(
  `  B 名字有语义、规则打不出           ${String(buckets.B.length).padStart(5)}  ${pct(buckets.B.length)}  ← 天花板`
)
console.log(
  `  C 名字零信息（要看图）             ${String(buckets.C.length).padStart(5)}  ${pct(buckets.C.length)}`
)

console.log('\n── B 档按资产类型 ────────────────────')
const byType = new Map<string, number>()
for (const asset of buckets.B) {
  const key = asset.type ?? asset.assetType ?? '?'
  byType.set(key, (byType.get(key) ?? 0) + 1)
}
for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(5)}  ${type}`)
}

console.log('\n── B 档样例（这些就是 Jev 要打的）────')
for (const item of bTagless.slice(0, 18)) {
  console.log(`  ${(item.type ?? '?').padEnd(14)} ${item.name}`)
}

console.log('\n── C 档样例（谁都补不上）─────────────')
for (const asset of buckets.C.slice(0, 6)) console.log(`  ${asset.name}`)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
  join(OUT_DIR, 'asset-tag-coverage.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      total: assets.length,
      A: buckets.A.length,
      B: buckets.B.length,
      C: buckets.C.length,
      bSample: bTagless.slice(0, 300)
    },
    null,
    2
  ),
  'utf-8'
)
console.log(`\n明细：${join(OUT_DIR, 'asset-tag-coverage.json')}`)
