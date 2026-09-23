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
      originals: { chat: { providerId: 'p', modelId: 'm' }, agent: null },
      etag: '"p-1"',
      manifest: null,
      unauthorized: true
    })
  })
})
