/**
 * WebSocket IPC 处理模块
 * 提供渲染进程调用 WebSocket 服务的接口
 */
import { ipcMain } from 'electron'
import { getAppWindows } from '../appWindows'
import { serviceManager } from '../services'
import { logger } from '../services/logger'
import { projectManager } from '../services/project'

/**
 * 注册 WebSocket 相关的 IPC handlers
 */
export function registerWebSocketIPC(): void {
  const ws = serviceManager.getWebSocketService()

  /**
   * 启动 WebSocket 服务器
   */
  ipcMain.handle('ws:start', async (_, port?: number) => {
    try {
      await ws.startServer(port)
      return { success: true }
    } catch (error) {
      logger.error('[WebSocket IPC] 启动失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 停止 WebSocket 服务器
   */
  ipcMain.handle('ws:stop', async () => {
    try {
      await ws.stopServer()
      return { success: true }
    } catch (error) {
      logger.error('[WebSocket IPC] 停止失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 获取服务状态
   */
  ipcMain.handle('ws:status', () => {
    return ws.getStatus()
  })

  /**
   * 发送事件（单向通知）
   */
  ipcMain.handle('ws:emit', (_, method: string, payload: unknown, clientId?: string) => {
    try {
      ws.emitEvent(method, payload, clientId)
      return { success: true }
    } catch (error) {
      logger.error('[WebSocket IPC] 发送事件失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 发送请求（RPC 模式）
   */
  ipcMain.handle(
    'ws:call',
    async (_, method: string, payload: unknown, clientId?: string, timeout?: number) => {
      try {
        const result = await ws.callRequest(method, payload, clientId, timeout)
        return { success: true, data: result }
      } catch (error) {
        logger.error('[WebSocket IPC] 请求失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 获取连接列表
   */
  ipcMain.handle('ws:connections', () => {
    const connections = ws.getConnectionManager().getAllConnections()
    return connections.map((conn) => ({
      id: conn.id,
      connectedAt: conn.connectedAt,
      isAlive: conn.isAlive
    }))
  })

  /**
   * 获取所有已连接的工程列表
   */
  // 只给交互式编辑器。界面上的「已连接」是说给用户听的，一个跑批的
  // commandlet 不算「你打开着这个工程」（见 projectManager.getInteractiveProjects）
  ipcMain.handle('ws:projects', () => {
    return projectManager.getInteractiveProjects()
  })

  /**
   * 获取指定连接的工程信息
   */
  ipcMain.handle('ws:project:get', (_, connectionId: string) => {
    return projectManager.getProject(connectionId) || null
  })

  // 注册事件转发到渲染进程
  setupEventForwarding()

  logger.info('[WebSocket IPC] IPC handlers 已注册')
}

/**
 * 设置事件转发到渲染进程
 */
function setupEventForwarding(): void {
  const ws = serviceManager.getWebSocketService()

  // 监听所有事件，转发到渲染进程。
  // `method` 必须带上：不带的话渲染进程收到的是一个匿名 payload，
  // 分不清这是 messagelog.changed 还是别的什么，只能全部忽略。
  ws.onEvent('*', (payload, clientId, method) => {
    const windows = getAppWindows()
    for (const win of windows) {
      win.webContents.send('ws:event', { method, payload, clientId })
    }
  })

  // 监听连接变化
  ws.onEvent('system.connected', (payload, clientId) => {
    const windows = getAppWindows()
    for (const win of windows) {
      win.webContents.send('ws:connection-change', { clientId, connected: true, payload })
    }
  })

  ws.onEvent('system.disconnected', (payload, clientId) => {
    const windows = getAppWindows()
    for (const win of windows) {
      win.webContents.send('ws:connection-change', { clientId, connected: false, payload })
    }
  })
}
