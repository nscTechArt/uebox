/**
 * 自动更新服务
 * 使用 electron-updater 实现应用的自动更新功能
 */
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { logger } from '../logger'
import { describeUpdateFeed, readAppMetadata, resolveUpdateFeed } from './updateFeed'

export interface UpdateStatus {
  checking: boolean
  updateAvailable: boolean
  updateDownloaded: boolean
  currentVersion: string
  latestVersion?: string
  downloadProgress?: {
    percent: number
    transferred: number
    total: number
  }
}

export interface UpdateErrorPayload {
  code: 'UPDATE_FEED_NOT_FOUND' | 'UPDATE_NETWORK_ERROR' | 'UPDATE_CHECK_FAILED'
  message: string
}

interface CheckForUpdatesOptions {
  source?: 'manual' | 'startup' | 'background'
  silent?: boolean
}

export class AutoUpdaterService {
  private mainWindow: BrowserWindow | null = null
  private readonly feed = resolveUpdateFeed({
    env: process.env,
    appMetadata: readAppMetadata(app.getAppPath())
  })
  private status: UpdateStatus = {
    checking: false,
    updateAvailable: false,
    updateDownloaded: false,
    currentVersion: app.getVersion()
  }
  private checkInterval: NodeJS.Timeout | null = null
  private readonly CHECK_INTERVAL = 4 * 60 * 60 * 1000 // 4小时
  private currentCheckOptions: Required<CheckForUpdatesOptions> = {
    source: 'manual',
    silent: false
  }
  private errorHandledByUpdaterEvent = false
  private downloading = false
  private updater: AppUpdater | null = null

  /**
   * 懒加载 electron-updater 并完成一次性配置。
   *
   * 以前是在构造函数里做的，而这个单例在 main 的顶层被 import，
   * 等于每次开机都要为 electron-updater 付一次加载成本 —— 开发环境
   * 压根不会去检查更新，正式环境也只在启动检查那一刻才需要它。
   * 所有用到 updater 的入口都会先走这里，配置只做一次。
   */
  private getUpdater(): AppUpdater {
    if (this.updater) {
      return this.updater
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    this.updater = autoUpdater
    this.setupAutoUpdater(autoUpdater)
    return autoUpdater
  }

  /**
   * 设置自动更新器
   */
  private setupAutoUpdater(autoUpdater: AppUpdater): void {
    // 走到这里说明 feed 一定有值：没有配置更新源时 initialize() 直接返回，
    // 连 electron-updater 都不会加载。
    const feed = this.feed
    if (feed) autoUpdater.setFeedURL(feed)

    // 不自动下载：发现新版先问一句。安装包是几百 MB，替用户决定要不要占带宽、
    // 占磁盘，在一个号称「完全离线」的应用里尤其说不过去。
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false // 不在退出时自动安装，由用户控制
    logger.info('自动更新源已配置:', { feed: describeUpdateFeed(feed) })

    // 监听更新检查事件
    autoUpdater.on('checking-for-update', () => {
      logger.info('正在检查更新...')
      this.status.checking = true
      this.notifyRenderer('update-checking')
    })

    // 监听更新可用事件
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      logger.info('发现新版本:', info.version)
      this.status.updateAvailable = true
      this.status.latestVersion = info.version
      this.status.checking = false
      this.notifyRenderer('update-available', { version: info.version })
    })

    // 监听更新不可用事件
    autoUpdater.on('update-not-available', () => {
      logger.info('当前已是最新版本')
      this.status.checking = false
      this.status.updateAvailable = false
      this.notifyRenderer('update-not-available')
    })

    // 监听下载进度事件
    autoUpdater.on('download-progress', (progress) => {
      logger.debug('下载进度:', `${progress.percent.toFixed(2)}%`)
      this.status.downloadProgress = {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      }
      this.notifyRenderer('update-download-progress', {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      })
    })

    // 监听更新下载完成事件
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      logger.info('更新下载完成:', info.version)
      this.status.updateDownloaded = true
      this.status.updateAvailable = true
      this.status.checking = false
      this.notifyRenderer('update-downloaded', { version: info.version })
    })

    // 监听错误事件
    autoUpdater.on('error', (error) => {
      this.errorHandledByUpdaterEvent = true
      this.handleUpdateError(error)
    })
  }

  /**
   * 设置主窗口（用于发送 IPC 消息）
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * 通知渲染进程
   */
  private notifyRenderer(event: string, data?: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(`updater:${event}`, data)
    }
  }

  /**
   * Build a short and user-friendly updater error payload.
   */
  private buildUpdateErrorPayload(error: unknown): UpdateErrorPayload {
    const rawMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : String(error || '')
    const normalizedMessage = rawMessage.replace(/\s+/g, ' ').trim()

    if (/latest\.yml/i.test(normalizedMessage) && /\b404\b/.test(normalizedMessage)) {
      return {
        code: 'UPDATE_FEED_NOT_FOUND',
        message: 'Update feed metadata is missing on the server.'
      }
    }

    if (
      /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|net::ERR_)\b/i.test(
        normalizedMessage
      )
    ) {
      return {
        code: 'UPDATE_NETWORK_ERROR',
        message: 'Unable to reach the update server.'
      }
    }

    return {
      code: 'UPDATE_CHECK_FAILED',
      message: normalizedMessage || 'Failed to check for updates.'
    }
  }

  /**
   * Handle updater failures without duplicating renderer notifications.
   */
  private handleUpdateError(error: unknown): void {
    const payload = this.buildUpdateErrorPayload(error)

    logger.error('Update check failed:', {
      source: this.currentCheckOptions.source,
      code: payload.code,
      message: payload.message,
      error
    })

    this.status.checking = false

    if (!this.currentCheckOptions.silent) {
      this.notifyRenderer('update-error', payload)
    }
  }

  /**
   * 检查更新
   */
  async checkForUpdates(options: CheckForUpdatesOptions = {}): Promise<void> {
    // 没有配置更新源 = 这个版本没有更新这回事。就地返回，不加载 electron-updater，
    // 也不发任何请求 —— 社区版默认就落在这一支。
    if (!this.isConfigured()) {
      logger.info('未配置更新源，跳过检查更新')
      return
    }

    if (this.status.checking) {
      logger.warn('更新检查已在进行中')
      return
    }

    this.currentCheckOptions = {
      source: options.source ?? 'manual',
      silent: options.silent ?? false
    }
    this.errorHandledByUpdaterEvent = false

    try {
      logger.info('Starting update check...', this.currentCheckOptions)
      await this.getUpdater().checkForUpdates()
    } catch (error) {
      if (!this.errorHandledByUpdaterEvent) {
        this.handleUpdateError(error)
      }
    } finally {
      this.errorHandledByUpdaterEvent = false
    }
  }

  /**
   * 下载已发现的新版本。
   *
   * autoDownload 是关的（理由见 setupAutoUpdater），所以下载必须显式触发一次 ——
   * 用户在「发现新版本」那个确认框里点了「下载」才会走到这里。
   *
   * 这一步以前是缺的：autoDownload=false 而全仓没有一处调 downloadUpdate()，
   * 于是检查更新只能发现版本、永远下不下来，`update-downloaded`、安装弹窗、
   * 左上角的「新版本 ↑」标记跟着全是死代码。
   */
  async downloadUpdate(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info('未配置更新源，跳过下载更新')
      return
    }

    if (!this.status.updateAvailable) {
      logger.warn('没有可下载的更新')
      return
    }

    if (this.downloading) {
      logger.warn('更新下载已在进行中')
      return
    }

    // 下载失败要让用户看见。错误统一走 autoUpdater 的 'error' 事件 → handleUpdateError，
    // 而它是按「最近一次检查」的 silent 决定要不要通知渲染进程的 ——
    // 后台静默检查发现的新版本，用户手点下载，报错会被咽掉。这里改写成手动、非静默。
    this.currentCheckOptions = { source: 'manual', silent: false }
    this.errorHandledByUpdaterEvent = false
    this.downloading = true

    try {
      logger.info('开始下载更新:', this.status.latestVersion)
      // updateAvailable 为真说明 updater 早已加载过，这里不会触发首次加载
      await this.getUpdater().downloadUpdate()
    } catch (error) {
      if (!this.errorHandledByUpdaterEvent) {
        this.handleUpdateError(error)
      }
      throw error
    } finally {
      this.downloading = false
      this.errorHandledByUpdaterEvent = false
    }
  }

  /**
   * 退出并安装更新。
   *
   * **必须有返回值。** 原来这里是 `void`：没下载完就 logger.warn 一声返回，
   * 而 IPC 那层照样回 `{ success: true }` —— 于是渲染进程那句
   * `if (!result.success) message.error(...)` 永远跑不到。用户点「立即重启」，
   * 弹窗关掉，应用不重启，一个字的提示都没有，再点一次还是这样。
   */
  quitAndInstall(): { success: boolean; error?: string } {
    if (!this.status.updateDownloaded) {
      logger.warn('更新尚未下载完成')
      return { success: false, error: '更新尚未下载完成' }
    }

    /*
     * 和 downloadUpdate 一样要改写成手动、非静默。
     *
     * 安装失败（装包起不来、用户在 UAC 弹窗上点了「否」）electron-updater 是发
     * `error` 事件报的，不是抛异常；而 handleUpdateError 按「最近一次检查」的
     * silent 决定要不要通知渲染进程。后台每 4 小时那次检查把 silent 置成了 true，
     * 这里不改回来的话，安装失败会被整条咽掉 —— 而这正是最常见的失败场景。
     */
    this.currentCheckOptions = { source: 'manual', silent: false }
    this.errorHandledByUpdaterEvent = false

    logger.info('退出应用并安装更新...')
    try {
      // updateDownloaded 为真说明 updater 早已加载过，这里不会触发首次加载
      this.getUpdater().quitAndInstall(false, true) // 不立即退出，等待应用关闭
      return { success: true }
    } catch (error) {
      logger.error('退出并安装更新失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '退出并安装更新失败'
      }
    }
  }

  /**
   * 获取更新状态
   */
  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  /**
   * 启动定期检查
   */
  startPeriodicCheck(): void {
    if (this.checkInterval) {
      logger.warn('定期检查已启动')
      return
    }

    logger.info('启动定期更新检查，间隔:', this.CHECK_INTERVAL / 1000 / 60, '分钟')
    this.checkInterval = setInterval(() => {
      this.checkForUpdates({ source: 'background', silent: true }).catch((error) => {
        logger.error('定期检查更新失败:', error)
      })
    }, this.CHECK_INTERVAL)
  }

  /**
   * 停止定期检查
   */
  stopPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
      logger.info('定期更新检查已停止')
    }
  }

  /**
   * 初始化更新服务
   * 在应用启动时调用
   */
  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info('未配置更新源，自动更新服务不启动')
      return
    }

    // 启动时检查一次
    await this.checkForUpdates({ source: 'startup', silent: true })

    // 启动定期检查
    this.startPeriodicCheck()
  }

  /** 这个安装包有没有更新源。没有就一次网络请求都不该发 */
  isConfigured(): boolean {
    return this.feed !== null
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.stopPeriodicCheck()
    this.mainWindow = null
  }
}

// 创建单例实例
export const autoUpdaterService = new AutoUpdaterService()
