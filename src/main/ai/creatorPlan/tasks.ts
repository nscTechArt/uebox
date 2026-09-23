/**
 * 创作者 Token Plan 的异步任务客户端（`/tasks`，协议 05-tasks）：视频、3D、音乐三处共用。
 *
 *   提交   `POST /tasks`，**每次都带 Idempotency-Key**：提交超时、断网后用同一个键重发，
 *          服务端只建一个任务、只占一次额度 —— 所以提交可以放心重试，不像直连厂商那样
 *          「5xx 之后不敢再发」。例外是 `429 daily_limit_reached`（今天的额度用完了）：
 *          要等到明天，不重发，和 402 / 403 一样当场报给用户。
 *   轮询   `GET /tasks/{id}`，间隔按协议：视频 10 秒、3D 5 秒、音乐 3 秒。时间上限交给服务端
 *          （到点置 failed、退额度），这边只比它多等两分钟兜底。
 *   取消   `POST /tasks/{id}/cancel`。用户按停止时调，服务端置 cancelled。**退不退额度看回来的
 *          `usage` 是否归零**（2026-09 起）：视频只有还在排队时取消才退；3D、音乐一经提交上游
 *          就会跑完，取消不退。不按模型写死 —— 以后能退的情况只会变多。
 *   续上   提交前把「请求摘要 → 幂等键 / 任务号」记进 `userData/creator-plan-tasks.json`。
 *          应用崩了、被关了，同一个请求再发一次时先查这本账：有任务号就直接接着轮询，
 *          只有键就带同一个键重发（服务端回首次那个任务）—— 两种都不会再扣一次。
 *          任务到了终态（成功 / 失败 / 取消）就从账上划掉，之后同样的请求是一次新的生成。
 *   下载   文件链接 7 天有效、不需要 Key（能力链接），由各调用方按自己的落盘方式取回
 *          （视频、3D 进素材库，音乐进工程目录），这里不重复一份下载器。
 *
 * 地址从 Provider 拿，不写域名（官方端点门禁）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveApiKey } from '../credentials'
import type { ProviderConfig } from '../types'
import { CreatorPlanCallError, planCallError } from './callError'

export type PlanTaskKind = 'video' | 'model3d' | 'music'

/** 协议建议的轮询间隔。更频繁不会更快，只会被限流 */
export const PLAN_TASK_POLL_MS: Readonly<Record<PlanTaskKind, number>> = Object.freeze({
  video: 10_000,
  model3d: 5_000,
  music: 3_000
})

/** 协议的时间上限。服务端到点置 failed（task_timeout）并退额度 */
export const PLAN_TASK_LIMIT_MS: Readonly<Record<PlanTaskKind, number>> = Object.freeze({
  video: 30 * 60_000,
  model3d: 15 * 60_000,
  music: 15 * 60_000
})

/** 比服务端多等这么久再放弃：它的超时判定要一个轮询周期才落到任务对象上 */
const DEADLINE_MARGIN_MS = 2 * 60_000
/** 提交带参考图（data URI）时请求体可以有几十兆，给足 */
const SUBMIT_TIMEOUT_MS = 120_000
const POLL_TIMEOUT_MS = 30_000
const CANCEL_TIMEOUT_MS = 10_000
/** 提交最多发几次（同一个幂等键）。网络异常、429、5xx、524 都重发 */
const SUBMIT_ATTEMPTS = 3
/** 轮询连着失败几次才认输。提交之后额度已经预占了，为一次抖动放弃最不划算 */
const POLL_FAILURE_TOLERANCE = 8
/** 幂等键 24 小时内有效；任务结果保留 7 天 */
const KEY_TTL_MS = 24 * 60 * 60_000
const TASK_TTL_MS = 7 * 24 * 60 * 60_000

export type PlanTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface PlanTaskFile {
  /** 视频：video / cover；3D：model / preview / texture；音乐：audio / cover */
  role: string
  url: string
  mimeType?: string
  size?: number
  expiresAt?: string
}

export interface PlanTask {
  id: string
  model: string
  status: PlanTaskStatus
  /** 0–100，只增不减 */
  progress: number
  files: PlanTaskFile[]
  error: { code?: string; message: string } | null
  /**
   * 本任务占用的额度：2026-09-24 起是 `{ credits }`，更早的服务端是 `video_seconds` / `model3d_tasks` /
   * `music_tasks`。失败、退了的取消后为 0。只按「有没有大于 0 的值」用，不认具体键
   */
  usage: Record<string, number> | null
}

const STATUSES: readonly PlanTaskStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
]

/** 任务对象 → 我们的形状。认不出来（没有 id / 状态）回 null */
export function parsePlanTask(payload: unknown): PlanTask | null {
  const raw = payload as Record<string, unknown> | null
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null
  const status = STATUSES.find((item) => item === raw.status)
  if (!status) return null
  const files = ((raw.output as { files?: unknown } | null)?.files ?? []) as unknown[]
  const error = raw.error as { code?: unknown; message?: unknown } | null
  return {
    id: raw.id,
    model: typeof raw.model === 'string' ? raw.model : '',
    status,
    progress: typeof raw.progress === 'number' ? raw.progress : 0,
    files: (Array.isArray(files) ? files : [])
      .map((item) => item as Record<string, unknown>)
      .filter((item) => typeof item?.url === 'string' && typeof item.role === 'string')
      .map((item) => ({
        role: item.role as string,
        url: item.url as string,
        ...(typeof item.mime_type === 'string' ? { mimeType: item.mime_type } : {}),
        ...(typeof item.size === 'number' ? { size: item.size } : {}),
        ...(typeof item.expires_at === 'string' ? { expiresAt: item.expires_at } : {})
      })),
    error: error
      ? {
          ...(typeof error.code === 'string' ? { code: error.code } : {}),
          message: typeof error.message === 'string' ? error.message : ''
        }
      : null,
    usage: raw.usage && typeof raw.usage === 'object' ? (raw.usage as Record<string, number>) : null
  }
}

// ── 错误 ───────────────────────────────────────────────────────────────────

/** 任务号怎么报给用户。各调用方有自己的令牌格式（`providerId:任务号` 之类），由它们给 */
export type TaskLabel = (taskId: string) => string

export class PlanTaskRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
    readonly code?: string
  ) {
    super(
      `创作者 Token Plan 任务接口报错 HTTP ${status || '—'}（${path}）：${detail || '没有说明'}`
    )
    this.name = 'PlanTaskRequestError'
  }
}

/** 服务端说任务没成。**额度已经退回**（协议：failed / cancelled 后 usage 为 0） */
export class PlanTaskFailedError extends Error {
  constructor(
    readonly task: PlanTask,
    label: string
  ) {
    super(
      `没生成出来（${label}）：${task.error?.message || task.error?.code || '服务端没有给出原因'}。` +
        '这次占用的额度已经退回。'
    )
    this.name = 'PlanTaskFailedError'
  }
}

/**
 * 取消的结局：服务端取消了、额度退回（refunded）；服务端取消了、额度不退（kept —— 上游已经在生成，
 * 会跑完、照常计费）；取消请求没送到（unconfirmed —— 任务可能还在跑）。
 */
export type PlanTaskCancelOutcome = 'refunded' | 'kept' | 'unconfirmed'

/** 取消了的任务退没退额度：以 `usage` 是否归零为准（05-tasks「取消」）。没给 usage 的按退了算 */
export function cancelOutcomeOf(task: PlanTask | null): PlanTaskCancelOutcome {
  if (task?.status !== 'cancelled') return 'unconfirmed'
  const usage = Object.values(task.usage ?? {})
  return usage.some((value) => typeof value === 'number' && value > 0) ? 'kept' : 'refunded'
}

/** 为什么不退：视频是「已经开始生成」，3D、音乐是「提交了就不退」 */
const KEPT_REASON: Readonly<Record<PlanTaskKind, string>> = {
  video: '视频已经开始生成，只有还在排队时取消才退',
  model3d: '已提交的 3D 取消后不退额度，上游会跑完并照常计费',
  music: '已提交的音乐取消后不退额度，上游会跑完并照常计费'
}

const CANCEL_MESSAGES: Readonly<
  Record<PlanTaskCancelOutcome, (label: string, kind?: PlanTaskKind) => string>
> = {
  refunded: (label) => `已取消（${label}），占用的额度已经退回。`,
  kept: (label, kind) =>
    `已取消（${label}），这次的额度不退（${kind ? KEPT_REASON[kind] : '任务已经开始生成'}）。` +
    '结果不再交付。',
  unconfirmed: (label) =>
    `已停止等待（${label}），但取消请求没送到服务端，任务可能还在跑 —— ` +
    `想要结果用这个任务号取回，不要重新提交。`
}

/** 用户按了停止（或任务在别处被取消了） */
export class PlanTaskCancelledError extends Error {
  constructor(
    readonly taskId: string,
    readonly outcome: PlanTaskCancelOutcome,
    label: string,
    kind?: PlanTaskKind
  ) {
    super(CANCEL_MESSAGES[outcome](label, kind))
    this.name = 'PlanTaskCancelledError'
  }

  /** 服务端已经取消、额度退回 */
  get refunded(): boolean {
    return this.outcome === 'refunded'
  }

  /** 服务端确认取消了（退没退都算结束） —— 账本可以划掉 */
  get settled(): boolean {
    return this.outcome !== 'unconfirmed'
  }
}

/** 提交成功之后连着查不到状态。任务多半还在跑，额度已预占 —— 用任务号接着查，别重提交 */
export class PlanTaskInterruptedError extends Error {
  constructor(
    readonly taskId: string,
    readonly reason: unknown,
    label: string
  ) {
    super(
      `任务已提交（${label}），但连着查不到它的状态：` +
        `${reason instanceof Error ? reason.message : String(reason)}。` +
        '任务多半还在跑 —— 稍后用这个任务号接着取，不要重新提交。'
    )
    this.name = 'PlanTaskInterruptedError'
  }
}

/** 等过了协议的上限还没结束。正常情况下服务端早该置 failed，走到这里多半是查询端出了问题 */
export class PlanTaskTimeoutError extends Error {
  constructor(
    readonly taskId: string,
    label: string
  ) {
    super(`等了很久还没结束（${label}）。稍后用这个任务号接着取，不要重新提交。`)
    this.name = 'PlanTaskTimeoutError'
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

export interface PlanTaskDeps {
  fetchImpl?: typeof fetch
  /** 测试里换成立即返回 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  /** 测试里换成临时目录 */
  ledgerPath?: string
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * 值得用同一个键再发一次的：限流、服务端临时故障、Cloudflare 的 524（源站 100 秒没回字节）。
 * 每日上限的 429 在这之前已经被 planCallError 认走了，不会走到这里
 */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

async function call(
  provider: ProviderConfig,
  method: 'GET' | 'POST',
  path: string,
  options: {
    body?: unknown
    headers?: Record<string, string>
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  }
): Promise<{ status: number; payload: unknown; retryAfter: number | null; headers: Headers }> {
  const apiKey = await resolveApiKey(provider.apiKey)
  const response = await (options.fetchImpl ?? fetch)(
    `${provider.baseUrl.replace(/\/+$/, '')}${path}`,
    {
      method,
      headers: {
        ...(provider.headers ?? {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Accept-Language': 'zh-CN',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers ?? {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal
    }
  )
  const text = await response.text()
  let payload: unknown = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }
  const seconds = Number(response.headers.get('retry-after'))
  return {
    status: response.status,
    payload,
    retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    headers: response.headers
  }
}

/** 非 2xx → 错误。套餐那几种（402 / 429 每日上限 / 403 / 401）换成说清下一步的 CreatorPlanCallError */
function failure(status: number, path: string, payload: unknown, headers?: Headers): Error {
  const planError = planCallError(status, payload, headers)
  if (planError) return planError
  const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error
  const detail =
    typeof error?.message === 'string'
      ? error.message
      : typeof payload === 'string'
        ? payload.slice(0, 200)
        : ''
  return new PlanTaskRequestError(
    status,
    path,
    detail,
    typeof error?.code === 'string' ? error.code : undefined
  )
}

function expectTask(status: number, path: string, payload: unknown, headers?: Headers): PlanTask {
  if (status < 200 || status >= 300) throw failure(status, path, payload, headers)
  const task = parsePlanTask(payload)
  if (!task) throw new PlanTaskRequestError(status, path, '响应里没有任务对象')
  return task
}

export interface PlanTaskBody {
  model: string
  input: Record<string, unknown>
  metadata?: Record<string, string>
}

/**
 * 提交。同一个 `idempotencyKey` 最多发 SUBMIT_ATTEMPTS 次 —— 重发是安全的，这正是带键的意义。
 * 4xx（除限流的 429）不重发：参数不对、额度不够、今天的额度用完了，再发也是同一个结果。
 */
export async function submitPlanTask(
  provider: ProviderConfig,
  body: PlanTaskBody,
  idempotencyKey: string,
  signal?: AbortSignal,
  deps: PlanTaskDeps = {}
): Promise<PlanTask> {
  const wait = deps.sleep ?? sleep
  let lastError: unknown = null
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(lastRetryDelay(lastError, attempt), signal)
    try {
      const result = await call(provider, 'POST', '/tasks', {
        body,
        headers: { 'Idempotency-Key': idempotencyKey },
        signal: withTimeout(signal, SUBMIT_TIMEOUT_MS),
        fetchImpl: deps.fetchImpl
      })
      // 套餐那几种先认：每日上限也是 429，但等到的是明天，不能当限流重发
      const planError = planCallError(result.status, result.payload, result.headers)
      if (planError) throw planError
      if (isRetryable(result.status)) {
        lastError = {
          retryAfter: result.retryAfter,
          error: failure(result.status, '/tasks', result.payload, result.headers)
        }
        continue
      }
      return expectTask(result.status, 'POST /tasks', result.payload, result.headers)
    } catch (error) {
      // 用户按了停止不算抖动；参数错、套餐错也不重发
      if (signal?.aborted || error instanceof PlanTaskRequestError) throw error
      if (error instanceof CreatorPlanCallError) throw error
      lastError = { retryAfter: null, error }
    }
  }
  throw (lastError as { error: unknown } | null)?.error ?? new Error('提交失败')
}

function lastRetryDelay(last: unknown, attempt: number): number {
  const retryAfter = (last as { retryAfter?: number | null } | null)?.retryAfter
  // Retry-After 太长也封个顶：提交阶段用户正盯着看
  return Math.min(retryAfter ?? 1000 * 2 ** (attempt - 1), 30_000)
}

export async function getPlanTask(
  provider: ProviderConfig,
  taskId: string,
  signal?: AbortSignal,
  deps: PlanTaskDeps = {}
): Promise<PlanTask> {
  const path = `/tasks/${encodeURIComponent(taskId)}`
  const result = await call(provider, 'GET', path, {
    signal: withTimeout(signal, POLL_TIMEOUT_MS),
    fetchImpl: deps.fetchImpl
  })
  return expectTask(result.status, `GET ${path}`, result.payload, result.headers)
}

/**
 * 取消。**尽力而为**，不抛：回服务端给的任务（成功取消时 status 为 cancelled），发不出去回 null。
 * 用自己的超时，不用调用方的信号 —— 走到这里时那个信号多半已经 abort 了。
 */
export async function cancelPlanTask(
  provider: ProviderConfig,
  taskId: string,
  deps: PlanTaskDeps = {}
): Promise<PlanTask | null> {
  try {
    const result = await call(provider, 'POST', `/tasks/${encodeURIComponent(taskId)}/cancel`, {
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      fetchImpl: deps.fetchImpl
    })
    return result.status >= 200 && result.status < 300 ? parsePlanTask(result.payload) : null
  } catch {
    return null
  }
}

// ── 等待 ───────────────────────────────────────────────────────────────────

export interface WaitOptions extends PlanTaskDeps {
  signal?: AbortSignal
  /** 进度（0–100）变化时回调 */
  onProgress?: (note: string) => void
  label?: TaskLabel
}

const defaultLabel: TaskLabel = (taskId) => `任务号 ${taskId}`

/**
 * 从一个已知的任务对象开始，按协议间隔轮询到终态。成功回任务，其余抛错。
 *
 * 用户按停止（signal abort）→ 取消服务端任务 → 抛 PlanTaskCancelledError（退没退额度写在里面）。
 */
export async function waitPlanTask(
  provider: ProviderConfig,
  kind: PlanTaskKind,
  first: PlanTask,
  options: WaitOptions = {}
): Promise<PlanTask> {
  const wait = options.sleep ?? sleep
  const now = options.now ?? Date.now
  const label = (options.label ?? defaultLabel)(first.id)
  const deadline = now() + PLAN_TASK_LIMIT_MS[kind] + DEADLINE_MARGIN_MS
  const cancel = async (): Promise<never> => {
    const cancelled = await cancelPlanTask(provider, first.id, options)
    throw new PlanTaskCancelledError(first.id, cancelOutcomeOf(cancelled), label, kind)
  }

  let current = first
  let lastProgress = -1
  let failures = 0
  for (;;) {
    if (current.status === 'succeeded') return current
    if (current.status === 'failed') throw new PlanTaskFailedError(current, label)
    if (current.status === 'cancelled') {
      throw new PlanTaskCancelledError(current.id, cancelOutcomeOf(current), label, kind)
    }
    if (current.progress !== lastProgress) {
      lastProgress = current.progress
      options.onProgress?.(
        `${current.status === 'queued' ? '排队中' : '生成中'} ${current.progress}%`
      )
    }
    if (now() > deadline) throw new PlanTaskTimeoutError(current.id, label)

    try {
      await wait(PLAN_TASK_POLL_MS[kind], options.signal)
    } catch {
      if (options.signal?.aborted) return cancel()
    }
    try {
      current = await getPlanTask(provider, current.id, options.signal, options)
      failures = 0
    } catch (error) {
      if (options.signal?.aborted) return cancel()
      // 查到了、就是这个结论：授权失效、任务不存在 —— 再查也一样
      if (error instanceof CreatorPlanCallError) throw error
      if (
        error instanceof PlanTaskRequestError &&
        !isRetryable(error.status) &&
        error.status !== 0
      ) {
        throw error
      }
      failures += 1
      if (failures >= POLL_FAILURE_TOLERANCE)
        throw new PlanTaskInterruptedError(current.id, error, label)
      options.onProgress?.(`查询任务状态失败（第 ${failures} 次），任务还在跑，继续等…`)
    }
  }
}

// ── 崩溃后续上：本机账本 ────────────────────────────────────────────────────

interface LedgerEntry {
  /** 请求摘要：同一个请求（模型 + 输入）才续得上 */
  hash: string
  key: string
  taskId?: string
  model: string
  createdAt: number
}

async function ledgerPath(deps: PlanTaskDeps): Promise<string> {
  if (deps.ledgerPath) return deps.ledgerPath
  // 懒加载：只有真的提交任务时才碰 electron
  const { app } = await import('electron')
  return join(app.getPath('userData'), 'creator-plan-tasks.json')
}

async function readLedger(path: string): Promise<LedgerEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path, 'utf-8')) as { entries?: unknown }
    return Array.isArray(raw.entries)
      ? (raw.entries as LedgerEntry[]).filter(
          (entry) => typeof entry?.hash === 'string' && typeof entry.key === 'string'
        )
      : []
  } catch {
    return []
  }
}

/** 同一进程里几个任务一起跑时，读改写排队进行，免得互相覆盖 */
let ledgerQueue: Promise<unknown> = Promise.resolve()

function updateLedger(
  deps: PlanTaskDeps,
  change: (entries: LedgerEntry[]) => LedgerEntry[]
): Promise<void> {
  const run = ledgerQueue.then(async () => {
    const path = await ledgerPath(deps)
    const now = (deps.now ?? Date.now)()
    // 顺手清掉过期的：没任务号的过了幂等键的有效期，有任务号的过了结果保留期
    const alive = (await readLedger(path)).filter(
      (entry) => now - entry.createdAt < (entry.taskId ? TASK_TTL_MS : KEY_TTL_MS)
    )
    const next = change(alive)
    await fs.mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    await fs.writeFile(temp, `${JSON.stringify({ entries: next }, null, 2)}\n`, 'utf-8')
    await fs.rename(temp, path)
  })
  ledgerQueue = run.catch(() => undefined)
  return run
}

/** 记账失败不该让生成失败：最坏只是崩溃后续不上 */
async function safely(action: Promise<void>): Promise<void> {
  await action.catch((error: unknown) => console.warn('[Creator Plan] 任务账本写入失败:', error))
}

export function planTaskHash(body: PlanTaskBody): string {
  return createHash('sha256')
    .update(JSON.stringify({ model: body.model, input: body.input }))
    .digest('hex')
}

export interface RunOptions extends WaitOptions {
  /** 提交之后、开始等之前回调一次（调用方可以先把任务号报出去） */
  onSubmitted?: (task: PlanTask) => void
}

/**
 * 提交（或续上）→ 等到终态。成功回任务（账由调用方落盘后用 settlePlanTask 划），
 * 失败、取消成功时自己划掉；其余错误（查不到、等太久）留在账上，下次续得上。
 *
 * 续上的判据是请求摘要：同样的模型 + 同样的输入，账上又有没结束的那一笔，
 * 就不再新建 —— 有任务号直接查，没任务号（提交那一下崩了）带原来的键重发。
 */
export async function runPlanTask(
  provider: ProviderConfig,
  kind: PlanTaskKind,
  body: PlanTaskBody,
  options: RunOptions = {}
): Promise<PlanTask> {
  const hash = planTaskHash(body)
  const now = options.now ?? Date.now
  const path = await ledgerPath(options).catch(() => null)
  const pending = path
    ? (await readLedger(path)).find(
        (entry) =>
          entry.hash === hash && now() - entry.createdAt < (entry.taskId ? TASK_TTL_MS : KEY_TTL_MS)
      )
    : undefined

  let task: PlanTask | null = null
  if (pending?.taskId) {
    options.onProgress?.('接着查上次没取完的任务（不重新提交、不再扣费）…')
    task = await getPlanTask(provider, pending.taskId, options.signal, options).catch(
      (error: unknown) => {
        // 账上那笔在服务端已经不在了（过了保留期），按新请求处理；别的错照抛
        if (error instanceof PlanTaskRequestError && error.status === 404) return null
        throw error
      }
    )
  }

  if (!task) {
    const key = pending && !pending.taskId ? pending.key : randomUUID()
    // 先记账再提交：提交那一下崩了，下次还能用同一个键把任务要回来
    await safely(
      updateLedger(options, (entries) => [
        ...entries.filter((entry) => entry.hash !== hash),
        { hash, key, model: body.model, createdAt: now() }
      ])
    )
    task = await submitPlanTask(provider, body, key, options.signal, options).catch(
      async (error: unknown) => {
        // 服务端明确没收下（参数错、额度不够）：这笔账作废
        if (error instanceof PlanTaskRequestError || error instanceof CreatorPlanCallError) {
          await safely(updateLedger(options, (entries) => entries.filter((e) => e.hash !== hash)))
        }
        throw error
      }
    )
    const submitted = task
    await safely(
      updateLedger(options, (entries) =>
        entries.map((entry) => (entry.hash === hash ? { ...entry, taskId: submitted.id } : entry))
      )
    )
  }

  options.onSubmitted?.(task)
  try {
    return await waitPlanTask(provider, kind, task, options)
  } catch (error) {
    // 还没结束的（查不到、等太久、没取消成）留在账上，下次续得上
    const ended =
      error instanceof PlanTaskFailedError ||
      (error instanceof PlanTaskCancelledError && error.settled)
    if (ended) {
      await safely(updateLedger(options, (entries) => entries.filter((e) => e.hash !== hash)))
    }
    throw error
  }
}

/**
 * 成功之后把账划掉：之后同样的请求是用户要「再来一个」，不该拿回上一次的结果。
 *
 * 不在 runPlanTask 里自己划，是为了让调用方**把文件落了盘再划** —— 下载到一半崩了，
 * 下次同样的请求还能把这个已经成功的任务接回来。音乐在 music.ts 里下完再划；
 * 视频、3D 的文件由工具层落盘，它们在拿到结果时就划（链接 7 天有效，任务号也报给了用户）。
 */
export async function settlePlanTask(body: PlanTaskBody, deps: PlanTaskDeps = {}): Promise<void> {
  const hash = planTaskHash(body)
  await safely(updateLedger(deps, (entries) => entries.filter((entry) => entry.hash !== hash)))
}

/** 按角色挑文件，保持服务端给的顺序 */
export function filesOfRole(task: PlanTask, ...roles: string[]): PlanTaskFile[] {
  return task.files.filter((file) => roles.includes(file.role))
}

/** 链接末段当文件名 */
export function fileNameOfUrl(url: string, fallback: string): string {
  const path = url.split(/[?#]/)[0]
  try {
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || fallback)
  } catch {
    return fallback
  }
}

/**
 * 按任务号接着取（工具的 `resume_job_id`）。不提交、不扣费；等到终态的规矩同 waitPlanTask。
 */
export async function resumePlanTask(
  provider: ProviderConfig,
  kind: PlanTaskKind,
  taskId: string,
  options: WaitOptions = {}
): Promise<PlanTask> {
  const task = await getPlanTask(provider, taskId, options.signal, options)
  return waitPlanTask(provider, kind, task, options)
}
