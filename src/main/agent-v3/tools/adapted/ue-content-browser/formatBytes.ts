/**
 * 字节数变成人能读的。
 *
 * 报告里该出现的是「412 MB」，不是「432013312」—— 后者要调用方自己心算
 * 除三次 1024，而它经常算错一个数量级，然后把结论也说错一个数量级。
 *
 * 两个体积工具（ue_project_asset_ranking / ue_asset_size_map）共用一份，
 * 免得同一个 412MB 在两处显示成不同的字样。
 */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }

  // 字节保持整数（没有 0.5 个字节）；三位数以上也不要小数，
  // 「1013.7 MB」比「1014 MB」多出来的那位没有信息量。
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
