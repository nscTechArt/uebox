import { app, screen } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}

const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1630,
  height: 1000
}

class WindowStateManager {
  private configPath: string
  private state: WindowState

  constructor() {
    this.configPath = join(app.getPath('userData'), 'window-state.json')
    this.state = this.loadState()
  }

  /**
   * 加载窗口状态
   */
  private loadState(): WindowState {
    try {
      if (existsSync(this.configPath)) {
        const data = readFileSync(this.configPath, 'utf8')
        const savedState = JSON.parse(data) as WindowState

        // 验证数据有效性
        if (this.isValidState(savedState)) {
          return { ...DEFAULT_WINDOW_STATE, ...savedState }
        }
      }
    } catch (error) {
      console.warn('加载窗口状态失败:', error)
    }

    return DEFAULT_WINDOW_STATE
  }

  /**
   * 保存窗口状态
   */
  saveState(state: Partial<WindowState>): void {
    try {
      this.state = { ...this.state, ...state }
      writeFileSync(this.configPath, JSON.stringify(this.state, null, 2))
    } catch (error) {
      console.error('保存窗口状态失败:', error)
    }
  }

  /**
   * 获取窗口状态（自动校验屏幕可见性）
   */
  getState(): WindowState {
    const state = { ...this.state }

    // 校验保存的位置是否在当前连接的显示器范围内
    // 如果用户之前使用多显示器（例如副屏在左侧，x 为负数），
    // 断开副屏后保存的坐标会导致窗口在屏幕外不可见
    if (state.x !== undefined && state.y !== undefined) {
      if (!this.isPositionVisible(state.x, state.y, state.width, state.height)) {
        // 位置不可见，重置为主屏幕居中
        console.warn(
          `[WindowState] 保存的坐标 (${state.x}, ${state.y}) 不在任何显示器范围内，重置为居中`
        )
        delete state.x
        delete state.y
      }
    }

    return state
  }

  /**
   * 验证状态数据有效性
   */
  private isValidState(state: any): state is WindowState {
    return (
      typeof state === 'object' &&
      typeof state.width === 'number' &&
      typeof state.height === 'number' &&
      state.width > 0 &&
      state.height > 0 &&
      state.width <= 7680 &&
      state.height <= 4320
    )
  }

  /**
   * 检测给定坐标是否在任意一个连接的显示器上可见
   * 至少要有 MIN_VISIBLE 像素在某个显示器内才算可见
   */
  private isPositionVisible(x: number, y: number, width: number, height: number): boolean {
    const MIN_VISIBLE = 100 // 至少 100px 在屏幕内

    try {
      const displays = screen.getAllDisplays()
      for (const display of displays) {
        const { x: dx, y: dy, width: dw, height: dh } = display.workArea

        // 计算窗口与显示器工作区的交叉区域
        const overlapX = Math.max(0, Math.min(x + width, dx + dw) - Math.max(x, dx))
        const overlapY = Math.max(0, Math.min(y + height, dy + dh) - Math.max(y, dy))

        if (overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE) {
          return true
        }
      }
    } catch (error) {
      console.warn('[WindowState] 屏幕检测失败:', error)
      return true // 出错时不阻止窗口打开
    }

    return false
  }

  /**
   * 重置为默认状态
   */
  reset(): void {
    this.state = { ...DEFAULT_WINDOW_STATE }
    this.saveState(this.state)
  }
}

export const windowStateManager = new WindowStateManager()
