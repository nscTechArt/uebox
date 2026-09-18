import Database from 'better-sqlite3'

// 数据库配置选项
export interface DatabaseConfig {
  // 是否启用外键约束
  foreignKeys?: boolean
  // 是否只读模式
  readonly?: boolean
  // 是否在控制台输出SQL语句（开发模式）
  verbose?: boolean | ((message?: any, ...additionalArgs: any[]) => void)
}

// 数据库查询结果
export interface QueryResult {
  // 最后插入的行ID
  lastInsertRowid?: number
  // 受影响的行数
  changes?: number
}

// 数据库事务函数类型
//
// ⚠️ 必须是同步函数。better-sqlite3 是同步 API：事务函数里一旦 await，
// BEGIN 就会跨越事件循环挂在共享连接上，别的 IPC handler 要么撞
// "cannot start a transaction within a transaction"，要么把自己的非事务写
// 挤进这个窗口，然后被本事务的 ROLLBACK 一起回滚掉。
//
// 需要 fs / 网络 / sharp 的调用方：把 I/O 放到 runInTransaction 之外，
// 事务里只留 DB 语句。
export type TransactionFunction<T> = (db: Database.Database) => T

// 分页查询选项
export interface PaginationOptions {
  page: number
  limit: number
}

// 分页查询结果
export interface PaginatedResult<T> {
  data: T[]
  pagination: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}
