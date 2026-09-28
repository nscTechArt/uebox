import { describe, expect, it } from 'vitest'
import { parsePlanPricing, parseVideoPricing } from './creatorPlanPricing'
const price = {
  version: 'rp-one',
  unit: 'token',
  minimum: { input: 1, cached_input: 0, output: 2 },
  maximum: { input: 3, cached_input: 1, output: 4 }
}
describe('plan pricing validation', () => {
  const video = {
    version: 'vp-one',
    unit: 'second',
    settlement: 'actual',
    variants: { '720p': { minimum: 1, maximum: 2 } }
  }
  it('accepts video estimates only with explicit actual settlement terms', () => {
    expect(parseVideoPricing(undefined)).toBeUndefined()
    expect(parseVideoPricing(video)).toEqual(video)
  })
  it.each([
    null,
    [],
    { ...video, version: 'bad\nheader' },
    { ...video, settlement: 'fixed' },
    { ...video, unit: 'token' },
    { ...video, variants: {} },
    { ...video, variants: { '720p': { minimum: 2, maximum: 1 } } },
    { ...video, variants: { '720p': { minimum: 1, maximum: Infinity } } }
  ])('rejects malformed video estimates: %j', (raw) => {
    expect(() => parseVideoPricing(raw)).toThrow()
  })
  it('supports absent legacy prices and explicitly free cache', () => {
    expect(parsePlanPricing(undefined)).toEqual({})
    expect(parsePlanPricing({ 'uebox-chat': price })['uebox-chat'].minimum.cached_input).toBe(0)
  })
  it.each([
    null,
    [],
    { chat: {} },
    { chat: { ...price, version: 'bad\nheader' } },
    { chat: { ...price, minimum: { ...price.minimum, input: -1 } } },
    { chat: { ...price, maximum: { ...price.maximum, input: 0 } } },
    { chat: { ...price, minimum: { input: 1, output: 2 } } }
  ])('rejects malformed prices: %j', (raw) => {
    expect(() => parsePlanPricing(raw)).toThrow()
  })
})
