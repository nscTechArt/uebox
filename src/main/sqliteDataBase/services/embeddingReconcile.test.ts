import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 换嵌入模型后重建向量表。
 *
 * 这段逻辑值得单独测，是因为它错了**不会报错**：vec0 表维度对不上时插入失败，
 * 而建表处只 warn 一句，表现是「知识库不报错但永远搜不到东西」。
 */

const executed: string[] = []

const fakeDb = {
  exec: (sql: string) => {
    executed.push(sql.trim())
  },
  prepare: (sql: string) => ({
    get: (name: string) => {
      // 只有向量表算「已存在」，其它一律当不存在
      if (!sql.includes('sqlite_master')) return undefined
      return name.endsWith('_vectors') ? { name } : undefined
    }
  })
}

vi.mock('../index', () => ({ getPublicDatabase: () => fakeDb }))

const stored: Record<string, unknown> = {}

vi.mock('./notebookRagConfig', () => ({
  getEmbeddingDim: () => (stored.dim as number) ?? 1024,
  getIndexedEmbeddingModelTag: () => (stored.tag as string) ?? null,
  setEmbeddingDim: (dim: number) => {
    stored.dim = dim
  },
  setIndexedEmbeddingModelTag: (tag: string) => {
    stored.tag = tag
  }
}))

vi.mock('../../ai/embedding', () => ({ getEmbeddingModelTag: async () => null }))

const { reconcileEmbeddingIndex, setPendingModelTagForTest } = await import('./embeddingReconcile')

beforeEach(() => {
  executed.length = 0
  stored.dim = 1024
  stored.tag = 'jina:jina-embeddings-v3'
})

describe('reconcileEmbeddingIndex', () => {
  it('模型没变时什么都不做', () => {
    setPendingModelTagForTest('jina:jina-embeddings-v3')

    expect(reconcileEmbeddingIndex(1024)).toBe(false)
    expect(executed).toHaveLength(0)
  })

  it('换了模型就按新维度重建用户知识库向量表', () => {
    setPendingModelTagForTest('ollama:nomic-embed-text')

    expect(reconcileEmbeddingIndex(768)).toBe(true)

    const created = executed.filter((sql) => sql.startsWith('CREATE VIRTUAL TABLE'))
    expect(created).toHaveLength(1)
    // 维度必须跟着新模型走，写死 1024 正是要避免的那个 bug
    expect(created.every((sql) => sql.includes('float[768]'))).toBe(true)
    expect(created[0]).toContain('notebook_chunk_vectors')
    expect(executed.filter((sql) => sql.startsWith('DROP TABLE'))).toHaveLength(1)
    expect(executed.some((sql) => sql.includes('product_knowledge'))).toBe(false)
    expect(stored.dim).toBe(768)
    expect(stored.tag).toBe('ollama:nomic-embed-text')
  })

  it('维度相同但模型不同，照样重建', () => {
    // bge-m3 与 jina-v3 都是 1024 维，但向量空间毫无关系。
    // 只比维度的话这里会放过去，检索结果看似正常实则全错。
    setPendingModelTagForTest('siliconflow:BAAI/bge-m3')

    expect(reconcileEmbeddingIndex(1024)).toBe(true)
    expect(stored.tag).toBe('siliconflow:BAAI/bge-m3')
  })

  it('重建知识库时保留分块，只把已向量化的来源标成仅关键词', () => {
    setPendingModelTagForTest('ollama:nomic-embed-text')
    reconcileEmbeddingIndex(768)

    // 片段和全文索引不依赖嵌入模型，换模型期间关键词检索必须照常
    expect(executed.some((sql) => sql.includes('DELETE FROM notebook_chunks'))).toBe(false)
    const update = executed.find((sql) => sql.startsWith('UPDATE notebook_sources'))
    expect(update).toContain("index_status = 'keyword'")
    expect(update).toContain("WHERE index_status = 'indexed'")
  })

  it('拿不到当前模型标识时不动任何东西', () => {
    // 宁可不重建，也不能在不知道要换成什么的情况下先把表删了
    setPendingModelTagForTest(null)

    expect(reconcileEmbeddingIndex(768)).toBe(false)
    expect(executed).toHaveLength(0)
  })

  it('维度非法时不动任何东西', () => {
    setPendingModelTagForTest('ollama:nomic-embed-text')

    expect(reconcileEmbeddingIndex(0)).toBe(false)
    expect(executed).toHaveLength(0)
  })
})
