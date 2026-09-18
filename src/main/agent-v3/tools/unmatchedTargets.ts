/**
 * 「点名了但没找到」的那几个名字，统一写成一句话。
 *
 * ## 为什么要有这个模块
 *
 * 插件的 `ResolveTargetsToActors` 以前把对不上的 `names` / `paths` **静默丢掉**：
 * 传 7 个名字只认出 6 个，响应里就只有 6 条，没有任何字段说少了谁。调用方拿到
 * 一个 200 和一句「成功」，于是告诉用户 7 个都办好了。
 *
 * 这条路上挂着 `actor.destroy` —— 删 7 个只删了 6 个而不吭声，剩下那个要到很久
 * 以后才被发现还活着；也挂着 `viewport.focus` —— 镜头框住的是 6 个，截图看着
 * 「对的」，第 7 个在画面外。2026-09-17 的实测反馈里报的是 focus 那一次
 * （`focused` 数组少一条，无任何报错）。
 *
 * 插件现在会回 `unmatched_targets` / `unmatched_count`（见
 * `plugin/.../UAL_CommandUtils.cpp` 的 `AddUnmatchedTargets`）。这里负责把它
 * **变成模型看得见的文字** —— 只放进结构化字段等于没给（模型只读 message）。
 *
 * 老版本插件不回这两个字段，这里返回空串，行为和以前一样。
 */

/** 插件在任何吃 `targets` 的命令里都可能带的两个字段 */
export interface UnmatchedTargetsResponse {
  unmatched_targets?: string[]
  unmatched_count?: number
}

/** 最多列几个名字，剩下的折成「还有 N 个」——名字可能很长，全列会把摘要撑爆 */
const MAX_LISTED = 8

function pickNames(response: UnmatchedTargetsResponse | null | undefined): string[] {
  const names = response?.unmatched_targets
  if (!Array.isArray(names)) return []
  return names.filter((name): name is string => typeof name === 'string' && name.length > 0)
}

/**
 * 接在 message 后面的一句话。没有漏掉任何目标时返回空串。
 */
export function describeUnmatchedTargets(
  response: UnmatchedTargetsResponse | null | undefined
): string {
  const names = pickNames(response)
  if (names.length === 0) return ''

  const shown = names.slice(0, MAX_LISTED)
  const rest = names.length - shown.length

  return (
    ` ⚠️ 点名的 ${names.length} 个目标在关卡里没找到，这一步**没有**对它们生效：` +
    `${shown.join('、')}${rest > 0 ? ` …（还有 ${rest} 个）` : ''}。` +
    'names 认的是大纲里显示的名字（ActorLabel），不是内部对象名；' +
    '拿不准就用 ue_get_actor 加 filter.name_pattern 先查一遍，不要凭名字重试。'
  )
}

/** 把两个字段原样透出，供调用方自己判断，而不是只能读摘要 */
export function unmatchedTargetFields(
  response: UnmatchedTargetsResponse | null | undefined
): UnmatchedTargetsResponse {
  const names = pickNames(response)
  if (names.length === 0) return {}
  return { unmatched_targets: names, unmatched_count: names.length }
}
