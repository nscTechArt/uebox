/**
 * 保管库数据库连接的公共调优参数 —— 主进程连接和查询 worker 的只读连接共用。
 * 为什么是这几个值，见 VaultManager.initializeVaultDatabase 里的说明。
 */

/** 内存映射读的上限：SQLite 默认编译上限（约 2 GB），库再大，超出的部分照旧 ReadFile */
export const VAULT_DB_MMAP_SIZE = 2_147_418_112
