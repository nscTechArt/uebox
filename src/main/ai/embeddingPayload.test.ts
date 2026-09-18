import { describe, expect, it } from 'vitest'
import { buildEmbeddingPayload } from './embedding'

/**
 * 各家 `/embeddings` 的形状分歧只有一处，但那一处**错了不会报错**：
 * Jina v3/v4 与 Voyage 是非对称检索模型，文档与查询用不同的向量空间编码。
 * 漏发那个参数请求照样 200、向量照样回来，只是召回明显变差 ——
 * 没有任何运行时信号能告诉你搞错了，只能靠这组断言守着。
 */
describe('buildEmbeddingPayload', () => {
  const base = { modelId: 'm', inputs: ['a', 'b'] }

  it('缺省走 OpenAI 形状，不发任何多余参数', () => {
    expect(buildEmbeddingPayload({ ...base, task: 'document' })).toEqual({
      model: 'm',
      input: ['a', 'b']
    })
  })

  it('声明了维度就显式发 dimensions', () => {
    const payload = buildEmbeddingPayload({ ...base, task: 'document', dimensions: 1024 })

    expect(payload.dimensions).toBe(1024)
  })

  /** 0 或负数是「没配」，不是「要 0 维」—— 发出去只会 400 */
  it('维度为 0 时不发', () => {
    expect(buildEmbeddingPayload({ ...base, task: 'document', dimensions: 0 })).not.toHaveProperty(
      'dimensions'
    )
  })

  it('Jina 按文档/查询发不同的 task', () => {
    expect(buildEmbeddingPayload({ ...base, task: 'document', api: 'jina-embeddings' }).task).toBe(
      'retrieval.passage'
    )
    expect(buildEmbeddingPayload({ ...base, task: 'query', api: 'jina-embeddings' }).task).toBe(
      'retrieval.query'
    )
  })

  it('Voyage 用的是 input_type，不是 task', () => {
    const doc = buildEmbeddingPayload({ ...base, task: 'document', api: 'voyage-embeddings' })
    const query = buildEmbeddingPayload({ ...base, task: 'query', api: 'voyage-embeddings' })

    expect(doc.input_type).toBe('document')
    expect(query.input_type).toBe('query')
    expect(doc).not.toHaveProperty('task')
  })

  /** OpenAI 没有这个概念，多发一个未知字段有些网关会直接 400 */
  it('OpenAI 形状下不发文档/查询参数', () => {
    const payload = buildEmbeddingPayload({ ...base, task: 'query', api: 'openai-embeddings' })

    expect(payload).not.toHaveProperty('task')
    expect(payload).not.toHaveProperty('input_type')
  })
})
