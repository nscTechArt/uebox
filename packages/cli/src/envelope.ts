/**
 * 输出信封。
 *
 * ## 两条硬约定
 *
 * 1. **`--json` 时 stdout 只有一个 JSON 对象加一个换行**，失败时也一样。
 *    进度、警告、诊断一律走 stderr。调用方 `JSON.parse(stdout)` 必须永远成立 ——
 *    只要有一次在 stdout 上多打了一行日志，所有解析它的脚本就都碎了。
 * 2. **`data` 和 `error` 互斥**，`artifacts` / `warnings` 永远是数组。
 *    「成功但没有 data」和「失败但没有 error」都是形状破损，调用方没法写判断。
 *
 * `schemaVersion` 只约束这一层外壳，**不代表**里面各工具的业务字段已经统一过
 * （那些字段来自九个引擎版本的插件，形状本来就不齐）。
 */

import type { ErrorCode, ExecutionState } from './errors.js'

/** 落到本地的产物（截图、超大结果）。V1 里只有截图和外置结果会用到 */
export interface Artifact {
  path: string
  mimeType: string
  bytes: number
  /** `result` 表示这是被外置的结构化结果，不是工具产出的图片 */
  role?: 'result' | 'image'
}

export interface EnvelopeProject {
  name: string
  path: string
}

export interface Envelope {
  schemaVersion: 1
  ok: boolean
  /** 工程无关的命令（tools list、doctor 的连通性部分）为 null */
  project: EnvelopeProject | null
  data?: unknown
  error?: {
    code: ErrorCode
    message: string
    hint?: string
    execution: ExecutionState
  }
  artifacts: Artifact[]
  warnings: string[]
}

export interface SuccessInput {
  data: unknown
  project?: EnvelopeProject | null
  artifacts?: Artifact[]
  warnings?: string[]
}

export function success(input: SuccessInput): Envelope {
  return {
    schemaVersion: 1,
    ok: true,
    project: input.project ?? null,
    data: input.data,
    artifacts: input.artifacts ?? [],
    warnings: input.warnings ?? []
  }
}

export interface FailureInput {
  code: ErrorCode
  message: string
  hint?: string
  execution: ExecutionState
  project?: EnvelopeProject | null
  artifacts?: Artifact[]
  warnings?: string[]
}

export function failure(input: FailureInput): Envelope {
  return {
    schemaVersion: 1,
    ok: false,
    project: input.project ?? null,
    error: {
      code: input.code,
      message: input.message,
      ...(input.hint ? { hint: input.hint } : {}),
      execution: input.execution
    },
    artifacts: input.artifacts ?? [],
    warnings: input.warnings ?? []
  }
}

/**
 * 写到 stdout。
 *
 * 只有这一个函数允许碰 stdout —— 别处一律 stderr。集中在一处，
 * 「stdout 只有一个 JSON」这条约定才守得住。
 */
export function writeJson(envelope: Envelope, out: NodeJS.WriteStream = process.stdout): void {
  out.write(`${JSON.stringify(envelope)}\n`)
}

/** 进度和诊断。永远走 stderr，不带颜色、不带转圈、不带终端控制码 */
export function note(message: string, err: NodeJS.WriteStream = process.stderr): void {
  err.write(`${message}\n`)
}
