/**
 * 打开一个 .uproject 文件。
 *
 * 从 `shell:openUproject` 的处理器里抽出来的 —— 首页双击、合集、右键「启动」
 * 走那条 IPC，托盘菜单的「最近项目」也走它。两条入口必须同一段代码：插件
 * 先装、失败原因带回来、「打开工程后隐藏主界面」的设置才都能对得上。
 */
import { shell } from 'electron'
import { existsSync } from 'fs'

import { appSettingsManager } from '../../appSettingsManager'
import { findMainWindow } from '../../appWindows'
import { ensureUnrealAgentLinkPlugin } from '../../sqliteDataBase/ipc/project'
import UnrealProcessDetector from '../../utils/UnrealProcessDetector'

export interface OpenUprojectOptions {
  /**
   * 导入弹窗替用户打开工程：编辑器已经在跑就复用（返回 `alreadyRunning`），
   * 且打开后不藏主界面 —— 用户正盯着弹窗等导入开始
   */
  forImport?: boolean
}

export interface OpenUprojectResult {
  success: boolean
  error?: string
  /** 工程文件已经不在盘上 —— 调用方可能想给「从列表移除」的出口 */
  pathNotFound?: boolean
  /** forImport 打开时发现编辑器已经在跑 —— 调用方通常改为等插件连上，而不是等启动 */
  alreadyRunning?: boolean
  /**
   * 工程打开了，但 UnrealAgentLink 没装上。它不拖垮 `success`（工程可以正常用），
   * 却是之后「AI 连不上引擎」唯一的线索 —— 调用方一定要拿它去提示用户。
   */
  pluginFailure?: string
}

export async function openUprojectFile(
  uprojectPath: string,
  options?: OpenUprojectOptions
): Promise<OpenUprojectResult> {
  try {
    // 工程文件不在了就直接说清楚。放在装插件之前：文件都没了，
    // 再去改 .uproject 只会多报一句无关的失败
    if (!existsSync(uprojectPath)) {
      return { success: false, error: '工程文件不存在', pathNotFound: true }
    }

    // 导入弹窗替用户打开工程，是为了等它连上后接着导。编辑器已经在跑（多半还在
    // 加载，插件还没连上来）就别再起一个 —— 两个编辑器抢同一个工程，只会更乱
    if (
      options?.forImport &&
      (await UnrealProcessDetector.findRunningProjectByPath(uprojectPath).catch(() => null))
    ) {
      return { success: true, alreadyRunning: true }
    }

    // 如果启用了自动启用 UnrealAgentLink 插件设置，则先确保插件被启用
    //
    // 装不上要回给界面：它不抛异常，只在返回值里写原因。丢掉的话工程照常打开，
    // 用户之后遇到「AI 连不上引擎」时，早就想不起来跟打开这一步有关
    let pluginFailure: string | null = null
    if (appSettingsManager.getAutoEnableUnrealAgentLink()) {
      try {
        pluginFailure = (await ensureUnrealAgentLinkPlugin(uprojectPath)).pluginFailure
      } catch (pluginError) {
        pluginFailure = pluginError instanceof Error ? pluginError.message : String(pluginError)
        console.warn('[openUproject] 自动启用 UnrealAgentLink 插件失败:', pluginError)
      }
    }

    const err = await shell.openPath(uprojectPath)
    if (err) {
      return { success: false, error: err }
    }

    // 「打开工程后隐藏主界面」只在**真的打开了**之后才生效。启动失败还把
    // 界面收走的话，用户面对的是一个空桌面：编辑器没起来，那句错误提示也
    // 跟着窗口一起没了。导入弹窗打开的也不藏：用户正盯着它等导入开始
    if (!options?.forImport && appSettingsManager.getHideWindowOnProjectLaunch()) {
      const mainWindow = findMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
    }

    return { success: true, ...(pluginFailure ? { pluginFailure } : {}) }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}
