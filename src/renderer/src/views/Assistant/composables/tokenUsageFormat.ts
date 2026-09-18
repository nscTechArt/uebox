/**
 * token 用量的显示格式。
 *
 * 单独一个模块而不是塞进组件里：输入框上的上下文指示器和回复下面的本轮用量
 * 用的是同一套数字口径，两处各写一份的话迟早会一个显示 `12.3k`、
 * 另一个显示 `12345`，用户会以为是两个不同的东西。
 */

/**
 * 大数字缩写。1000 以下原样显示 —— 「花了 856 tokens」比「0.9k」有用得多。
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (value < 1000) return String(Math.round(value))
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
}

/** 带千分位的完整数字，给悬浮明细用 —— 那里要的是能对账的精确值 */
export function formatExactTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  return Math.round(value).toLocaleString('en-US')
}

/**
 * 费用。
 *
 * 一轮对话常常只要几厘钱，四位小数还不够 —— 直接 `$0.0000` 会让人以为没花钱，
 * 所以小到那一档就显示 `<$0.0001`。厂商没给价的模型 cost 是 0，返回空串，
 * 调用方据此整段不显示，而不是显示一个假的「$0.00」。
 */
export function formatUsageCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value < 0.0001) return '<$0.0001'
  return `$${value.toFixed(4)}`
}
