/**
 * UE 工具的 RPC 样板收敛。
 *
 * V2 里 78 个 UE 工具各自重复同一段 60 行：取 WebSocket 服务 → 查连接数 →
 * `callRequest` → 手工解 RPC 错误的四种形状 → 拼 `{ success, ... }`。
 * 每处的错误处理都略有差异，模型看到的失败信息因此不一致。
 *
 * 这里收敛成一处，工具本身只剩「方法名 + 参数映射 + 成功文案」。
 * 迁移一个 UE 工具从改 60 行变成改 15 行。
 *
 * ## 注册表没扫完怎么办
 *
 * 读资产注册表的命令（content.* 那一批）在引擎冷启动、注册表还在扫盘时，
 * 插件不再死等（那会把编辑器卡住几分钟，然后盒子这边超时报「插件没有响应」），
 * 而是立刻回 `registry_not_ready` 加一份扫描进度。这里把它接住：转成轮询
 * `content.registry_status`，把进度推给界面，扫完自动重发原命令。
 * 用户看到的是「引擎还在扫资产：42,318 / 96,000」在跳，而不是一个转圈。
 * 设计。
 */

import { z } from 'zod'

import { serviceManager } from '../../services'
import { WebSocketServiceError } from '../../services/websocket/types'
import { getTargetConnectionId } from '../../agent-v3/core/projectTargetContext'
import { defineTool, type ToolOutcome, type ToolRisk, type UnrealAgentTool } from './defineTool'

/** UE 侧 RPC 的失败响应形状。历史原因有四种，全部在这里认。 */
interface RpcErrorShape {
  ok?: boolean
  success?: boolean
  error?: string
  message?: string
  code?: string | number
  details?: unknown
  __rpc?: { code?: string | number }
}

/** 默认 RPC 超时。蓝图编译、批量导入这类要单独调大。 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 引擎没连上时，所有 ue.* 工具回给模型的那一句。
 *
 * ## 为什么值得单独一条常量
 *
 * 这句话原来在 43 个文件里各抄了一份，内容是**首次安装的引导词**：
 * 「请确保虚幻引擎已启动并安装了 UnrealAgentLink 插件，且已在盒子里连接该项目。」
 * 于是真机上最常见的一幕是：用户编辑器重启了一下（或者崩了一次），十分钟前还
 * 连得好好的，模型张口就让他去装插件、去「连接该项目」。
 *
 * 「在盒子里连接该项目」这半句更是**一个不存在的操作**。连接方向是反的：盒子是
 * 被动的 WebSocket 服务端，插件那边主动连过来，断了每 5 秒自己重试
 * （`plugin/.../UAL_NetworkManager.cpp` 的 `StartReconnectTimer`）。首页工程卡片
 * 上只有一个「已连接」标识，**没有连接按钮** —— 把用户支去点它，他只会找不到。
 * 同一条结论在 `adapted/ue-system/sessionHealth.ts` 的文件头里论证过一遍。
 *
 * 所以改成**陈述事实 + 给模型的下一步**，而不是一句借模型之口下达给用户的指令：
 * 三种情况（没开 / 开着还没连上 / 盯着重启前那条死连接）的下一步完全不同，
 * 而 `ue_session_health` 正是为分辨它们而存在的，且不走 RPC ——
 * 恰恰在连接断掉的时刻它还能用。
 */
export const UE_NOT_CONNECTED_MESSAGE =
  '引擎未连接：现在没有任何虚幻引擎连到盒子。先调 ue_session_health 判断是哪一种 ——' +
  '编辑器没在跑 / 在跑但还没连上 / 这一轮盯的是重启前那条死连接，三种的下一步不一样。' +
  '不要让用户去界面上「连接」：盒子是服务端，插件断线后每 5 秒自己重连，也没有这个按钮。'

export class UeNotConnectedError extends Error {
  constructor() {
    super(UE_NOT_CONNECTED_MESSAGE)
    this.name = 'UeNotConnectedError'
  }
}

/**
 * 调一次 UE RPC，**不**把 `ok:false` 当异常。
 *
 * 给那些「响应本身就是结果」的命令用：`content.batch_move` 一批里有一条搬失败，
 * 插件会回 `ok:false` 外加每一条的状态和引擎日志 —— 这份结构化数据正是调用方
 * 要拿去写摘要、写账本的东西。`callUe` 会把它压成一句「失败：未提供失败原因」
 * 然后扔掉，第一轮的「逐条回读」在盒子这一侧就断在这里。
 *
 * 连接检查和目标项目路由与 `callUe` 相同；只有「没连接」和「引擎没回数据」才抛。
 */
export async function callUeRaw<T>(
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const ws = serviceManager.getWebSocketService()
  if (ws.getConnectionCount() === 0) throw new UeNotConnectedError()

  // 多项目场景：agent 可能被指定了目标项目，没指定则用当前活跃项目。
  const connectionId = getTargetConnectionId()

  let response: T
  try {
    response = await ws.callRequest<T>(
      method,
      params,
      connectionId,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.signal
    )
  } catch (error) {
    /*
     * 把写给模型的那半句拼回来。
     *
     * `WebSocketServiceError.message` 只放面向用户那句 —— 同一个异常也会经
     * `ws:call` 这条 IPC 回到渲染层，工具名混在里面就会弹给一个看不见工具的用户。
     * 而这条路（`defineTool` 不 catch，异常直接交给 pi）的终点是模型，两句都要给它。
     */
    throw withAgentHint(error)
  }
  if (response === null || response === undefined) {
    throw new Error(`${method} 失败：虚幻引擎未返回数据`)
  }
  return response
}

/** 异常带着 `agentHint` 的话，把它拼进 message —— 只在通向模型的这条路上做 */
function withAgentHint(error: unknown): unknown {
  if (!(error instanceof WebSocketServiceError) || !error.agentHint) return error
  return new WebSocketServiceError(error.code, `${error.message} ${error.agentHint}`)
}

/** `ok:false` / `success:false` → 抛一个 message 已经写给模型看的异常 */
function assertRpcOk(method: string, response: unknown): void {
  const shape = response as RpcErrorShape | null
  if (shape && (shape.ok === false || shape.success === false)) {
    const reason = shape.error || shape.message || '未提供失败原因'
    const code = shape.__rpc?.code ?? shape.code
    // 错误码和 details 拼进 message —— 模型只看得到 message，
    // 把诊断信息藏在结构化字段里等于没有。
    throw new Error(
      [
        `${method} 失败：${reason}`,
        code !== undefined ? `（错误码 ${code}）` : '',
        shape.details ? `\n详情：${JSON.stringify(shape.details)}` : ''
      ].join('')
    )
  }
}

/**
 * 调一次 UE RPC。
 *
 * 连接检查、目标项目路由、错误形状归一都在这里。
 * @throws {UeNotConnectedError} 没有已连接的引擎
 * @throws {Error} RPC 返回失败，message 已经是给模型看的完整描述
 */
export async function callUe<T>(
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const response = await callUeRaw<T>(method, params, options)
  assertRpcOk(method, response)
  return response
}

// ────────────────────────────────────────────────────────────────────────────
// 注册表就绪
// ────────────────────────────────────────────────────────────────────────────

/** 插件 `content.registry_status` 的响应，也是 `registry_not_ready` 错误里 details 的形状 */
export interface RegistryStatus {
  ok?: boolean
  ready: boolean
  /** 插件用的判据：5.6+ 是 IsGathering，5.0–5.5 是 IsLoadingAssets（只反映首次扫描） */
  criterion?: string
  search_all_assets?: boolean
  progress?: {
    total: number
    processed: number
    pending_data_load: number
    discovering_files: boolean
    /** 快照多久没更新了；一直不动说明卡住了 */
    snapshot_age_ms: number
    has_snapshot?: boolean
  }
  note?: string
}

export const REGISTRY_NOT_READY = 'registry_not_ready'

/** 插件说「注册表还没扫完」。`callRequest` 已把 503 的 message 归一进 error 字段 */
export function isRegistryNotReady(
  response: unknown
): response is RpcErrorShape & { details?: RegistryStatus } {
  const shape = response as RpcErrorShape | null
  if (!shape || typeof shape !== 'object') return false
  return shape.error === REGISTRY_NOT_READY || shape.message === REGISTRY_NOT_READY
}

export interface RegistryWaitOptions {
  /** 轮询间隔，默认 2 秒 */
  pollMs?: number
  /** 最多等多久，默认 10 分钟 */
  maxWaitMs?: number
  /** 进度连续多久没动就放弃，默认 60 秒 */
  stallMs?: number
}

const DEFAULT_WAIT: Required<RegistryWaitOptions> = {
  pollMs: 2_000,
  maxWaitMs: 10 * 60 * 1000,
  stallMs: 60_000
}

/**
 * 轮询时用到的那一点上下文。只要 text 一行，不绑具体工具的 details 类型 ——
 * 否则 `ToolCallContext<BatchMoveAggregate>` 这种带类型参数的 ctx 传不进来
 * （函数参数是逆变的）。
 */
type ProgressContext = {
  report: (partial: { text: string }) => void
  signal?: AbortSignal
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function fmt(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString('en-US')
}

/** 「引擎还在扫资产：已处理 42,318 / 约 96,000（约还要 1 分钟）」 */
export function describeRegistryProgress(status: RegistryStatus, etaMs?: number): string {
  const p = status.progress
  if (!p || !p.has_snapshot) {
    return '引擎还在扫资产（插件还没收到进度快照）'
  }
  const stage = p.discovering_files ? '，还在发现文件' : ''
  const eta =
    etaMs !== undefined && Number.isFinite(etaMs) && etaMs > 0
      ? `（约还要 ${etaMs < 60_000 ? `${Math.max(1, Math.round(etaMs / 1000))} 秒` : `${Math.round(etaMs / 60_000)} 分钟`}）`
      : ''
  return `引擎还在扫资产：已处理 ${fmt(p.processed)} / 约 ${fmt(p.total)}${stage}${eta}`
}

/**
 * 轮询 `content.registry_status` 直到 ready。
 *
 * 每一轮都把进度推给界面；`ctx.signal` 一响就停（引擎自己的扫描不受影响，
 * 那本来就不是我们发起的）；进度连续 `stallMs` 没动、或总时长超过 `maxWaitMs`
 * 就放弃并说清楚卡在哪一步 —— 不能让用户对着一句「还在扫」等到天荒地老。
 */
export async function waitForRegistry(
  ctx: ProgressContext | undefined,
  first: RegistryStatus | undefined,
  options: RegistryWaitOptions = {}
): Promise<void> {
  const opts = { ...DEFAULT_WAIT, ...options }
  const startedAt = Date.now()
  let status: RegistryStatus | undefined = first
  let lastProcessed = status?.progress?.processed ?? -1
  let lastMovedAt = startedAt
  let lastSampleAt = startedAt
  let etaMs: number | undefined

  for (;;) {
    if (ctx?.signal?.aborted) {
      throw new Error('已取消：引擎仍在扫描资产，命令没有发出。')
    }
    if (status?.ready) return

    if (status) {
      ctx?.report({ text: describeRegistryProgress(status, etaMs) })
    }

    const now = Date.now()
    if (now - startedAt > opts.maxWaitMs) {
      throw new Error(
        `等了 ${Math.round((now - startedAt) / 60_000)} 分钟引擎还没扫完资产（${describeRegistryProgress(status ?? { ready: false })}）。` +
          '命令没有发出。等编辑器扫完再试，或者用 on_registry_busy=wait 让插件死等。'
      )
    }
    const snapshotAge = status?.progress?.snapshot_age_ms ?? 0
    if (now - lastMovedAt > opts.stallMs || snapshotAge > opts.stallMs) {
      throw new Error(
        `引擎的资产扫描进度已经 ${Math.round(Math.max(now - lastMovedAt, snapshotAge) / 1000)} 秒没动` +
          `（${describeRegistryProgress(status ?? { ready: false })}）。命令没有发出。` +
          '去编辑器看一眼是不是卡住了或者弹了窗。'
      )
    }

    await sleep(opts.pollMs, ctx?.signal)
    if (ctx?.signal?.aborted) {
      throw new Error('已取消：引擎仍在扫描资产，命令没有发出。')
    }

    status = await callUeRaw<RegistryStatus>('content.registry_status', {}, { timeoutMs: 15_000 })

    const processed = status.progress?.processed ?? -1
    const sampledAt = Date.now()
    if (processed !== lastProcessed) {
      const total = status.progress?.total ?? 0
      const rate = (processed - lastProcessed) / Math.max(1, sampledAt - lastSampleAt)
      etaMs = rate > 0 && total > processed ? (total - processed) / rate : undefined
      lastProcessed = processed
      lastMovedAt = sampledAt
    }
    lastSampleAt = sampledAt
  }
}

export interface ReadyCallOptions {
  timeoutMs?: number
  /** 有它才能报进度、响应取消；没有就静默轮询 */
  ctx?: ProgressContext
  wait?: RegistryWaitOptions
}

/**
 * 调一次 UE RPC；插件回 `registry_not_ready` 时等注册表扫完再重发，不当失败。
 * 不把 `ok:false` 当异常（同 `callUeRaw`）。
 */
export async function callUeRawWhenRegistryReady<T>(
  method: string,
  params: Record<string, unknown>,
  options: ReadyCallOptions = {}
): Promise<T> {
  // 中止信号跟着一起往下走：用户按停止时，这两次调用里还没回来的那次
  // 当场作废，等注册表的轮询也会退出（`waitForRegistry` 自己读 ctx.signal）。
  const rpcOptions = {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.ctx?.signal ? { signal: options.ctx.signal } : {})
  }
  let response = await callUeRaw<T>(method, params, rpcOptions)
  // 重发一次就够：扫完了就是扫完了。要是第二次仍然说没扫完，那是插件的判据和
  // 状态命令不一致，让它以错误的形式暴露出来，别在这里绕圈掩盖。
  if (isRegistryNotReady(response)) {
    await waitForRegistry(options.ctx, response.details, options.wait)
    response = await callUeRaw<T>(method, params, rpcOptions)
  }
  return response
}

/** `callUe` 的注册表就绪版：等扫完再发，`ok:false` 仍然抛 */
export async function callUeWhenRegistryReady<T>(
  method: string,
  params: Record<string, unknown>,
  options: ReadyCallOptions = {}
): Promise<T> {
  const response = await callUeRawWhenRegistryReady<T>(method, params, options)
  assertRpcOk(method, response)
  return response
}

// ────────────────────────────────────────────────────────────────────────────
// 工具定义
// ────────────────────────────────────────────────────────────────────────────

export interface UeToolSpec<TIn extends z.ZodTypeAny, TResponse> {
  name: string
  /** 形如 `ue.material`，与 V2 的工具分组对齐 */
  namespace: string
  description: string
  input: TIn
  /** UE 侧的 RPC 方法名，如 `material.create` */
  method: string
  risk?: ToolRisk
  /** 见 `ToolMeta.riskFor`：dry_run 这类只读开关按参数降风险 */
  riskFor?: (args: z.infer<TIn>) => ToolRisk
  concurrency?: 'sequential' | 'parallel'
  timeoutMs?: number
  /** Zod 解析后的参数 → RPC payload。省略则原样透传 */
  toParams?: (args: z.infer<TIn>) => Record<string, unknown>
  /** RPC 响应 → 给模型看的结果。省略则 JSON 序列化整个响应 */
  toOutcome?: (response: TResponse, args: z.infer<TIn>) => ToolOutcome<TResponse>
}

/**
 * 定义一个「一次 RPC 调用」形态的 UE 工具。
 *
 * 一律走注册表就绪版：不读注册表的命令永远不会回 `registry_not_ready`，
 * 对它们这层是零开销；读注册表的命令则自动拿到「等扫完、报进度、可取消」。
 */
export function defineUeTool<TIn extends z.ZodTypeAny, TResponse = unknown>(
  spec: UeToolSpec<TIn, TResponse>
): UnrealAgentTool<TResponse> {
  return defineTool<TIn, TResponse>({
    name: spec.name,
    namespace: spec.namespace,
    description: spec.description,
    input: spec.input,
    risk: spec.risk ?? 'mutating',
    ...(spec.riskFor ? { riskFor: spec.riskFor } : {}),
    concurrency: spec.concurrency ?? 'parallel',
    execute: async (args, ctx) => {
      const params = spec.toParams ? spec.toParams(args) : (args as Record<string, unknown>)
      const response = await callUeWhenRegistryReady<TResponse>(spec.method, params, {
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
        ctx
      })

      if (spec.toOutcome) return spec.toOutcome(response, args)
      return { text: JSON.stringify(response), details: response }
    }
  })
}
