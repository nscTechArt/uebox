/**
 * Agent 上下文持久化模型
 * 用于保存和恢复 AI会话的上下文状态（黑板数据）
 *
 * 存储内容：
 * - activeAsset: 当前焦点资产
 * - recentAssets: 最近操作的资产列表
 * - executionPlan: 执行计划
 * - variables: 全局变量
 */

import Database from 'better-sqlite3'

/**
 * Agent 上下文记录接口
 */
export interface AgentContextRecord {
  id: number
  session_id: string
  context_data: string // JSON 序列化的上下文数据
  created_at: string
  updated_at: string
}

/**
 * 上下文数据结构（对应 GlobalContext）
 */
export interface SerializedContext {
  activeAsset: unknown | null
  recentAssets: unknown[]
  variables: Record<string, unknown>
  executionPlan: unknown | null
  sessionStartTime: number
}

/**
 * 初始化 Agent 上下文模型
 * @param db 数据库实例
 */
export const initAgentContextModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS agent_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      context_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `

  db.exec(createTableSQL)

  // 创建会话 ID 索引
  const createIndexSQL = `
    CREATE INDEX IF NOT EXISTS idx_agent_context_session_id
    ON agent_context(session_id);
  `

  db.exec(createIndexSQL)
  console.log('[AgentContext] 模型初始化完成')
}

/**
 * 保存或更新会话上下文
 * @param db 数据库实例
 * @param sessionId 会话 ID
 * @param contextData 上下文数据
 */
export const saveAgentContext = (
  db: Database.Database,
  sessionId: string,
  contextData: SerializedContext
): void => {
  const jsonData = JSON.stringify(contextData)

  const stmt = db.prepare(`
    INSERT INTO agent_context (session_id, context_data, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(session_id) DO UPDATE SET
      context_data = excluded.context_data,
      updated_at = datetime('now', 'localtime')
  `)

  stmt.run(sessionId, jsonData)
}

/**
 * 获取会话上下文
 * @param db 数据库实例
 * @param sessionId 会话 ID
 * @returns 上下文数据，如果不存在返回 null
 */
export const getAgentContext = (
  db: Database.Database,
  sessionId: string
): SerializedContext | null => {
  const stmt = db.prepare(`
    SELECT context_data FROM agent_context WHERE session_id = ?
  `)

  const row = stmt.get(sessionId) as { context_data: string } | undefined

  if (!row) {
    return null
  }

  try {
    return JSON.parse(row.context_data) as SerializedContext
  } catch (error) {
    console.error('[AgentContext] 解析上下文数据失败:', error)
    return null
  }
}

/**
 * 删除会话上下文
 * @param db 数据库实例
 * @param sessionId 会话 ID
 * @returns 是否成功删除
 */
export const deleteAgentContext = (db: Database.Database, sessionId: string): boolean => {
  const stmt = db.prepare(`DELETE FROM agent_context WHERE session_id = ?`)
  const result = stmt.run(sessionId)
  return result.changes > 0
}

/**
 * 获取所有会话上下文（用于调试或管理）
 * @param db 数据库实例
 * @returns 所有上下文记录
 */
export const getAllAgentContexts = (db: Database.Database): AgentContextRecord[] => {
  const stmt = db.prepare(`SELECT * FROM agent_context ORDER BY updated_at DESC`)
  return stmt.all() as AgentContextRecord[]
}

/**
 * 清理过期的上下文（超过指定天数未更新的）
 * @param db 数据库实例
 * @param daysOld 过期天数，默认 30 天
 * @returns 删除的记录数
 */
export const cleanupOldContexts = (db: Database.Database, daysOld: number = 30): number => {
  const stmt = db.prepare(`
    DELETE FROM agent_context
    WHERE datetime(updated_at) < datetime('now', '-' || ? || ' days', 'localtime')
  `)
  const result = stmt.run(daysOld)
  console.log(`[AgentContext] 清理了 ${result.changes} 条过期上下文记录`)
  return result.changes
}
