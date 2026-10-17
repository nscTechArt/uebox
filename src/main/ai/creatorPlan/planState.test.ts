/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { normalizePlanState } = await import('./planState')

describe('normalizePlanState', () => {
  it('读坏了按空状态：丢的只是还原信息和缓存', () => {
    expect(normalizePlanState(null)).toEqual({
      originals: {},
      etag: null,
      manifest: null,
      unauthorized: false
    })
  })

  it('原绑定只收认识的角色和完整的绑定；null（原来没设置）保留', () => {
    const state = normalizePlanState({
      originals: {
        chat: { providerId: 'p', modelId: 'm', source: 'plan' },
        agent: null,
        vision: { providerId: 'p' },
        nonsense: { providerId: 'p', modelId: 'm' }
      },
      etag: '"p-1"',
      manifest: { schema: 2 },
      unauthorized: true
    })
    expect(state).toEqual({
      originals: { chat: { providerId: 'p', modelId: 'm' } },
      etag: '"p-1"',
      manifest: null,
      unauthorized: true
    })
  })

  /**
   * 1.0.8 及以前「对话」「Agent」分两格，原绑定也各记各的。主模型合并之后只剩 chat 一格，
   * 读的时候并过去，规则和 store.ts 的 mergeMainModel 一样：Agent 那条有值就听它的
   */
  it('合并之前记的原绑定：agent 并进 chat，agent 有值时听 agent 的', () => {
    const a = { providerId: 'p', modelId: 'a' }
    const x = { providerId: 'p', modelId: 'x' }
    const fold = (originals: Record<string, unknown>): unknown =>
      normalizePlanState({ originals }).originals
    expect(fold({ chat: null, agent: x })).toEqual({ chat: x })
    expect(fold({ chat: a, agent: x })).toEqual({ chat: x })
    expect(fold({ chat: a, agent: null })).toEqual({ chat: a })
    expect(fold({ agent: x })).toEqual({ chat: x })
    expect(fold({ agent: null })).toEqual({ chat: null })
    expect(fold({ chat: a, vision: null })).toEqual({ chat: a, vision: null })
    // agent 那条形状不对：当没记过，chat 照旧
    expect(fold({ chat: a, agent: { providerId: 'p' } })).toEqual({ chat: a })
  })

  it('对象存储的原配置原样留着（断开时要照着还原）；不是对象的丢掉', () => {
    const original = { enabled: true, preset: 'r2', bucket: 'b' }
    expect(normalizePlanState({ storageOriginal: original }).storageOriginal).toEqual(original)
    expect(normalizePlanState({ storageOriginal: 'x' })).not.toHaveProperty('storageOriginal')
  })
})
