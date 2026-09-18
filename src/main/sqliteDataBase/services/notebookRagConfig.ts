import { getPublicDatabase } from '../index'
import { getSetting, setSetting } from '../models/settings'

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 老库的默认维度（Jina v3）。没记录过维度的历史安装按它走 */
const LEGACY_EMBEDDING_DIM = 1024

const DIM_KEY = 'embedding_vector_dim'
const MODEL_TAG_KEY = 'embedding_model_tag'

/**
 * 向量维度。
 *
 * **必须持久化**，不能写死：维度由用户选的嵌入模型决定
 * （nomic-embed-text 是 768，bge-m3 是 1024，text-embedding-3-small 是 1536），
 * 而 vec0 虚拟表在建表时就把维度固定下来了。写死成 1024 的话，用户换成
 * 768 维的模型后每一次插入都会失败，而建表处的 catch 只 warn 一句，
 * 表现就是「知识库不报错但永远搜不到东西」。
 */
export const getEmbeddingDim = (): number => {
  try {
    const db = getPublicDatabase()
    const stored = getSetting<number | null>(db, DIM_KEY, null)
    if (stored !== null && Number.isFinite(stored) && stored > 0) return stored
  } catch {
    // 数据库还没初始化时按下面的兜底走
  }
  return parseNumber(process.env.JINA_EMBEDDING_DIM, LEGACY_EMBEDDING_DIM)
}

export const setEmbeddingDim = (dim: number): void => {
  if (!Number.isFinite(dim) || dim <= 0) return
  setSetting(getPublicDatabase(), DIM_KEY, dim)
}

/** 当前索引是用哪个模型建的，形如 `ollama:nomic-embed-text` */
export const getIndexedEmbeddingModelTag = (): string | null => {
  try {
    return getSetting<string | null>(getPublicDatabase(), MODEL_TAG_KEY, null)
  } catch {
    return null
  }
}

/**
 * 写进各表 `embedding_model` 列的模型名。
 *
 * 同步取值，取的是**上一次索引时记录的**标识 —— 调用点都在写数据库的同步
 * 路径上，没法 await 当前绑定。真正决定用哪个模型的是 ai/embedding.ts，
 * 这里只负责留个可追溯的痕迹。索引重建时 reconcile 会把它更新掉。
 */
export const getEmbeddingModel = (): string => getIndexedEmbeddingModelTag() || 'unknown'

export const setIndexedEmbeddingModelTag = (tag: string): void => {
  setSetting(getPublicDatabase(), MODEL_TAG_KEY, tag)
}

export const getChunkSize = (): number => parseNumber(process.env.NOTEBOOK_CHUNK_SIZE, 1200)

export const getChunkOverlap = (): number => parseNumber(process.env.NOTEBOOK_CHUNK_OVERLAP, 200)

export const getEmbeddingBatchSize = (): number =>
  parseNumber(process.env.JINA_EMBEDDING_BATCH_SIZE, 32)

/**
 * 获取知识库向量搜索的召回距离阈值。距离越小表示匹配度越高，超过阈值的结果被过滤。
 *
 * **只认环境变量，不再读 `notebook_recall_distance_threshold` 那条设置。**
 *
 * 那个输入框（偏好设置 → 知识库 → 召回距离阈值）已经删了：合适的阈值取决于嵌入模型、
 * 语料和 query 长度，用户没有依据在 0.5 和 2.0 之间选。但删掉界面之后那条数据库记录
 * 还在，而它原先的优先级**高于**环境变量 —— 于是：
 *
 * - 曾经填过 0.6 的用户被永久钉在 0.6，检索静默丢掉所有更远的匹配，且没有界面能改回来；
 * - 旧输入框是 `@blur` 触发写入的，光是点进那个数字框再点走就会存下 1.1，
 *   所以连「从没主动选过」的用户也有一条记录，同样盖掉环境变量。
 *
 * 那条记录现在被无视（`app_settings` 没有 delete 原语，留着不管即可，没有写入方了）。
 * 要调就走 NOTEBOOK_RECALL_DISTANCE_THRESHOLD。
 *
 * @returns 召回距离阈值，默认 1.1
 */
export const getRecallDistanceThreshold = (): number =>
  parseNumber(process.env.NOTEBOOK_RECALL_DISTANCE_THRESHOLD, 1.1)
