/**
 * 资产库语义搜索的开关、建索引任务和查询。
 *
 * 模型层（models/assetVectorIndex.ts）只管表和队列，这里管**什么时候花钱**：
 * 算向量是要调 embedding 模型的，几十万个资产就是几十万次调用。所以：
 *
 * - 默认关闭，用户在资产库设置里自己打开
 * - 打开之后后台分批算，进度可查、随时可停
 * - 算不动了（没配模型、网断了、余额没了）就停下来并**把原因说出来**，
 *   不重试到天荒地老，也不假装还在跑
 *
 * 搜索侧永远是「有就用、没有就算了」：语义这一路挂了，关键词那一路照常出结果。
 */

import Database from 'better-sqlite3'
import { embedTexts } from '../../ai/embedding'
import {
  commitVectors,
  disableAssetVectorIndex,
  enableAssetVectorIndex,
  getAssetVectorStatus,
  isAssetVectorEnabled,
  searchAssetVectors,
  takePendingVectorAssets,
  type AssetVectorStatus
} from '../models/assetVectorIndex'

/** 一批送多少条去算向量。厂商的 body 上限和单次失败的代价之间取的折中 */
const EMBED_BATCH = 64

/** 两批之间歇多久。给主线程和厂商限流都留点余地 */
const BATCH_INTERVAL_MS = 200

/** 语义那一路召回多少个候选。太少会漏，太多会把关键词那一路的好结果挤下去 */
const SEMANTIC_RECALL_K = 200

export interface SemanticJobState {
  running: boolean
  /** 上一次停下来的原因。null = 正常跑完或者从没跑过 */
  lastError: string | null
  /** 这一轮已经算了多少条 */
  processed: number
}

const jobs = new WeakMap<Database.Database, SemanticJobState>()

function stateOf(db: Database.Database): SemanticJobState {
  let state = jobs.get(db)
  if (!state) {
    state = { running: false, lastError: null, processed: 0 }
    jobs.set(db, state)
  }
  return state
}

/**
 * 打开语义搜索。
 *
 * 先拿一条探针文本去问模型要维度 —— 向量表建表时就把维度写死了，
 * 猜错的话后续插入会全部失败，而且是**静默**失败：索引看起来在跑，
 * 实际一条都没进去。宁可在这里因为「模型没配」直接报错，也不要那种状态。
 */
export async function enableAssetSemanticSearch(
  db: Database.Database,
  publicDb?: Database.Database
): Promise<{ ok: boolean; error?: string; dimension?: number }> {
  let dimension = 0
  try {
    const [probe] = await embedTexts(['probe'], 'document')
    dimension = probe?.length ?? 0
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (dimension <= 0) {
    return {
      ok: false,
      error: '嵌入模型没有返回向量，检查一下「设置 → 模型」的配置。'
    }
  }

  const result = enableAssetVectorIndex(db, dimension)
  if (!result.ok) return result

  startAssetSemanticIndexing(db, publicDb)
  return { ok: true, dimension }
}

export function disableAssetSemanticSearch(db: Database.Database): void {
  const state = stateOf(db)
  // 循环下一次醒来会看到索引已经关了，自己退出
  state.running = false
  state.lastError = null
  disableAssetVectorIndex(db)
}

/**
 * 后台把队列里的资产算成向量。已经在跑就不重复起。
 */
export function startAssetSemanticIndexing(
  db: Database.Database,
  publicDb?: Database.Database
): void {
  const state = stateOf(db)
  if (state.running) return
  if (!isAssetVectorEnabled(db)) return

  state.running = true
  state.lastError = null
  state.processed = 0

  const step = async (): Promise<void> => {
    if (!state.running) return
    if (!db.open || !isAssetVectorEnabled(db)) {
      state.running = false
      return
    }

    const batch = takePendingVectorAssets(db, publicDb, EMBED_BATCH)
    if (batch.length === 0) {
      state.running = false
      console.log('[资产语义索引] 已全部算完')
      return
    }

    // 已经没了的资产只要把向量删掉，不用花钱去算
    const gone = batch.filter((item) => item.gone)
    const live = batch.filter((item) => !item.gone && item.card.trim())
    // 卡片是空的（名字也没有）也没什么可算的，直接划掉，免得队列卡在这一条上
    const blank = batch.filter((item) => !item.gone && !item.card.trim())

    if (gone.length > 0 || blank.length > 0) {
      commitVectors(
        db,
        [...gone, ...blank].map((item) => ({ id: item.id, embedding: null }))
      )
    }

    if (live.length === 0) {
      setTimeout(() => void step(), 0)
      return
    }

    try {
      const embeddings = await embedTexts(
        live.map((item) => item.card),
        'document'
      )
      if (embeddings.length !== live.length) {
        throw new Error(`向量条数对不上：要了 ${live.length} 条，回来 ${embeddings.length} 条`)
      }
      commitVectors(
        db,
        live.map((item, index) => ({ id: item.id, embedding: embeddings[index] ?? null }))
      )
      state.processed += live.length
    } catch (error) {
      // **停下来并说清楚**。没配模型 / 网断了 / 余额没了都会走到这里，
      // 一直重试只会刷日志和刷账单，而用户看不到发生了什么。
      state.running = false
      state.lastError = error instanceof Error ? error.message : String(error)
      console.warn('[资产语义索引] 算向量失败，已暂停：', state.lastError)
      return
    }

    setTimeout(() => void step(), BATCH_INTERVAL_MS)
  }

  setTimeout(() => void step(), 0)
}

export interface AssetSemanticStatus extends AssetVectorStatus {
  running: boolean
  lastError: string | null
}

export function getAssetSemanticStatus(db: Database.Database): AssetSemanticStatus {
  const state = stateOf(db)
  return { ...getAssetVectorStatus(db), running: state.running, lastError: state.lastError }
}

/**
 * 把查询文本算成向量。跨库搜索时每个库用的是同一个嵌入模型，
 * 一次调用只算一次、各库复用 —— 否则开了语义的库有几个就串行调几次 embedding。
 */
export async function embedSearchQuery(query: string): Promise<number[] | null> {
  const text = (query ?? '').trim()
  if (!text) return null
  // 'query' 而不是 'document'：Jina v3 / Voyage 这类非对称模型两边是不同的
  // 向量空间，用错一边不报错，只是召回变差
  const [embedding] = await embedTexts([text], 'query')
  return embedding && embedding.length > 0 ? embedding : null
}

/**
 * 把一句自然语言查询变成一串资产 id，按语义相关度排好。
 *
 * 任何一步出问题都回空数组 —— 语义是**加分项**，不是必需品。
 * 它失败时关键词那一路照常给结果，用户不该因为 embedding 服务抽风就搜不了东西。
 *
 * @param getEmbedding 调用方已经有（或者能懒算出）查询向量时传进来，不再单独算一次
 */
export async function semanticRecall(
  db: Database.Database,
  query: string,
  k: number = SEMANTIC_RECALL_K,
  getEmbedding: () => Promise<number[] | null> = () => embedSearchQuery(query)
): Promise<number[]> {
  const text = (query ?? '').trim()
  if (!text || !isAssetVectorEnabled(db)) return []

  try {
    const embedding = await getEmbedding()
    if (!embedding || embedding.length === 0) return []
    return searchAssetVectors(db, embedding, k)
  } catch (error) {
    console.warn('[资产语义索引] 查询向量化失败，这次只走关键词:', error)
    return []
  }
}
