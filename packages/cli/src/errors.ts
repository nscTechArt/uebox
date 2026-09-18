/**
 * 错误码与退出码。
 *
 * ## 为什么退出码要分这么细
 *
 * 调用方多半是脚本或别的 Agent，它们看不见终端上那句话。「配置没写对」和
 * 「引擎操作失败了」要走完全不同的下一步：前者该去改配置，后者该去现场核实。
 * 全都返回 1 的话，两者只能靠解析中文输出来区分 —— 那是今天能跑、
 * 改一个标点就失效的接口。
 *
 * 码本身固定为英文：字段名和错误码是接口，
 * 只有给人看的话才双语。
 */

/** 错误码。新增时必须同时在 `EXIT_CODES` 里给它归类 */
export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'OUTPUT_EXISTS'
  | 'CONFIG_MISSING'
  | 'CONFIG_UNREADABLE'
  | 'CONFIG_INVALID'
  | 'AUTH_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'INCOMPATIBLE_SERVER'
  | 'PROJECT_NOT_CONNECTED'
  | 'PROJECT_AMBIGUOUS'
  | 'TOOL_UNAVAILABLE'
  | 'RISK_NOT_SUPPORTED'
  | 'TIMEOUT'
  | 'ENGINE_NOT_FOUND'
  | 'TOOL_FAILED'
  | 'OUTPUT_INVALID'
  | 'OUTPUT_WRITE_FAILED'
  | 'CANCELLED'

/**
 * 这次请求走到哪一步了。
 *
 * - `not_started` —— 还没发出去（参数错、连不上、目标定不下来）
 * - `failed`      —— 收到了明确的失败结果。**注意它不承诺副作用已回滚**
 * - `unknown`     —— 发出去了但结局不明（超时、连接中断）。只能去现场核实
 */
export type ExecutionState = 'not_started' | 'failed' | 'unknown'

/** 错误码 → 退出码。 */
const EXIT_CODES: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 2,
  OUTPUT_EXISTS: 2,
  CONFIG_MISSING: 3,
  // 文件在，但读不了（权限、被占、是个目录）。退出码和 MISSING 一样是 3 ——
  // 对脚本来说都是「配置这一环没搞定」；分开成两个码是给能读懂码的调用方
  // 一个准确的下一步，见 config.ts 的 describeReadFailure
  CONFIG_UNREADABLE: 3,
  CONFIG_INVALID: 3,
  AUTH_FAILED: 3,
  SERVICE_UNAVAILABLE: 4,
  INCOMPATIBLE_SERVER: 4,
  PROJECT_NOT_CONNECTED: 5,
  PROJECT_AMBIGUOUS: 5,
  TOOL_UNAVAILABLE: 6,
  RISK_NOT_SUPPORTED: 6,
  TIMEOUT: 7,
  // 「按这个条件没查到」。快捷命令会自己接住它（查不到往往正是要的答案），
  // 只有直接 `tools call` 一个查询工具时才会走到这里
  ENGINE_NOT_FOUND: 8,
  TOOL_FAILED: 8,
  OUTPUT_INVALID: 8,
  OUTPUT_WRITE_FAILED: 8,
  // 128 + SIGINT(2)，Unix 惯例。**不等同于引擎已经撤销了操作**
  CANCELLED: 130
}

export function exitCodeFor(code: ErrorCode): number {
  return EXIT_CODES[code]
}

/**
 * CLI 自己的失败。
 *
 * 一律带 `hint`：只说「工程有歧义」而不说下一步该敲什么，等于把用户扔在原地。
 */
export class UeboxError extends Error {
  readonly execution: ExecutionState

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    execution: ExecutionState = 'not_started'
  ) {
    super(message)
    this.name = 'UeboxError'
    this.execution = execution
  }
}

/** 任何异常都要能变成一条有码的失败，不能让未知异常裸奔到退出码 1 */
export function toUeboxError(error: unknown): UeboxError {
  if (error instanceof UeboxError) return error

  const message = error instanceof Error ? error.message : String(error)
  // 归到 TOOL_FAILED 并保留真实诊断，不按中文字符串猜精细类别（§6.2）
  return new UeboxError('TOOL_FAILED', message, undefined, 'unknown')
}
