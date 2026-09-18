/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
// @ts-expect-error The generator is a standalone .mjs script without type declarations.
import { CURATED, pickModels, sourceFor } from '../../scripts/sync-provider-catalog.mjs'

interface SourceModel {
  id: string
  release_date?: string
  modalities?: { input?: string[]; output: string[] }
  tool_call?: boolean
  reasoning?: boolean
  limit?: { context: number; output?: number }
  attachment?: boolean
  status?: string
  isCompatibilityAlias?: boolean
}

const chat = (id: string, extra: Partial<SourceModel> = {}): SourceModel => ({
  id,
  release_date: '2026-06-01',
  modalities: { input: ['text'], output: ['text'] },
  tool_call: true,
  reasoning: false,
  limit: { context: 128_000, output: 8_192 },
  ...extra
})
const models = (...items: SourceModel[]): Record<string, SourceModel> =>
  Object.fromEntries(items.map((m) => [m.id, m]))

describe('provider catalog generation', () => {
  it('keeps only dated 2026 models, including both year boundaries', () => {
    const input = models(
      chat('old', { release_date: '2025-12-31' }),
      chat('first', { release_date: '2026-01-01' }),
      chat('last', { release_date: '2026-12-31' }),
      chat('next', { release_date: '2027-01-01' }),
      chat('unknown', { release_date: undefined }),
      chat('malformed', { release_date: '2026' })
    )
    expect(pickModels(input, 'test').map((m) => m.id)).toEqual(['last', 'first'])
  })

  it('does not refill an empty provider with old or undated models', () => {
    expect(pickModels(models(chat('old', { release_date: '2025-01-01' })), 'test')).toEqual([])
    expect(pickModels(models(chat('unknown', { release_date: undefined })), 'test')).toEqual([])
  })

  it('excludes retired routes, compatibility aliases and dedicated media models', () => {
    expect(
      pickModels(
        models(
          chat('current'),
          chat('retired', { status: 'retired' }),
          chat('deprecated', { status: 'deprecated' }),
          chat('alias', { isCompatibilityAlias: true }),
          chat('classifier', { limit: { context: 512 } }),
          chat('image', { modalities: { output: ['text', 'image'] } }),
          chat('audio', { modalities: { output: ['audio', 'text'] } })
        ),
        'test'
      ).map((m) => m.id)
    ).toEqual(['current'])
  })

  it('uses explicit image input, not the generic attachment flag', () => {
    const result = pickModels(
      models(
        chat('pdf', { attachment: true, modalities: { input: ['text', 'pdf'], output: ['text'] } }),
        chat('image', {
          attachment: false,
          modalities: { input: ['text', 'image'], output: ['text'] }
        }),
        chat('unknown', {
          attachment: true,
          modalities: undefined,
          tool_call: undefined,
          reasoning: undefined,
          limit: undefined
        })
      ),
      'test'
    )
    expect(result.find((m) => m.id === 'pdf').supportsVision).toBe(false)
    expect(result.find((m) => m.id === 'image').supportsVision).toBe(true)
    const unknown = result.find((m) => m.id === 'unknown')
    for (const field of [
      'supportsVision',
      'supportsTools',
      'supportsReasoning',
      'contextWindow',
      'maxOutputTokens'
    ]) {
      expect(unknown).not.toHaveProperty(field)
    }
  })

  it('preserves provider route limits and scopes official corrections to that route', () => {
    const input = models(chat('grok-4.6', { limit: { context: 500_000, output: 42_000 } }))
    expect(pickModels(input, 'gateway')[0].maxOutputTokens).toBe(42_000)
    expect(pickModels(input, 'xai')[0]).not.toHaveProperty('maxOutputTokens')
    expect(
      pickModels(models(chat('missing-output', { limit: { context: 100_000 } })), 'test')[0]
    ).not.toHaveProperty('maxOutputTokens')
  })

  it('removes only DeepSeek direct compatibility aliases', () => {
    const input = models(
      chat('deepseek-v4-flash'),
      chat('deepseek-v4-flash-vision-exp'),
      chat('deepseek-flash')
    )
    expect(pickModels(input, 'deepseek').map((m) => m.id)).toEqual(['deepseek-flash'])
    expect(pickModels(input, 'gateway')).toHaveLength(3)
  })

  it('uses exact provider mappings while preserving application IDs', () => {
    const tokenhub = { models: models(chat('hy4-preview')) }
    expect(
      sourceFor(
        CURATED.find((p) => p.id === 'tencent'),
        { 'tencent-tokenhub': tokenhub }
      )
    ).toBe(tokenhub)
    const ark = sourceFor(
      CURATED.find((p) => p.id === 'bytedance'),
      {
        volcengine: { models: models(chat('doubao-seed-2-1-pro-260628'), chat('third-party')) }
      }
    )
    expect(Object.keys(ark.models)).toEqual(['doubao-seed-2-1-pro-260628'])
  })

  it('keeps manual chat entries dated and testable without a network request', () => {
    for (const id of ['chatgpt', 'baidu']) {
      const item = CURATED.find((p) => p.id === id)
      const source = sourceFor(item, {})
      expect(pickModels(source.models, id)).toHaveLength(Object.keys(source.models).length)
    }
  })

  it('keeps the newest tool models first and enforces the per-provider cap', () => {
    const input = models(
      ...Array.from({ length: 14 }, (_, index) =>
        chat(String(index), {
          release_date: `2026-06-${String(index + 1).padStart(2, '0')}`,
          tool_call: index !== 13
        })
      )
    )
    const result = pickModels(input, 'test')
    expect(result).toHaveLength(12)
    expect(result[0].id).toBe('12')
    expect(result.some((m) => m.id === '13')).toBe(false)
  })
})
