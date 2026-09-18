/**
 * @vitest-environment node
 *
 * 知识库索引与检索：**没有嵌入模型也要能用**。
 *
 * 这是整个改动的目的。以前向量是唯一一条路，没配模型时切片都不做，
 * 资料导进去了但一个字都搜不出来，而且界面上什么都不说。
 * 现在切片和全文索引永远本地建，向量有就加、没有就记下原因跳过。
 *
 * sqlite-vec 原生扩展在测试里不加载，所以这里覆盖的是关键词那一路 +
 * 两路融合的纯逻辑；向量那一路只验证「挂了不拦路」。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const embedding = vi.hoisted(() => ({
  /** 每次调用的行为，默认当作没配模型 */
  embedTexts: vi.fn<(inputs: string[]) => Promise<number[][]>>()
}))
const vec = vi.hoisted(() => ({ loaded: false }))

vi.mock('../../ai/embedding', () => ({
  embedTexts: embedding.embedTexts,
  getEmbeddingModelTag: async () => null
}))
vi.mock('../sqliteVec', () => ({
  ensureSqliteVecLoaded: () => vec.loaded,
  isSqliteVecLoaded: () => vec.loaded
}))
vi.mock('./notebookRagConfig', () => ({
  getEmbeddingDim: () => 3,
  getEmbeddingModel: () => 'test:embed',
  getChunkSize: () => 1200,
  getChunkOverlap: () => 200,
  getEmbeddingBatchSize: () => 32,
  getRecallDistanceThreshold: () => 1.1
}))
vi.mock('./embeddingReconcile', () => ({
  reconcileEmbeddingIndex: () => false,
  refreshEmbeddingModelTag: async () => null
}))

import { createNotebook, createNotebookSource, initNotebookModel } from '../models/notebook'
import { initNoteModel } from '../models/note'
import { initNotebookRagModel, type NotebookChunkSearchResult } from '../models/notebookRag'
import {
  fuseNotebookSearchResults,
  indexNotebookRag,
  searchNotebookRag
} from './notebookRagService'

let db: Database.Database

const notConfigured = (): Error =>
  new Error('知识库检索需要一个「嵌入」模型。到 设置 → 模型 绑定一个。')

interface SourceRow {
  index_status: string
  index_error: string | null
  indexed_content_hash: string | null
  content_hash: string
  embedding_model: string | null
}

const sourceRow = (sourceId: string): SourceRow =>
  db
    .prepare(
      'SELECT index_status, index_error, indexed_content_hash, content_hash, embedding_model FROM notebook_sources WHERE source_id = ?'
    )
    .get(sourceId) as SourceRow

const chunkCount = (sourceId: string): number =>
  Number(
    (
      db.prepare('SELECT COUNT(*) AS n FROM notebook_chunks WHERE source_id = ?').get(sourceId) as {
        n: number
      }
    ).n
  )

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  embedding.embedTexts.mockReset()
  embedding.embedTexts.mockRejectedValue(notConfigured())
  vec.loaded = false

  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initNotebookModel(db)
  initNoteModel(db)
  initNotebookRagModel(db)

  createNotebook(db, { notebookId: 'nb1', title: '渲染资料' })
  createNotebookSource(db, {
    sourceId: 'src-nanite',
    notebookId: 'nb1',
    title: 'Nanite 笔记',
    type: 'file',
    content: 'Nanite 适合高模静态网格体，不支持蒙皮骨骼网格体。开启后三角形数量不再是瓶颈。'
  })
  createNotebookSource(db, {
    sourceId: 'src-lumen',
    notebookId: 'nb1',
    title: 'Lumen 笔记',
    type: 'file',
    content: 'Lumen 是全局光照方案，动态光源下不需要烘焙光照贴图。'
  })
})

describe('没有嵌入模型时', () => {
  it('照样切片、建全文索引，来源标成「仅关键词」并写明原因', async () => {
    vec.loaded = true
    const result = await indexNotebookRag(db, 'nb1')

    expect(result.indexedSources).toBe(2)
    expect(chunkCount('src-nanite')).toBeGreaterThan(0)

    const row = sourceRow('src-nanite')
    expect(row.index_status).toBe('keyword')
    expect(row.index_error).toContain('嵌入')
    // 片段是按当前内容切的，指纹要对上，后台队列才不会反复排它
    expect(row.indexed_content_hash).toBe(row.content_hash)
    expect(row.embedding_model).toBeNull()
  })

  it('按关键词能搜到，命中标为 keyword 且没有向量距离', async () => {
    await indexNotebookRag(db, 'nb1')

    const hits = await searchNotebookRag(db, 'nb1', 'Nanite 支持骨骼吗')

    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].sourceId).toBe('src-nanite')
    expect(hits[0].matchedBy).toBe('keyword')
    expect(hits[0].distance).toBeNull()
  })

  it('中文关键词也能命中', async () => {
    await indexNotebookRag(db, 'nb1')

    const hits = await searchNotebookRag(db, 'nb1', '光照贴图')

    expect(hits.map((hit) => hit.sourceId)).toEqual(['src-lumen'])
  })

  it('内容没变就跳过，不会把片段灌两遍', async () => {
    await indexNotebookRag(db, 'nb1')
    const before = chunkCount('src-nanite')

    const second = await indexNotebookRag(db, 'nb1')

    expect(second.indexedSources).toBe(0)
    expect(chunkCount('src-nanite')).toBe(before)
  })

  it('全是标点的查询直接回空，不会让 FTS 报语法错', async () => {
    await indexNotebookRag(db, 'nb1')

    await expect(searchNotebookRag(db, 'nb1', '?!?"')).resolves.toEqual([])
  })
})

describe('向量那一路挂了不拦路', () => {
  it('扩展没加载时不去碰嵌入模型，原因写进来源', async () => {
    embedding.embedTexts.mockResolvedValue([[0.1, 0.2, 0.3]])
    vec.loaded = false

    await indexNotebookRag(db, 'nb1')

    expect(embedding.embedTexts).not.toHaveBeenCalled()
    expect(sourceRow('src-nanite').index_status).toBe('keyword')
    expect(sourceRow('src-nanite').index_error).toContain('sqlite-vec')
  })

  it('检索时嵌入模型报错，关键词结果照常返回', async () => {
    await indexNotebookRag(db, 'nb1')
    vec.loaded = true
    embedding.embedTexts.mockRejectedValue(new Error('401 invalid api key'))

    const hits = await searchNotebookRag(db, 'nb1', 'Lumen')

    expect(hits.map((hit) => hit.sourceId)).toEqual(['src-lumen'])
  })

  it('模型配好之后再训练，会把「仅关键词」的来源补上向量路', async () => {
    await indexNotebookRag(db, 'nb1')
    expect(sourceRow('src-nanite').index_status).toBe('keyword')

    // 扩展有了、模型也通了 —— 但 vec0 表在测试里建不起来，插向量会失败。
    // 这里只验证它**没有被当成最新而跳过**：真的去算了向量。
    vec.loaded = true
    embedding.embedTexts.mockResolvedValue([[0.1, 0.2, 0.3]])

    await indexNotebookRag(db, 'nb1').catch(() => undefined)

    // 探针 1 次 + 至少一个来源的片段
    expect(embedding.embedTexts.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('两路融合', () => {
  const hit = (chunkId: string, distance: number | null = null): NotebookChunkSearchResult => ({
    chunkId,
    notebookId: 'nb1',
    sourceId: 's',
    content: chunkId,
    chunkIndex: 0,
    createdAt: '',
    updatedAt: '',
    distance
  })

  it('两路都命中的片段排最前，且标为 both', () => {
    const fused = fuseNotebookSearchResults(
      [hit('a', 0.2), hit('b', 0.3), hit('c', 0.4)],
      [hit('c'), hit('d'), hit('a')],
      10
    )

    expect(fused[0].chunkId).toBe('a')
    expect(fused[0].matchedBy).toBe('both')
    expect(fused[1].chunkId).toBe('c')
    expect(fused.map((item) => item.chunkId)).toContain('b')
    expect(fused.map((item) => item.chunkId)).toContain('d')
  })

  it('只有一路有结果时保持那一路的原序', () => {
    const fused = fuseNotebookSearchResults([], [hit('x'), hit('y'), hit('z')], 10)

    expect(fused.map((item) => item.chunkId)).toEqual(['x', 'y', 'z'])
    expect(fused.every((item) => item.matchedBy === 'keyword')).toBe(true)
  })

  it('融合后仍然带着向量距离，并按 limit 截断', () => {
    const fused = fuseNotebookSearchResults([hit('a', 0.25)], [hit('a'), hit('b'), hit('c')], 2)

    expect(fused).toHaveLength(2)
    expect(fused[0].distance).toBe(0.25)
  })
})
