import { registerWindowIPC } from './window'
import { registerDatabaseIPC } from '../sqliteDataBase/ipc'
import { registerDialogIPC } from './dialog'
import { registerDragDropIPC } from './dragDrop'
import { registerBaiduyunIPC } from './baiduyun'
import { registerWebdavIPC } from './webdav'
import { registerShellIPC } from './shell'
import { registerPathIPC } from './path'
import { registerAssistantIPC } from './assistant'
import { registerUnrealPathIPC } from './unrealPath'
import { registerUnrealProcessIPC } from './unrealProcess'
import { registerAgentV3IPC } from './agentV3'
import { registerAgentBrowserIPC } from './agentBrowser'
import { registerUpdaterIPC } from './updater'
import { registerCliIPC } from './cli'
import { registerObjectStorageIPC } from './objectStorage'
import { registerSpotlightIPC } from './spotlight'
import { registerWebSocketIPC } from './websocket'
import { registerAIGCIPC } from './aigc'
import { registerNamingRulesIPC } from './namingRules'
import { registerAiIPC } from './ai'
import { registerAiProviderIPC } from '../ai/ipc'
import { registerDashScopeIPC } from './dashscope'
import { registerVisionIPC } from './vision'
import { registerAttachmentIPC } from './attachment'
import { registerRealtimeVoiceIPC } from './realtimeVoice'
import { registerSpeechToTextIPC } from './speechToText'
import { registerVideoThumbnailIPC } from './videoThumbnail'
import { registerVideoCompressIPC } from './videoCompress'
import { registerAiImageIPC } from './aiImage'
import { registerAppSettingsIPC, type SetAppIconTheme } from './appSettings'
import { registerPersonalizationIPC } from './personalization'
import { registerChatHistoryIPC } from './chatHistory'
import { registerBackupIpc } from './backup'
import { registerFileIPC } from './fileIPC'
import { registerScreenshotIPC } from './screenshot'
import { registerScreenRecorderIPC } from './screenRecorder'
import { registerNetworkVaultHandlers } from './networkVault'
import { registerNetworkVaultV2Handlers } from './networkVaultV2'
import { registerDiagnosticsIPC } from './diagnostics'
// 导入assetImport以注册其IPC处理器
import './assetImport'
import './projectImport'
import './projectArchiveUpload'
import './projectTemplate'
import { registerContextMenuIPC } from './contextMenu'
import { registerLibraryPackageIPC } from './libraryPackage'

/**
 * 注册所有IPC处理函数
 */
export function registerAllIPC(setAppIconTheme: SetAppIconTheme): void {
  // 注册窗口控制相关IPC
  registerWindowIPC()

  // 注册数据库相关IPC
  registerDatabaseIPC()

  // 注册文件对话框相关IPC
  registerDialogIPC()

  // 注册拖拽功能相关IPC
  registerDragDropIPC()

  // 注册百度云相关IPC
  registerBaiduyunIPC()

  // 注册 WebDAV 相关IPC
  registerWebdavIPC()

  // 注册 shell 相关IPC
  registerShellIPC()

  // 注册路径相关IPC
  registerPathIPC()
  // 注册虚幻AI助手相关IPC
  registerAssistantIPC()
  // 注册 Unreal 引擎相关IPC
  registerUnrealPathIPC()
  // 注册 Unreal 引擎进程检测相关IPC
  registerUnrealProcessIPC()
  // 注册 Agent V3 相关IPC（pi 内核，V2 已下线）
  registerAgentV3IPC()
  // Agent 浏览器的界面通道（嵌入模式的面板位置 / 关闭）
  registerAgentBrowserIPC()

  // 注册更新相关IPC
  registerUpdaterIPC()
  registerCliIPC()
  registerObjectStorageIPC()

  // 注册 Spotlight 搜索相关 IPC
  registerSpotlightIPC()

  // 注册 WebSocket 相关IPC
  registerWebSocketIPC()

  // 注册 AIGC 资产保存相关 IPC（图片等下载入库）
  registerAIGCIPC()

  // 注册命名规则配置相关 IPC
  registerNamingRulesIPC()

  // 注册通用 AI 能力相关 IPC
  registerAiIPC()

  // 注册本地直连 Provider 配置相关 IPC
  registerAiProviderIPC()

  // 注册阿里云百炼 DashScope 相关 IPC（文件上传等）
  registerDashScopeIPC()

  // 注册视觉识别相关 IPC（图片/视频内容识别）
  registerVisionIPC()

  // 注册聊天附件解释 IPC（视频/文档在本地先解释成模型吃得下的东西）
  registerAttachmentIPC()

  // 注册实时语音会话 IPC
  registerRealtimeVoiceIPC()

  // 注册语音识别（听写）IPC。和上面那条是两路独立会话，见 speechToText.ts
  registerSpeechToTextIPC()

  // 注册视频缩略图相关 IPC（视频首帧截取）
  registerVideoThumbnailIPC()

  // 注册视频压缩相关 IPC（AI 分析预处理）
  registerVideoCompressIPC()

  // 注册 Deep Research 相关 IPC（Jina 深度研究）

  // 注册3D模型处理相关 IPC（格式转换、压缩等）

  // 注册 AI 图片生成相关 IPC
  registerAiImageIPC()

  // 注册 AI 视频生成相关 IPC

  // 注册 AI 音乐生成相关 IPC

  // 注册应用设置相关 IPC
  registerAppSettingsIPC(setAppIconTheme)

  // 注册个性化 IPC（用户写给 agent 的常驻说明 + 它自己攒下来的技能）
  registerPersonalizationIPC()

  // 注册 AI 对话历史落盘 IPC（原来存在 localStorage，配额不够）
  registerChatHistoryIPC()

  // 注册数据库备份相关 IPC
  registerBackupIpc()

  // 注册通用文件操作相关 IPC
  registerFileIPC()

  // 注册截图模式相关 IPC
  registerScreenshotIPC()

  // 注册屏幕录制相关 IPC
  registerScreenRecorderIPC()

  // 注册局域网协作库相关 IPC
  registerNetworkVaultHandlers()

  // 注册 V2 网络协作库 IPC
  registerNetworkVaultV2Handlers()

  // Register diagnostics and import recovery IPC
  registerDiagnosticsIPC()

  // 注册输入框右键菜单 IPC
  registerContextMenuIPC()

  // 注册蓝图包 / 材质包的磁盘读写 IPC
  registerLibraryPackageIPC()
}
