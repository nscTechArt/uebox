import { ipcMain } from 'electron'
import {
  appSettingsManager,
  type AgentBrowserMode,
  type AgentFileAccessScope,
  type TurnCompleteNotification
} from '../appSettingsManager'
import { agentBrowser } from '../services/agentBrowser'
import UnrealPathManagerUtil from '../utils/UnrealPathManager'

export type AppIconTheme = 'light' | 'dark'
export type SetAppIconTheme = (theme: AppIconTheme) => void

/**
 * 注册应用设置相关的 IPC 处理函数
 */
export function registerAppSettingsIPC(setAppIconTheme: SetAppIconTheme): void {
  /**
   * 获取应用设置
   */
  ipcMain.handle('app-settings:get', () => {
    const settings = appSettingsManager.getSettings()
    // 同步获取系统实际的开机自启状态
    const actualAutoLaunch = appSettingsManager.getAutoLaunchStatus()
    return {
      ...settings,
      autoLaunch: actualAutoLaunch
    }
  })

  /**
   * 更新应用设置
   */
  ipcMain.handle(
    'app-settings:set',
    (
      _event,
      settings: {
        autoLaunch?: boolean
        enableFollowUpSuggestions?: boolean
        autoEnableUnrealAgentLink?: boolean
        agentBrowserMode?: AgentBrowserMode
        agentFileAccessScope?: AgentFileAccessScope
        agentToolSearchEnabled?: boolean
        agentDisabledTools?: string[]
        agentResidentTools?: Record<string, boolean>
        notifyTurnComplete?: TurnCompleteNotification
        notifyApprovalRequired?: boolean
        notifyQuestionRequired?: boolean
        hideWindowOnProjectLaunch?: boolean
        autoRecoverEditorCrash?: boolean
      }
    ) => {
      if (typeof settings.autoLaunch === 'boolean') {
        appSettingsManager.setAutoLaunch(settings.autoLaunch)
      }
      if (typeof settings.enableFollowUpSuggestions === 'boolean') {
        appSettingsManager.setEnableFollowUpSuggestions(settings.enableFollowUpSuggestions)
      }
      if (typeof settings.autoEnableUnrealAgentLink === 'boolean') {
        appSettingsManager.setAutoEnableUnrealAgentLink(settings.autoEnableUnrealAgentLink)
      }
      if (
        settings.agentBrowserMode === 'window' ||
        settings.agentBrowserMode === 'embedded' ||
        settings.agentBrowserMode === 'hidden'
      ) {
        appSettingsManager.setAgentBrowserMode(settings.agentBrowserMode)
        // 当场把旧容器收掉：不然用户切到「嵌入」之后，眼前还杵着一个独立窗口
        agentBrowser.applyModeChange()
      }
      // 只认这两个字面量。写死枚举而不是原样透传，是因为这个值直接决定
      // 工具能不能碰盘 —— 一个拼错的字符串落进配置文件，下次启动兜底成
      // 「整台电脑」，用户以为自己收紧了，其实没有
      if (settings.agentFileAccessScope === 'ue-only' || settings.agentFileAccessScope === 'full') {
        appSettingsManager.setAgentFileAccessScope(settings.agentFileAccessScope)
      }
      if (typeof settings.agentToolSearchEnabled === 'boolean') {
        appSettingsManager.setAgentToolSearchEnabled(settings.agentToolSearchEnabled)
      }
      // 整份名单替换，不做增量：设置页那边本来就是拿着完整清单在点，
      // 增量协议只会在两处各存一份状态，然后慢慢对不上
      if (Array.isArray(settings.agentDisabledTools)) {
        appSettingsManager.setAgentDisabledTools(settings.agentDisabledTools)
      }
      if (
        settings.agentResidentTools &&
        typeof settings.agentResidentTools === 'object' &&
        !Array.isArray(settings.agentResidentTools)
      ) {
        appSettingsManager.setAgentResidentTools(settings.agentResidentTools)
      }
      // 同样写死枚举再落盘。一个拼错的字符串进了配置文件，通知那边会兜底成
      // 默认档，于是用户明明选了「关闭」，右下角还在弹
      if (
        settings.notifyTurnComplete === 'off' ||
        settings.notifyTurnComplete === 'unfocused' ||
        settings.notifyTurnComplete === 'always'
      ) {
        appSettingsManager.setNotifyTurnComplete(settings.notifyTurnComplete)
      }
      if (typeof settings.notifyApprovalRequired === 'boolean') {
        appSettingsManager.setNotifyApprovalRequired(settings.notifyApprovalRequired)
      }
      if (typeof settings.notifyQuestionRequired === 'boolean') {
        appSettingsManager.setNotifyQuestionRequired(settings.notifyQuestionRequired)
      }
      if (typeof settings.hideWindowOnProjectLaunch === 'boolean') {
        appSettingsManager.setHideWindowOnProjectLaunch(settings.hideWindowOnProjectLaunch)
      }
      if (typeof settings.autoRecoverEditorCrash === 'boolean') {
        appSettingsManager.setAutoRecoverEditorCrash(settings.autoRecoverEditorCrash)
      }
      return { success: true }
    }
  )

  /**
   * 单独设置开机自启
   */
  ipcMain.handle('app-settings:setAutoLaunch', (_event, enabled: boolean) => {
    const success = appSettingsManager.setAutoLaunch(enabled)
    return { success }
  })

  /**
   * 单独设置启用智能追加提问建议
   */
  ipcMain.handle('app-settings:setEnableFollowUpSuggestions', (_event, enabled: boolean) => {
    appSettingsManager.setEnableFollowUpSuggestions(enabled)
    return { success: true }
  })

  /**
   * 设置应用语言
   */
  ipcMain.handle('app-settings:setLanguage', (_event, language: 'zh-CN' | 'en-US') => {
    // `setLanguage` 自己会把新语言推给 main/i18n 并触发托盘重建
    appSettingsManager.setLanguage(language)
    return { success: true }
  })

  /**
   * 获取应用语言
   */
  ipcMain.handle('app-settings:getLanguage', () => {
    return appSettingsManager.getLanguage()
  })

  ipcMain.handle('app-settings:setThemeIcon', (_event, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark') {
      return { success: false, data: false, error: '无效的应用图标主题' }
    }

    try {
      setAppIconTheme(theme)
      return { success: true, data: true }
    } catch (error) {
      return {
        success: false,
        data: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  /**
   * 设置启动项目时自动启用 UnrealAgentLink 插件
   */
  ipcMain.handle('app-settings:setAutoEnableUnrealAgentLink', (_event, enabled: boolean) => {
    appSettingsManager.setAutoEnableUnrealAgentLink(enabled)
    return { success: true }
  })

  /**
   * 获取启动项目时自动启用 UnrealAgentLink 插件设置
   */
  ipcMain.handle('app-settings:getAutoEnableUnrealAgentLink', () => {
    return appSettingsManager.getAutoEnableUnrealAgentLink()
  })

  /**
   * 手动修复并清理引擎目录中残留的 UnrealAgentLink 插件
   */
  ipcMain.handle('app-settings:repairUnrealAgentLinkEngineResidue', async () => {
    try {
      const summary = await UnrealPathManagerUtil.repairUnrealAgentLinkEngineResidue()
      return {
        success: summary.failedEngines.length === 0,
        ...summary
      }
    } catch (error) {
      return {
        success: false,
        scannedEngineCount: 0,
        cleanedEngineCount: 0,
        skippedEngineCount: 0,
        failedEngines: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}
