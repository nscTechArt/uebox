import { Modal } from 'ant-design-vue'
import type { CSSProperties, VNode } from 'vue'

/**
 * 全局对话框（确认框 / 提示框）。
 *
 * ## 为什么要有这一层
 *
 * ant-design-vue 的最后一个 npm 版本是 2024-11 的 4.2.6，之后近两年没有代码发版，
 * 迟早要换掉。`Modal.confirm` 这类命令式 API 是最难换的部分 —— 它自己挂 DOM、
 * 自己读 ConfigProvider 的主题上下文，散在 27 个文件里的话，换底层就得改 27 个地方。
 *
 * 收敛到这里之后，换实现只改这一个文件。业务代码**不要**再直接
 * `import { Modal } from 'ant-design-vue'`。
 *
 * ## 这里的选项不是 antd 选项的透传
 *
 * 只暴露全仓真正用到的那些，并且用「意图」命名：antd 里同一件事有 `okType: 'danger'`
 * 和 `okButtonProps: { danger: true }` 两种写法，这里统一成 `danger: true`。
 * 需要新选项就往下加，不要为了省事改成 `[key: string]: unknown` —— 那等于没有接缝。
 */

/** 确认框和提示框共用的部分 */
interface BaseDialogOptions {
  title: string
  /** 正文。传 VNode 是为了少数需要富文本/列表的场景 */
  content?: string | VNode | (() => VNode)
  /** 确认按钮文案，不传用 antd 的默认「确定」 */
  okText?: string
  /** 主按钮是危险动作（删除、移除、覆盖），按钮渲染成红色 */
  danger?: boolean
  /** 垂直居中，默认贴顶 */
  centered?: boolean
  width?: number
  /** 标题左侧的图标。传 `null` 表示不要图标 */
  icon?: VNode | null
  /** 压在别的浮层之上时用；不传走 antd 默认 */
  zIndex?: number
  class?: string
  style?: CSSProperties | string
  /** 自定义底部按钮区，给少数需要自己排布按钮的弹窗 */
  footer?: () => VNode
  /** 点遮罩能不能关掉，默认能 */
  maskClosable?: boolean
  /** 关闭动画放完之后。用来清理「这个弹窗还开着」之类的标记 */
  afterClose?: () => void
}

/**
 * 打开后的句柄。
 *
 * 只有自定义 footer 的弹窗用得上 —— 自己画的按钮得能把弹窗关掉，
 * 而它们不走 onOk/onCancel 那条路。
 */
export interface DialogHandle {
  destroy: () => void
}

export interface ConfirmDialogOptions extends BaseDialogOptions {
  cancelText?: string
  /**
   * 点确定。返回 Promise 时，弹窗会保持 loading 直到它 resolve ——
   * reject 则弹窗不关，用来做「保存失败就别关」。
   */
  onOk?: () => void | Promise<unknown>
  onCancel?: () => void
}

export interface AlertDialogOptions extends BaseDialogOptions {
  onOk?: () => void | Promise<unknown>
}

/** 把我们的选项翻译成 antd 的形状。换底层时，要重写的只有这个函数和下面五个入口。 */
function toAntdConfig(options: ConfirmDialogOptions | AlertDialogOptions): Record<string, unknown> {
  const { danger, ...rest } = options
  const config: Record<string, unknown> = { ...rest }
  if (danger) config.okType = 'danger'
  return config
}

/** 需要用户点「确定 / 取消」二选一的确认框 */
export function confirmDialog(options: ConfirmDialogOptions): DialogHandle {
  return Modal.confirm(toAntdConfig(options))
}

/** 只有一个「确定」的提示框 —— 出错了、必须让用户看见 */
export function errorDialog(options: AlertDialogOptions): DialogHandle {
  return Modal.error(toAntdConfig(options))
}

/** 只有一个「确定」的提示框 —— 有风险但不是错误 */
export function warningDialog(options: AlertDialogOptions): DialogHandle {
  return Modal.warning(toAntdConfig(options))
}

/** 只有一个「确定」的提示框 —— 纯告知 */
export function infoDialog(options: AlertDialogOptions): DialogHandle {
  return Modal.info(toAntdConfig(options))
}

/** 只有一个「确定」的提示框 —— 操作成功且需要用户确认看到 */
export function successDialog(options: AlertDialogOptions): DialogHandle {
  return Modal.success(toAntdConfig(options))
}
