/**
 * 批量写入「部分成功」时，给模型看的第一句话。
 *
 * ## 为什么要有这个模块
 *
 * AGENTS.md §5 第 14 条：有一件没办成，第一句就不许说成功。模型读回执的习惯是
 * 看到「成功」「✅」就收工，失败条目哪怕列在后面的数组里也常被跳过。
 *
 * 2026-09-24 的回执审计里，十几个工具各自拼「成功导入 3/5」「成功删除 6 / 7」，
 * 句式各不相同，而且都是**先说成功、再在后面补失败**。这里收成一处：
 * 有失败时第一句一律是 `⚠️ 部分完成：N 成功 / M 失败`，失败原因逐条跟在后面。
 *
 * 全部失败不走这里 —— 那种情况工具应当抛错或 `isError: true`。
 */

export interface PartialFailure {
  /** 哪一条：名字、路径或序号 */
  item: string
  /** 为什么没办成。插件没给原因时留空，这里会写「未给原因」 */
  reason?: string
}

export interface PartialCounts {
  succeeded: number
  failed: number
  /** 跳过的（没尝试、被过滤、格式不对）。和失败分开数，但同样要摆在第一句 */
  skipped?: number
  /** 量词后的名词，如「个 Actor」「个属性」。默认「项」 */
  unit?: string
}

/** 列几条原因。条目名可能很长，全列会把回执撑爆 */
const MAX_LISTED = 8

/** 是否需要按部分失败来写第一句 */
export function hasPartialFailure(counts: PartialCounts): boolean {
  return counts.failed > 0 || (counts.skipped ?? 0) > 0
}

/**
 * 第一句话。没有失败也没有跳过时返回空串，调用方照常写自己的成功文案。
 *
 * `⚠️ 部分完成：3 个 Actor 成功 / 2 个 Actor 失败 / 1 个 Actor 跳过。`
 */
export function partialHeadline(counts: PartialCounts): string {
  if (!hasPartialFailure(counts)) return ''
  const unit = counts.unit ?? '项'
  // 中文与英文之间留空格：「3 个 Actor 成功」「3 项成功」
  const sep = /[A-Za-z0-9]$/.test(unit) ? ' ' : ''
  const count = (n: number, verb: string): string => `${n} ${unit}${sep}${verb}`
  const parts = [count(counts.succeeded, '成功'), count(counts.failed, '失败')]
  if ((counts.skipped ?? 0) > 0) parts.push(count(counts.skipped ?? 0, '跳过'))
  return `⚠️ 部分完成：${parts.join(' / ')}。`
}

/** 失败条目逐条写出。空数组返回空串 */
export function describeFailures(failures: readonly PartialFailure[], label = '没办成的'): string {
  if (failures.length === 0) return ''
  const shown = failures.slice(0, MAX_LISTED)
  const rest = failures.length - shown.length
  const lines = shown.map((f) => `- ${f.item}：${f.reason?.trim() || '未给原因'}`)
  if (rest > 0) lines.push(`- …还有 ${rest} 条`)
  return `${label}：\n${lines.join('\n')}`
}

/**
 * 把第一句、原来的成功文案、失败清单拼成一段。
 * 没有失败时原样返回 `body`。
 */
export function withPartialHeadline(
  body: string,
  counts: PartialCounts,
  failures: readonly PartialFailure[] = []
): string {
  const headline = partialHeadline(counts)
  if (!headline) return body
  return [headline, body, describeFailures(failures)].filter(Boolean).join('\n')
}
