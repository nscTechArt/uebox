/**
 * harness 侧工具预检索（Tool RAG）—— 评测臂用的检索器。
 *
 * 不靠模型主动去搜：台架拿用户那句话在工具目录里检索，把命中的工具连同常驻核心
 * 一起给模型，其余藏起来。这条路线的正面数据（RAG-MCP 13.6%→43.1%、2026 自适应 K
 * 论文）全是这种形态；上一轮 A/B 输掉的 finder 方案（模型自己决定去不去找）不是。
 *
 * ## 分组表
 *
 * 常驻 / 延迟的划分**原样沿用**上一轮实验冻结的那份
 * （`docs/工具渐进式披露设计.md` §2.3）：常驻 36 个，其余按十组延迟。
 * 沿用的理由是可比性 —— 两轮实验只差「谁来找」这一个变量。
 *
 * ## 检索：BM25 + 向量，RRF 融合
 *
 * 第一版只有 BM25，离线召回 K=20 才 86.7%（`docs/review/工具预检索A-B预登记` §3）。
 * 漏的全是题面故意不写领域词的那些（「能刷在墙上、看起来是红的」→ 材质；
 * 「编辑器刚才自己关了」→ 崩溃日志）—— 词面检索按定义捞不到。
 * 业界数据也是这个形状：top-1 上 BM25 14% vs 向量 38%，混合 94% vs BM25 34%。
 *
 * 所以加一路向量（用户配的向量化模型，经 `/api/debug/embed`），两路按
 * Reciprocal Rank Fusion 合并（k=60，无参数可调）。BM25 得分为 0 的工具不拿 BM25
 * 那一份名次分 —— 否则「一个词都没匹配上」也会按名字顺序白拿分。
 *
 * BM25 只在延迟池（约 119 个）里排名。文档 = 工具名（拆下划线，权重 ×3）+ 命名空间
 * + 描述 + 参数名和参数描述。中文单字 + 双字，英文 `[a-z0-9]+`。
 * 向量文档 = 「名字: 描述 (参数名…)」。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

/** 上一轮实验冻结的分组表（`tools/builtin/toolFinder.ts`，已删，这里是数据副本） */
export const GROUPS = Object.freeze([
  { id: 'blueprint', namespaces: ['ue.blueprint'] },
  { id: 'material', namespaces: ['ue.material'] },
  { id: 'pcg', namespaces: ['ue.pcg'] },
  { id: 'widget', namespaces: ['ue.widget'] },
  { id: 'sequencer', namespaces: ['ue.sequencer', 'ue.mesh'] },
  {
    id: 'content',
    namespaces: ['ue.content'],
    exclude: ['ue_content_search', 'ue_content_describe']
  },
  {
    id: 'assetlib',
    namespaces: ['asset', 'library'],
    exclude: ['search_assets', 'library_overview']
  },
  { id: 'aigc', namespaces: ['aigc'] },
  {
    id: 'engineops',
    namespaces: ['ue.cpp'],
    include: [
      'ue_set_config',
      'ue_collect_garbage',
      'ue_restart_editor',
      'ue_get_performance_stats',
      'ue_get_crash_logs',
      'ue_capture_perf_trace',
      'ue_insights_trace',
      'ue_manage_plugin'
    ]
  },
  {
    id: 'level',
    namespaces: ['ue.level', 'ue.input'],
    include: ['ue_playtest'],
    exclude: ['ue_get_current_level', 'ue_get_levels']
  }
])

/** 工具属于哪个延迟组；不属于任何组就是常驻，返回 undefined */
export function groupOf(tool) {
  for (const g of GROUPS) {
    if (g.exclude?.includes(tool.name)) continue
    if (g.include?.includes(tool.name)) return g.id
    if (g.namespaces.includes(tool.namespace)) return g.id
  }
  return undefined
}

const CJK = /[㐀-鿿]/

/** 分词：英文标识符按 [a-z0-9]+，中文按单字 + 双字 */
export function tokenize(text) {
  const out = []
  const s = String(text ?? '').toLowerCase()
  for (const m of s.matchAll(/[a-z0-9]+|[㐀-鿿]+/g)) {
    const t = m[0]
    if (CJK.test(t)) {
      for (let i = 0; i < t.length; i++) {
        out.push(t[i])
        if (i + 1 < t.length) out.push(t[i] + t[i + 1])
      }
    } else {
      out.push(t)
    }
  }
  return out
}

function schemaText(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 4) return []
  const parts = []
  if (typeof schema.description === 'string') parts.push(schema.description)
  const props = schema.properties
  if (props && typeof props === 'object') {
    for (const [key, sub] of Object.entries(props)) {
      parts.push(key)
      parts.push(...schemaText(sub, depth + 1))
    }
  }
  for (const k of ['items', 'anyOf', 'oneOf', 'allOf']) {
    const v = schema[k]
    if (Array.isArray(v)) for (const sub of v) parts.push(...schemaText(sub, depth + 1))
    else if (v) parts.push(...schemaText(v, depth + 1))
  }
  return parts
}

function paramNames(schema) {
  const props = schema?.properties
  return props && typeof props === 'object' ? Object.keys(props) : []
}

/** 一个工具的 BM25 文档 */
export function toolDocument(tool) {
  const name = tokenize(tool.name)
  return [
    ...name,
    ...name,
    ...name, // 名字权重 ×3
    ...tokenize(tool.namespace),
    ...tokenize(tool.description),
    ...tokenize(schemaText(tool.parameters).join(' '))
  ]
}

/** 一个工具的向量文档 */
export function toolEmbeddingText(tool) {
  const params = paramNames(tool.parameters)
  return (
    `${tool.name.replace(/_/g, ' ')}: ${tool.description ?? ''}` +
    (params.length ? ` (${params.join(', ')})` : '')
  )
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

const RRF_K = 60

/**
 * 向量缓存：同一段文本不重复花钱。键 = task + 文本哈希。
 */
class EmbeddingCache {
  constructor(file) {
    this.file = file
    this.map = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  }
  key(task, text) {
    return `${task}:${createHash('sha256').update(text).digest('hex').slice(0, 24)}`
  }
  get(task, text) {
    return this.map[this.key(task, text)]
  }
  set(task, text, vec) {
    this.map[this.key(task, text)] = vec
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.map))
  }
}

/**
 * 建索引。`tools` 是 `/api/debug/tools` 的 data。`embed(inputs, task)` 返回向量数组；
 * 不给就退化成纯 BM25（`mode` 会写明）。
 */
export async function buildIndex(tools, { embed, cacheFile } = {}) {
  const resident = []
  const deferred = []
  for (const t of tools) {
    const g = groupOf(t)
    if (g) deferred.push({ ...t, group: g })
    else resident.push(t)
  }

  const docs = deferred.map((t) => {
    const tokens = toolDocument(t)
    const tf = new Map()
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1)
    return { tool: t, tf, len: tokens.length }
  })
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length)
  const df = new Map()
  for (const d of docs) for (const tok of d.tf.keys()) df.set(tok, (df.get(tok) ?? 0) + 1)
  const N = docs.length
  const K1 = 1.2
  const B = 0.75

  function bm25(query) {
    const q = tokenize(query)
    return docs.map((d) => {
      let s = 0
      for (const tok of q) {
        const n = df.get(tok)
        if (!n) continue
        const f = d.tf.get(tok) ?? 0
        if (!f) continue
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
        s += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen))
      }
      return { name: d.tool.name, score: s }
    })
  }

  // 向量那一路
  const cache = new EmbeddingCache(
    cacheFile ?? path.join(process.cwd(), '.test', 'rag', 'embeddings.json')
  )
  let docVectors = null
  if (embed) {
    const texts = deferred.map(toolEmbeddingText)
    const missing = texts.filter((t) => !cache.get('document', t))
    if (missing.length) {
      const vecs = await embed(missing, 'document')
      missing.forEach((t, i) => cache.set('document', t, vecs[i]))
      cache.save()
    }
    docVectors = texts.map((t) => cache.get('document', t))
  }

  async function queryVector(query) {
    const hit = cache.get('query', query)
    if (hit) return hit
    const [vec] = await embed([query], 'query')
    cache.set('query', query, vec)
    cache.save()
    return vec
  }

  /** 融合排名：返回按分降序的 { name, score, group } */
  async function rank(query) {
    const lex = bm25(query)
    const fused = new Map(deferred.map((t) => [t.name, { name: t.name, group: t.group, score: 0 }]))
    // BM25：只有匹配到词的才拿名次分
    lex
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .forEach((r, i) => {
        fused.get(r.name).score += 1 / (RRF_K + i + 1)
      })
    if (docVectors) {
      const qv = await queryVector(query)
      deferred
        .map((t, i) => ({ name: t.name, score: cosine(qv, docVectors[i]) }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .forEach((r, i) => {
          fused.get(r.name).score += 1 / (RRF_K + i + 1)
        })
    }
    return [...fused.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  }

  return {
    mode: docVectors ? 'hybrid(bm25+embedding, rrf)' : 'bm25',
    resident,
    deferred,
    /** 工具级：延迟池里得分最高的 K 个 */
    async topTools(query, k) {
      return (await rank(query)).slice(0, k).map((r) => r.name)
    },
    /** 组级：按组内前 3 名得分之和排组，取前 n 组的全部工具 */
    async topGroups(query, n) {
      const ranked = await rank(query)
      const byGroup = new Map()
      for (const r of ranked) {
        const arr = byGroup.get(r.group) ?? []
        if (arr.length < 3) arr.push(r.score)
        byGroup.set(r.group, arr)
      }
      const groups = [...byGroup.entries()]
        .map(([id, top]) => ({ id, score: top.reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, n)
        .map((g) => g.id)
      return {
        groups,
        tools: deferred.filter((t) => groups.includes(t.group)).map((t) => t.name)
      }
    },
    /** 可见 = 常驻 + 选中的延迟工具；藏掉的 = 延迟池里没选中的 */
    hiddenFor(selected) {
      const keep = new Set(selected)
      return deferred.filter((t) => !keep.has(t.name)).map((t) => t.name)
    }
  }
}

/**
 * 离线召回：不花模型钱，先看检索器把答案捞没捞出来。
 * 只看非纯常驻例（常驻例答案本来就可见）。
 */
export async function offlineRecall(index, cases, pick) {
  const rows = cases.filter((c) => c.group)
  let hit = 0
  const misses = []
  for (const c of rows) {
    const visible = new Set([...index.resident.map((t) => t.name), ...(await pick(c.say))])
    if (c.accept.some((n) => visible.has(n))) hit++
    else misses.push(c.tag)
  }
  return { n: rows.length, hit, recall: rows.length ? hit / rows.length : 0, misses }
}
