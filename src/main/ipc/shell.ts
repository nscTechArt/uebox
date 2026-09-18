import { app, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { isAbsolute } from 'path'
import { appSettingsManager } from '../appSettingsManager'
import { findMainWindow } from '../appWindows'
import { ensureUnrealAgentLinkPlugin } from '../sqliteDataBase/ipc/project'
import { openSafeExternalUrl } from '../security'

/**
 * 各编辑器的「打开文件」URL 协议。
 *
 * VS Code / Cursor / Trae 是同一家族（Trae 的注册表命令就是 `Trae.exe --open-url`，
 * 和 VS Code 一模一样），共用 `<scheme>://file/<绝对路径>`。
 * WebStorm 走 JetBrains Toolbox 注册的 `jetbrains://` 协议。
 *
 * 反斜杠要换成正斜杠，否则 `vscode://file/C:\a\b` 会被当成一整段主机名。
 */
const EDITOR_URL_BUILDERS: Record<string, (path: string) => string> = {
  vscode: (path) => `vscode://file/${path.replace(/\\/g, '/')}`,
  cursor: (path) => `cursor://file/${path.replace(/\\/g, '/')}`,
  trae: (path) => `trae://file/${path.replace(/\\/g, '/')}`,
  webstorm: (path) =>
    `jetbrains://web-storm/navigate/reference?path=${encodeURIComponent(path.replace(/\\/g, '/'))}`
}

/** 判断某个编辑器装没装时，去问系统谁注册了这个协议 */
const EDITOR_PROTOCOLS: Record<string, string> = {
  vscode: 'vscode',
  cursor: 'cursor',
  trae: 'trae',
  webstorm: 'jetbrains'
}

/**
 * 注册 shell 相关 IPC
 */
export function registerShellIPC(): void {
  // 打开指定路径（文件或目录）
  ipcMain.handle('shell:openPath', async (_event, targetPath: string) => {
    void _event
    try {
      // 路径不在了要单独报出来：系统给的是一句 "Failed to open path"，
      // 用户看了不知道是文件被删了还是盒子出毛病了
      if (!existsSync(targetPath)) {
        return { success: false, error: '路径不存在', pathNotFound: true }
      }

      const err = await shell.openPath(targetPath)
      if (err) {
        return { success: false, error: err }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 打开 .uproject 文件，如果启用了自动启用 UnrealAgentLink 设置，
   * 则在打开前先确保插件被启用
   */
  ipcMain.handle('shell:openUproject', async (_event, uprojectPath: string) => {
    void _event
    try {
      // 工程文件不在了就直接说清楚。放在装插件之前：文件都没了，
      // 再去改 .uproject 只会多报一句无关的失败
      if (!existsSync(uprojectPath)) {
        return { success: false, error: '工程文件不存在', pathNotFound: true }
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
          console.warn('[shell:openUproject] 自动启用 UnrealAgentLink 插件失败:', pluginError)
        }
      }

      const err = await shell.openPath(uprojectPath)
      if (err) {
        return { success: false, error: err }
      }

      // 「打开工程后隐藏主界面」只在**真的打开了**之后才生效。启动失败还把
      // 界面收走的话，用户面对的是一个空桌面：编辑器没起来，那句错误提示也
      // 跟着窗口一起没了
      if (appSettingsManager.getHideWindowOnProjectLaunch()) {
        const mainWindow = findMainWindow()
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
      }

      return { success: true, ...(pluginFailure ? { pluginFailure } : {}) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 在系统文件管理器中显示并选中指定文件/文件夹
   * 修复 Windows 11 上可能在后台打开的问题
   */
  ipcMain.handle('shell:showItemInFolder', async (_event, targetPath: string) => {
    void _event
    try {
      if (!targetPath) {
        console.warn('[shell:showItemInFolder] 路径为空')
        return { success: false, error: '路径为空' }
      }

      // 标准化路径分隔符（Windows 使用反斜杠）
      const normalizedPath = targetPath.replace(/\//g, '\\')
      console.log('[shell:showItemInFolder] 目标路径:', normalizedPath)

      // 检查路径是否存在，如果不存在则返回错误
      if (!existsSync(normalizedPath)) {
        console.warn('[shell:showItemInFolder] 路径不存在:', normalizedPath)
        return { success: false, error: '路径不存在', pathNotFound: true }
      }

      // Windows 平台使用 explorer.exe /select 命令确保窗口前置显示
      if (process.platform === 'win32') {
        const { exec } = await import('child_process')
        return new Promise((resolve) => {
          // explorer /select, 会打开资源管理器并选中指定文件/文件夹
          // 注意：Windows explorer.exe 即使成功打开也可能返回 exit code 1，这是正常行为
          exec(`explorer /select,"${normalizedPath}"`, (error) => {
            if (error && error.code !== 1) {
              // 只有非 exit code 1 的错误才降级
              console.warn('[shell:showItemInFolder] explorer 命令异常，降级处理:', error.code)
              shell.showItemInFolder(normalizedPath)
            }
            // 无论如何都返回成功，因为 explorer 通常会正确打开
            resolve({ success: true })
          })
        })
      }

      // 非 Windows 平台使用 Electron 原生方法
      shell.showItemInFolder(targetPath)
      return { success: true }
    } catch (error) {
      console.error('[shell:showItemInFolder] 异常:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 打开外部链接（系统默认浏览器）
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    void _event
    try {
      await openSafeExternalUrl(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 用指定的外部程序打开一个文件。
   *
   * 这里以前是裸 `spawn(appPath, [filePath])`，两个参数都不校验 —— IPC 边界上
   * 一个「用任意参数启动任意可执行文件」的原语。同一个文件里的 openExternal
   * 走了白名单，这个没有。
   *
   * 现在的最低要求：两个都必须是**磁盘上真实存在的**绝对路径。这不能防住
   * 「用户自己在设置里配了个坏程序」，但能挡住把参数当命令行拼进来的用法，
   * 也让越界调用在源头就失败，而不是先起一个进程再说。
   */
  ipcMain.handle('shell:openWith', async (_event, filePath: string, appPath: string) => {
    void _event
    try {
      const target = String(filePath || '')
      const program = String(appPath || '')

      if (!isAbsolute(target) || !isAbsolute(program)) {
        return { success: false, error: '文件与程序都必须是绝对路径' }
      }
      if (!existsSync(target)) {
        return { success: false, error: '要打开的文件不存在' }
      }
      if (!existsSync(program)) {
        return { success: false, error: '指定的程序不存在' }
      }

      spawn(program, [target], {
        detached: true,
        stdio: 'ignore',
        // 不经过 shell：经过的话路径里的空格、`&`、`|` 会被当成命令行语法
        shell: false
      }).unref()
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 用代码编辑器打开一个路径。
   *
   * 走编辑器自己注册的 URL 协议，不去猜安装目录 —— 没装的话系统直接无响应，
   * 不会误起别的程序。URL 在主进程里拼，渲染进程只能传路径和一个枚举值，
   * 所以 `openExternal` 的 http/https 白名单在这里绕开是可控的。
   */
  ipcMain.handle('shell:openInEditor', async (_event, targetPath: string, editor: string) => {
    void _event
    try {
      const buildUrl = EDITOR_URL_BUILDERS[String(editor)]
      if (!buildUrl) {
        return { success: false, error: `不支持的编辑器: ${editor}` }
      }

      const target = String(targetPath || '')
      if (!isAbsolute(target)) {
        return { success: false, error: '必须是绝对路径' }
      }
      if (!existsSync(target)) {
        return { success: false, error: '路径不存在' }
      }

      await shell.openExternal(buildUrl(target))
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 这台机器上装了哪些编辑器。
   *
   * 靠「谁注册了这个 URL 协议」判断，不去猜安装目录。菜单里只列真的装了的，
   * 免得点了一个没装的编辑器什么都不发生，看起来像功能坏了。
   */
  ipcMain.handle('shell:listEditors', async () => {
    try {
      const editors = Object.entries(EDITOR_PROTOCOLS)
        .filter(([, protocol]) => Boolean(app.getApplicationNameForProtocol(`${protocol}://`)))
        .map(([id]) => id)
      return { success: true, editors }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 打开 Skills 目录（在系统文件管理器中）
  ipcMain.handle('shell:openSkillsDir', async () => {
    try {
      const { join } = await import('path')
      const { mkdirSync } = await import('fs')
      const skillsDir = join(app.getPath('userData'), 'skills')

      if (!existsSync(skillsDir)) {
        mkdirSync(skillsDir, { recursive: true })
      }

      const err = await shell.openPath(skillsDir)
      if (err) {
        return { success: false, error: err }
      }
      return { success: true, path: skillsDir }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
