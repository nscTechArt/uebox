/**
 * 从旧存储里把老用户那份读出来，只在迁移到包目录时用一次。
 *
 * 这两个库的存储换过两轮：
 *
 *   localStorage（整库序列化，几 MB 就爆） → SQLite `library_store_*` → 保管库里的包目录
 *
 * 所以「旧存储」有两处都要看：先看 SQLite，没有再看 localStorage
 * （有的用户从没启动过中间那一版）。
 *
 * **这个文件是临时的。** 等确认没有用户还停在旧版本，它和 `libraryPersistence.ts`、
 * `api/libraryStore.ts`、`models/libraryStore.ts` 一起删掉，不留兼容层。
 *
 * 注意这里**不清 SQLite 里的行**：迁移万一出岔子，用户的数据还在库里能捞回来。
 * 防重复迁移靠的是保管库 `.library-meta.json` 里的 `migrated` 标记，不是靠删源数据。
 */

import { libraryStoreAPI, type LibraryName } from '@renderer/api/libraryStore'
import type { LibrarySnapshot } from './libraryPersistence'

export interface ReadLegacyOptions<TEntry, TCollection> {
  library: LibraryName
  /** 最早那一版写在 localStorage 的键名 */
  legacyKey: string
  /** 把 localStorage 里那份扁平结构翻译成通用快照 */
  parseLegacy: (raw: Record<string, unknown>) => LibrarySnapshot<TEntry, TCollection>
}

function parseUi(ui: string | null): Record<string, unknown> {
  if (!ui) return {}
  try {
    const parsed = JSON.parse(ui)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 从 SQLite 那一版里读。没有数据（或没有 preload）时返回 null。 */
async function readFromSqlite<TEntry, TCollection>(
  library: LibraryName
): Promise<LibrarySnapshot<TEntry, TCollection> | null> {
  const loaded = await libraryStoreAPI.load(library)
  if (!loaded || loaded.records.length === 0) return null

  const entries: TEntry[] = []
  const collections: TCollection[] = []

  for (const record of loaded.records) {
    let parsed: unknown
    try {
      parsed = JSON.parse(record.data)
    } catch {
      // 单条坏了不该让整次迁移失败，跳过它
      console.warn('[LibraryLegacy] 记录解析失败，已跳过:', record.kind, record.id)
      continue
    }
    if (record.kind === 'entry') entries.push(parsed as TEntry)
    else collections.push(parsed as TCollection)
  }

  return { entries, collections, ui: parseUi(loaded.ui) }
}

/** 从最早那一版的 localStorage 里读。 */
function readFromLocalStorage<TEntry, TCollection>(
  options: ReadLegacyOptions<TEntry, TCollection>
): LibrarySnapshot<TEntry, TCollection> | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(options.legacyKey)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return options.parseLegacy(parsed as Record<string, unknown>)
  } catch (error) {
    console.warn(`[LibraryLegacy] localStorage 数据解析失败（${options.legacyKey}）:`, error)
    return null
  }
}

/**
 * 两处旧存储都看一遍。都没有就返回 null。
 *
 * 读失败不抛 —— 迁移读不出来最多是「这次没搬成」，下次启动还会再试，
 * 但抛出去会把整个库的初始化带崩。
 */
export async function readLegacyLibrarySnapshot<TEntry, TCollection>(
  options: ReadLegacyOptions<TEntry, TCollection>
): Promise<LibrarySnapshot<TEntry, TCollection> | null> {
  try {
    const fromSqlite = await readFromSqlite<TEntry, TCollection>(options.library)
    if (fromSqlite) return fromSqlite
  } catch (error) {
    console.warn(`[LibraryLegacy] 读 SQLite 失败（${options.library}）:`, error)
  }

  return readFromLocalStorage(options)
}

/**
 * 迁移成功之后清掉 localStorage 里那份。
 *
 * 只清 localStorage：它有几 MB 的硬上限，占着就是在挤别人。
 * SQLite 那份留着当保险，不差那点磁盘。
 */
export function clearLegacyLocalStorage(legacyKey: string): void {
  try {
    localStorage.removeItem(legacyKey)
  } catch {
    // 删不掉不影响正确性，迁移标记已经写进保管库了
  }
}
