/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { looksLikeEmbeddingModelId } from './aiProvider'

/**
 * 向量化模型的手填 / 导入条目没有 `supportsEmbedding` 能力位，渲染层过滤
 * 「嵌入」角色候选、主进程选探测方式，兜底都靠这一份 id 特征词判定。
 * 判错了的代价不对称：把对话模型认成向量化，用户会在角色下拉里看到一个
 * 绑上去也不报错、但永远搜不到东西的选项；反过来漏认，刚配好的模型在
 * 下拉里找不到。
 */
describe('looksLikeEmbeddingModelId', () => {
  it.each([
    'text-embedding-v4',
    'text-embedding-v3',
    'nomic-embed-text',
    'bge-m3',
    'gte-large',
    'jina-embeddings-v3',
    'voyage-3-lite',
    'Qwen3.7-Text-Embedding'
  ])('%s → 是向量化模型', (id) => {
    expect(looksLikeEmbeddingModelId(id)).toBe(true)
  })

  it.each(['gpt-4o', 'deepseek-chat', 'qwen-max', 'claude-sonnet-4', 'glm-5'])(
    '%s → 不是向量化模型',
    (id) => {
      expect(looksLikeEmbeddingModelId(id)).toBe(false)
    }
  )
})
