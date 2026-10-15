/**
 * 保管库数据库连接的公共设置 —— 主进程连接、导入用的临时连接、查询 worker 的连接共用。
 * 以前各处 `new Database(vaultDbPath)` 之后自己抄两行 pragma，抄漏的（导入）就一直慢着。
 *
 * - temp_store = MEMORY：assetData 上挂着搜索索引的触发器，带触发器的写语句每一条都要开
 *   一个「语句日志」，一行动了二十几个索引页，超过 64 KiB 就落成**磁盘临时文件** ——
 *   插一行建一次临时文件。实测一页 2000 行从 626 ms 降到 124 ms。代价是一条语句改动
 *   几十万行时日志全在内存里，所以大批量的 DELETE / UPDATE 要分块（见 clearDeleted）。
 * - mmap：读页走内存映射，不再一页一次 ReadFile（Windows 上每次都要过杀毒软件的过滤
 *   驱动，全表读一遍几乎全是系统调用：保管库目录下实测快 7~9 倍）。只给本机 userData 下的
 *   库开：保管库可以建在自选目录、U 盘、映射的网络盘上，映射页读失败是进程级崩溃，
 *   不是一个能接住的 SQLITE_IOERR；而被映射的文件在 Windows 上也不能被覆盖（恢复备份）。
 * - synchronous 不用设：better-sqlite3 编译时带了 SQLITE_DEFAULT_WAL_SYNCHRONOUS=1，
 *   WAL 库默认就是 NORMAL。
 * - 别设 analysis_limit：采样统计会把 isDelete、扩展名这类低基数列估成「很有筛选力」
 *   （实测从每值 2 万行估成 1001 行），规划器挑错索引，查询慢几百倍。
 */
import { relative, isAbsolute } from 'node:path'
import type Database from 'better-sqlite3'

/** 内存映射读的上限：SQLite 默认编译上限（约 2 GB），库再大，超出的部分照旧 ReadFile */
export const VAULT_DB_MMAP_SIZE = 2_147_418_112

/**
 * WAL 检查点交给 worker 之后，主连接自动检查点的页数：64 MB（4 KiB 一页），只当兜底。
 * 大批量写入每写几百毫秒就等 worker 追平一次（见 assetQueryRunner），WAL 正常长不到这么大；
 * 没走那条路的大批量写入撞上它，才由主线程自己做一次检查点。
 */
export const WATCHED_WAL_AUTOCHECKPOINT = 16_384

export interface VaultConnectionOptions {
  readonly?: boolean
  /** 只有确认库文件在本机 userData 下才传 true，见文件头 */
  mmap?: boolean
}

export function applyVaultConnectionPragmas(
  db: Database.Database,
  options: VaultConnectionOptions = {}
): void {
  try {
    if (!options.readonly) db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('temp_store = MEMORY')
    if (options.mmap) db.pragma(`mmap_size = ${VAULT_DB_MMAP_SIZE}`)
  } catch (e) {
    console.warn('[vaultConnection] 设置连接参数失败:', e)
  }
}

/** child 是否在 root 目录之内（同一个盘、不经过 `..`） */
export function isPathInside(child: string, root: string): boolean {
  const rel = relative(root, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
