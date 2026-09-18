import type Database from 'better-sqlite3'
import { getPublicDatabase } from '../index'
import { getEmbeddingModelTag } from '../../ai/embedding'
import {
  getEmbeddingDim,
  getIndexedEmbeddingModelTag,
  setEmbeddingDim,
  setIndexedEmbeddingModelTag
} from './notebookRagConfig'

/**
 * 换嵌入模型后的索引重建。
 *
 * 两张向量表都是 sqlite-vec 的 vec0 虚拟表，**建表时就把维度写死了**
 * （`embedding float[1024]`）。用户把嵌入模型从 1024 维换成 768 维之后：
 *
 *   - `CREATE VIRTUAL TABLE IF NOT EXISTS` 看到表已存在就跳过，维度还是旧的
 *   - 之后每次插入都会因维度不符失败
 *   - 而建表处的 catch 只 warn 一句
 *
 * 净效果是「知识库不报错，但永远搜不到东西」—— 最难查的那种坏法。
 *
 * 另外**维度相同也不代表可以复用**：bge-m3 和 jina-v3 都是 1024 维，但它们的
 * 向量空间毫无关系，混在一起检索会返回看似正常实则乱套的结果。所以判据是
 * **模型标识**而不是维度。
 */

/** 用户知识库向量表，以及重建时要连带清掉什么 */
const VECTOR_TABLES = Object.freeze([
  {
    vectorTable: 'notebook_chunk_vectors',
    // 片段和全文索引不依赖嵌入模型，留着 —— 换模型期间关键词检索照常。
    // 只把「向量齐了」的来源标成「仅关键词」，下一次训练会按新模型补向量。
    onRebuild: (db: Database.Database): void => {
      db.exec(
        "UPDATE notebook_sources SET index_status = 'keyword', " +
          "index_error = '嵌入模型已更换，向量待重建' WHERE index_status = 'indexed'"
      )
    }
  }
])

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name)
  return Boolean(row)
}

/**
 * 若嵌入模型变了，就把向量表按新维度重建。
 *
 * 幂等：模型没变时什么都不做，可以在每次索引前无脑调用。
 *
 * @param dimension 新模型实际产出的维度（从一次真实向量化中得到，不靠猜）
 * @returns 是否真的重建了
 */
export function reconcileEmbeddingIndex(dimension: number): boolean {
  const currentTag = pendingModelTag
  if (!currentTag || !Number.isFinite(dimension) || dimension <= 0) return false

  const indexedTag = getIndexedEmbeddingModelTag()
  const indexedDim = getEmbeddingDim()
  if (indexedTag === currentTag && indexedDim === dimension) return false

  const db = getPublicDatabase()
  console.warn(
    `[embedding] 嵌入模型从 ${indexedTag ?? '(未记录)'} 变为 ${currentTag}` +
      `（${indexedDim} → ${dimension} 维），重建向量索引。`
  )

  for (const { vectorTable, onRebuild } of VECTOR_TABLES) {
    try {
      if (tableExists(db, vectorTable)) db.exec(`DROP TABLE ${vectorTable}`)
      db.exec(`CREATE VIRTUAL TABLE ${vectorTable} USING vec0(embedding float[${dimension}])`)
      onRebuild(db)
    } catch (error) {
      // 一张表失败不该拖垮另一张知识库索引
      console.error(`[embedding] 重建 ${vectorTable} 失败：`, error)
    }
  }

  setEmbeddingDim(dimension)
  setIndexedEmbeddingModelTag(currentTag)
  return true
}

/**
 * 当前绑定的嵌入模型标识。
 *
 * 缓存一份同步值，是因为 reconcile 要在 better-sqlite3 的同步事务里用，
 * 那里没法 await。由 refreshEmbeddingModelTag() 在每次索引任务开始前刷新。
 */
let pendingModelTag: string | null = null

export async function refreshEmbeddingModelTag(): Promise<string | null> {
  pendingModelTag = await getEmbeddingModelTag()
  return pendingModelTag
}

/** 仅供测试 */
export function setPendingModelTagForTest(tag: string | null): void {
  pendingModelTag = tag
}
