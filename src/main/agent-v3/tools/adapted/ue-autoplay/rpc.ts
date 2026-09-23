/**
 * 机器人对插件的全部调用，收成一个接口。
 *
 * 循环本身（`runner.ts`）只认这个接口，不认 WebSocket —— 测试里换成一个假世界，
 * 整条决策循环就能在没有引擎的情况下跑。真实实现只是把每个方法映射到一条 RPC，
 * 由工具入口用 `serviceManager` 的连接拼出来（那条 import 链不能进纯逻辑文件，
 * 见 AGENTS §7）。
 */

import type {
  InjectResult,
  InputMapInfo,
  MoveRequest,
  MoveStatus,
  NavResult,
  PlanResult,
  Observation,
  SceneSnapshot,
  Vec3
} from './types'

/** 发一条 RPC、拿回原始返回。插件回 4xx/5xx 时返回体里带 `ok:false` 和 `error` */
export type RawCall = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
) => Promise<unknown>

export class BotRpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number
  ) {
    super(message)
    this.name = 'BotRpcError'
  }

  /** 游戏已经不在跑了（插件回 409）。循环据此收尾，而不是当成一次失败的操作 */
  get playEnded(): boolean {
    return this.code === 409 && /not running|没在运行/i.test(this.message)
  }
}

export interface ObserveOptions {
  targets?: string[]
  logSince?: number
  includeWidgets?: boolean
  /** 要不要带以角色为中心的感知（射线、落差、附近 Actor）。每次多十几条射线，默认不带 */
  sensors?: boolean
  /** 感知里「前方」指哪个世界朝向。不给就是此刻的控制器朝向 */
  headingYaw?: number
}

export interface InjectActionParams {
  action: string
  x?: number
  y?: number
  z?: number
  value?: boolean
  frames?: number
}

export interface InjectKeyParams {
  key: string
  frames?: number
  event?: 'tap' | 'press' | 'release'
}

export type NavQuery = { to: Vec3 } | { randomRadius: number }

export interface BotRpc {
  observe(options: ObserveOptions): Promise<Observation>
  setView(yaw: number): Promise<void>
  injectAction(params: InjectActionParams): Promise<InjectResult>
  injectKey(params: InjectKeyParams): Promise<InjectResult>
  click(id: string): Promise<{ text?: string }>
  navPath(query: NavQuery): Promise<NavResult>
  inputMap(): Promise<InputMapInfo>
  stop(reason: string): Promise<void>
  /** 整关的玩法对象。老插件没有这条命令时抛 404 */
  scene(headingYaw: number): Promise<SceneSnapshot>
  /** 连续移动（插件逐帧执行）。可选：没有它时 runner 退回一步一步走 */
  moveTo?(request: MoveRequest): Promise<MoveStatus>
  moveStop?(): Promise<void>
  /** 没有导航网格时的路径规划。可选：没有它时退回局部导航 */
  planPath?(to: Vec3): Promise<PlanResult>
}

const SHORT_TIMEOUT_MS = 10_000

/** 注入要等插件按帧跑完再回。60fps 下 600 帧是 10 秒，失焦节流时更久 */
function injectTimeout(frames: number | undefined): number {
  return Math.max(15_000, (frames ?? 1) * 60 + 15_000)
}

async function callChecked<T>(
  call: RawCall,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const response = (await call(method, params, timeoutMs)) as
    | (Record<string, unknown> & { __rpc?: { code?: number } })
    | null
    | undefined
  if (!response) {
    throw new BotRpcError(`插件没有响应（${method}）`, method)
  }
  if (response.ok === false || response.success === false) {
    const code =
      typeof response.code === 'number'
        ? response.code
        : typeof response.__rpc?.code === 'number'
          ? response.__rpc.code
          : undefined
    throw new BotRpcError(String(response.error ?? `${method} 失败`), method, code)
  }
  return response as T
}

export function createBotRpc(call: RawCall): BotRpc {
  return {
    observe: (options) =>
      callChecked<Observation>(
        call,
        'pie.observe',
        {
          include_widgets: options.includeWidgets ?? true,
          ...(options.targets?.length ? { targets: options.targets } : {}),
          ...(options.logSince !== undefined ? { log_since: options.logSince } : {}),
          ...(options.sensors ? { sensors: true } : {}),
          ...(options.headingYaw !== undefined ? { heading_yaw: options.headingYaw } : {})
        },
        SHORT_TIMEOUT_MS
      ),
    setView: async (yaw) => {
      await callChecked(call, 'pie.set_view', { yaw }, SHORT_TIMEOUT_MS)
    },
    injectAction: (params) =>
      callChecked<InjectResult>(
        call,
        'input.inject_action',
        { ...params },
        injectTimeout(params.frames)
      ),
    injectKey: (params) =>
      callChecked<InjectResult>(
        call,
        'input.inject_key',
        { ...params },
        injectTimeout(params.frames)
      ),
    click: (id) =>
      callChecked<{ text?: string }>(call, 'pie.click_widget', { id }, SHORT_TIMEOUT_MS),
    navPath: (query) =>
      callChecked<NavResult>(
        call,
        'pie.nav_path',
        'to' in query ? { to: query.to } : { random_radius: query.randomRadius },
        SHORT_TIMEOUT_MS
      ),
    inputMap: () => callChecked<InputMapInfo>(call, 'input.map', {}, SHORT_TIMEOUT_MS),
    stop: async (reason) => {
      await callChecked(call, 'pie.stop', { reason }, SHORT_TIMEOUT_MS)
    },
    moveTo: (request) =>
      callChecked<MoveStatus>(call, 'pie.move_to', { ...request }, SHORT_TIMEOUT_MS),
    planPath: (to) => callChecked<PlanResult>(call, 'pie.plan_path', { to }, 20_000),
    moveStop: async () => {
      await callChecked(call, 'pie.move_stop', {}, SHORT_TIMEOUT_MS)
    },
    scene: (headingYaw) =>
      callChecked<SceneSnapshot>(call, 'pie.scene', { heading_yaw: headingYaw }, SHORT_TIMEOUT_MS)
  }
}

/**
 * 等 PIE 真正起来。起来之前 `pie.observe` 会回 409，那不是失败，是还没到。
 * `pie.run` 先回来了（编辑器已在 Play、起不来）就把它的原话交出去。
 *
 * 插件回 404「Unknown method」说明用户装的插件比盒子旧，没有机器人要的那几条命令 ——
 * 这要当场说出来，不能等满 40 秒再报一句「游戏没起来」。
 */
export async function waitForPlay(
  rpc: BotRpc,
  isSettled: () => boolean,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<'ready' | 'not_started' | 'plugin_too_old'> {
  const start = Date.now()
  let waited = 0
  while (Date.now() - start < timeoutMs && waited < timeoutMs) {
    if (isSettled() || signal?.aborted) return 'not_started'
    try {
      const obs = await rpc.observe({ includeWidgets: false })
      // 只认我们自己 pie.run 起的会话：用户自己按的 Play 也会让 observe 成功，
      // 那时 pie.run 马上会回 409，机器人绝不能趁这个空当去操作用户的游戏
      if (obs.playing && obs.session_active) return 'ready'
    } catch (error) {
      if (!(error instanceof BotRpcError)) throw error
      if (error.code === 404 || /unknown method/i.test(error.message)) return 'plugin_too_old'
    }
    await sleep(400)
    waited += 400
  }
  return 'not_started'
}
