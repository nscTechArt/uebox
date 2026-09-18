/**
 * 一次引擎扫描回来之后该怎么处理 —— 抽出来是为了能测。
 *
 * 三条守则都藏在这几行里，而它们各自都出过事：
 * 1. **降级也要用给回来的列表。** 主进程读失败时回的是上次的缓存（`scanEngines()`
 *    的注释：「engines 仍然是能给多少给多少」）。首页没有 keepAlive，切个标签
 *    回来就是空列表，丢掉这份等于对着装了四个引擎的用户显示一个都没有。
 * 2. **降级不许同步用户的选择。** 调用方据 `syncSelections` 决定跑不跑
 *    `syncEngineSelectionsWithList()` —— 那个函数把「不在列表里」当成「引擎没了」，
 *    一次读失败就会把 defaultEngineVersion 从磁盘删掉，删了不回来。
 * 3. **空列表要分得清是「没装」还是「没读到」。** 靠 `ok`。
 */
export type EngineScanReply = {
  success: boolean
  data?: unknown[]
  degraded?: boolean
  error?: string
}

export type EngineScanOutcome<T> = {
  /** 这一趟读成没读成。false = 界面要说「没读到」而不是「没有」 */
  ok: boolean
  /** 要显示的列表；`null` = 这趟没拿到可用数据，保留界面上现有的 */
  engines: T[] | null
  /** 能不能拿这份列表去回收用户存的默认引擎 / 上次打开记录 */
  syncSelections: boolean
}

export function readEngineScan<T>(
  reply: EngineScanReply | null | undefined,
  map: (info: unknown) => T
): EngineScanOutcome<T> {
  if (!reply?.success) {
    // 连 IPC 都没成，什么都别动
    return { ok: false, engines: null, syncSelections: false }
  }

  const ok = !reply.degraded
  const list = Array.isArray(reply.data) ? reply.data : []

  // 降级但给了数据（缓存）：照样显示。降级且空：保留现有的，别把界面清空。
  if (!ok)
    return { ok: false, engines: list.length > 0 ? list.map(map) : null, syncSelections: false }

  return { ok: true, engines: list.map(map), syncSelections: true }
}
