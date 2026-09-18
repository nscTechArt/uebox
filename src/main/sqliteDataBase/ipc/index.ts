import { registerProductIPC } from './product'
import { registerAssetFolderIPC } from './assetFolder'
import { registerAssetDataIPC } from './assetData'
import { registerTagIPC } from './tag'
import { registerTagGroupIPC } from './tagGroup'
import { registerAssetFavoriteIpcHandlers } from './assetFavorite'
import { registerVaultIPC } from '../../ipc/vault'
import { VaultManager } from '../VaultManager'
import { registerAssetTagIPC } from './assetTag'
import { registerFolderTagIPC } from './folderTag'
import { registerAssetSearchIPC } from './assetSearch'
import { registerAssetSemanticIPC } from './assetSemantic'
import { registerProjectIPC } from './project'
import { registerProjectCollectionIPC } from './projectCollection'
import { registerNoteIPC } from './note'
import { registerAssetNoteIPC } from './assetNote'
import { registerImportTaskIPC } from './importTask'
import { registerDragMoveIPC } from './dragMove'
import { registerShortcutIPC } from './shortcut'
import { registerSettingsIPC } from './settings'
import { registerWebReadIPC } from './webRead'
import { registerDocumentLoaderIPC } from './documentLoader'
import { registerYouTubeIPC } from './youtube'
import { registerBilibiliIPC } from './bilibili'
import { registerNotebookIPC } from './notebook'
import { registerNotebookChatV2IPC } from './notebookChatV2'
import { registerNotebookImagesIPC } from './notebookImages'
import { registerNotebookRagIPC } from './notebookRag'
import { registerNotebookInfographicIPC } from './notebookInfographic'
import { registerNotebookOutputsIPC } from './notebookOutputs'
import { registerCrashLogsIpc } from './crashLogs'
import { registerWechatIPC } from './wechat'
import { registerEpicProjectsIPC } from '../../ipc/epicProjects'
import { registerLibraryStoreIpc } from './libraryStore'
import { registerLegacyImportIPC } from './legacyImport'

/**
 * 注册所有数据库相关的IPC处理函数
 * 这个文件作为IPC注册的入口，统一管理所有模块的IPC注册
 */
export const registerDatabaseIPC = (): void => {
  // 注册设置相关的IPC处理函数（公共数据库）
  registerSettingsIPC()

  // 注册产品相关的IPC处理函数（公共数据库）
  registerProductIPC()

  // 注册保管库相关的IPC处理函数（公共数据库）
  registerVaultIPC()

  // 注册标签相关的IPC处理函数（公共数据库）
  registerTagIPC()

  // 注册标签组相关的IPC处理函数（公共数据库）
  registerTagGroupIPC()

  // 注册资产文件夹相关的IPC处理函数（保管库数据库）
  registerAssetFolderIPC()

  // 注册资产数据相关的IPC处理函数（保管库数据库）
  registerAssetDataIPC()

  // 注册统一资产搜索相关的IPC处理函数（保管库数据库）
  registerAssetSearchIPC()
  registerAssetSemanticIPC()

  // 注册项目相关的IPC处理函数（公共数据库）
  registerProjectIPC()

  // 注册工程合集相关的IPC处理函数（公共数据库）
  registerProjectCollectionIPC()

  // 注册笔记相关的IPC处理函数（公共数据库）
  registerNoteIPC()
  registerAssetNoteIPC()

  registerImportTaskIPC()

  // 注册资产收藏相关的IPC处理函数（保管库数据库）
  const vaultManager = VaultManager.getInstance()
  registerAssetFavoriteIpcHandlers(vaultManager)

  // 注册资产标签相关的IPC处理函数（保管库数据库）
  registerAssetTagIPC()

  // 注册文件夹标签相关的IPC处理函数（保管库数据库）
  registerFolderTagIPC()

  // 注册拖拽移动相关的IPC处理函数（保管库数据库）
  registerDragMoveIPC()

  // 注册快捷键相关的IPC处理函数（公共数据库）
  registerShortcutIPC()

  // 注册 Jina Reader 相关的 IPC 处理函数
  registerWebReadIPC()

  // 注册文档加载器 IPC 处理函数
  registerDocumentLoaderIPC()

  // 注册 YouTube 视频分析 IPC 处理函数
  registerYouTubeIPC()

  // 注册 Bilibili 视频分析 IPC 处理函数
  registerBilibiliIPC()

  // 注册知识库相关的 IPC 处理函数（公共数据库）
  registerNotebookIPC()
  registerNotebookChatV2IPC()
  registerNotebookImagesIPC()
  registerNotebookRagIPC()
  registerNotebookInfographicIPC()
  registerNotebookOutputsIPC()

  // 注册崩溃日志 IPC 处理函数（文件系统读取）
  registerCrashLogsIpc()

  // 注册3D生成任务 IPC 处理函数（公共数据库）

  // 注册微信公众号文章采集 IPC 处理函数
  registerWechatIPC()

  // 注册Epic项目读取 IPC 处理函数
  registerEpicProjectsIPC()

  // 注册蓝图库 AI 对话 IPC 处理函数（公共数据库）

  // 注册蓝图库 / 材质库本地持久化 IPC 处理函数（公共数据库）
  registerLibraryStoreIpc()

  // 注册旧版蓝图迁移 IPC 处理函数（读取外部 DB）
  registerLegacyImportIPC()
}

// 导出所有模块的IPC注册函数，方便单独使用
export * from './product'
export * from './tag'
export * from './tagGroup'
export * from './assetFolder'
export * from './assetData'
export * from './assetFavorite'
export * from './assetTag'
export * from './folderTag'
export * from './assetSearch'
export * from './project'
export * from './projectCollection'
export * from './note'
export * from './importTask'
export { registerVaultIPC } from '../../ipc/vault'
export * from './documentLoader'
export * from './youtube'
export * from './bilibili'
export * from './notebook'
export * from './notebookChatV2'
export * from './notebookRag'
export * from './notebookInfographic'
export * from './crashLogs'
export * from './legacyImport'
