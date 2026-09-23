/**
 * 试玩机器人的决策循环。
 *
 * ## 它在哪儿跑
 *
 * 在 `pie.run` 跑着的那段时间里，由盒子这一侧循环：看一眼 → 决定 → 动一下 → 再看。
 * 一步是十几帧（固定步长下约 0.2 秒游戏时间），加上 RPC 往返，
 * 大约每秒做几次宏观决策。模型一轮 2–20 秒，做不了这件事（设计稿 §3）；
 * 这里的决策全是代码里的规则，策略接口留着给以后替换。
 *
 * ## 它证明什么、证明不了什么
 *
 * - 动作层注入**绕开键位映射**；点按钮**绕开命中测试**。所以「走得动、点得开」
 *   说明的是逻辑，不是「玩家按得动、点得到」。摘要里每次都要说。
 * - 探索模式没有断言，**只能说明没崩、没卡死、没掉出世界**（设计稿 §6.1）。
 * - 输入动作「触发了」和「角色动了」分开记（设计稿 §12.8 结尾）。
 *
 * ## 为什么一步一步量，而不是信注入的返回
 *
 * 注入的返回只说明「值塞进去了」。角色有没有动、卡没卡住、掉没掉出去，
 * 只能在注入前后各看一眼、比出来。量之前还要等角色停稳 —— 探针第一版就是把
 * 上一步的刹车惯性量成了这一步的效果，差点得出「注入走不通」的假否定（设计稿 §14 0d 之后那段）。
 */

import { BotRpcError, type BotRpc } from './rpc'
import { diffScenes, playerVars, sceneToNearby } from './scene'
import {
  buildControllerState,
  offerActions,
  perceive,
  rememberedView,
  offerNavSteps,
  dirForBearing,
  moveCaps,
  SAFE_DROP,
  type ActionSpec,
  type ControllerBrain,
  type NavStep,
  type Navigator,
  type KnownActor,
  type HistoryEntry,
  type OfferedAction
} from './controller'
import {
  cellKey,
  dist2d,
  formatVec,
  headingDeg,
  normalizeYaw,
  roundVec,
  CELL_SIZE
} from './geometry'
import { UNSTICK_ORDER, isDeniedButton } from './policy'
import type { TraceSink } from './trace'
import type {
  AutoplayPolicy,
  ButtonInfo,
  Choice,
  DecisionPoint,
  DecisionState,
  InputActionInfo,
  InputMapInfo,
  Observation,
  MoveRequest,
  MoveStatus,
  PawnState,
  SceneSnapshot,
  Vec3
} from './types'

// ---------------------------------------------------------------------------
// 选项与结果
// ---------------------------------------------------------------------------

export interface GoalSpec {
  /** 走到某个 Actor（大纲里的名字）或某个坐标附近 */
  reach?: { actor?: string; location?: Vec3; radius?: number }
  /** 到了之后（没有 reach 就是一开始）按一次这个动作或按键 */
  press?: string
  /** 出现包含这段文字的 PrintString 就算达成 */
  untilLog?: string
}

export interface AutoplayOptions {
  mode: 'explore' | 'goal' | 'objective'
  goal?: GoalSpec
  /** objective 模式：一句自然语言的目标，每一步由 brain 在合法动作里挑 */
  objective?: string
  /** objective 模式的决策者。不给就是规则基线 */
  brain?: ControllerBrain
  /**
   * 没有导航网格（或寻路失败）时，「走到某处」每一步往哪迈由它决定。
   * 不给就走直线、撞了再用固定的几种脱困办法
   */
  navigator?: Navigator
  /** 这次 `pie.run` 的时长（秒）。循环按它倒算自己的截止时间 */
  durationSeconds: number
  /** 一步按住多少帧。固定 60fps 下 12 帧 = 0.2 秒 */
  stepFrames?: number
  /** 探索时每次挑下一个点的半径 */
  exploreRadius?: number
  /** 最多点几次按钮，防止在两个界面之间来回点 */
  maxUiClicks?: number
}

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

export interface AutoplayDeps {
  rpc: BotRpc
  policy: AutoplayPolicy
  trace: TraceSink
  clock?: Clock
  signal?: AbortSignal
  /** `pie.run` 已经回来了（跑满、出错、用户按了 Esc） */
  isSessionOver?: () => boolean
}

export type FindingKind =
  | 'stuck'
  | 'fell_out'
  | 'long_fall'
  | 'respawned'
  | 'pawn_lost'
  | 'error_after_action'
  | 'target_missing'
  | 'unreachable'
  | 'blocked_by_ui'
  | 'no_movement_binding'
  | 'move_input_ignored'
  | 'edge_avoided'

export interface Finding {
  kind: FindingKind
  /** 开跑后第几秒（墙钟，取自插件的 session_elapsed） */
  t?: number
  at?: Vec3
  /** 出事前最后一个动作 */
  after?: string
  detail: string
}

export interface MoveBinding {
  kind: 'action' | 'key'
  name: string
  /** 用哪根轴推「前进」 */
  axis?: 'x' | 'y'
  /** 推这根轴时角色实际走的方向，相对控制器朝向偏了多少度 */
  offset: number
}

export interface JumpBinding {
  kind: 'action' | 'key'
  name: string
}

export interface SweepEntry {
  action: string
  value_type: string
  effects: string[]
  errors: string[]
}

export type AutoplayOutcome =
  | 'goal_reached'
  | 'goal_failed'
  | 'explored'
  | 'no_pawn'
  | 'blocked_by_ui'
  | 'no_movement'
  | 'session_ended'
  | 'objective_done'
  | 'objective_unfinished'

export interface ControllerStats {
  brain: string
  ticks: number
  /** 动作真的由判定模型选的次数（其余是只有一个选项或调用失败走了规则） */
  judgeDecisions: number
  latencyMs: number[]
  confidences: number[]
  /** 局部导航里由判定模型决定的步数 */
  navDecisions?: number
  /** 最后一次「目标完成了吗」的概率 */
  lastDone?: number
  lastProgress?: number
  actionCounts: Record<string, number>
}

export interface AutoplayResult {
  outcome: AutoplayOutcome
  outcomeNote: string
  steps: number
  decisions: number
  move?: MoveBinding
  jump?: JumpBinding
  calibrationNotes: string[]
  inputSource?: 'runtime' | 'asset'
  cellsVisited: number
  distanceTravelled: number
  findings: Finding[]
  sweep: SweepEntry[]
  uiClicks: Array<{ id: string; text: string; reason: string }>
  uiDenied: string[]
  inputWarnings: string[]
  goal?: {
    reached: boolean
    reachedTarget?: boolean
    closestDistance?: number
    pressed?: boolean
    logSeen?: boolean
    targetLabel?: string
  }
  logsDropped: boolean
  controller?: ControllerStats
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_STEP_FRAMES = 12
const DEFAULT_EXPLORE_RADIUS = 2500
const DEFAULT_MAX_UI_CLICKS = 8
/** 这一步走出去不到这么远算「没走动」。一步 12 帧，正常跑速能走 100 以上 */
const STUCK_PROGRESS = 15
/** 连续几步没走动算卡住 */
const STUCK_STEPS = 2
/** 到路点多近算到了 */
const WAYPOINT_REACHED = 100
/** 默认的「到了」半径（到目标 Actor 的水平距离） */
const DEFAULT_REACH_RADIUS = 150
/** 校准时走出多远才算这根轴在推角色 */
const CALIBRATION_MIN_MOVE = 40
/** 离 KillZ 还剩多少就算掉出世界 */
const KILL_Z_MARGIN = 100
/** 连续下落多久（秒）算「一直在掉」—— 没开世界边界检查时 KillZ 不管用，只能靠它 */
const LONG_FALL_SECONDS = 4
/** 前方落差超过这么多（厘米）就不往前走。模板角色从 4 米高掉下来不会死，但多半回不来了 */
const EDGE_DROP = 400
/** 循环比 `pie.run` 的时长提前多久收手，给收尾截图留时间 */
const END_MARGIN_SECONDS = 1.5
const MAX_SWEEP_ACTIONS = 16
const MAX_FINDINGS_PER_KIND = 12

const LOOK_LIKE = /look|mouse|camera|view|aim|turn|视角|镜头|瞄准/i
const MOVE_LIKE = /move|locomot|walk|移动|行走/i
const JUMP_LIKE = /jump|跳/i

/** 机器人自己要停下的信号。不是错误，是「这次到此为止」 */
class StopLoop extends Error {
  constructor(
    readonly outcome: AutoplayOutcome,
    readonly note: string
  ) {
    super(note)
  }
}

// ---------------------------------------------------------------------------

export async function runAutoplay(
  deps: AutoplayDeps,
  options: AutoplayOptions
): Promise<AutoplayResult> {
  const session = new AutoplaySession(deps, options)
  return session.run()
}

class AutoplaySession {
  private readonly rpc: BotRpc
  private readonly policy: AutoplayPolicy
  private readonly trace: TraceSink
  private readonly clock: Clock
  private readonly stepFrames: number

  private obs: Observation | null = null
  private logCursor = 0
  private deadline = Number.POSITIVE_INFINITY
  private lastAction = '（开局）'
  private lastPawn: PawnState | null = null
  private lastPawnName: string | null = null
  private pawnLostReported = false
  private fallingSince: number | null = null
  private recentPrints: string[] = []
  private seenErrors = new Set<string>()
  private readonly visited = new Map<string, number>()
  private readonly triedButtons = new Set<string>()
  private readonly stuckCells = new Set<string>()
  private inputMap: InputMapInfo | null = null
  /** 插件支持 sensors 时每走一小段都探一次前方落差 */
  private edgeProbe = true

  private readonly result: AutoplayResult = {
    outcome: 'explored',
    outcomeNote: '',
    steps: 0,
    decisions: 0,
    calibrationNotes: [],
    cellsVisited: 0,
    distanceTravelled: 0,
    findings: [],
    sweep: [],
    uiClicks: [],
    uiDenied: [],
    inputWarnings: [],
    logsDropped: false
  }

  constructor(
    private readonly deps: AutoplayDeps,
    private readonly options: AutoplayOptions
  ) {
    this.rpc = deps.rpc
    this.policy = deps.policy
    this.trace = deps.trace
    this.clock = deps.clock ?? realClock
    this.stepFrames = Math.max(4, Math.min(60, options.stepFrames ?? DEFAULT_STEP_FRAMES))
    if (options.mode === 'goal' || (options.mode === 'objective' && options.goal?.untilLog)) {
      this.result.goal = {
        reached: false,
        ...(options.goal?.reach?.actor ? { targetLabel: options.goal.reach.actor } : {})
      }
    }
  }

  async run(): Promise<AutoplayResult> {
    this.trace.write({
      type: 'header',
      version: 1,
      mode: this.options.mode,
      goal: this.options.goal ?? null,
      policy: this.policy.name,
      step_frames: this.stepFrames,
      duration_seconds: this.options.durationSeconds
    })

    try {
      await this.waitReady()
      await this.calibrate()
      if (this.options.mode === 'goal') {
        await this.runGoal()
      } else if (this.options.mode === 'objective') {
        await this.runObjective()
      } else {
        await this.runExplore()
      }
    } catch (error) {
      if (error instanceof StopLoop) {
        this.result.outcome = error.outcome
        this.result.outcomeNote = error.note
      } else if (error instanceof BotRpcError && error.playEnded) {
        this.result.outcome = 'session_ended'
        this.result.outcomeNote = '游戏在机器人跑完之前就停了'
      } else {
        throw error
      }
    }

    this.result.cellsVisited = this.visited.size
    this.result.distanceTravelled = Math.round(this.result.distanceTravelled)
    this.trace.write({ type: 'end', outcome: this.result.outcome, note: this.result.outcomeNote })
    return this.result
  }

  // -------------------------------------------------------------------------
  // 感知
  // -------------------------------------------------------------------------

  private checkContinue(): void {
    if (this.deps.signal?.aborted) {
      throw new StopLoop('session_ended', '用户停止了这一轮')
    }
    if (this.deps.isSessionOver?.()) {
      throw new StopLoop('session_ended', '游戏在机器人跑完之前就停了')
    }
  }

  private timeLeft(): number {
    return this.deadline - this.clock.now()
  }

  private outOfTime(): boolean {
    return this.timeLeft() <= 0
  }

  private goalTargets(): string[] | undefined {
    const actor = this.options.goal?.reach?.actor
    return actor ? [actor] : undefined
  }

  private async observe(
    extra: { sensors?: boolean; headingYaw?: number } = {}
  ): Promise<Observation> {
    this.checkContinue()
    const obs = await this.rpc.observe({
      targets: this.goalTargets(),
      logSince: this.logCursor,
      includeWidgets: true,
      ...extra
    })
    this.obs = obs
    if (typeof obs.log_cursor === 'number') this.logCursor = obs.log_cursor
    if (obs.logs_dropped) this.result.logsDropped = true

    this.digestLogs(obs)
    this.trackPawn(obs)
    if (obs.input?.viewport_ignores_input && this.result.inputWarnings.length === 0) {
      // 设计稿 §12.8：这段时间里动作注入照样生效，真人按键却没反应。
      // 机器人走的是动作层，所以它「走得动」在这段时间里不代表玩家走得动
      this.result.inputWarnings.push(
        `第 ${Math.round(obs.session_elapsed ?? 0)} 秒起有一段时间游戏不接受视口输入（菜单一类的界面开着）——` +
          '这段时间里机器人的动作注入照样生效，但真人按键是没反应的'
      )
    }
    return obs
  }

  private digestLogs(obs: Observation): void {
    for (const line of obs.logs ?? []) {
      if (line.kind === 'print') {
        this.recentPrints.push(line.text)
        if (this.recentPrints.length > 8) this.recentPrints.shift()
        const wanted = this.options.goal?.untilLog
        if (wanted && this.result.goal && line.text.includes(wanted)) {
          this.result.goal.logSeen = true
        }
      } else if (line.kind === 'error') {
        // 同一句错误刷一百遍只记一次，但记下**第一次**是在哪个动作之后冒出来的 ——
        // 那就是这份报告里最值钱的一条线索
        const signature = line.text.replace(/\d+/g, '#').slice(0, 160)
        if (this.seenErrors.has(signature)) continue
        this.seenErrors.add(signature)
        this.addFinding({
          kind: 'error_after_action',
          t: line.at,
          ...(this.lastPawn ? { at: roundVec(this.lastPawn.location) } : {}),
          after: this.lastAction,
          detail: line.text
        })
      }
    }
  }

  private trackPawn(obs: Observation): void {
    const pawn = obs.pawn
    const t = obs.session_elapsed
    if (!pawn) {
      if (this.lastPawn && !this.pawnLostReported) {
        this.pawnLostReported = true
        this.addFinding({
          kind: 'pawn_lost',
          t,
          at: roundVec(this.lastPawn.location),
          after: this.lastAction,
          detail: '玩家角色没了（被销毁、死亡等待重生，或被解除控制）'
        })
      }
      return
    }

    if (this.lastPawnName && pawn.name !== this.lastPawnName) {
      this.addFinding({
        kind: 'respawned',
        t,
        ...(this.lastPawn ? { at: roundVec(this.lastPawn.location) } : {}),
        after: this.lastAction,
        detail: `玩家角色换了一个（${this.lastPawnName} → ${pawn.name}），多半是死亡后重生`
      })
    }
    this.pawnLostReported = false

    if (typeof obs.kill_z === 'number' && pawn.location.z < obs.kill_z + KILL_Z_MARGIN) {
      this.addFinding({
        kind: 'fell_out',
        t,
        at: roundVec(pawn.location),
        after: this.lastAction,
        detail: `掉到了 KillZ（${Math.round(obs.kill_z)}）附近 —— 这里多半有个缺口或者地面没碰撞`
      })
    }

    const falling = pawn.is_falling === true || pawn.movement_mode === 'falling'
    const now = this.clock.now()
    if (falling && pawn.velocity.z < -50) {
      this.fallingSince ??= now
      if (now - this.fallingSince > LONG_FALL_SECONDS * 1000) {
        this.addFinding({
          kind: 'long_fall',
          t,
          at: roundVec(pawn.location),
          after: this.lastAction,
          detail: `连续下落超过 ${LONG_FALL_SECONDS} 秒 —— 可能穿过地面掉出了世界（这个关卡没开 KillZ 检查时只能这样判断）`
        })
        this.fallingSince = null
      }
    } else {
      this.fallingSince = null
    }

    if (this.lastPawn && this.lastPawnName === pawn.name) {
      this.result.distanceTravelled += dist2d(this.lastPawn.location, pawn.location)
    }
    const cell = cellKey(pawn.location)
    this.visited.set(cell, (this.visited.get(cell) ?? 0) + 1)

    this.lastPawn = pawn
    this.lastPawnName = pawn.name
  }

  private addFinding(finding: Finding): void {
    const sameKind = this.result.findings.filter((f) => f.kind === finding.kind).length
    if (sameKind >= MAX_FINDINGS_PER_KIND) return
    // 同一个格子里同一类问题只记一次：卡在同一堵墙前十步不是十个问题
    if (finding.at && finding.kind !== 'error_after_action') {
      const key = `${finding.kind}@${cellKey(finding.at)}`
      if (this.stuckCells.has(key)) return
      this.stuckCells.add(key)
    }
    this.result.findings.push(finding)
    this.trace.write({ type: 'finding', ...finding })
  }

  /**
   * 量基线之前先等角色停稳（设计稿 0d 之后「探针自身的缺陷」第 3 条）。
   * 「稳」包括落地：上一步跳起来还没落下，这一步的前后对比就会量到落地
   */
  private async waitStill(maxMs = 1200): Promise<Observation> {
    const start = this.clock.now()
    let obs = await this.observe()
    const moving = (o: Observation): boolean =>
      Boolean(o.pawn && (o.pawn.speed > 10 || o.pawn.is_falling === true))
    while (moving(obs) && this.clock.now() - start < maxMs) {
      await this.clock.sleep(150)
      obs = await this.observe()
    }
    return obs
  }

  private stateFor(obs: Observation | null): DecisionState {
    const pawn = obs?.pawn
    const target = obs?.targets?.[0]
    return {
      mode: this.options.mode,
      ...(pawn ? { location: roundVec(pawn.location), movement_mode: pawn.movement_mode } : {}),
      ...(obs?.control_rotation ? { yaw: Math.round(obs.control_rotation.yaw) } : {}),
      ...(obs?.input ? { input: obs.input } : {}),
      ...(target?.found && target.location
        ? {
            goal: {
              label: target.label || target.name || target.query,
              location: roundVec(target.location),
              ...(typeof target.distance === 'number'
                ? { distance: Math.round(target.distance) }
                : {})
            }
          }
        : {}),
      ...(this.recentPrints.length > 0 ? { recent_prints: [...this.recentPrints] } : {})
    }
  }

  /** 问策略，并把这个决策点连同结果落进 trace */
  private async decide(
    point: DecisionPoint
  ): Promise<{ choice: Choice; record: (outcome: Record<string, unknown>) => void }> {
    const choice = await this.policy.choose(point)
    this.result.decisions++
    const step = this.result.decisions
    const t = this.obs?.session_elapsed
    return {
      choice,
      record: (outcome) =>
        this.trace.write({
          type: 'decision',
          step,
          t,
          kind: point.kind,
          policy: this.policy.name,
          state: point.state,
          options: point.options,
          chosen: choice.optionId,
          reason: choice.reason,
          outcome
        })
    }
  }

  // -------------------------------------------------------------------------
  // 开局
  // -------------------------------------------------------------------------

  private async waitReady(): Promise<void> {
    const start = this.clock.now()
    let obs = await this.observe()
    // 20 秒：大关卡加载、开场过场都要时间，但一直等不到就说明真的没有可控角色
    while (!(obs.pawn && obs.has_controller) && this.clock.now() - start < 20_000) {
      if (await this.handleUi(obs)) {
        obs = await this.observe()
        continue
      }
      await this.clock.sleep(300)
      obs = await this.observe()
    }

    const elapsed = obs.session_elapsed ?? 0
    this.deadline =
      this.clock.now() + (this.options.durationSeconds - elapsed - END_MARGIN_SECONDS) * 1000

    if (!obs.pawn) {
      throw new StopLoop(
        'no_pawn',
        '等了 20 秒也没有可操作的玩家角色 —— 关卡里可能没有 PlayerStart、GameMode 没生成 Pawn，' +
          '或者这个工程本来就没有可控角色（展示类项目常见）'
      )
    }

    // 开局可能还在往下掉（出生点悬空、World Partition 还在流送地面）
    const groundStart = this.clock.now()
    while (obs.pawn?.is_falling && this.clock.now() - groundStart < 3000) {
      await this.clock.sleep(200)
      obs = await this.observe()
    }
    this.trace.write({
      type: 'ready',
      t: obs.session_elapsed,
      pawn: obs.pawn
        ? { name: obs.pawn.name, class: obs.pawn.class, at: roundVec(obs.pawn.location) }
        : null,
      input: obs.input ?? null
    })
  }

  // -------------------------------------------------------------------------
  // 界面
  // -------------------------------------------------------------------------

  private uiBlocking(obs: Observation): boolean {
    if (!obs.buttons || obs.buttons.length === 0) return false
    return Boolean(obs.input?.viewport_ignores_input || obs.input?.show_mouse_cursor || obs.paused)
  }

  /**
   * 屏幕上有按钮挡着时，让策略挑一个点。点了回 true。
   *
   * 挑不出来（全被拦、目标模式没有「开始」、点满了）而视口又不吃输入时，
   * 机器人就卡在这个界面上了 —— 这时继续注入移动只会得到 §12.8 那种
   * 「注入成功、玩家按不动」的假结论，所以直接收手。
   */
  private async handleUi(obs: Observation): Promise<boolean> {
    if (!this.uiBlocking(obs)) return false
    const buttons = obs.buttons ?? []

    if (this.result.uiClicks.length >= (this.options.maxUiClicks ?? DEFAULT_MAX_UI_CLICKS)) {
      return this.stuckInUi(buttons, `已经点了 ${this.result.uiClicks.length} 次按钮，还在界面里`)
    }

    const point: DecisionPoint = {
      kind: 'ui',
      state: { ...this.stateFor(obs), tried: [...this.triedButtons] },
      options: buttons.map((button) => ({
        id: button.id,
        label: button.text,
        features: {
          enabled: button.enabled,
          denied: isDeniedButton(button.text),
          owner: button.owner
        }
      }))
    }
    for (const button of buttons) {
      if (isDeniedButton(button.text) && !this.result.uiDenied.includes(button.text)) {
        this.result.uiDenied.push(button.text)
      }
    }

    const { choice, record } = await this.decide(point)
    if (!choice.optionId) {
      record({ clicked: null })
      return this.stuckInUi(buttons, choice.reason)
    }

    const button = buttons.find((b) => b.id === choice.optionId)
    const label = button?.text || choice.optionId
    this.triedButtons.add(choice.optionId)
    try {
      await this.rpc.click(choice.optionId)
    } catch (error) {
      if (error instanceof BotRpcError && error.playEnded) throw error
      record({
        clicked: choice.optionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
    this.lastAction = `点击按钮「${label}」`
    this.result.uiClicks.push({ id: choice.optionId, text: label, reason: choice.reason })
    this.result.steps++

    await this.clock.sleep(500)
    const after = await this.observe()
    record({
      clicked: choice.optionId,
      buttons_after: (after.buttons ?? []).map((b) => b.text || b.id),
      input_after: after.input ?? null
    })
    return true
  }

  private stuckInUi(buttons: ButtonInfo[], reason: string): boolean {
    const ignoring = this.obs?.input?.viewport_ignores_input === true
    if (!ignoring) {
      // 有按钮但视口还收输入（比如一直挂着的 HUD 按钮），不算被挡住
      return false
    }
    const labels = buttons.map((b) => b.text || b.id).join('、')
    this.addFinding({
      kind: 'blocked_by_ui',
      t: this.obs?.session_elapsed,
      after: this.lastAction,
      detail: `卡在一个界面上：${reason}。屏幕上的按钮：${labels}`
    })
    throw new StopLoop('blocked_by_ui', `卡在界面上出不去（${reason}）`)
  }

  // -------------------------------------------------------------------------
  // 校准：哪根轴是「前进」、哪个动作是「跳」
  // -------------------------------------------------------------------------

  private async calibrate(): Promise<void> {
    try {
      this.inputMap = await this.rpc.inputMap()
      this.result.inputSource = this.inputMap.source
      if (this.inputMap.source !== 'runtime') {
        this.result.calibrationNotes.push('读到的是工程里定义的映射，不是运行时真实挂着的那套')
      }
    } catch (error) {
      if (error instanceof BotRpcError && error.playEnded) throw error
      this.result.calibrationNotes.push(
        `读输入映射失败：${error instanceof Error ? error.message : String(error)}`
      )
      this.inputMap = { source: 'asset', input_system: 'none', actions: [] }
    }

    const axes = this.inputMap.actions.filter((a) => a.value_type === 'Axis2D')
    const ordered = [
      ...axes.filter((a) => MOVE_LIKE.test(a.name)),
      ...axes.filter((a) => !MOVE_LIKE.test(a.name) && !LOOK_LIKE.test(a.name))
    ].slice(0, 4)

    for (const action of ordered) {
      for (const axis of ['y', 'x'] as const) {
        const offset = await this.measureMove({ kind: 'action', name: action.name, axis })
        if (offset !== null) {
          this.result.move = { kind: 'action', name: action.name, axis, offset }
          break
        }
      }
      if (this.result.move) break
    }

    // 没有 Enhanced Input 的移动动作（旧输入系统工程）就按真键试 W
    if (!this.result.move) {
      const offset = await this.measureMove({ kind: 'key', name: 'W' })
      if (offset !== null) this.result.move = { kind: 'key', name: 'W', offset }
    }

    if (!this.result.move) {
      this.addFinding({
        kind: 'no_movement_binding',
        t: this.obs?.session_elapsed,
        detail:
          `试了 ${ordered.map((a) => a.name).join('、') || '（没有 Axis2D 动作）'} 和 W 键，角色都没走动。` +
          '可能是这个角色本来就不靠这些输入移动（载具、点击移动、GAS 技能驱动），也可能是移动被逻辑锁住了'
      })
    }

    const jumpCandidates = this.inputMap.actions.filter(
      (a) => a.value_type === 'Boolean' && JUMP_LIKE.test(a.name)
    )
    for (const action of jumpCandidates.slice(0, 2)) {
      if (await this.measureJump({ kind: 'action', name: action.name })) {
        this.result.jump = { kind: 'action', name: action.name }
        break
      }
    }
    if (!this.result.jump && (await this.measureJump({ kind: 'key', name: 'SpaceBar' }))) {
      this.result.jump = { kind: 'key', name: 'SpaceBar' }
    }

    this.trace.write({
      type: 'calibration',
      move: this.result.move ?? null,
      jump: this.result.jump ?? null,
      notes: this.result.calibrationNotes
    })
  }

  /** 推一次，看角色往哪走。返回相对控制器朝向的偏角；没走动回 null */
  private async measureMove(binding: {
    kind: 'action' | 'key'
    name: string
    axis?: 'x' | 'y'
  }): Promise<number | null> {
    const before = await this.waitStill()
    if (!before.pawn) return null
    const yaw = before.control_rotation?.yaw ?? before.pawn.rotation.yaw
    const label =
      binding.kind === 'action' ? `${binding.name}（${binding.axis}=1）` : `按键 ${binding.name}`
    this.lastAction = `校准移动：${label}`
    try {
      if (binding.kind === 'action') {
        await this.rpc.injectAction({
          action: binding.name,
          ...(binding.axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 }),
          frames: this.stepFrames * 2
        })
      } else {
        await this.rpc.injectKey({ key: binding.name, frames: this.stepFrames * 2 })
      }
    } catch (error) {
      if (error instanceof BotRpcError && error.playEnded) throw error
      this.result.calibrationNotes.push(
        `${label} 注入失败：${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
    this.result.steps++
    const after = await this.observe()
    if (!after.pawn || !before.pawn) return null
    const moved = dist2d(before.pawn.location, after.pawn.location)
    this.trace.write({ type: 'calibration_try', binding, moved: Math.round(moved) })
    if (moved < CALIBRATION_MIN_MOVE) return null
    return normalizeYaw(headingDeg(before.pawn.location, after.pawn.location) - yaw)
  }

  private async measureJump(binding: JumpBinding): Promise<boolean> {
    const before = await this.waitStill()
    if (!before.pawn || before.pawn.is_falling) return false
    this.lastAction = `校准跳跃：${binding.kind === 'action' ? binding.name : `按键 ${binding.name}`}`
    try {
      await this.pressBinding(binding, 6)
    } catch (error) {
      if (error instanceof BotRpcError && error.playEnded) throw error
      return false
    }
    this.result.steps++
    const after = await this.observe()
    const jumped = Boolean(
      after.pawn &&
        (after.pawn.velocity.z > 50 ||
          after.pawn.is_falling === true ||
          after.pawn.location.z - before.pawn.location.z > 20)
    )
    this.trace.write({ type: 'calibration_try', binding, jumped })
    return jumped
  }

  private async pressBinding(
    binding: { kind: 'action' | 'key'; name: string },
    frames: number
  ): Promise<void> {
    if (binding.kind === 'action') {
      await this.rpc.injectAction({ action: binding.name, value: true, frames })
    } else {
      await this.rpc.injectKey({ key: binding.name, frames })
    }
  }

  // -------------------------------------------------------------------------
  // 移动
  // -------------------------------------------------------------------------

  /** 朝某个世界朝向走一步 */
  /**
   * 朝某个世界朝向走一段。回 false = 走到一半发现前面是悬崖，停下了。
   *
   * 防坠落放在这一层，所有走法（走向物件、八方向移动、脱困让位）都过这里。
   * 每次只走一小段（`stepFrames` 帧，约 1 米），走之前用插件的落差探测看一眼正前方 ——
   * 那个探测看的是前方约 1.4 米，一段 1 米加上刹车滑行仍然在它前面。
   * 一口气按住几米再看的话，边缘在 1.5 米外时探测说「有地」，按下去就掉下去了。
   *
   * 插件没有 sensors（老版本）时照常走，没有这层保护。
   */
  private async stepToward(
    yaw: number,
    label: string,
    frames = this.stepFrames,
    allowDrop = false
  ): Promise<boolean> {
    const move = this.result.move
    if (!move) return false
    await this.rpc.setView(normalizeYaw(yaw - move.offset))
    this.lastAction = label
    let left = frames
    while (left > 0) {
      if (!allowDrop && (await this.edgeAhead(yaw))) {
        this.addFinding({
          kind: 'edge_avoided',
          t: this.obs?.session_elapsed,
          ...(this.obs?.pawn ? { at: roundVec(this.obs.pawn.location) } : {}),
          after: label,
          detail: '前方是悬崖或大落差，没往前走 —— 这里的边缘没有护栏'
        })
        return false
      }
      const chunk = Math.min(left, this.stepFrames)
      if (move.kind === 'action') {
        await this.rpc.injectAction({
          action: move.name,
          ...(move.axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 }),
          frames: chunk
        })
      } else {
        await this.rpc.injectKey({ key: move.name, frames: chunk })
      }
      left -= chunk
    }
    this.result.steps++
    return true
  }

  /** 插件支持 pie.move_to 时，所有「走到某处」都交给它逐帧连续执行 */
  private continuous = true

  /**
   * 连续移动：发一串路径点给插件，然后每 ~150ms 看一眼进度，直到它结束。
   * 途中不做任何决策 —— 角色一直在走；只有结束（到了 / 被挡 / 边缘 / 超时）才回来。
   * 插件太旧没有这条命令时回 null，调用方退回一步一步走。
   */
  private async moveContinuous(request: MoveRequest): Promise<MoveStatus | null> {
    if (!this.continuous || !this.rpc.moveTo) return null
    try {
      await this.rpc.moveTo(request)
    } catch (error) {
      if (error instanceof BotRpcError && error.playEnded) throw error
      this.continuous = false
      this.result.calibrationNotes.push(
        '插件没有 pie.move_to（版本旧），移动是一段一段走的，看起来会一顿一顿'
      )
      return null
    }
    this.result.steps++
    for (;;) {
      if (this.outOfTime()) {
        await this.rpc.moveStop?.().catch(() => undefined)
        return {
          active: false,
          status: 'timeout',
          index: 0,
          points: 0,
          travelled: 0,
          jumps: 0,
          elapsed: 0
        }
      }
      await this.clock.sleep(150)
      const obs = await this.observe()
      const move = obs.move
      if (!move) {
        this.continuous = false
        return null
      }
      if (!move.active) {
        this.trace.write({
          type: 'move',
          status: move.status,
          detail: move.detail ?? null,
          travelled: Math.round(move.travelled),
          jumps: move.jumps,
          events: move.events ?? []
        })
        if (move.status === 'edge') {
          this.addFinding({
            kind: 'edge_avoided',
            t: obs.session_elapsed,
            ...(obs.pawn ? { at: roundVec(obs.pawn.location) } : {}),
            after: this.lastAction,
            detail: `连续移动在边缘刹住了（${move.detail ?? '前方没有地'}）—— 这里的边缘没有护栏`
          })
        }
        return move
      }
    }
  }

  /** 插件支持 pie.plan_path 时，没有导航网格也能规划路线 */
  private planner = true

  /**
   * 规划 → 连续走 → 被挡了再规划，最多三轮。
   *
   * 回 'reached' / 'timeout'；其他情况（规划器不支持、到不了、三轮都被挡）回 'unplanned'，
   * 调用方接着用局部导航或者老办法。
   */
  private async followPlannedPath(
    resolve: () => Vec3 | undefined,
    acceptRadius: number,
    label: string
  ): Promise<'reached' | 'timeout' | 'unplanned'> {
    if (!this.planner || !this.rpc.planPath || !this.continuous || !this.rpc.moveTo)
      return 'unplanned'
    for (let round = 0; round < 3; round++) {
      if (this.outOfTime()) return 'timeout'
      const goal = resolve()
      if (!goal) return 'unplanned'
      let plan
      try {
        plan = await this.rpc.planPath(goal)
      } catch (error) {
        if (error instanceof BotRpcError && error.playEnded) throw error
        this.planner = false
        return 'unplanned'
      }
      this.trace.write({
        type: 'plan',
        target: label,
        found: plan.found,
        partial: plan.partial,
        points: plan.points.length,
        length: Math.round(plan.length),
        jumps: plan.jumps,
        ms: Math.round(plan.ms),
        walkable: plan.walkable,
        start_floor: plan.start_floor,
        goal_floor: plan.goal_floor,
        goal_walkable: plan.goal_walkable,
        // 原始格子路线只留高度变化处，排查「在哪一级断的」够用，trace 也不会太大
        raw: (plan.raw ?? []).filter(
          (c, i, all) =>
            i === 0 || i === all.length - 1 || c.link === 2 || Math.abs(c.z - all[i - 1].z) > 5
        )
      })
      if (plan.points.length === 0) return 'unplanned'
      const status = await this.moveContinuous({
        points: plan.points,
        final_radius: plan.found ? acceptRadius : 120,
        accept_radius: 110,
        auto_jump: true,
        max_seconds: 30
      })
      if (!status) return 'unplanned'
      if (status.status === 'timeout') return 'timeout'
      const pawn = this.obs?.pawn
      if (plan.found && pawn && dist2d(pawn.location, goal) <= acceptRadius + 50) return 'reached'
      if (status.status === 'reached' && plan.found) return 'reached'
      if (!plan.found) {
        // 规划器说到不了：走到了离它最近的地方，剩下的交给局部导航 / 组合动作
        this.addFinding({
          kind: 'unreachable',
          t: this.obs?.session_elapsed,
          ...(pawn ? { at: roundVec(pawn.location) } : {}),
          after: this.lastAction,
          detail: `按地形规划不出走到 ${label} 的路（没有地、墙挡着或者台阶太高），先走到了离它最近的地方`
        })
        return 'unplanned'
      }
    }
    return 'unplanned'
  }

  /** 从 heading 朝某个相对角度走 meters 米之外的一个点 */
  private pointToward(from: Vec3, yaw: number, meters: number): Vec3 {
    const rad = (yaw * Math.PI) / 180
    return {
      x: from.x + Math.cos(rad) * meters * 100,
      y: from.y + Math.sin(rad) * meters * 100,
      z: from.z
    }
  }

  /** 按住「前进」若干帧，不做落差检查（组合动作自己管时机）。返回注入的 Promise */
  private injectMove(frames: number): Promise<unknown> {
    const move = this.result.move
    if (!move) return Promise.resolve()
    return move.kind === 'action'
      ? this.rpc.injectAction({
          action: move.name,
          ...(move.axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 }),
          frames
        })
      : this.rpc.injectKey({ key: move.name, frames })
  }

  /**
   * 执行一个带方向的动作。回 false = 因为前面是悬崖停下了。
   *
   * 组合动作的要点是**边走边跳**：原地起跳时空中控制很弱（模板角色 AirControl 0.35），
   * 跳起来基本落回原地。所以都是先走几帧起速，再在移动还在按着的时候起跳。
   */
  private async performMove(
    spec: Extract<ActionSpec, { angle: number }>,
    heading: number,
    label: string,
    frames: number
  ): Promise<boolean> {
    const move = this.result.move
    if (!move) return false
    const yaw = normalizeYaw(heading + spec.angle)
    this.lastAction = label
    const from = this.obs?.pawn?.location
    if (from && this.continuous && this.rpc.moveTo) {
      // 连续执行：走向那个方向几米外的一个点，插件逐帧处理起跳、跨沟、边缘刹停。
      // 每种组合动作对应一组开关，判定模型选的是哪种，这里就开哪种
      const meters = Math.max(2, (frames / 60) * 5)
      const status = await this.moveContinuous({
        points: [this.pointToward(from, yaw, spec.kind === 'run_jump' ? meters + 3 : meters)],
        final_radius: 60,
        max_seconds: 6,
        auto_jump: spec.kind !== 'move' && spec.kind !== 'drop_down',
        jump_gaps: spec.kind === 'run_jump',
        stop_at_edge: spec.kind !== 'drop_down',
        ...(spec.kind === 'drop_down' ? { edge_drop: SAFE_DROP } : {})
      })
      if (status) return status.status !== 'edge'
    }
    switch (spec.kind) {
      case 'move':
        return this.stepToward(yaw, label, frames)
      case 'drop_down':
        // 主动跳下：下面探测得到地面，落差在安全范围内 —— 跳过落差检查
        return this.stepToward(yaw, label, frames, true)
      case 'jump_move': {
        await this.rpc.setView(normalizeYaw(yaw - move.offset))
        await this.injectMove(6)
        const hop = this.jump()
        await this.injectMove(Math.max(frames, 24))
        await hop
        this.result.steps++
        return true
      }
      case 'double_jump': {
        await this.rpc.setView(normalizeYaw(yaw - move.offset))
        await this.injectMove(6)
        const moving = this.injectMove(Math.max(frames, 40))
        await this.jump()
        // 第二跳要在上升段里按：太早引擎当成同一次，太晚已经在往下掉
        await this.clock.sleep(180)
        await this.jump()
        await moving
        this.result.steps++
        return true
      }
      case 'run_jump':
        return this.runningJump(yaw, label)
    }
  }

  /**
   * 助跑跳：后退一步拉开助跑距离 → 朝沟冲 → 边缘进入落差探测范围时起跳，
   * 空中继续按住前进。
   *
   * 起跳时机靠边跑边看：每 ~50ms 看一次正前方落差，一出现就跳。RPC 往返的延迟
   * 相当于晚跳十几二十厘米，所以能不能跳过的判断（maneuversFor）打了七五折。
   */
  private async runningJump(yaw: number, label: string): Promise<boolean> {
    const move = this.result.move
    if (!move) return false
    // 后退一段拉开助跑距离（后退本身也过落差检查）
    await this.stepToward(normalizeYaw(yaw + 180), `${label}（后退助跑）`, this.stepFrames)
    await this.rpc.setView(normalizeYaw(yaw - move.offset))
    const startZ = this.obs?.pawn?.location.z
    let finished = false
    const run = this.injectMove(150).finally(() => {
      finished = true
    })
    let jumped = false
    for (let i = 0; i < 60 && !finished; i++) {
      const obs = await this.observe({ sensors: true, headingYaw: yaw })
      const front = obs.sensors?.rays.find((ray) => Math.round(ray.angle) === 0)
      if (front?.drop !== undefined && (front.drop < 0 || front.drop > EDGE_DROP / 2)) {
        await this.jump()
        jumped = true
        break
      }
    }
    await run
    this.result.steps++
    const endZ = (await this.observe()).pawn?.location.z
    if (startZ !== undefined && endZ !== undefined && endZ < startZ - 300) {
      this.addFinding({
        kind: 'fell_out',
        t: this.obs?.session_elapsed,
        ...(this.obs?.pawn ? { at: roundVec(this.obs.pawn.location) } : {}),
        after: label,
        detail: `助跑跳没跳过去，掉下去了约 ${Math.round((startZ - endZ) / 100)} 米${jumped ? '' : '（没等到起跳时机）'}`
      })
    }
    return jumped
  }

  /** 朝 yaw 方向正前方是不是悬崖 / 大落差（插件的 sensors 落差探测） */
  private async edgeAhead(yaw: number): Promise<boolean> {
    if (!this.edgeProbe) return false
    const obs = await this.observe({ sensors: true, headingYaw: yaw })
    if (!obs.sensors) {
      this.edgeProbe = false
      return false
    }
    const front = obs.sensors.rays.find((ray) => Math.round(ray.angle) === 0)
    return front?.drop !== undefined && (front.drop < 0 || front.drop > EDGE_DROP)
  }

  private async jump(): Promise<void> {
    if (!this.result.jump) return
    this.lastAction = '跳'
    await this.pressBinding(this.result.jump, 6)
    this.result.steps++
  }

  /** 拿一条到目标的路。没有导航网格或者寻不到路就走直线 */
  private async planPath(target: Vec3): Promise<{ points: Vec3[]; note: string }> {
    try {
      const nav = await this.rpc.navPath({ to: target })
      if (nav.has_navmesh && nav.found && nav.points && nav.points.length > 0) {
        return {
          points: nav.points.slice(1).length > 0 ? nav.points.slice(1) : [target],
          note: nav.is_partial ? 'partial_path' : 'navmesh'
        }
      }
      return { points: [target], note: nav.has_navmesh ? 'no_path_found' : 'no_navmesh' }
    } catch (error) {
      if (error instanceof BotRpcError && error.playEnded) throw error
      return { points: [target], note: 'nav_query_failed' }
    }
  }

  /**
   * 沿路走到目标附近。
   *
   * 每一步前后各看一眼：没走出去 `STUCK_PROGRESS` 就记一次没进展，
   * 连续 `STUCK_STEPS` 次算卡住，交给策略挑脱困方式。脱困方式都试完了还卡着，
   * 就记下卡住的位置、放弃这个目标。
   */
  private async walkTo(
    target: Vec3 | (() => Vec3 | undefined),
    acceptRadius: number,
    label: string,
    maxSteps: number,
    frames: number = this.stepFrames
  ): Promise<'reached' | 'stuck' | 'timeout' | 'no_target'> {
    const resolve = (): Vec3 | undefined => (typeof target === 'function' ? target() : target)
    let goal = resolve()
    if (!goal) return 'no_target'

    let { points, note } = await this.planPath(goal)
    // 导航网格给出了路线：整条交给插件连续走，不再一米一停
    if (note === 'navmesh' || note === 'partial_path') {
      const status = await this.moveContinuous({
        points,
        final_radius: acceptRadius,
        auto_jump: true,
        max_seconds: 25
      })
      if (status) {
        if (status.status === 'reached') return 'reached'
        if (status.status === 'timeout') return 'timeout'
        // blocked / edge：下面按老办法（或局部导航）接着处理
      }
    }
    // 导航网格走不通（没有、找不到、只有半截、走到一半被挡）时，让插件铺网格规划一条路：
    // 它按角色真实的迈步 / 跳跃能力算，能上导航网格认为「太高」的台阶 ——
    // 虚幻导航网格默认迈步 35 厘米，50~80 厘米的台阶在它眼里是断的，玩家却跳得上去。
    // 走到一半被挡住就从新位置再规划。规划器说根本到不了，才交给局部导航去摸索
    {
      const planned = await this.followPlannedPath(resolve, acceptRadius, label)
      if (planned === 'reached' || planned === 'timeout') return planned
    }
    // 没有可用路线：交给局部导航一步一步绕（给了 navigator 的话）
    if (
      this.options.navigator &&
      (note === 'no_navmesh' || note === 'no_path_found' || note === 'nav_query_failed')
    ) {
      return this.navigateTo(resolve, acceptRadius, label, maxSteps)
    }
    let noProgress = 0
    const triedUnstick = new Set<string>()

    for (let i = 0; i < maxSteps; i++) {
      if (this.outOfTime()) return 'timeout'
      let obs = await this.observe()
      if (await this.handleUi(obs)) continue
      obs = this.obs ?? obs
      const pawn = obs.pawn
      if (!pawn) {
        await this.clock.sleep(300)
        continue
      }

      goal = resolve() ?? goal
      const distance = dist2d(pawn.location, goal)
      if (this.result.goal && this.options.mode === 'goal') {
        const prev = this.result.goal.closestDistance
        this.result.goal.closestDistance =
          prev === undefined ? Math.round(distance) : Math.min(prev, Math.round(distance))
      }
      if (distance <= acceptRadius) return 'reached'

      if (obs.input?.move_input_ignored) {
        this.addFinding({
          kind: 'move_input_ignored',
          t: obs.session_elapsed,
          at: roundVec(pawn.location),
          after: this.lastAction,
          detail:
            '游戏正在忽略移动输入（过场、剧情常见）—— 这时角色不动是游戏的正确行为，机器人等它结束'
        })
        await this.clock.sleep(500)
        continue
      }

      while (points.length > 1 && dist2d(pawn.location, points[0]) < WAYPOINT_REACHED)
        points.shift()
      const waypoint = points[0] ?? goal
      const before = pawn.location
      await this.stepToward(headingDeg(before, waypoint), `朝 ${label} 走`, frames)
      const after = (await this.observe()).pawn
      if (!after) continue
      const progress = dist2d(before, after.location)

      if (progress >= STUCK_PROGRESS) {
        noProgress = 0
        triedUnstick.clear()
        continue
      }
      noProgress++
      if (noProgress < STUCK_STEPS) continue

      // 卡住了
      this.addFinding({
        kind: 'stuck',
        t: this.obs?.session_elapsed,
        at: roundVec(after.location),
        after: this.lastAction,
        detail: `朝 ${label} 走时原地不动（路线：${note}）`
      })
      const point: DecisionPoint = {
        kind: 'unstick',
        state: this.stateFor(this.obs),
        options: UNSTICK_ORDER.map((id) => ({
          id,
          label: UNSTICK_LABELS[id],
          features: {
            tried: triedUnstick.has(id),
            available: id === 'jump_forward' ? Boolean(this.result.jump) : true
          }
        }))
      }
      const { choice, record } = await this.decide(point)
      if (!choice.optionId) {
        record({ gave_up: true })
        return 'stuck'
      }
      triedUnstick.add(choice.optionId)
      const heading = headingDeg(after.location, waypoint)
      const beforeUnstick = after.location
      if (choice.optionId === 'replan') {
        ;({ points, note } = await this.planPath(goal))
      } else {
        await this.unstick(choice.optionId, heading)
      }
      noProgress = 0
      const settled = (await this.observe()).pawn
      record({
        moved: settled ? Math.round(dist2d(beforeUnstick, settled.location)) : null
      })
    }
    return 'timeout'
  }

  /** 局部导航用的朝向：objective 模式里就是整局固定的那个「罗盘」 */
  private navHeading: number | null = null

  /**
   * 没有路线时，一步一步走向目标：每一步看八个方向哪里通、目标在哪边、
   * 最近几步走得怎么样，由 navigator 挑下一步。
   *
   * 悬崖方向根本不提供；落差检查在 stepToward 里兜底。
   * 连续六步离目标没有更近就算卡住，交还给上层（上层会换目标或换办法）。
   */
  private async navigateTo(
    resolve: () => Vec3 | undefined,
    acceptRadius: number,
    label: string,
    maxSteps: number
  ): Promise<'reached' | 'stuck' | 'timeout' | 'no_target'> {
    const navigator = this.options.navigator
    if (!navigator) return 'stuck'
    const heading = this.navHeading ?? this.obs?.control_rotation?.yaw ?? 0
    const steps: NavStep[] = []
    let best = Infinity
    let sinceBest = 0
    let tryDirect = true

    for (let i = 0; i < maxSteps; i++) {
      if (this.outOfTime()) return 'timeout'
      const obs = await this.observe({ sensors: true, headingYaw: heading })
      const pawn = obs.pawn
      const goal = resolve()
      if (!goal) return 'no_target'
      if (!pawn || !obs.sensors) {
        await this.clock.sleep(300)
        continue
      }
      const distance = dist2d(pawn.location, goal)
      if (distance <= acceptRadius) return 'reached'
      if (distance < best - 30) {
        best = distance
        sinceBest = 0
      } else if (++sinceBest >= 6) {
        this.addFinding({
          kind: 'stuck',
          t: obs.session_elapsed,
          at: roundVec(pawn.location),
          after: this.lastAction,
          detail: `绕障碍走向 ${label} 时连续六步没有更近（局部导航：${navigator.name}）`
        })
        return 'stuck'
      }

      // 能连续走就先径直走过去：插件边走边处理矮障碍和边缘，被挡住才回来问往哪绕。
      // 这样只有「绕」的时候才花判定调用，其余时间角色一直在连贯地走
      if (tryDirect && this.continuous && this.rpc.moveTo) {
        tryDirect = false
        const status = await this.moveContinuous({
          points: [goal],
          final_radius: acceptRadius,
          auto_jump: true,
          max_seconds: 12
        })
        if (status) {
          if (status.status === 'reached') return 'reached'
          const now = this.obs?.pawn?.location ?? pawn.location
          steps.push({
            action: 'walk straight toward the target',
            result: `${status.status === 'edge' ? 'stopped at an edge' : 'got blocked'} after ${(status.travelled / 100).toFixed(1)} m (now ~${Math.round(dist2d(now, goal) / 100)} m away)`
          })
          continue
        }
      }
      const bearing = normalizeYaw(headingDeg(pawn.location, goal) - heading)
      const view = perceive(obs.sensors, pawn.location, (p) => this.visited.get(cellKey(p)) ?? 0)
      const offered = offerNavSteps(
        view.directions,
        bearing,
        Boolean(this.result.jump),
        moveCaps(obs.sensors, Boolean(this.result.jump))
      )
      if (offered.length === 0) return 'stuck'

      const decision = await navigator.decide({
        target: { name: label, where: dirForBearing(bearing), meters: distance / 100 },
        bearing,
        directions: view.directions,
        offered,
        steps
      })
      const stats = this.result.controller
      if (stats && decision.source === 'judge') stats.navDecisions = (stats.navDecisions ?? 0) + 1
      if (stats && decision.ms !== undefined) stats.latencyMs.push(decision.ms)

      const action = offered.find((o) => o.id === decision.actionId) ?? offered[0]
      const spec = action.spec
      if (!isDirectional(spec)) return 'stuck'
      const went = await this.performMove(spec, heading, `绕行 ${action.id}`, this.stepFrames * 2)
      const after = (await this.observe()).pawn
      const moved = after ? dist2d(pawn.location, after.location) : 0
      const now = after ? dist2d(after.location, goal) : distance
      const result = !went
        ? 'stopped: a drop ahead'
        : moved < STUCK_PROGRESS
          ? 'blocked, did not move'
          : `moved ${(moved / 100).toFixed(1)} m, ${now < distance - 30 ? 'closer to' : now > distance + 30 ? 'farther from' : 'no closer to'} the target (now ~${Math.round(now / 100)} m)`
      steps.push({ action: action.id, result })
      // 绕开了（这一步有明显进展）就再试一次径直走过去
      if (went && moved >= STUCK_PROGRESS) tryDirect = true
      this.trace.write({
        type: 'nav_step',
        target: label,
        navigator: navigator.name,
        bearing: Math.round(bearing),
        offered: offered.map((o) => ({ id: o.id, description: o.description })),
        chosen: action.id,
        source: decision.source,
        ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        ...(decision.ms !== undefined ? { ms: decision.ms } : {}),
        result
      })
    }
    return 'timeout'
  }

  private async unstick(option: string, heading: number): Promise<void> {
    switch (option) {
      case 'jump_forward':
        await this.jump()
        await this.stepToward(heading, '跳着往前')
        break
      case 'strafe_left':
        await this.stepToward(heading - 90, '往左让开', this.stepFrames * 2)
        break
      case 'strafe_right':
        await this.stepToward(heading + 90, '往右让开', this.stepFrames * 2)
        break
      case 'back_off':
        await this.stepToward(heading + 180, '后退', this.stepFrames * 2)
        break
    }
  }

  // -------------------------------------------------------------------------
  // 探索模式
  // -------------------------------------------------------------------------

  private async runExplore(): Promise<void> {
    await this.sweepInputs()
    if (!this.result.move) {
      throw new StopLoop('no_movement', '找不到能让角色走动的输入，按键扫了一遍就结束')
    }
    await this.exploreLoop(() => false)
    this.result.outcome = 'explored'
    this.result.outcomeNote = '探索到时间用完'
  }

  /** 挑一个没去过的点走过去，反复，直到 done() 或时间用完 */
  private async exploreLoop(done: () => boolean): Promise<void> {
    while (!done() && !this.outOfTime()) {
      const obs = await this.observe()
      if (done()) return
      if (await this.handleUi(obs)) continue
      const pawn = this.obs?.pawn
      if (!pawn) {
        await this.clock.sleep(300)
        continue
      }
      const candidates = await this.explorationCandidates(pawn.location)
      if (candidates.length === 0) return

      const point: DecisionPoint = {
        kind: 'waypoint',
        state: this.stateFor(this.obs),
        options: candidates.map((p, index) => ({
          id: `p${index}`,
          label: formatVec(p),
          features: {
            distance: Math.round(dist2d(pawn.location, p)),
            novelty: Math.round(this.novelty(p)),
            visits: this.visited.get(cellKey(p)) ?? 0
          }
        }))
      }
      const { choice, record } = await this.decide(point)
      if (!choice.optionId) {
        record({ skipped: true })
        return
      }
      const target = candidates[Number(choice.optionId.slice(1))]
      const outcome = await this.walkTo(target, DEFAULT_REACH_RADIUS, formatVec(target), 25)
      record({ result: outcome, at: this.obs?.pawn ? roundVec(this.obs.pawn.location) : null })
    }
  }

  /** 离去过的格子有多远：最近的已访问格子中心到这个点的距离 */
  private novelty(p: Vec3): number {
    let nearest = Number.POSITIVE_INFINITY
    for (const key of this.visited.keys()) {
      const [cx, cy] = key.split(',').map(Number)
      const d = Math.hypot((cx + 0.5) * CELL_SIZE - p.x, (cy + 0.5) * CELL_SIZE - p.y)
      if (d < nearest) nearest = d
    }
    return Number.isFinite(nearest) ? nearest : 0
  }

  private async explorationCandidates(origin: Vec3): Promise<Vec3[]> {
    const radius = this.options.exploreRadius ?? DEFAULT_EXPLORE_RADIUS
    const points: Vec3[] = []
    try {
      for (let i = 0; i < 6; i++) {
        const nav = await this.rpc.navPath({ randomRadius: radius })
        if (!nav.has_navmesh) break
        if (nav.found && nav.point) points.push(nav.point)
      }
    } catch (error) {
      if (error instanceof BotRpcError && error.playEnded) throw error
    }
    if (points.length > 0) return points
    // 没有导航网格：八个方向各取一个点，直线走过去
    const reach = Math.min(radius, 1200)
    return Array.from({ length: 8 }, (_, i) => {
      const angle = (i * Math.PI) / 4
      return {
        x: origin.x + Math.cos(angle) * reach,
        y: origin.y + Math.sin(angle) * reach,
        z: origin.z
      }
    })
  }

  /**
   * 把每个输入动作按一遍，看有没有「看得见的反应」。
   *
   * 看得见的反应 = 角色位置 / 速度 / 移动模式 / 控制器朝向变了、冒出新的 PrintString 或错误、
   * 屏幕上的按钮变了、角色换了。一样都没有就记「没观察到效果」——
   * **这不等于坏了**：放个音效、改个 UI 数字、在别处生成东西，这里都看不见。
   */
  private async sweepInputs(): Promise<void> {
    const actions = (this.inputMap?.actions ?? [])
      .filter((a) => a.name !== this.result.move?.name)
      .slice(0, MAX_SWEEP_ACTIONS)

    for (const action of actions) {
      if (this.outOfTime()) return
      const before = await this.waitStill()
      if (await this.handleUi(before)) continue
      const snapshot = this.obs ?? before
      const errorsBefore = this.result.findings.filter(
        (f) => f.kind === 'error_after_action'
      ).length

      this.lastAction = `按动作 ${action.name}`
      try {
        await this.rpc.injectAction({
          action: action.name,
          ...valueFor(action),
          frames: framesFor(action)
        })
      } catch (error) {
        if (error instanceof BotRpcError && error.playEnded) throw error
        this.result.sweep.push({
          action: action.name,
          value_type: action.value_type,
          effects: [],
          errors: [`注入失败：${error instanceof Error ? error.message : String(error)}`]
        })
        continue
      }
      this.result.steps++
      await this.clock.sleep(200)
      const after = await this.observe()

      const effects = describeEffects(snapshot, after)
      if ((after.logs ?? []).some((l) => l.kind === 'print')) {
        effects.push('打印了 PrintString')
      }
      const newErrors = this.result.findings
        .filter((f) => f.kind === 'error_after_action')
        .slice(errorsBefore)
        .map((f) => f.detail)
      const entry: SweepEntry = {
        action: action.name,
        value_type: action.value_type,
        effects,
        errors: newErrors
      }
      this.result.sweep.push(entry)
      this.trace.write({ type: 'sweep', ...entry })

      // 按出了一个界面（暂停菜单、背包），先想办法回到能操作的状态
      if (this.uiBlocking(after)) await this.handleUi(after)
    }
  }

  // -------------------------------------------------------------------------
  // 目标模式
  // -------------------------------------------------------------------------

  private async runGoal(): Promise<void> {
    const goal = this.options.goal ?? {}
    const status = this.result.goal
    if (!status) throw new StopLoop('goal_failed', '目标模式没有目标')

    if (goal.reach) {
      const radius = goal.reach.radius ?? DEFAULT_REACH_RADIUS
      let resolveTarget: () => Vec3 | undefined
      if (goal.reach.actor) {
        const target = this.obs?.targets?.[0]
        if (!target?.found) {
          this.addFinding({
            kind: 'target_missing',
            t: this.obs?.session_elapsed,
            detail: `游戏世界里找不到「${goal.reach.actor}」—— 名字写错了，或者它在一个运行时没加载的子关卡里`
          })
          throw new StopLoop('goal_failed', `找不到目标「${goal.reach.actor}」`)
        }
        status.targetLabel = target.label || target.name || goal.reach.actor
        resolveTarget = () => this.obs?.targets?.[0]?.location
      } else if (goal.reach.location) {
        const fixed = goal.reach.location
        resolveTarget = () => fixed
      } else {
        throw new StopLoop('goal_failed', 'reach 里既没有 actor 也没有 location')
      }

      if (!this.result.move) {
        throw new StopLoop('no_movement', '找不到能让角色走动的输入，走不过去')
      }

      const outcome = await this.walkTo(
        resolveTarget,
        radius,
        status.targetLabel ?? '目标点',
        10_000
      )
      if (outcome !== 'reached') {
        const where = this.obs?.pawn ? roundVec(this.obs.pawn.location) : undefined
        this.addFinding({
          kind: 'unreachable',
          t: this.obs?.session_elapsed,
          ...(where ? { at: where } : {}),
          after: this.lastAction,
          detail:
            outcome === 'stuck'
              ? `几种脱困方式都试过了，还是到不了（最近到过 ${status.closestDistance ?? '?'} 单位）`
              : `时间用完还没走到（最近到过 ${status.closestDistance ?? '?'} 单位）`
        })
        throw new StopLoop(
          'goal_failed',
          outcome === 'stuck' ? '卡住了，走不到目标' : '时间用完还没走到目标'
        )
      }
      status.reachedTarget = true
    }

    if (goal.press) {
      const binding = this.resolvePress(goal.press)
      this.lastAction = `按 ${goal.press}`
      await this.pressBinding(
        binding,
        binding.kind === 'action' ? framesFor(this.findAction(goal.press)) : 6
      )
      this.result.steps++
      status.pressed = true
      await this.clock.sleep(300)
      await this.observe()
    }

    if (goal.untilLog) {
      // 只给了 untilLog：一边探索一边等它出现
      if (!goal.reach && !goal.press && this.result.move) {
        await this.exploreLoop(() => status.logSeen === true)
      }
      const waitStart = this.clock.now()
      while (!status.logSeen && !this.outOfTime() && this.clock.now() - waitStart < 10_000) {
        await this.clock.sleep(300)
        await this.observe()
      }
      if (!status.logSeen) {
        throw new StopLoop('goal_failed', `没等到包含「${goal.untilLog}」的 PrintString`)
      }
    }

    status.reached = true
    this.result.outcome = 'goal_reached'
    this.result.outcomeNote = '目标达成'
  }

  // -------------------------------------------------------------------------
  // 目标模式（自然语言）：每一步由 brain 在合法动作里挑一个
  // -------------------------------------------------------------------------

  private async runObjective(): Promise<void> {
    const objective = this.options.objective?.trim()
    if (!objective) throw new StopLoop('goal_failed', 'objective 模式没有目标')
    const brain = this.options.brain
    if (!brain) throw new StopLoop('goal_failed', 'objective 模式没有决策者')
    if (!this.result.move) throw new StopLoop('no_movement', '找不到能让角色走动的输入')

    const stats: ControllerStats = {
      brain: brain.name,
      ticks: 0,
      judgeDecisions: 0,
      latencyMs: [],
      confidences: [],
      actionCounts: {}
    }
    this.result.controller = stats

    const pressable = (this.inputMap?.actions ?? []).filter(
      (a) =>
        a.value_type === 'Boolean' && a.name !== this.result.jump?.name && !LOOK_LIKE.test(a.name)
    )
    const history: HistoryEntry[] = []
    const cooldown = new Map<string, number>()
    const known = new Map<string, KnownActor>()
    // 整关场景（插件 pie.scene）：有它就用它当「世界知识」，没有（老插件）退回射线 + 附近
    let scene: SceneSnapshot | null = null
    let sceneSupported = true
    const fetchScene = async (): Promise<SceneSnapshot | null> => {
      if (!sceneSupported) return null
      try {
        return await this.rpc.scene(heading)
      } catch (error) {
        if (error instanceof BotRpcError && error.playEnded) throw error
        sceneSupported = false
        this.result.calibrationNotes.push(
          '插件没有 pie.scene（版本旧），控制器只用射线和附近看得见的 Actor'
        )
        return null
      }
    }
    // 「有没有出现新信息」的版本号：见到没见过的东西、打印出没见过的文字，都算。
    // 试过没用的东西（exhausted）只在版本号往前走之后才重新提供 ——
    // 捡到钥匙（新打印）之后，刚才锁着的门才值得再去一次
    let infoVersion = 0
    const everSeen = new Set<string>()
    const seenPrints = new Set<string>()
    const exhausted = new Map<string, number>()
    const lastInteraction = new Map<string, string>()
    const gotoFails = new Map<string, number>()
    // 选定一个探索方向后连走几步，不每步都问：一步一问时判定模型会在两个方向之间来回换
    let commit: { id: string; remaining: number; version: number } | null = null
    // 朝向整局固定，等于一个罗盘：「前后左右」每一步都指同一个世界方向。
    // 第一版每走一步就把「前」改成刚走的方向，于是「往后」每选一次就对调一次，
    // 判定模型在假世界里连选八十多次「往后」，原地来回
    const heading = this.obs?.control_rotation?.yaw ?? 0
    this.navHeading = heading
    let doneStreak = 0

    while (!this.outOfTime()) {
      const obs = await this.observe({ sensors: true, headingYaw: heading })
      const pawn = obs.pawn
      if (this.result.goal?.logSeen) {
        this.result.goal.reached = true
        throw new StopLoop(
          'goal_reached',
          `等到了包含「${this.options.goal?.untilLog}」的 PrintString`
        )
      }
      if (!pawn || !obs.sensors) {
        await this.clock.sleep(300)
        continue
      }

      stats.ticks++
      scene ??= await fetchScene()
      const sensed = perceive(obs.sensors, pawn.location, (p) => this.visited.get(cellKey(p)) ?? 0)
      // 见过的东西记住位置：离开感知范围不等于从世界上消失
      // 反过来，走到记住的位置附近却感知不到了，说明它真的没了（被捡走、被销毁）——
      // 不忘掉的话控制器会一直被引回一个空地方
      const present = new Set(sensed.nearby.map((a) => a.name))
      for (const [name, actor] of known) {
        if (!present.has(name) && dist2d(actor.location, pawn.location) < 1500) known.delete(name)
      }
      for (const actor of sensed.nearby) {
        if (!everSeen.has(actor.name)) {
          everSeen.add(actor.name)
          infoVersion++
        }
        known.set(actor.name, {
          name: actor.name,
          class: actor.class,
          location: actor.location,
          ...(actor.is_pawn ? { is_pawn: true } : {}),
          ...(actor.tags ? { tags: actor.tags } : {})
        })
      }
      for (const text of this.recentPrints) {
        if (!seenPrints.has(text)) {
          seenPrints.add(text)
          infoVersion++
        }
      }
      const markExhausted = <T extends { name: string }>(actor: T): T & { exhausted?: boolean } =>
        exhausted.get(actor.name) === infoVersion ? { ...actor, exhausted: true } : actor
      if (scene) {
        for (const actor of scene.actors) {
          if (!everSeen.has(actor.name)) {
            everSeen.add(actor.name)
            infoVersion++
          }
        }
      }
      const view = {
        directions: sensed.directions,
        nearby: scene
          ? sceneToNearby(scene).map(markExhausted)
          : [
              ...sensed.nearby,
              ...rememberedView(
                known.values(),
                new Set(sensed.nearby.map((a) => a.name)),
                pawn.location,
                obs.sensors.heading_yaw
              )
            ].map(markExhausted)
      }
      const cooling = new Set(
        [...cooldown].filter(([, until]) => until > stats.ticks).map(([id]) => id)
      )
      const blocking = this.uiBlocking(obs) ? (obs.buttons ?? []) : undefined
      const offered = offerActions({
        directions: view.directions,
        nearby: view.nearby,
        ...(blocking ? { blockingButtons: blocking } : {}),
        pressable,
        canJump: Boolean(this.result.jump),
        cooling,
        caps: moveCaps(obs.sensors, Boolean(this.result.jump))
      })
      const state = buildControllerState({
        objective,
        step: stats.ticks,
        secondsLeft: this.timeLeft() / 1000,
        movement: pawn.movement_mode,
        directions: view.directions,
        nearby: view.nearby,
        ...(blocking ? { menuButtons: blocking.map((b) => b.text || b.id) } : {}),
        recentPrints: this.recentPrints.slice(-6),
        history: history.slice(-6),
        ...(scene ? { playerVars: playerVars(scene) } : {})
      })

      const committed =
        commit && commit.remaining > 0 && commit.version === infoVersion
          ? offered.find((o) => o.id === commit?.id)
          : undefined
      const decision = committed
        ? { actionId: committed.id, source: 'rule' as const, reason: '沿选定的探索方向继续' }
        : await brain.decide({
            objective,
            state,
            offered,
            nearby: view.nearby,
            directions: view.directions,
            history: history.slice(-6)
          })
      if (committed && commit) commit.remaining--
      if (decision.source === 'judge') stats.judgeDecisions++
      if (decision.ms !== undefined) stats.latencyMs.push(decision.ms)
      if (decision.confidence !== undefined) stats.confidences.push(decision.confidence)
      if (decision.done !== undefined) stats.lastDone = decision.done
      if (decision.progress !== undefined) stats.lastProgress = decision.progress

      const action = offered.find((o) => o.id === decision.actionId) ?? offered[0]
      stats.actionCounts[action.spec.kind] = (stats.actionCounts[action.spec.kind] ?? 0) + 1
      const touching = view.nearby.find((a) => a.distance === 'touching')?.name
      const outcome = await this.executeControllerAction(action, heading)
      // 这一步之后世界变了什么：对象没了 / 动了 / 蓝图变量变了 / 玩家变量变了。
      // 很多游戏不打印，状态只在变量里 —— 没有这一段，「捡到钥匙」只能靠猜
      if (sceneSupported && scene) {
        const after = await fetchScene()
        if (after) {
          const changes = diffScenes(scene, after)
          scene = after
          if (changes.length > 0) {
            infoVersion++
            const text = `world changed: ${changes.slice(0, 6).join('; ')}`
            outcome.result =
              outcome.result === 'no visible effect' ? text : `${outcome.result}; ${text}`
            if (action.spec.kind !== 'move' && action.spec.kind !== 'jump_move') {
              outcome.effective = true
            }
          }
        }
      }

      history.push({
        action: action.id,
        result: outcome.result,
        ...(action.spec.kind === 'press' && touching ? { at: touching } : {})
      })
      // 没效果的动作冷却三步：同一堵墙前原地踏步、对着空气反复按交互，
      // 是公开项目里最常见的坏循环 —— 修法是不再提供，而不是指望模型自己想通
      if (!outcome.effective) cooldown.set(action.id, stats.ticks + 3)
      // 同一个目标连续两次走不到：在出现新信息之前不再提供 —— 真机上它就是这样
      // 一遍遍选「走到出口」、一遍遍撞同一堵墙
      if (action.spec.kind === 'goto' && !outcome.result.startsWith('reached')) {
        const fails = (gotoFails.get(action.spec.target) ?? 0) + 1
        gotoFails.set(action.spec.target, fails)
        if (fails >= 2) exhausted.set(action.spec.target, infoVersion)
      } else if (action.spec.kind === 'goto') {
        gotoFails.delete(action.spec.target)
      }
      if (action.spec.kind === 'press' && touching) {
        const previous = lastInteraction.get(touching)
        if (outcome.result === 'no visible effect' || previous === outcome.result) {
          exhausted.set(touching, infoVersion)
        }
        lastInteraction.set(touching, outcome.result)
      }
      if (!committed) {
        commit =
          (action.spec.kind === 'move' || action.spec.kind === 'jump_move') && outcome.effective
            ? { id: action.id, remaining: 2, version: infoVersion }
            : null
      } else if (!outcome.effective) {
        commit = null
      }

      this.trace.write({
        type: 'tick',
        step: stats.ticks,
        t: obs.session_elapsed,
        brain: brain.name,
        state,
        offered: offered.map((o) => ({ id: o.id, description: o.description })),
        chosen: action.id,
        source: decision.source,
        reason: decision.reason,
        ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        ...(decision.probabilities ? { probabilities: decision.probabilities } : {}),
        ...(decision.done !== undefined ? { done: decision.done } : {}),
        ...(decision.progress !== undefined ? { progress: decision.progress } : {}),
        ...(decision.ms !== undefined ? { ms: decision.ms } : {}),
        outcome: outcome.result
      })

      if (this.result.goal?.logSeen) {
        this.result.goal.reached = true
        throw new StopLoop(
          'goal_reached',
          `等到了包含「${this.options.goal?.untilLog}」的 PrintString`
        )
      }
      // 判定模型连续两步都说「完成了」才停：一次高分可能只是它读错了一句打印。
      // 给了 untilLog 就只认 untilLog —— 那是断言，这个只是判断
      if (!this.options.goal?.untilLog) {
        // 沿探索方向自动走的那几步没问判定模型，不算数也不清零
        if (decision.done !== undefined) doneStreak = decision.done >= 0.9 ? doneStreak + 1 : 0
        if (doneStreak >= 2) {
          throw new StopLoop(
            'objective_done',
            `判定模型认为目标已完成（连续两步 ≥ 0.9，最后一次 ${(stats.lastDone ?? 0).toFixed(2)}）—— 这是它的判断，不是断言`
          )
        }
      }
    }
    throw new StopLoop('objective_unfinished', '时间用完，目标没有完成（或者没有证据表明完成了）')
  }

  /** 执行一个控制器动作，回报它有没有效果、朝向变成了什么 */
  private async executeControllerAction(
    action: OfferedAction,
    heading: number
  ): Promise<{ result: string; effective: boolean; heading: number }> {
    const before = this.obs?.pawn?.location
    const errorsBefore = this.seenErrors.size
    const spec = action.spec
    let nextHeading = heading
    const printed: string[] = []
    const collectPrints = (obs: Observation): void => {
      for (const line of obs.logs ?? []) if (line.kind === 'print') printed.push(line.text)
    }

    switch (spec.kind) {
      case 'move':
      case 'jump_move':
      case 'run_jump':
      case 'double_jump':
      case 'drop_down':
        nextHeading = normalizeYaw(heading + spec.angle)
        // 一次走远一点（约 5 米）：一步一问的话，探索时大半调用花在「再往前一点」上
        await this.performMove(spec, heading, action.id, this.stepFrames * 4)
        break
      case 'goto': {
        const logCursor = this.logCursor
        // 一次「走到某物件」要能真的走到：真机上 10 步 × 12 帧只走出四米多，
        // 同一个 goto 要连选三次才到，每次还白花一次判定调用
        const reached = await this.walkTo(
          spec.location,
          spec.radius ?? 180,
          spec.target,
          20,
          this.stepFrames * 2
        )
        const now = this.obs?.pawn?.location
        if (before && now && dist2d(before, now) > 30) nextHeading = headingDeg(before, now)
        if (this.logCursor !== logCursor) printed.push(...this.recentPrints.slice(-2))
        if (reached !== 'reached') {
          const moved = before && now ? dist2d(before, now) : 0
          return {
            result: `did not reach ${spec.target} (${reached}, moved ${(moved / 100).toFixed(1)} m)`,
            effective: moved > 30,
            heading: nextHeading
          }
        }
        break
      }
      case 'press':
        this.lastAction = `按 ${spec.action}`
        await this.rpc.injectAction({
          action: spec.action,
          value: true,
          frames: framesFor(this.findAction(spec.action))
        })
        this.result.steps++
        await this.clock.sleep(200)
        break
      case 'click':
        this.lastAction = `点击按钮「${spec.text}」`
        await this.rpc.click(spec.id)
        this.result.uiClicks.push({ id: spec.id, text: spec.text, reason: '控制器选择' })
        this.result.steps++
        await this.clock.sleep(500)
        break
      case 'wait':
        await this.clock.sleep(500)
        break
    }

    const after = await this.observe()
    collectPrints(after)
    const moved = before && after.pawn ? dist2d(before, after.pawn.location) : 0
    const parts: string[] = []
    if (spec.kind === 'goto') parts.push(`reached ${spec.target}`)
    else if (isDirectional(spec)) {
      parts.push(
        moved > STUCK_PROGRESS ? `moved ${(moved / 100).toFixed(1)} m` : 'blocked, did not move'
      )
    }
    if (printed.length > 0) parts.push(`game printed: ${printed.map((p) => `"${p}"`).join(', ')}`)
    if (this.seenErrors.size > errorsBefore) parts.push('a runtime error appeared')
    if (parts.length === 0) parts.push('no visible effect')
    const effective = isDirectional(spec)
      ? moved > STUCK_PROGRESS
      : parts[0] !== 'no visible effect'
    return { result: parts.join('; '), effective, heading: nextHeading }
  }

  private findAction(name: string): InputActionInfo | undefined {
    const actions = this.inputMap?.actions ?? []
    const lower = name.toLowerCase()
    return (
      actions.find((a) => a.name === name) ??
      actions.find((a) => a.name.toLowerCase() === lower) ??
      actions.find((a) => a.name.toLowerCase().includes(lower))
    )
  }

  /** press 给的是动作名就按动作，否则当按键名 */
  private resolvePress(name: string): { kind: 'action' | 'key'; name: string } {
    const action = this.findAction(name)
    if (action) return { kind: 'action', name: action.name }
    return { kind: 'key', name }
  }
}

const UNSTICK_LABELS: Record<(typeof UNSTICK_ORDER)[number], string> = {
  jump_forward: '跳一下再往前',
  strafe_left: '往左让开两步',
  strafe_right: '往右让开两步',
  back_off: '后退两步',
  replan: '重新寻路'
}

/** 扫描时给每种值类型一个「按下去」的值 */
function valueFor(action: InputActionInfo): { value?: boolean; x?: number; y?: number } {
  switch (action.value_type) {
    case 'Boolean':
      return { value: true }
    case 'Axis2D':
      return { x: 1, y: 0 }
    default:
      return { x: 1 }
  }
}

/**
 * 挂了 Hold 类触发器的动作要按住够久才会触发（设计稿 §13.2 第 12 条）。
 * 触发器的阈值插件没回秒数，一律给 45 帧（固定 60fps 下 0.75 秒），够大多数「长按」
 */
export function framesFor(action: InputActionInfo | undefined): number {
  const triggers = action?.triggers ?? []
  return triggers.some((t) => /hold/i.test(t.type)) ? 45 : 6
}

/** 注入前后两次观察之间，看得见的变化 */
export function describeEffects(before: Observation, after: Observation): string[] {
  const effects: string[] = []
  const a = before.pawn
  const b = after.pawn
  if (a && b) {
    if (a.name !== b.name) effects.push('角色换了一个')
    const moved = dist2d(a.location, b.location)
    if (moved > 20) effects.push(`角色移动了 ${Math.round(moved)}`)
    if (Math.abs(b.location.z - a.location.z) > 20)
      effects.push(`高度变了 ${Math.round(b.location.z - a.location.z)}`)
    if (Math.abs(b.speed - a.speed) > 50) effects.push('速度变了')
    if (a.movement_mode !== b.movement_mode)
      effects.push(`移动模式 ${a.movement_mode} → ${b.movement_mode}`)
  } else if (a && !b) {
    effects.push('角色没了')
  }
  const yawA = before.control_rotation?.yaw
  const yawB = after.control_rotation?.yaw
  if (yawA !== undefined && yawB !== undefined && Math.abs(normalizeYaw(yawB - yawA)) > 2) {
    effects.push('视角转了')
  }
  const buttonsA = (before.buttons ?? []).map((btn) => btn.id).join('|')
  const buttonsB = (after.buttons ?? []).map((btn) => btn.id).join('|')
  if (buttonsA !== buttonsB) effects.push('屏幕上的按钮变了')
  if (before.input && after.input) {
    if (before.input.viewport_ignores_input !== after.input.viewport_ignores_input)
      effects.push('输入模式变了')
    if (before.input.show_mouse_cursor !== after.input.show_mouse_cursor)
      effects.push('鼠标指针显隐变了')
  }
  if (before.paused !== after.paused) effects.push(after.paused ? '游戏暂停了' : '游戏取消暂停')
  if ((after.logs ?? []).some((l) => l.kind === 'error')) effects.push('报错了')
  return effects
}

/** 带方向的动作（走、跳、助跑跳、二段跳、跳下） */
function isDirectional(spec: ActionSpec): spec is Extract<ActionSpec, { angle: number }> {
  return 'angle' in spec
}
