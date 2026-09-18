import type { ToolRisk } from './changeSummary'

/**
 * 工具风险表（工具名 → safe / mutating / destructive）。
 *
 * 取失败就退回空表 —— 那时「本轮改动」什么都不显示，总好过显示一份错的。
 *
 * ## 为什么不是永久缓存
 *
 * 原来是「一个应用生命周期内不会变，只取一次」。**接进 MCP 之后这条不成立了**：
 * 表里现在还包含已连接 MCP server 的工具（含 UE 5.8 引擎工具集），
 * 而那些是会变的 —— 用户中途加一个 server、或者一键开启引擎工具集之后，
 * 永久缓存里没有那些新工具名，`summarizeChanges()` 查不到风险就跳过，
 * 于是「本轮改动」把引擎工具集干的活全漏掉。
 *
 * 所以改成短 TTL：同一轮回复里的多次调用共用一次请求（这是缓存真正要解决的），
 * 跨轮则重新取。一次 IPC 往返的代价远小于一份漏报的改动清单。
 */
const TTL_MS = 5_000

let cached: Promise<Record<string, ToolRisk>> | undefined
let cachedAt = 0

export async function loadToolRiskTable(): Promise<Record<string, ToolRisk>> {
  const now = Date.now()
  if (!cached || now - cachedAt > TTL_MS) {
    cachedAt = now
    cached = (async () => {
      try {
        const table = await window.api?.agentV3?.toolRisks?.()
        return table || {}
      } catch (error) {
        console.warn('[toolRiskTable] 获取工具风险表失败:', error)
        return {}
      }
    })()
  }

  return cached
}

/** 测试用：清掉缓存 */
export function resetToolRiskTableForTest(): void {
  cached = undefined
  cachedAt = 0
}
