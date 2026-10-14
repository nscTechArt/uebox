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
  destroyFn: (() => void) | null
  expireTimer: ReturnType<typeof setTimeout> | null
}

/** 同时最多显示几条**不带 key** 的消息；再多就把最早的那条收掉 */
const MAX_VISIBLE_UNKEYED = 3

/**
 * 消息管理器类
 * 用于管理全局消息通知，实现相同内容的消息去重和计数
 */
class MessageManager {
  /** 当前显示着的不带 key 的消息，按出现先后排（Map 保持插入顺序） */
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
    // 带 key 的是「同一条消息的新状态」（加载中 → 完成、进度 30% → 31%），
    // 身份由 key 决定，不归下面按内容去重管
    if (typeof content === 'object' && content.key) {
      this.showKeyed(type, content, duration ?? 3)
      return
    }

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
    let record: MessageRecord

    if (existingRecord) {
      // 消息已存在，增加计数、换成带计数的新消息，挪到队尾（算「最新」）
      existingRecord.count++
      existingRecord.destroyFn?.()
      existingRecord.destroyFn = antdMessage[type](
        `${messageContent} (${existingRecord.count})`,
        messageDuration
      )
      this.messageMap.delete(key)
      record = existingRecord
    } else {
      record = {
        content: messageContent,
        type,
        count: 1,
        destroyFn: antdMessage[type](messageContent, messageDuration),
        expireTimer: null
      }
    }
    this.messageMap.set(key, record)
    this.resetExpireTimer(key, record, messageDuration, onClose)
    this.trimVisible()
  }

  /**
   * 同屏条数的上限自己管，不交给 antd 的 maxCount。
   *
   * antd 4.2.6 的 maxCount 满了之后，新消息会**借用最早那条的 key**，用户给的 key 存到
   * 另一个字段里；而之后按 key 更新时只认前者 —— 于是屏幕上已经有三条消息的时候，
   * 带 key 的进度消息每更新一次就多出一条，「三条进度卡住不动」原样复现。
   * 这里只给不带 key 的消息设上限；带 key 的消息本来就是一条原地更新，不会堆。
   */
  private trimVisible(): void {
    while (this.messageMap.size > MAX_VISIBLE_UNKEYED) {
      const [oldestKey, oldest] = this.messageMap.entries().next().value as [string, MessageRecord]
      this.messageMap.delete(oldestKey)
      if (oldest.expireTimer) clearTimeout(oldest.expireTimer)
      oldest.destroyFn?.()
    }
  }

  /**
   * 重置消息过期定时器（同一条消息重复出现时，旧的定时器要清掉，否则它会提前把记录删掉）
   */
  private resetExpireTimer(
    key: string,
    record: MessageRecord,
    duration: number,
    onClose?: () => void
  ): void {
    if (record.expireTimer) clearTimeout(record.expireTimer)
    // duration 0 = 不自动关闭，记录留着，等被顶掉或 destroy
    if (duration <= 0) {
      record.expireTimer = null
      return
    }
    record.expireTimer = setTimeout(() => {
      if (this.messageMap.get(key) === record) this.messageMap.delete(key)
      onClose?.()
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
      if (record.expireTimer) clearTimeout(record.expireTimer)
      record.destroyFn?.()
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
    if (typeof content === 'object' && content.key) {
      return this.showKeyed('loading', content, duration ?? 0)
    }

    // 否则使用自定义去重逻辑
    const messageContent = typeof content === 'string' ? content : content.content
    const messageDuration =
      typeof content === 'string' ? (duration ?? 0) : (content.duration ?? duration ?? 0)

    return antdMessage.loading(messageContent, messageDuration)
  }

  /**
   * 带 key 的消息：key 必须原样交给 antd，它才会**原地更新**同一条，而不是再弹一条。
   *
   * 这里以前只转了内容和时长，key 被扔掉了。于是所有「先 loading 再用同一个 key 改成
   * success / 刷新进度」的地方都在不停新开消息：网络库同步每 2000 行弹一条
   * 「正在下载资产 (N/M)」，duration 0 永不消失；按 key 销毁也销毁不到，因为 antd 那边
   * 根本没有这个 key。同屏上限见 trimVisible。
   */
  private showKeyed(
    type: MessageType | 'loading',
    config: MessageConfig,
    fallbackDuration: number
  ): () => void {
    return antdMessage[type]({
      // 空字符串过不了 antd 的「这是配置对象」判断，整个对象会被当成内容渲染出来，key 也丢了
      content: config.content || ' ',
      key: config.key,
      duration: config.duration ?? fallbackDuration,
      onClose: config.onClose
    })
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

// 配置全局消息位置，默认 top 为 24px，往下偏移 30px。
// 不设 maxCount：同屏上限由 MessageManager.trimVisible 自己管，理由见那里
antdMessage.config({
  top: '54px',
  duration: 3
})
