import { ipcMain } from 'electron'
import { logger } from '../services/logger'
import { normalizeBrowserAddress } from '../services/agentBrowser/address'

import { getSessionBrowser, type EmbeddedBounds } from '../services/agentBrowser'

/**
 * Agent 浏览器的界面通道。
 *
 * 只在**嵌入模式**下有实质作用：那一档把远程页面挂成主窗口的一个子视图，
 * 而子视图是浮在渲染层内容之上的一层，不参与网页布局 —— 它的位置只能由
 * 渲染层那块占位面板量出来报上来。
 *
 * 用户可在地址栏导航；手动导航、会话恢复与 Agent 打开均经过相同的 URL/DNS 校验。
 */

/** 面板尺寸的合理上限，挡住渲染层传来的离谱值（比如 NaN 或负数） */
function sanitize(bounds: unknown): EmbeddedBounds | null {
  if (!bounds || typeof bounds !== 'object') return null

  const raw = bounds as Record<string, unknown>
  const numbers = ['x', 'y', 'width', 'height'].map((key) =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? Math.round(raw[key] as number) : NaN
  )
  if (numbers.some(Number.isNaN)) return null

  const [x, y, width, height] = numbers
  // 宽或高为 0 等同于「现在不该显示」，交给上层按隐藏处理
  if (width <= 0 || height <= 0) return null

  return { x, y, width, height }
}

function validSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new Error('Invalid browser session ID')
  }
  return value
}

export function registerAgentBrowserIPC(): void {
  /**
   * 渲染层报告嵌入面板的位置。
   *
   * 传 null（或不合法的值）表示面板此刻不该显示 —— 切到别的页面、窗口太窄、
   * 用户折叠了它。不报的话，那层网页会继续盖在别的界面上面。
   */
  ipcMain.on('agent-browser:set-bounds', (event, bounds: unknown, sessionId?: string) => {
    // 和本文件其余通道用同一个校验。这是 `on` 不是 `handle`，抛出去没人接，
    // 所以只能记一笔 —— 但一定要记：位置报给了错的实例时，界面上的表现是
    // 「那层网页没出现」或者「盖错了地方」，不留痕迹的话根本查不到这儿。
    let valid: string | undefined
    try {
      valid = validSessionId(sessionId)
    } catch (error) {
      logger.warn(`[AgentBrowser] 忽略非法会话 ID 的面板位置上报：${String(error)}`)
      return
    }
    getSessionBrowser(valid).setEmbeddedBounds(sanitize(bounds), event.sender.id)
  })

  /** 用户在面板上点了关闭。独立窗口模式下他直接关窗口，走不到这里 */
  ipcMain.handle('agent-browser:close', async (_event, sessionId?: string) => {
    await getSessionBrowser(validSessionId(sessionId)).close()
    return { success: true }
  })

  ipcMain.handle('agent-browser:open-url', async (_event, sessionId: string, address: unknown) => {
    try {
      if (!sessionId) throw new Error('Missing browser session ID')
      const browser = getSessionBrowser(validSessionId(sessionId))
      const page = await browser.open(normalizeBrowserAddress(address))
      return { success: true, data: { url: page.url } }
    } catch (error) {
      return {
        success: false,
        data: { url: '' },
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('agent-browser:toolbar', (_event, sessionId: string, action: unknown) => {
    try {
      if (!sessionId) throw new Error('Missing browser session ID')
      if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') {
        throw new Error('Invalid browser toolbar action')
      }
      getSessionBrowser(validSessionId(sessionId)).toolbar(action)
      return { success: true, data: null }
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('agent-browser:tab', async (_event, sessionId: string, command: unknown) => {
    try {
      if (!sessionId || !command || typeof command !== 'object')
        throw new Error('Invalid tab command')
      const browser = getSessionBrowser(validSessionId(sessionId))
      const input = command as Record<string, unknown>
      if (input.action === 'create') browser.createTab()
      else if (input.action === 'mode' && (input.mode === 'embedded' || input.mode === 'window'))
        browser.setMode(input.mode)
      else if (typeof input.tabId === 'string' && input.action === 'select')
        browser.selectTab(input.tabId)
      else if (typeof input.tabId === 'string' && input.action === 'close')
        await browser.closeTab(input.tabId)
      else throw new Error('Invalid tab command')
      return { success: true, data: null }
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  /** 界面刚挂载时问一次：现在开着吗、哪一档模式 */
  ipcMain.handle('agent-browser:get-state', async (_event, sessionId?: string, restore = false) => {
    const browser = getSessionBrowser(validSessionId(sessionId))
    try {
      if (restore === true) await browser.restore()
      return {
        success: true,
        data: {
          ...browser.groupState(),
          open: browser.hasWindow(),
          mode: browser.currentMode(),
          url: browser.currentUrl(),
          navigation: browser.navigationState()
        }
      }
    } catch (error) {
      return {
        success: false,
        data: {
          ...browser.groupState(),
          open: browser.hasWindow(),
          mode: browser.currentMode(),
          url: browser.currentUrl(),
          navigation: browser.navigationState()
        },
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}
