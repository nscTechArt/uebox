/** Beta 测试统一口径：input 已扣除缓存，绝不把 cacheRead 再加回累计输入。 */
export function summarizeToolSearchUsage(usageByTurn = []) {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite']
  const valid = (value) => Number.isFinite(value) && value >= 0
  const tokens = Object.fromEntries(
    fields.map((field) => [
      field,
      usageByTurn.length && usageByTurn.every((turn) => valid(turn[field]))
        ? usageByTurn.reduce((sum, turn) => sum + turn[field], 0)
        : null
    ])
  )
  const perResponse = usageByTurn.map((turn) => {
    const hasInputUsage =
      ['input', 'cacheRead', 'cacheWrite'].every((field) => valid(turn[field])) &&
      turn.input + turn.cacheRead + turn.cacheWrite > 0
    return { ...turn, cacheHit: hasInputUsage ? turn.cacheRead > 0 : null }
  })
  const measured = perResponse.filter((turn) => turn.cacheHit !== null)
  const hitResponses = measured.filter((turn) => turn.cacheHit).length
  // 只作为 token 命中占比的分母，不输出成“累计输入”。不是计费折算。
  const inputVolume = ['input', 'cacheRead', 'cacheWrite'].every((field) => valid(tokens[field]))
    ? tokens.input + tokens.cacheRead + tokens.cacheWrite
    : 0
  return {
    tokens,
    cache: {
      measuredResponses: measured.length,
      hitResponses,
      missResponses: measured.length - hitResponses,
      unmeasuredResponses: perResponse.length - measured.length,
      responseHitRate: measured.length ? hitResponses / measured.length : null,
      readTokenShare: inputVolume > 0 ? tokens.cacheRead / inputVolume : null
    },
    perResponse
  }
}
