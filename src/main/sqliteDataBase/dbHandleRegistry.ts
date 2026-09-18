/**
 * 「一个库一个连接」的记账本。
 *
 * 为什么需要它：后台网络库的连接要一直开着给 AssetServer / SyncClient 用，
 * 于是没人觉得自己该关它。而 `startAllNetworkServers` 每次切库都会重跑一遍，
 * 每次都 `new Database(...)`，AssetServer 只是把 map 里的旧条目覆盖掉、从不 close ——
 * **每切一次库，就为每个后台网络库泄漏一个 SQLite 句柄**。
 * 切几十次之后 WAL 一直长，Windows 上还会压住库文件，导致删库/移库 EBUSY：
 * 保管库在界面上消失了，磁盘上几十 GB 一个字节没释放。
 *
 * 记账本只做三件事：已经开过就复用、放开时关掉、清空时全关。
 * 不 import electron 也不 import better-sqlite3，可以直接单测。
 */

export interface ClosableHandle {
  close(): void
}

export class DbHandleRegistry<T extends ClosableHandle> {
  private handles = new Map<string, T>()

  constructor(private readonly onCloseError?: (key: string, error: unknown) => void) {}

  /** 已经开过就直接返回，否则用 open() 开一个并记上账 */
  acquire(key: string, open: () => T): T {
    const existing = this.handles.get(key)
    if (existing) return existing
    const handle = open()
    this.handles.set(key, handle)
    return handle
  }

  get(key: string): T | undefined {
    return this.handles.get(key)
  }

  has(key: string): boolean {
    return this.handles.has(key)
  }

  get size(): number {
    return this.handles.size
  }

  /** 关掉并销账。关闭失败也一定销账 —— 留着只会让下次拿到一个已死的句柄 */
  release(key: string): void {
    const handle = this.handles.get(key)
    if (!handle) return
    this.handles.delete(key)
    try {
      handle.close()
    } catch (error) {
      this.onCloseError?.(key, error)
    }
  }

  releaseAll(): void {
    for (const key of [...this.handles.keys()]) this.release(key)
  }
}
