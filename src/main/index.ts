import { execSync } from 'child_process'

// 🛡️ Windows 控制台 UTF-8 编码修复（必须在任何日志输出之前）
// electron-vite dev 启动 Electron 子进程时，控制台默认使用 GBK (936) 代码页，
// 导致 electron-log 的中文日志显示为乱码。强制切换到 UTF-8 (65001)。
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' })
  } catch {
    // 忽略失败，不影响应用启动
  }
}

// 🛡️ 增大 libuv 线程池（默认 4 → 16），避免网络 I/O 排队阻塞事件循环
// 必须在任何异步 I/O 操作之前设置，否则不生效
process.env.UV_THREADPOOL_SIZE = '16'

import { app, BrowserWindow, dialog, ipcMain, Tray, Menu, protocol, screen } from 'electron'
import { join } from 'path'
import os from 'os'
import { existsSync, readdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import iconPng from '../../resources/icon.png?asset'
import iconIco from '../../resources/icon.ico?asset'
import iconDarkIco from '../../resources/icon-dark.ico?asset'
import type { AppIconTheme } from './ipc/appSettings'

// Windows 使用 ico 格式，其他平台使用 png
const icon = process.platform === 'win32' ? iconIco : iconPng
import { initDatabase, closeDatabase } from './sqliteDataBase'
import {
  getProjectCoverService,
  stopProjectCoverSync
} from './services/project/projectCoverRuntime'
import { findMainWindow } from './appWindows'
import {
  keepMainWindowInTray,
  minimizeCurrentMainWindow,
  showOrCreateMainWindow
} from './mainWindowLifecycle'
import { agentBrowser } from './services/agentBrowser'
import { startAgentNotifications } from './services/agentNotifications'
import { closeSearchBrowser } from './services/browserSearch'
import { windowStateManager } from './windowStateManager'
import { fitMacWindow, mainWindowChrome } from './mainWindowAppearance'
import { prepareTrayIcon } from './trayIcon'
import { initializeDockIcon } from './dockIcon'
import { appSettingsManager } from './appSettingsManager'
import { mt, onLanguageChanged } from './i18n'
import { serviceManager, logger } from './services'
import { initializeApp } from './init'
import { spotlightManager } from './spotlightManager'
import { miniChatManager } from './miniChatManager'
import { ShortcutService } from './services/shortcutService'
import { serveRemoteAsset } from './networkV2/assetProxy'
import { installSystemProxyFetch } from './utils/systemProxyFetch'
import { shouldStartHiddenAtLaunch } from './startupVisibility'
import { beginQuietStartup, endQuietStartup } from './startupQuiet'
import { keepWindowTitleFixed, MAIN_WINDOW_TITLE } from './windowTitle'
import { acquireSingleInstanceLock } from './singleInstanceLock'

import { registerAllIPC } from './ipc'
import { shutdownMcp, stopMcpServer } from './agent-v3/capabilities/mcp'
import { installOfflineNetworkPolicy } from './networkPolicy'
import './ipc/vault'
import { autoUpdaterService } from './services/updater/autoUpdater'
import { protectRendererWindow } from './security'
import { resolveLocalResourcePath, serveLocalFile } from './utils/localResourceServer'
import { getListThumbnail } from './utils/listThumbnail'
const disableSingleInstanceLock = process.env.UA_DISABLE_SINGLE_INSTANCE_LOCK === '1'
const remoteDebuggingPort = process.env.UA_REMOTE_DEBUGGING_PORT?.trim()

/**
 * 全局变量接口定义
 */
interface GlobalVars {
  __ueAgentTray__?: Tray
  __forceQuit__?: boolean
}

declare const globalThis: typeof global & GlobalVars

function setAppIconTheme(theme: AppIconTheme): void {
  if (process.platform !== 'win32') return

  const themedIcon = theme === 'dark' ? iconDarkIco : iconIco
  // 这里用 getAllWindows() 是对的：换图标对哪个窗口都合理，
  // Agent 浏览器窗口跟着一起换反而更一致
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.setIcon(themedIcon)
  })
  globalThis.__ueAgentTray__?.setImage(themedIcon)
}

/**
 * 检测当前系统是否为 Windows 11
 * 规则：仅在 Win32 且构建号 >= 22000 视为 Windows 11
 */
function isWindows11(): boolean {
  if (process.platform !== 'win32') return false
  const v = (process.getSystemVersion?.() || os.release()) as string
  const parts = v.split('.')
  const build = Number(parts[2] || 0)
  return build >= 22000
}

/**
 * 创建主窗口，依据操作系统版本动态开启/关闭透明窗口
 */
function createWindow(): void {
  // 获取保存的窗口状态
  const windowState = windowStateManager.getState()

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 1500, // 打开界面最小宽
    minHeight: 900, // 打开界面最小高
    show: false,
    title: MAIN_WINDOW_TITLE,
    ...mainWindowChrome(process.platform),
    ...(process.platform === 'darwin'
      ? fitMacWindow(
          windowState,
          (windowState.x !== undefined && windowState.y !== undefined
            ? screen.getDisplayMatching({ ...windowState, x: windowState.x, y: windowState.y })
            : screen.getPrimaryDisplay()
          ).workArea
        )
      : {}),
    autoHideMenuBar: true,
    transparent: false,
    backgroundColor: '#121212',
    backgroundMaterial: 'none',
    vibrancy: 'under-window', // macOS 毛玻璃效果
    icon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      backgroundThrottling: false // 防止窗口最小化或隐藏时停止渲染
    }
  })

  keepWindowTitleFixed(mainWindow)

  mainWindow.on('ready-to-show', () => {
    // 仅在窗口未显示时（首次启动）处理状态恢复
    if (!mainWindow.isVisible()) {
      // 检测是否为开机自启动（系统登录时以隐藏状态启动）
      // 方法1: 检查 Electron 的 wasOpenedAtLogin (仅 macOS 可靠)
      const loginItemSettings = app.getLoginItemSettings()
      const wasOpenedAtLogin = loginItemSettings.wasOpenedAtLogin

      // 方法2: 检查命令行参数 --hidden (Windows 下更可靠)
      // 我们在 setAutoLaunch 中设置了 args: ['--hidden']
      const shouldStartHidden = shouldStartHiddenAtLaunch({
        argv: process.argv,
        wasOpenedAtLogin
      })

      // 如果任一检测方式表明是隐藏启动，则不显示窗口
      if (shouldStartHidden) {
        logger.info(
          `[主窗口] 检测到开机自启动，窗口保持隐藏状态（仅显示托盘）wasOpenedAtLogin=${wasOpenedAtLogin}, shouldStartHidden=${shouldStartHidden}`
        )
        return
      }

      // 如果窗口之前是最大化状态，则恢复最大化
      if (windowState.isMaximized) {
        mainWindow.maximize()
      }
      mainWindow.show()
    }
    // 开发模式下自动打开开发者工具控制台
    // mainWindow.webContents.openDevTools()
  })

  // 关闭按钮隐藏窗口；应用菜单、Dock 或托盘发起退出时允许销毁。
  mainWindow.on('close', (event): void => {
    keepMainWindowInTray(event, mainWindow, Boolean(globalThis.__forceQuit__))
  })

  // 系统托盘
  // 辅助函数：将日志发送到渲染进程
  const sendLogToRenderer = (msg: string): void => {
    try {
      mainWindow.webContents.send('main-log', msg)
    } catch {
      // 忽略发送失败
    }
    logger.info(msg)
  }

  try {
    // 仅创建一次托盘图标
    if (!globalThis.__ueAgentTray__) {
      // 获取托盘图标路径
      // 开发环境使用 icon 变量，生产环境使用打包后的图标
      let trayIcon: string = ''
      if (is.dev) {
        trayIcon = icon as unknown as string
        sendLogToRenderer(`[托盘] 开发环境，使用内置图标: ${trayIcon}`)
      } else {
        // 生产环境：尝试多个可能的路径
        const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'

        // 可能的图标路径列表（按优先级排序）
        const possiblePaths = [
          join(process.resourcesPath, iconName), // extraResources 默认位置（最优先）
          join(process.resourcesPath, 'app.asar.unpacked', 'resources', iconName), // asar 解压位置
          join(__dirname, '../../resources', iconName), // 相对于 main 的位置
          join(app.getAppPath(), 'resources', iconName) // 内部 resources 目录
        ]

        sendLogToRenderer(`[托盘] 生产环境，resourcesPath: ${process.resourcesPath}`)
        sendLogToRenderer(`[托盘] 生产环境，appPath: ${app.getAppPath()}`)
        sendLogToRenderer(`[托盘] 生产环境，__dirname: ${__dirname}`)
        sendLogToRenderer(`[托盘] 生产环境，图标名称: ${iconName}`)

        // 尝试找到存在的图标文件
        for (const p of possiblePaths) {
          sendLogToRenderer(`[托盘] 检查路径: ${p}`)
          if (existsSync(p)) {
            trayIcon = p
            sendLogToRenderer(`[托盘] ✓ 找到图标文件: ${p}`)
            break
          } else {
            sendLogToRenderer(`[托盘] ✗ 路径不存在: ${p}`)
          }
        }

        // 如果都找不到，列出 resources 目录内容帮助调试
        if (!trayIcon) {
          sendLogToRenderer(`[托盘] ❌ 未能找到图标文件`)
          try {
            const files = readdirSync(process.resourcesPath)
            sendLogToRenderer(`[托盘] resources 目录内容: ${files.join(', ')}`)
          } catch (e) {
            sendLogToRenderer(`[托盘] 无法读取 resources 目录: ${e}`)
          }
          // 使用第一个路径作为后备（虽然可能不存在）
          trayIcon = possiblePaths[0]
          sendLogToRenderer(`[托盘] 使用后备路径: ${trayIcon}`)
        }
      }

      sendLogToRenderer(`[托盘] 最终使用图标路径: ${trayIcon}`)
      const tray = new Tray(prepareTrayIcon(trayIcon, iconPng, process.platform))
      sendLogToRenderer(`[托盘] 托盘创建成功`)
      tray.setToolTip('Unreal Box')
      const showMainWindowFromTray = (): void => {
        showOrCreateMainWindow(findMainWindow, createWindow)
      }
      const minimizeMainWindowFromTray = (): void => {
        minimizeCurrentMainWindow(findMainWindow)
      }
      /*
       * 托盘菜单是**唯一**不能走「主进程回码、渲染层查语言包」的一类：
       * Electron 把它交给操作系统画，渲染进程碰不到。所以这三句在主进程翻
       * （见 `main/i18n.ts`）。
       *
       * 包成函数是为了能重建 —— 用户在设置里切了语言，托盘要跟着变，
       * 而不是留着上一种语言直到下次启动。
       */
      const buildTrayMenu = (): void => {
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: mt('tray.show'), click: showMainWindowFromTray },
            { label: mt('tray.minimize'), click: minimizeMainWindowFromTray },
            { type: 'separator' },
            {
              label: mt('tray.quit'),
              click: (): void => {
                // 设置标志防止窗口关闭时隐藏
                globalThis.__forceQuit__ = true
                app.quit()
              }
            }
          ])
        )
      }
      buildTrayMenu()
      onLanguageChanged(buildTrayMenu)
      // macOS 单击由系统展开托盘菜单，避免同时把主窗口抢到前台。
      if (process.platform !== 'darwin') tray.on('click', showMainWindowFromTray)
      globalThis.__ueAgentTray__ = tray
    }
  } catch (e) {
    // 忽略托盘初始化失败，不影响窗口逻辑
    sendLogToRenderer(`[托盘] 托盘初始化失败: ${e}`)
    logger.error('托盘初始化失败:', e)
  }

  const appMenu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'help' }
  ])
  Menu.setApplicationMenu(appMenu)

  // 监听窗口大小和位置变化，保存状态
  const saveWindowState = (): void => {
    const isMaximized = mainWindow.isMaximized()

    if (isMaximized) {
      windowStateManager.saveState({ isMaximized: true })
    } else {
      const bounds = mainWindow.getBounds()
      windowStateManager.saveState({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        isMaximized: false
      })
    }
  }

  // 监听窗口事件
  mainWindow.on('resize', saveWindowState)
  mainWindow.on('move', saveWindowState)
  mainWindow.on('maximize', saveWindowState)
  mainWindow.on('unmaximize', saveWindowState)

  const rendererFilePath = join(__dirname, '../renderer/index.html')
  protectRendererWindow(
    mainWindow,
    rendererFilePath,
    is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  )

  // 设置主窗口到更新服务
  autoUpdaterService.setMainWindow(mainWindow)

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(rendererFilePath)
  }
}

function registerSystemIPC(): void {
  ipcMain.handle('system:getInfo', () => {
    const version = (process.getSystemVersion?.() || os.release()) as string
    const win11 = isWindows11()

    // 生成准确的 OS 名称
    let osName: string = process.platform
    if (process.platform === 'win32') {
      osName = win11 ? 'Windows 11' : 'Windows 10'
    } else if (process.platform === 'darwin') {
      osName = 'macOS'
    } else if (process.platform === 'linux') {
      osName = 'Linux'
    }

    // 获取本机局域网 IP（非 127.0.0.1）
    let localIp = ''
    try {
      const nets = os.networkInterfaces()
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          // 取第一个非内部 IPv4 地址
          if (net.family === 'IPv4' && !net.internal) {
            localIp = net.address
            break
          }
        }
        if (localIp) break
      }
    } catch {
      /* ignore */
    }

    return {
      platform: process.platform,
      version,
      isWindows11: win11,
      appVersion: app.getVersion(),
      osName, // 准确的 OS 名称，如 "Windows 11"
      hostname: os.hostname(), // 设备主机名
      localIp // 本机局域网 IP
    }
  })
}

/**
 * 初始化单例进程锁，保证应用只启动一个实例
 * 如果检测到重复启动，则聚焦已有窗口；若无窗口则创建新窗口
 */
function setupSingleInstanceLock(): boolean {
  if (disableSingleInstanceLock) {
    logger.warn('[App] Single-instance lock disabled by UA_DISABLE_SINGLE_INSTANCE_LOCK=1')
    return true
  }

  const gotTheLock = acquireSingleInstanceLock(app, false)
  if (!gotTheLock) {
    // app.quit() 不会中断当前模块；返回 false 让调用方别再注册 whenReady 初始化。
    return false
  }

  // 监听第二实例启动事件，将已有窗口置前
  app.on('second-instance', () => {
    // 找到主窗口。判据在 appWindows.ts —— 那里会先把 Agent 浏览器窗口
    // （1280×820，正好落在这条尺寸判据里）摘出去，否则用户双击图标
    // 唤起的会是一个网页
    const mainWindow = findMainWindow() ?? null

    if (mainWindow) {
      // Windows 下如果直接 focus，渲染进程里上一次聚焦的控件会把“聚焦框/高亮”一并带出来。
      // 这里先通知渲染进程 blur 掉 activeElement，再进行窗口置前与 focus，可避免视觉聚焦框闪现。
      try {
        if (!mainWindow.isDestroyed() && !mainWindow.isFocused()) {
          mainWindow.webContents.send('app:blur-active-element')
        }
      } catch (e) {
        // 忽略（例如：webContents 尚未 ready 或窗口正在销毁）
        void e
      }

      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }
      mainWindow.focus()
      logger.info('检测到重复启动，已将已有窗口置前')
    } else {
      // 如果没有窗口，创建新窗口
      createWindow()
      logger.info('检测到重复启动，但无窗口，已创建新窗口')
    }
  })

  return true
}

// ==================== V8 堆内存配置 ====================
// 🛡️ 解决资产导入时的 OOM (Out of Memory) 崩溃问题
// 注意：app.commandLine.appendSwitch('js-flags', ...) 对主进程取决于 Electron 版本
// 必须分开设置每个 flag（多个 flag 写在同一字符串中可能不会被正确解析）
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')
app.commandLine.appendSwitch('js-flags', '--expose-gc')
// 同时设置 NODE_OPTIONS 环境变量作为后备（影响子进程和某些 Electron 版本的主进程）
if (!process.env.NODE_OPTIONS?.includes('max-old-space-size')) {
  process.env.NODE_OPTIONS =
    `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192 --expose-gc`.trim()
}

// 仅在显式配置合法端口时启用远程调试，正式包默认关闭。
if (remoteDebuggingPort && /^\d{2,5}$/.test(remoteDebuggingPort)) {
  const port = Number(remoteDebuggingPort)
  if (port >= 1024 && port <= 65535) {
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
    app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)
  }
}
// 主进程调试需要在启动命令中添加 --inspect 参数

// ==================== 高 DPI 渲染优化 ====================
// 修复 Windows 高 DPI 缩放导致的文字模糊问题

// 启用高 DPI 支持 - 让 Electron 正确感知 Windows 缩放设置
app.commandLine.appendSwitch('high-dpi-support', '1')

// 注意：不设置 force-device-scale-factor，让 Electron 自动使用系统的 DPI 缩放比例
// 这样 Windows 4K 屏幕上设置 150%/200% 缩放时，应用 UI 会正确放大

// 禁用 LCD 文本抗锯齿 - 在非整数缩放（如 125%、150%）时可以减少模糊
// LCD 抗锯齿假设像素是固定的，在缩放时会导致颜色边缘
if (process.platform === 'win32') {
  // 使用 GPU 加速进行合成渲染
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  // 禁用 LCD 亚像素文本渲染 - 改用全像素抗锯齿，在高 DPI 缩放下更清晰
  app.commandLine.appendSwitch('disable-lcd-text')
  // 强制使用 DirectWrite 进行文本渲染（Windows 上更清晰）
  app.commandLine.appendSwitch('enable-features', 'DirectWriteAntiAliasing')
}

// 应用初始化前设置单例锁
const shouldInitializeApp = setupSingleInstanceLock()

// 在应用启动前声明自定义协议（必须在 app.whenReady() 之前）
// 这告诉 Electron 这是一个特权协议，允许在渲染进程中使用
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-resource',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
  {
    scheme: 'uebox-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
  {
    // 服务端资产库的缩略图（按内容哈希缓存在本机磁盘，见 src/main/libraryV3/previews.ts）
    scheme: 'uebox-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
const appReady = shouldInitializeApp ? app.whenReady() : null
appReady?.then(async () => {
  // 最先装：之后所有模型、授权请求都要按系统代理走，见 systemProxyFetch.ts
  await installSystemProxyFetch()
  initializeDockIcon(iconPng)

  // ==================== 测试版时间限制检查 ====================
  // const BETA_EXPIRATION_DATE = new Date('2099-03-31T23:59:59')
  // const now = new Date()
  // if (now > BETA_EXPIRATION_DATE) {
  //   // 创建过期提示窗口
  //   const expiredWindow = new BrowserWindow({
  //     width: 580,
  //     height: 520,
  //     resizable: false,
  //     frame: false,
  //     transparent: false,
  //     backgroundColor: '#1a1a2e',
  //     icon,
  //     webPreferences: {
  //       nodeIntegration: false,
  //       contextIsolation: true
  //     }
  //   })
  //
  //   // 监听打开外部链接的请求
  //   ipcMain.on('open-external-url', (_event, url: string) => {
  //     shell.openExternal(url)
  //   })
  //
  //   // 允许页面中的链接在默认浏览器打开
  //   expiredWindow.webContents.setWindowOpenHandler(({ url }) => {
  //     shell.openExternal(url)
  //     return { action: 'deny' }
  //   })
  //
  //   // 加载过期页面
  //   if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
  //     // 开发环境：从 renderer 目录加载
  //     expiredWindow.loadFile(join(__dirname, '../../src/renderer/expired.html'))
  //   } else {
  //     // 生产环境：从打包后的 renderer 目录加载
  //     expiredWindow.loadFile(join(__dirname, '../renderer/expired.html'))
  //   }
  //
  //   expiredWindow.show()
  //
  //   // 当过期窗口关闭时退出应用
  //   expiredWindow.on('closed', () => {
  //     app.quit()
  //   })
  //
  //   return
  // }

  // 开发环境：把启动期那一百多行 console.log 收起来，结束时报一句折叠了多少条。
  // 报错（console.warn/error）和 electron-log 的输出都不受影响。
  beginQuietStartup()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.unreal.agent')
  appSettingsManager.ensureAutoLaunchSetting()

  // 注册自定义协议 'local-resource'：渲染进程加载本地图片/视频/3D 模型贴图的唯一通道。
  // dev 模式下页面跑在 http://localhost 上，Chromium 会直接拒掉 file:/// 子资源，
  // 所以本地文件必须经这个特权协议转一手。
  // 用法示例: local-resource://C:/Users/Admin/Desktop/model.fbx
  protocol.handle('local-resource', async (request) => {
    try {
      let filePath = resolveLocalResourcePath(request.url)
      const query = new URLSearchParams(request.url.split('?')[1]?.split('#')[0])
      if (query.get('listThumbnail') === '400') {
        filePath = await getListThumbnail(
          filePath,
          join(app.getPath('userData'), 'list-thumbnails')
        )
      }

      if (is.dev) {
        logger.debug(`[local-resource] ${request.url} -> ${filePath}`)
      }

      const response = await serveLocalFile(filePath, request.headers.get('range'))
      if (query.get('listThumbnail') === '400') {
        // Disk caching owns freshness; the browser must recheck referenced files on reload.
        response.headers.set('Cache-Control', 'no-store')
      }
      return response
    } catch (error) {
      logger.error(`[local-resource] 处理请求失败: ${request.url}`, error)
      return new Response(
        `Failed to load resource: ${error instanceof Error ? error.message : String(error)}`,
        {
          status: 500,
          headers: { 'Content-Type': 'text/plain' }
        }
      )
    }
  })

  protocol.handle('uebox-asset', async (request) => {
    try {
      return await serveRemoteAsset(request)
    } catch (error) {
      logger.warn('[uebox-asset] proxy failed:', error)
      return new Response('Asset proxy failed', { status: 502 })
    }
  })

  protocol.handle('uebox-preview', async (request) => {
    try {
      const { handlePreviewRequest } = await import('./libraryV3')
      return await handlePreviewRequest(request)
    } catch (error) {
      logger.warn('[uebox-preview] failed:', error)
      return new Response('Preview failed', { status: 502 })
    }
  })

  try {
    // 初始化数据库
    await initDatabase()
    void getProjectCoverService().start()
    logger.info('数据库初始化完成')

    // 执行应用初始化逻辑
    initializeApp()
    logger.info('应用初始化逻辑执行完成')

    // 启动服务管理器（它内部已经打过「所有服务启动完成」，这里不再复述）
    await serviceManager.start()

    // [项目级插件自动升级] App 启动时静默检查并升级所有已导入项目的 UALink 插件
    // 替代旧的引擎级安装方案，解决用户插件版本停留在旧版本的问题
    import('./sqliteDataBase/ipc/project')
      .then((module) => module.upgradeAllProjectPlugins())
      .catch((e) => logger.warn('[UALink] 启动升级检查失败:', e))

    // 注册所有IPC处理函数
    registerAllIPC(setAppIconTheme)
    logger.info('IPC处理函数注册完成')

    // 用户上次开着「对外暴露虚幻引擎能力」的话，随盒子一起拉起来。
    //
    // 外部客户端（Claude Code / Cursor）的 MCP 配置写在它们自己的磁盘上，
    // 是长期配置；要求用户每次开机再进设置点一次「开启」，那份配置就等于废的。
    // 动态 import 是为了不把整棵工具树拉进启动路径的静态依赖图。
    void (async () => {
      const [{ autoStartMcpServer }, { buildAllTools }] = await Promise.all([
        import('./agent-v3/capabilities/mcp'),
        import('./agent-v3/tools/registry')
      ])
      await autoStartMcpServer(() => buildAllTools())
    })().catch((e) => logger.warn('[MCP-Server] 自动启动失败:', e))

    installOfflineNetworkPolicy({ enforce: false })

    // 注册系统信息 IPC
    registerSystemIPC()

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // IPC test
    ipcMain.on('ping', () => console.log('pong'))

    createWindow()
    logger.info('主窗口创建完成')

    // 初始化 Spotlight 聚焦窗口 / MiniChat 迷你对话窗口
    // （两者各自都会打一行「初始化完成」，这里不再复述）
    spotlightManager.initialize()
    miniChatManager.initialize()

    // 初始化应用全局快捷键
    ShortcutService.getInstance().registerGlobalShortcuts()
    logger.info('应用全局快捷键注册完成')

    // 系统通知：agent 跑完 / 卡在审批或反问上时提醒用户回来。
    // 放在窗口创建之后 —— 它要问「盒子的窗口在不在前台」
    startAgentNotifications(createWindow)

    // 初始化自动更新服务（仅在非开发环境或明确启用时）
    if (!is.dev || process.env.ENABLE_AUTO_UPDATE === 'true') {
      try {
        await autoUpdaterService.initialize()
        logger.info('自动更新服务初始化完成')
      } catch (error) {
        logger.error('自动更新服务初始化失败:', error)
      }
    } else {
      logger.info('开发环境：自动更新服务已跳过')
    }

    app.on('activate', function () {
      showOrCreateMainWindow(findMainWindow, createWindow)
    })
  } catch (error) {
    logger.error('应用启动失败:', error)
    /*
     * 退出之前必须留一句话。
     *
     * 这里原来是直接 app.quit()：数据库文件被占、磁盘满、原生模块加载不起来时，
     * 用户看到的是双击图标闪一下就没了 —— 没有窗口、没有报错、日志他也不知道在哪。
     * 这是最难求助的一种故障，因为他连「发生了什么」都描述不出来。
     */
    try {
      dialog.showErrorBox(
        mt('startup.failedTitle'),
        mt('startup.failedBody', {
          reason: error instanceof Error ? error.message : String(error),
          logDir: join(app.getPath('userData'), 'logs')
        })
      )
    } catch (dialogErr) {
      logger.error('连错误框都弹不出来:', dialogErr)
    }
    app.quit()
  } finally {
    // 启动流程走完（成功或失败都要恢复），控制台交还给正常输出
    endQuietStartup()
  }
})

// 系统菜单、Cmd+Q、Dock 和 app.quit() 都必须放行窗口关闭。
app.on('before-quit', () => {
  // 在 Electron 关闭独立浏览器窗口之前释放，避免把退出误记为用户主动关闭。
  agentBrowser.dispose()
  globalThis.__forceQuit__ = true
})

// 单独关闭窗口时保持后台运行，可从 Dock 或托盘恢复。
app.on('window-all-closed', () => {
  // 不执行 app.quit()
})

// 在应用退出前关闭数据库连接和服务
app.on('will-quit', async () => {
  try {
    // 断开 MCP server：它们是子进程，不显式关会变成孤儿进程留在系统里
    await shutdownMcp()
    await stopMcpServer()
    logger.info('MCP 连接与对外服务已停止')

    // 清理 Spotlight 和 MiniChat
    spotlightManager.cleanup()
    logger.info('Spotlight 已清理')

    miniChatManager.cleanup()
    logger.info('Mini Chat 已清理')

    // Agent 浏览器：窗口不销毁的话进程退不干净。没开过就是空操作（不会
    // 因此创建 session 或窗口 —— 这条路径要保持社区版的零网络承诺）
    agentBrowser.dispose()

    // 检索用的那个隐藏浏览器窗口，同理
    closeSearchBrowser()

    // 清理更新服务
    autoUpdaterService.cleanup()
    logger.info('自动更新服务已清理')

    // 停止服务管理器
    await serviceManager.stop()
    logger.info('服务管理器已停止')

    // 停掉封面同步：最多等 2 秒，免得离线网络盘上的 stat 拖住退出
    await stopProjectCoverSync()

    // 关闭数据库连接
    closeDatabase()
    logger.info('数据库连接已关闭')

    console.log('应用即将退出，所有服务已停止')
  } catch (error) {
    logger.error('应用退出时清理失败:', error)
    console.error('应用退出时清理失败:', error)
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
