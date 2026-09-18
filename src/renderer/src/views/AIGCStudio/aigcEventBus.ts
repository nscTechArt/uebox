/**
 * AIGC 模块事件总线
 * 用于跨模块传递数据（如从资产库传递参考图到 AI 创作）
 */

type EventCallback = (...args: any[]) => void

class AIGCEventBus {
  private events: Map<string, Set<EventCallback>> = new Map()

  /**
   * 监听事件
   * @param event 事件名称
   * @param callback 回调函数
   */
  on(event: string, callback: EventCallback): void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set())
    }
    this.events.get(event)!.add(callback)
  }

  /**
   * 取消监听
   * @param event 事件名称
   * @param callback 回调函数
   */
  off(event: string, callback: EventCallback): void {
    const callbacks = this.events.get(event)
    if (callbacks) {
      callbacks.delete(callback)
    }
  }

  /**
   * 触发事件
   * @param event 事件名称
   * @param args 事件参数
   */
  emit(event: string, ...args: any[]): void {
    const callbacks = this.events.get(event)
    if (callbacks) {
      callbacks.forEach((callback) => callback(...args))
    }
  }

  /**
   * 清除指定事件的所有监听器
   * @param event 事件名称
   */
  clear(event: string): void {
    this.events.delete(event)
  }
}

// 导出单例
export const aigcEventBus = new AIGCEventBus()

// 定义事件类型
export const AIGC_EVENTS = {
  /** 设置参考图片 - 参数: imagePaths: string[] */
  SET_REFERENCE_IMAGE: 'setReferenceImage',
  /** 切换到图片分类并设置参考图 - 参数: imagePaths: string[] */
  SWITCH_TO_IMAGE_AND_SET_REFERENCE: 'switchToImageAndSetReference',
  /** 设置提示词（从导航专家跳转） - 参数: prompt: string */
  SET_PROMPT: 'setPrompt'
} as const
