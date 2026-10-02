/**
 * 短 TTL 的异步结果缓存。
 *
 * 「最近项目」在 win32 上每次右键都现查：读所有引擎版本的 EditorSettings.ini、
 * 逐条查库、确认 `.uproject` 还在盘上。连点两下就把同一趟全量 IO 重跑一次，
 * 而这些都发生在主进程 —— 工程放在休眠磁盘 / 掉线网络盘上时，弹菜单的
 * 这几秒整个界面都在陪着卡。
 *
 * 这份候选名单变化极慢（UE 只在编辑器启动 / 退出时写 ini），十秒内的重复
 * 读取看到的必然是同一份。**只缓存名单本身**：「运行中 / 启动中」状态由
 * `withProjectState` 在缓存之外每次现算，不经过这里，所以缓存不会拖住状态刷新。
 *
 * 失败的调用不缓存 —— 一次读盘错误不该被记成十秒的「没有最近项目」。
 * 同一时刻的并发调用共用同一趟加载。
 */
export interface TtlCache<T> {
  /** 命中就直接返回；未命中调 loader，并发共用同一趟 */
  get: (loader: () => Promise<T>) => Promise<T>
  invalidate: () => void
}

export function createTtlCache<T>(deps: { ttlMs: number; now?: () => number }): TtlCache<T> {
  const { ttlMs, now = Date.now } = deps
  let entry: { at: number; value: T } | null = null
  let inflight: Promise<T> | null = null
  let generation = 0

  return {
    get(loader) {
      if (entry !== null && now() - entry.at <= ttlMs) return Promise.resolve(entry.value)
      if (inflight === null) {
        const gen = generation
        const pending = loader()
          .then((value) => {
            if (generation === gen) entry = { at: now(), value }
            return value
          })
          .finally(() => {
            if (inflight === pending) inflight = null
          })
        inflight = pending
        return pending
      }
      return inflight
    },
    invalidate() {
      entry = null
      generation++
      inflight = null
    }
  }
}
