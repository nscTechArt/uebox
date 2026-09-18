/**
 * 蓝图库 / 材质库本地持久化的渲染层封装。
 *
 * 主进程实现见 `src/main/sqliteDataBase/models/libraryStore.ts`。
 * 这里只做通道名和类型的收口，不含任何业务判断 —— 调度和增量计算在
 * `store/modules/libraryPersistence.ts`。
 */

export type LibraryName = 'blueprint' | 'material'
export type LibraryRecordKind = 'entry' | 'collection'

export interface LibraryStoreRecord {
  kind: LibraryRecordKind
  id: string
  data: string
  sortIndex: number
}

export interface LibraryStoreSnapshot {
  records: LibraryStoreRecord[]
  ui: string | null
  migratedFromLocal: boolean
}

export interface LibraryStorePatch {
  upserts?: LibraryStoreRecord[]
  deletes?: Array<{ kind: LibraryRecordKind; id: string }>
  ui?: string
}

/**
 * 没有 preload 时返回 null（浏览器调试环境、单元测试）。调用方据此退回只读模式，
 * 而不是抛异常把整个 store 的初始化带崩。
 */
function getInvoke(): ((channel: string, ...args: unknown[]) => Promise<unknown>) | null {
  const invoke = (globalThis as { api?: { invoke?: unknown } }).api?.invoke
  return typeof invoke === 'function'
    ? (invoke as (channel: string, ...args: unknown[]) => Promise<unknown>)
    : null
}

export const libraryStoreAPI = {
  isAvailable(): boolean {
    return getInvoke() !== null
  },

  async load(library: LibraryName): Promise<LibraryStoreSnapshot | null> {
    const invoke = getInvoke()
    if (!invoke) return null
    return (await invoke('library-store:load', library)) as LibraryStoreSnapshot
  },

  async save(library: LibraryName, patch: LibraryStorePatch): Promise<void> {
    const invoke = getInvoke()
    if (!invoke) return
    await invoke('library-store:save', library, patch)
  },

  async migrate(
    library: LibraryName,
    payload: { records: LibraryStoreRecord[]; ui: string }
  ): Promise<boolean> {
    const invoke = getInvoke()
    if (!invoke) return false
    return (await invoke('library-store:migrate', library, payload)) as boolean
  }
}

export default libraryStoreAPI
