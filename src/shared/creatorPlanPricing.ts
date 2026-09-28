/** 对客报价；只含虚拟模型与 Credits，不保存采购信息。 */
export interface CreatorPlanTokenPrice {
  input: number
  cached_input: number
  output: number
}
export interface CreatorPlanRoutePrice {
  version: string
  unit: 'token'
  minimum: CreatorPlanTokenPrice
  maximum: CreatorPlanTokenPrice
}
export const PLAN_PRICING_HEADER = 'X-UEBox-Pricing-Version'

/** 旧清单允许不含报价；坏报价不能被当作固定价或免费价。 */
export function parsePlanPricing(value: unknown): Record<string, CreatorPlanRoutePrice> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid plan pricing')
  const result: Record<string, CreatorPlanRoutePrice> = {}
  for (const [model, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid plan pricing')
    const price = raw as CreatorPlanRoutePrice
    if (
      typeof price.version !== 'string' ||
      !/^[!-~]{1,200}$/.test(price.version) ||
      price.unit !== 'token'
    )
      throw new Error('Invalid plan pricing version')
    for (const dimension of ['input', 'cached_input', 'output'] as const) {
      const low = price.minimum?.[dimension]
      const high = price.maximum?.[dimension]
      if (
        typeof low !== 'number' ||
        typeof high !== 'number' ||
        !Number.isFinite(low) ||
        !Number.isFinite(high) ||
        low < 0 ||
        high < low
      )
        throw new Error('Invalid plan pricing range')
    }
    Object.defineProperty(result, model, { value: price, enumerable: true })
  }
  return result
}

export interface CreatorPlanVideoPrice {
  version: string
  unit: 'second'
  settlement: 'actual'
  variants: Record<string, { minimum: number; maximum: number }>
}
export function parseVideoPricing(value: unknown): CreatorPlanVideoPrice | undefined {
  if (value === undefined) return undefined
  const price = value as CreatorPlanVideoPrice
  if (
    !price ||
    typeof price.version !== 'string' ||
    !/^[!-~]{1,200}$/.test(price.version) ||
    price.unit !== 'second' ||
    price.settlement !== 'actual' ||
    !price.variants ||
    typeof price.variants !== 'object' ||
    Array.isArray(price.variants) ||
    !Object.keys(price.variants).length
  )
    throw new Error('Invalid video pricing')
  for (const range of Object.values(price.variants)) {
    if (
      !range ||
      typeof range.minimum !== 'number' ||
      typeof range.maximum !== 'number' ||
      !Number.isFinite(range.minimum) ||
      !Number.isFinite(range.maximum) ||
      range.minimum < 0 ||
      range.maximum < range.minimum
    )
      throw new Error('Invalid video price range')
  }
  return price
}
