import Database from 'better-sqlite3'

import { initAiImageGenerationModel } from './aiImageGeneration'
import { initTagModel } from './tag'
import { initTagGroupModel } from './tagGroup'
import { initProjectModel } from './project'
import { initProjectCollectionModel } from './projectCollection'
import { initNoteModel } from './note'
import { initImportTaskModel } from './importTask'
import { initAgentContextModel } from './agentContext'
import { initShortcutModel } from './shortcut'
import { initSettingsModel } from './settings'
import { initNotebookModel } from './notebook'
import { initNotebookIndexJobModel } from './notebookIndexJob'
import { initNotebookRagModel } from './notebookRag'
import { initImportRecoveryContextModel } from './importRecoveryContext'
import { initCustomEngineModel } from './customEngine'
import { initLibraryStoreModel } from './libraryStore'

/**
 * 清除已下线的内置产品知识库缓存。
 *
 * 这些表只存随安装包分发的产品说明向量，不包含用户在知识库里导入的资料；
 * 保留这一步是为了让从旧版本升级的用户也能释放无用缓存。`IF EXISTS` 使它可重复执行。
 */
export const dropRetiredProductKnowledgeTables = (db: Database.Database): void => {
  db.exec(`
    DROP TABLE IF EXISTS product_knowledge_vectors;
    DROP TABLE IF EXISTS product_knowledge_chunks;
    DROP TABLE IF EXISTS product_knowledge;
  `)
}

/**
 * 初始化公共数据库模型（全局共享数据）
 * @param db 公共数据库实例
 */
export const initPublicModels = (db: Database.Database): void => {
  // 注册设置相关的模型（公共数据库）
  initSettingsModel(db)

  // 创建保管库信息表
  initVaultInfoModel(db)

  // 创建标签和标签组表（属于公共数据）
  initTagGroupModel(db)
  initTagModel(db)

  // 先建分组表：工程表初始化时要合并重复记录，合并要把被删那条的分组归属搬过来
  initProjectCollectionModel(db)
  // 创建项目数据表（主数据库）
  initProjectModel(db)

  // AI3D 生成任务表应该在公共数据库中，因为它是全局的，不依赖于特定保管库

  // AI图片生成任务表（公共数据库）
  initAiImageGenerationModel(db)

  // AI音乐生成任务表（公共数据库）

  // AI视频生成任务表（公共数据库）

  // 笔记表（公共数据库）
  initNoteModel(db)

  initImportTaskModel(db)

  // Agent 上下文持久化表（公共数据库）
  initAgentContextModel(db)

  // 初始化快捷键表
  initShortcutModel(db)

  // 初始化知识库数据表
  initNotebookModel(db)
  initNotebookIndexJobModel(db)
  initNotebookRagModel(db)

  dropRetiredProductKnowledgeTables(db)

  // 初始化远程导入恢复上下文表
  initImportRecoveryContextModel(db)

  // 初始化自定义引擎表（持久化用户添加的自定义引擎）
  initCustomEngineModel(db)

  // 初始化蓝图库 AI 对话表（公共数据库）

  // 初始化蓝图库 / 材质库本地持久化表（公共数据库，取代 localStorage）
  initLibraryStoreModel(db)

  console.log('公共数据库模型初始化完成')
}

/*
 * 这里没有对应的 initVaultModels。
 *
 * 曾经有一个，但从来没人调用 —— 保管库的建表和列迁移全在
 * `VaultManager.initializeVaultDatabase()` 里，那份 SQL 是内联写的。
 * 留着一个长得像入口、实际不执行的函数，只会让下一个加字段的人把改动加进去，
 * 然后对着「no such table / no such column」查半天。这是真事，不是假想。
 *
 * 要给保管库加表或加列，改 VaultManager 那一处。
 */

/**
 * 初始化保管库信息表（在公共数据库中）
 * @param db 数据库实例
 */
const initVaultInfoModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS vault_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      path TEXT NOT NULL,
      is_custom_location BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT FALSE,
      disk_info TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `

  db.exec(createTableSQL)

  // 创建索引
  const createIndexSQL = `
    CREATE INDEX IF NOT EXISTS idx_vault_info_vault_id ON vault_info(vault_id);
    CREATE INDEX IF NOT EXISTS idx_vault_info_is_active ON vault_info(is_active);
    CREATE INDEX IF NOT EXISTS idx_vault_info_path ON vault_info(path);
  `

  db.exec(createIndexSQL)
  console.log('保管库信息表初始化完成')
}

// 导出所有模型，方便在其他地方使用
export * from './assetFolder'
export * from './assetData'
export * from './assetNote'
export * from './aiImageGeneration'
export * from './tag'
export * from './tagGroup'
export * from './assetFavorite'
export * from './assetTag'
export * from './folderTag'
export * from './project'
export * from './projectCollection'
export * from './note'
export * from './importTask'
export * from './agentContext'
export * from './notebook'
export * from './notebookIndexJob'
export * from './notebookRag'
export * from './importRecoveryContext'
export * from './customEngine'
export * from './libraryStore'
// export * from './other-model';
