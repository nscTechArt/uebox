import Database from 'better-sqlite3'
import { TransactionFunction, PaginationOptions, PaginatedResult } from './types'

declare const asyncTransactionBrand: unique symbol

/**
 * 编译期哨兵。
 *
 * 事务回调返回 Promise 时，runInTransaction 的返回类型会变成它，之后任何取值 /
 * 赋值都会在 typecheck 阶段报错，错误信息里直接写着该怎么改 —— 迁移不靠人肉 grep 纪律。
 */
export interface TransactionCallbackMustBeSynchronous {
  readonly [asyncTransactionBrand]: '事务回调必须同步执行：把 fs / 网络 / sharp 等 I/O 移到 runInTransaction 之外'
}

/**
 * 在一个数据库事务里**同步**执行 fn。
 *
 * 用 better-sqlite3 原生的 db.transaction()，好处有三：
 *  1. BEGIN / COMMIT / ROLLBACK 由驱动管理，不再手写裸 SQL；
 *  2. 已经处在事务里时自动降级为 SAVEPOINT / RELEASE / ROLLBACK TO，
 *     所以「事务里再调事务」是安全的，不会再出
 *     "cannot start a transaction within a transaction"；
 *  3. 回调返回 Promise 时驱动会直接抛错，异步回调漏不进来。
 *
 * 为什么不能异步：better-sqlite3 是同步 API。旧实现手写 BEGIN 后 await 业务函数，
 * 事务窗口会跨越事件循环挂在**共享连接**上 —— 别的 IPC handler 此时的普通写
 * （crud.ts / assetFolder.ts 里大量裸调的 update/delete 都不在任何事务里）
 * 会掉进这个窗口，然后被本事务的 ROLLBACK 一起静默回滚掉。
 *
 * @param db 数据库实例（保管库库或公共库都行，事务状态是按连接算的）
 * @param fn 事务函数，必须同步
 * @returns 事务函数的返回值
 */
export function runInTransaction(
  db: Database.Database,
  fn: (db: Database.Database) => PromiseLike<unknown>
): TransactionCallbackMustBeSynchronous
export function runInTransaction<T>(db: Database.Database, fn: TransactionFunction<T>): T
export function runInTransaction(
  db: Database.Database,
  fn: (db: Database.Database) => unknown
): unknown {
  return db.transaction(fn)(db)
}

/**
 * 兼容外壳：语义上它并不异步 —— DB 工作在 Promise 被创建之前就已经同步提交完了。
 *
 * 保留它只是为了让存量的 `await transaction(...)` 调用点（30 处纯 DB 回调）
 * 不必一次性全改。新代码直接用 runInTransaction。
 *
 * @deprecated 用 runInTransaction 代替。
 */
export const transaction = <T>(db: Database.Database, fn: TransactionFunction<T>): Promise<T> => {
  try {
    return Promise.resolve(runInTransaction(db, fn))
  } catch (error) {
    // 抛错转成 reject，调用点现有的 try { await ... } catch 照旧生效
    return Promise.reject(error)
  }
}

/**
 * 执行分页查询
 * @param db 数据库实例
 * @param tableName 表名
 * @param options 分页选项
 * @param whereClause WHERE子句（可选）
 * @param params WHERE子句参数（可选）
 * @returns 分页结果
 */
export const paginateQuery = <T>(
  db: Database.Database,
  tableName: string,
  options: PaginationOptions,
  whereClause: string = '',
  params: any[] = []
): PaginatedResult<T> => {
  const { page, limit } = options
  const offset = (page - 1) * limit

  // 构建WHERE子句
  const where = whereClause ? `WHERE ${whereClause}` : ''

  // 查询总记录数
  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM ${tableName} ${where}`)
  const { total } = countStmt.get(...params) as { total: number }

  // 查询分页数据
  const dataStmt = db.prepare(`SELECT * FROM ${tableName} ${where} LIMIT ? OFFSET ?`)
  const data = dataStmt.all(...params, limit, offset) as T[]

  // 计算总页数
  const totalPages = Math.ceil(total / limit)

  return {
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages
    }
  }
}

/**
 * 检查表是否存在
 * @param db 数据库实例
 * @param tableName 表名
 * @returns 表是否存在
 */
export const tableExists = (db: Database.Database, tableName: string): boolean => {
  const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
  const result = stmt.get(tableName)
  return !!result
}

/**
 * 获取表的所有列信息
 * @param db 数据库实例
 * @param tableName 表名
 * @returns 列信息数组
 */
export const getTableColumns = (db: Database.Database, tableName: string): any[] => {
  const stmt = db.prepare(`PRAGMA table_info(${tableName})`)
  return stmt.all()
}
