import { message as antdMessage } from 'ant-design-vue'

/**
 * 消息类型
 */
type MessageType = 'success' | 'error' | 'warning' | 'info'

/**
 * 消息配置项
 */
interface MessageConfig {
  content: string
  duration?: number
  onClose?: () => void
  key?: string // 消息的唯一标识，用于更新或销毁特定消息
}

/**
 * 消息记录项
 */
interface MessageRecord {
  content: string
  type: MessageType
  count: number
  messageKey: string // Ant Design message 实例的 key
  destroyFn: (() => void) | null
}

/**
 * 消息管理器类
 * 用于管理全局消息通知，实现相同内容的消息去重和计数
 */
class MessageManager {
  // 存储当前显示的消息记录
  private messageMap: Map<string, MessageRecord> = new Map()

  /**
   * 生成消息的唯一标识
   * @param content 消息内容
   * @param type 消息类型
   * @returns 唯一标识字符串
   */
  private generateKey(content: string, type: MessageType): string {
    return `${type}:${content}`
  }

  /**
   * 显示消息
   * @param type 消息类型
   * @param content 消息内容或配置对象
   * @param duration 持续时间（秒）
   */
  private show(type: MessageType, content: string | MessageConfig, duration?: number): void {
    // 解析参数
    let messageContent: string
    let messageDuration: number
    let onClose: (() => void) | undefined

    if (typeof content === 'string') {
      messageContent = content
      messageDuration = duration ?? 3
    } else {
      messageContent = content.content
      messageDuration = content.duration ?? 3
      onClose = content.onClose
    }

    const key = this.generateKey(messageContent, type)
    const existingRecord = this.messageMap.get(key)

    if (existingRecord) {
      // 消息已存在，增加计数
      existingRecord.count++

      // 更新显示内容，添加计数器
      const displayContent = `${messageContent} (${existingRecord.count})`

      // 销毁旧消息
      if (existingRecord.destroyFn) {
        existingRecord.destroyFn()
      }

      // 显示新消息
      const destroyFn = antdMessage[type](displayContent, messageDuration)
      existingRecord.destroyFn = destroyFn

      // 重置过期定时器
      this.resetExpireTimer(key, messageDuration, onClose)
    } else {
      // 新消息，直接显示
      const destroyFn = antdMessage[type](messageContent, messageDuration)

      // 记录消息
      const record: MessageRecord = {
        content: messageContent,
        type,
        count: 1,
        messageKey: key,
        destroyFn
      }

      this.messageMap.set(key, record)

      // 设置过期定时器
      this.resetExpireTimer(key, messageDuration, onClose)
    }
  }

  /**
   * 重置消息过期定时器
   * @param key 消息唯一标识
   * @param duration 持续时间（秒）
   * @param onClose 关闭回调
   */
  private resetExpireTimer(key: string, duration: number, onClose?: () => void): void {
    setTimeout(() => {
      this.messageMap.delete(key)
      if (onClose) {
        onClose()
      }
    }, duration * 1000)
  }

  /**
   * 显示成功消息
   * @param content 消息内容或配置对象
   * @param duration 持续时间（秒）
   */
  success(content: string | MessageConfig, duration?: number): void {
    this.show('success', content, duration)
  }

  /**
   * 显示错误消息
   * @param content 消息内容或配置对象
   * @param duration 持续时间（秒）
   */
  error(content: string | MessageConfig, duration?: number): void {
    this.show('error', content, duration)
  }

  /**
   * 显示警告消息
   * @param content 消息内容或配置对象
   * @param duration 持续时间（秒）
   */
  warning(content: string | MessageConfig, duration?: number): void {
    this.show('warning', content, duration)
  }

  /**
   * 显示信息消息
   * @param content 消息内容或配置对象
   * @param duration 持续时间（秒）
   */
  info(content: string | MessageConfig, duration?: number): void {
    this.show('info', content, duration)
  }

  /**
   * 销毁所有消息
   */
  destroyAll(): void {
    this.messageMap.forEach((record) => {
      if (record.destroyFn) {
        record.destroyFn()
      }
    })
    this.messageMap.clear()
    antdMessage.destroy()
  }

  /**
   * 显示加载消息
   * @param content 消息内容或配置对象
   * @param duration 持续时间（秒），0 表示不自动关闭
   */
  loading(content: string | MessageConfig, duration?: number): () => void {
    // 如果传入的是配置对象且包含 key，直接使用原生 API
    if (typeof content === 'object' && content.key) {
      return antdMessage.loading(content.content, content.duration ?? duration ?? 0)
    }

    // 否则使用自定义去重逻辑
    const messageContent = typeof content === 'string' ? content : content.content
    const messageDuration =
      typeof content === 'string' ? (duration ?? 0) : (content.duration ?? duration ?? 0)

    return antdMessage.loading(messageContent, messageDuration)
  }

  /**
   * 销毁指定消息或所有消息
   * @param key 可选的消息 key，如果不传则销毁所有消息
   */
  destroy(key?: string): void {
    if (key) {
      // 销毁指定 key 的消息
      antdMessage.destroy(key)
    } else {
      // 销毁所有消息
      this.destroyAll()
    }
  }
}

// 导出单例
export const message = new MessageManager()

// 配置全局消息位置，默认 top 为 24px，往下偏移 30px
antdMessage.config({
  top: '54px',
  duration: 3,
  maxCount: 3
})
