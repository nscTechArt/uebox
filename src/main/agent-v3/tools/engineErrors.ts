/**
 * 引擎超时的机器可读通道。
 *
 * ## 为什么需要它
 *
 * 外部评审抓到的一条：写工具内部等引擎 60 秒，超时之后 `catch` 把
 * `WebSocketServiceError(E_TIMEOUT)` 拍成了一句 `{ success: false, error: '请求超时: ...' }`
 * ——**错误码在这一步就丢了**。再往外走，`adaptV2Tool` 抛普通 Error、
 * `McpServerHost` 一律标成 `TOOL_FAILED`，于是命令行把它读成「明确失败」。
 *
 * 后果不是少一句提示：超时的时候 Actor **可能已经生成了**。调用方按「失败」
 * 重试，就会多出第二个。这正是 整套准入规则要防的那件事，
 * 而它在最关键的一条路径上没有生效。
 *
 * ## 为什么不在外层按错误文本判断
 *
 * 那是「今天能跑、改一个标点就静默失效」的接口，`McpServerHost` 的注释里
 * 已经写明不这么干。所以在**错误对象还在**的地方把码留下来，一层层原样传出去。
 *
 * 传递链：
 *   工具 catch（这里判定）→ V2 返回值的 `code` 字段
 *   → `adaptV2Tool` 抛 `EngineTimeoutError`
 *   → `McpServerHost` 回 `_meta.unrealBox.errorCode = 'ENGINE_TIMEOUT'`
 *   → CLI 读成「结局不明」，附上回读命令
 */

import { WebSocketErrorCode, WebSocketServiceError } from '../../services/websocket/types'

/** 对外的错误码。CLI 认这个字符串 */
export const ENGINE_TIMEOUT_CODE = 'ENGINE_TIMEOUT'

/**
 * 「按这个条件没查到东西」。
 *
 * ## 这是真机上抓到的，假盒子完全看不出来
 *
 * `ue_get_actor` 查一个不存在的名字时，插件回 RPC 404，工具把它变成一次
 * **失败**。而 CLI 的 `readActor()` 正是用它做回读：
 *
 *   - `actors delete` 删完回读 → 查不到 → 404 → 抛错 → 一次**成功的删除被报成失败**；
 *   - `actors spawn` 动手前查重名 → 查不到（正是我们要的）→ 404 → 抛错 → 生成永远失败。
 *
 * 也就是说三条写命令里有两条在真机上根本跑不通，而假盒子里 `ue_get_actor`
 * 返回的是空数组，一路绿灯。
 *
 * 「没查到」是一个合法的查询结果，不是故障。所以给它一个单独的码，让调用方
 * 能把它和真正的失败分开 —— 而不是去匹配「No actor found」这句英文。
 */
export const ENGINE_NOT_FOUND_CODE = 'ENGINE_NOT_FOUND'

/** 插件用 RPC 404 表示「按这个条件没查到」 */
export const RPC_NOT_FOUND = 404

/** V2 工具返回值里用的码，`adaptV2Tool` 据此判定 */
export const V2_TIMEOUT_CODE = WebSocketErrorCode.E_TIMEOUT

/**
 * 等引擎超时了。
 *
 * 单独一个类型，好让 `McpServerHost` 用 `instanceof` 判定，
 * 而不是去猜错误信息里有没有「超时」两个字。
 */
export class EngineTimeoutError extends Error {
  readonly code = ENGINE_TIMEOUT_CODE

  constructor(message: string) {
    super(message)
    this.name = 'EngineTimeoutError'
  }
}

/** 按条件没查到东西。**不是故障**，只是结果为空 */
export class EngineNotFoundError extends Error {
  readonly code = ENGINE_NOT_FOUND_CODE

  constructor(message: string) {
    super(message)
    this.name = 'EngineNotFoundError'
  }
}

/** 这个异常是不是「等引擎等超时了」 */
export function isEngineTimeout(error: unknown): boolean {
  return error instanceof WebSocketServiceError && error.code === WebSocketErrorCode.E_TIMEOUT
}

/**
 * 工具 catch 里用：把异常拍成 V2 失败返回值，**并且保住超时这个事实**。
 *
 * 超时和别的失败必须分开：别的失败是「引擎明确说没做成」，超时是
 * 「不知道做没做成」。混成同一种，调用方就会拿一个它以为确定的结论去重试。
 */
export function describeToolError(error: unknown): {
  success: false
  error: string
  code?: string
} {
  const base = error instanceof Error ? error.message : String(error)
  /*
   * 把写给模型的那半句拼回来。
   *
   * `WebSocketServiceError.message` 只放面向用户那句（它也会经 `ws:call` 回到界面），
   * 给模型的下一步单独放在 `agentHint` 里。这条路的终点是模型，两句都该给它。
   * 同一条处理见 `services/webReader.ts` 的 `agentHint`。
   */
  const hint = error instanceof WebSocketServiceError ? error.agentHint : undefined
  const message = hint ? `${base} ${hint}` : base

  return isEngineTimeout(error)
    ? { success: false, error: message, code: V2_TIMEOUT_CODE }
    : { success: false, error: message }
}
