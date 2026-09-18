import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const settings = {
  version: 1 as const,
  providers: [
    {
      id: 'ollama',
      displayName: 'Ollama',
      protocol: 'openai-completions' as const,
      // 末尾带斜杠，用来验证拼 URL 时不会拼出双斜杠
      baseUrl: 'http://localhost:11434/v1/',
      apiKey: { kind: 'none' as const },
      models: [{ id: 'nomic-embed-text' }]
    }
  ],
  roles: {} as Record<string, { providerId: string; modelId: string }>
}

vi.mock('./store', () => ({
  readSettings: async () => settings
}))

const { embedTexts, isEmbeddingConfigured, getEmbeddingModelTag } = await import('./embedding')

const originalFetch = globalThis.fetch

beforeEach(() => {
  settings.roles = { embedding: { providerId: 'ollama', modelId: 'nomic-embed-text' } }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 造一个能记录请求的 /embeddings 桩 */
function stubEmbeddings(handler: (body: { model: string; input: string[] }) => unknown): {
  urls: string[]
} {
  const urls: string[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    urls.push(String(url))
    const body = JSON.parse(String(init.body))
    return { ok: true, status: 200, json: async () => handler(body) }
  }) as unknown as typeof fetch
  return { urls }
}

describe('embedTexts', () => {
  it('打到 /embeddings，且不会因 baseUrl 末尾斜杠拼出双斜杠', async () => {
    const stub = stubEmbeddings((body) => ({
      data: body.input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] }))
    }))

    await embedTexts(['你好'])

    expect(stub.urls[0]).toBe('http://localhost:11434/v1/embeddings')
  })

  it('按 index 回填，厂商乱序返回也不会串行', async () => {
    // 协议允许乱序。依赖数组顺序的话，A 的向量会挂到 B 的文本上 ——
    // 检索结果整体错位，而且完全不报错。
    stubEmbeddings(() => ({
      data: [
        { index: 2, embedding: [3] },
        { index: 0, embedding: [1] },
        { index: 1, embedding: [2] }
      ]
    }))

    expect(await embedTexts(['a', 'b', 'c'])).toEqual([[1], [2], [3]])
  })

  it('返回条数对不上时报错，而不是留空洞', async () => {
    stubEmbeddings(() => ({ data: [{ index: 0, embedding: [1] }] }))

    await expect(embedTexts(['a', 'b'])).rejects.toThrow(/缺少第 1 条/)
  })

  it('空输入直接返回，不发请求', async () => {
    const stub = stubEmbeddings(() => ({ data: [] }))

    expect(await embedTexts([])).toEqual([])
    expect(stub.urls).toHaveLength(0)
  })

  it('超过一批时分批发送', async () => {
    const stub = stubEmbeddings((body) => ({
      data: body.input.map((_, index) => ({ index, embedding: [index] }))
    }))

    const result = await embedTexts(Array.from({ length: 70 }, (_, i) => `t${i}`))

    expect(stub.urls).toHaveLength(2)
    expect(result).toHaveLength(70)
  })

  it('没绑定嵌入模型时给出可操作的提示', async () => {
    settings.roles = {}

    // 关键是别回落到对话模型：那样只会拿到一句看不懂的厂商报错
    await expect(embedTexts(['a'])).rejects.toThrow(/嵌入/)
  })
})

describe('isEmbeddingConfigured', () => {
  it('绑定存在且 Provider 还在时为真', async () => {
    expect(await isEmbeddingConfigured()).toBe(true)
  })

  it('绑定指向已删除的 Provider 时为假', async () => {
    settings.roles = { embedding: { providerId: 'gone', modelId: 'x' } }
    expect(await isEmbeddingConfigured()).toBe(false)
  })
})

describe('getEmbeddingModelTag', () => {
  it('拼成 provider:model，用来判断索引要不要重建', async () => {
    expect(await getEmbeddingModelTag()).toBe('ollama:nomic-embed-text')
  })
})
