/**
 * 目标驱动的控制器 —— 判定模型当「每一步选哪个动作」的那一层。
 *
 * ## 分层（照公开的 Jev 游戏项目的做法）
 *
 * 《我的世界》那几个项目（rmalde/minecraft-agent、teknium1/hermes-and-jev-play-minecraft）
 * 和吃豆人、贪吃蛇、马里奥的 demo 是同一个切法：
 *
 * - **规划**在更上面：调 `ue_autoplay` 的 agent 用一句自然语言说目标（「拿到钥匙把门打开」）。
 * - **控制**在这里：每一步由**代码**算出此刻合法的动作（`offerActions`），
 *   判定模型在里面挑一个；同一次调用里顺带问「目标完成了没有」「进展到哪了」。
 * - **执行**在 runner：转向、注入、寻路、点按钮。
 *
 * 关键是那句「坏行为靠改提供的选项来修」：撞墙的方向不提供、跳不过去的不提供跳、
 * 刚试过没走动的方向冷却几步不提供、「等待」只在别的都不行时才提供。
 * 判定模型永远选不出一个非法动作，所以不需要拿 confidence 去卡它 —— confidence 只记录。
 *
 * ## 为什么要把数字变成类别
 *
 * 厂商列的短板：读得极其字面、不会数数。所以射线距离、方位角、高度差在这里先落成
 * 「左前方 / 很近 / 同一高度 / 能跳过去」，判定模型读的是意思，不是算术。
 * 同理，「哪边没去过」由代码按格子算好给出，不让它比数字。
 */

import { PROGRESS_BUTTON_PATTERN, isDeniedButton } from './policy'
import type { ButtonInfo, InputActionInfo, NearbyActor, SensorRay, Sensors, Vec3 } from './types'

// ---------------------------------------------------------------------------
// 感知 → 类别
// ---------------------------------------------------------------------------

export type DirName =
  | 'front'
  | 'front_right'
  | 'right'
  | 'back_right'
  | 'back'
  | 'back_left'
  | 'left'
  | 'front_left'

export const DIRS: ReadonlyArray<{ name: DirName; angle: number }> = [
  { name: 'front', angle: 0 },
  { name: 'front_right', angle: 45 },
  { name: 'right', angle: 90 },
  { name: 'back_right', angle: 135 },
  { name: 'back', angle: 180 },
  { name: 'back_left', angle: -135 },
  { name: 'left', angle: -90 },
  { name: 'front_left', angle: -45 }
]

/** 近于这个距离的障碍算「挡住了，这一步走不过去」 */
const BLOCK_DISTANCE = 150
/** 落差超过这么多算「大落差」（可能摔伤、可能回不来） */
const BIG_DROP = 400

export interface DirectionView {
  dir: DirName
  path: 'open' | 'blocked'
  blocked_by?: string
  obstacle?: 'jumpable' | 'wall'
  ground: 'flat' | 'step_down' | 'big_drop' | 'cliff' | 'unknown'
  /** 这个方向上 4–20 米那一条带子，去过的格子占多少 */
  area: 'unexplored' | 'partly_explored' | 'explored'
  /** 原始读数，组合动作用：落差（厘米，-1 没有地）、沟对面落点、障碍顶高 */
  drop_cm?: number
  landing_cm?: number
  landing_dz?: number
  obstacle_top?: number
}

export interface NearbyView {
  name: string
  class: string
  where: DirName
  distance: 'touching' | 'near' | 'medium' | 'far'
  meters: number
  height: 'above' | 'level' | 'below'
  visible: boolean
  is_pawn?: boolean
  tags?: string[]
  location: Vec3
  /** 此刻感知范围外，是之前见过、记下的位置 */
  remembered?: boolean
  /** 来自整关场景：它是什么、能怎么用（类链、接口、事件名、组件名、标签） */
  hints?: string[]
  /** 来自整关场景：蓝图变量当前值 */
  state?: Record<string, unknown>
  /** 走进去就会触发 */
  trigger?: boolean
  /** 从玩家走过去：reachable / partial（半路被挡）/ unreachable / off_navmesh */
  path?: 'reachable' | 'partial' | 'unreachable' | 'off_navmesh'
  /** 沿导航网格要走多少米 */
  path_m?: number
  /**
   * 已经试过、而且再试也不会有新结果：上次交互的结果和再上次一样（或者毫无效果），
   * 之后也没出现任何新信息。这种东西不再提供「走过去」，免得被反复引回去
   */
  exhausted?: boolean
}

export interface KnownActor {
  name: string
  class: string
  location: Vec3
  is_pawn?: boolean
  tags?: string[]
}

/**
 * 把记住的东西（此刻不在感知范围里）也换算成相对方位。
 *
 * 没有这个，控制器只有 25 米的「当下」：拉完拉杆一转身，
 * 刚才还看得见的出口就从世界上消失了 —— 假世界第一轮 Jev 就是这么卡死的
 * （拉杆之后连走一百多步「前进」，离出口越来越远）。
 * 《我的世界》那几个项目的规划器给的 waypoint 也是这个作用。
 */
export function rememberedView(
  known: Iterable<KnownActor>,
  present: ReadonlySet<string>,
  pawn: Vec3,
  headingYaw: number
): NearbyView[] {
  const out: NearbyView[] = []
  for (const actor of known) {
    if (present.has(actor.name)) continue
    const dx = actor.location.x - pawn.x
    const dy = actor.location.y - pawn.y
    const cm = Math.hypot(dx, dy)
    const bearing = (Math.atan2(dy, dx) * 180) / Math.PI - headingYaw
    const dz = actor.location.z - pawn.z
    out.push({
      name: actor.name,
      class: actor.class,
      where: dirForBearing(bearing),
      distance: distanceBucket(cm),
      meters: Math.round(cm / 10) / 10,
      height: dz > 150 ? 'above' : dz < -150 ? 'below' : 'level',
      visible: false,
      ...(actor.is_pawn ? { is_pawn: true } : {}),
      ...(actor.tags?.length ? { tags: actor.tags } : {}),
      location: actor.location,
      remembered: true
    })
  }
  return out.sort((a, b) => a.meters - b.meters)
}

export function dirForBearing(bearing: number): DirName {
  const normalized = (((bearing % 360) + 540) % 360) - 180
  const index = Math.round(normalized / 45)
  const angle = index * 45 === -180 ? 180 : index * 45
  return DIRS.find((d) => d.angle === angle)?.name ?? 'front'
}

function viewRay(
  ray: SensorRay,
  jumpHeight: number,
  stepHeight: number,
  visitedCells: number
): Omit<DirectionView, 'dir'> {
  const blocked = ray.low !== undefined && ray.low < BLOCK_DISTANCE
  let obstacle: DirectionView['obstacle']
  if (blocked) {
    // 跳到最高点那一层没撞，或者撞得明显更远 —— 障碍比跳跃高度矮
    const clearAtJump =
      jumpHeight > stepHeight && (ray.jump === undefined || ray.jump > (ray.low ?? 0) + 60)
    obstacle = clearAtJump ? 'jumpable' : 'wall'
  }
  let ground: DirectionView['ground'] = 'unknown'
  if (ray.drop !== undefined) {
    if (ray.drop < 0) ground = 'cliff'
    else if (ray.drop > BIG_DROP) ground = 'big_drop'
    else if (ray.drop > stepHeight + 5) ground = 'step_down'
    else ground = 'flat'
  }
  if (blocked && ray.obstacle_top !== undefined) {
    // 量到了顶高就以它为准：矮于跳跃高度才算「跳得过去」
    obstacle = ray.obstacle_top < jumpHeight - 10 ? 'jumpable' : 'wall'
  }
  return {
    path: blocked ? 'blocked' : 'open',
    ...(blocked && ray.hit ? { blocked_by: ray.hit } : {}),
    ...(obstacle ? { obstacle } : {}),
    ...(ray.drop !== undefined ? { drop_cm: ray.drop } : {}),
    ...(ray.landing !== undefined ? { landing_cm: ray.landing } : {}),
    ...(ray.landing_dz !== undefined ? { landing_dz: ray.landing_dz } : {}),
    ...(ray.obstacle_top !== undefined ? { obstacle_top: ray.obstacle_top } : {}),
    ground,
    area: visitedCells <= 1 ? 'unexplored' : visitedCells <= 3 ? 'partly_explored' : 'explored'
  }
}

function distanceBucket(cm: number): NearbyView['distance'] {
  if (cm < 250) return 'touching'
  if (cm < 700) return 'near'
  if (cm < 1500) return 'medium'
  return 'far'
}

/**
 * 把一帧感知翻成类别。`visitsAt` 给出某个世界坐标所在格子去过几次 ——
 * 「哪边是新地方」是代码算的，不让判定模型比数字。
 */
export function perceive(
  sensors: Sensors,
  pawn: Vec3,
  visitsAt: (p: Vec3) => number
): { directions: DirectionView[]; nearby: NearbyView[] } {
  const directions = DIRS.map((d) => {
    const ray = sensors.rays.find((r) => Math.round(r.angle) === d.angle) ?? { angle: d.angle }
    const yaw = ((sensors.heading_yaw + d.angle) * Math.PI) / 180
    // 只看前方一格太短视：那一格没去过，不代表那个方向没探索过。
    // 看 4–20 米一整条带子上五个格子，去过几个
    let visitedCells = 0
    for (let meters = 4; meters <= 20; meters += 4) {
      const p = {
        x: pawn.x + Math.cos(yaw) * meters * 100,
        y: pawn.y + Math.sin(yaw) * meters * 100,
        z: pawn.z
      }
      if (visitsAt(p) > 0) visitedCells++
    }
    return {
      dir: d.name,
      ...viewRay(ray, sensors.jump_height, sensors.step_height, visitedCells)
    }
  })
  const nearby: NearbyView[] = sensors.nearby.map((actor: NearbyActor) => ({
    name: actor.name,
    class: actor.class,
    where: dirForBearing(actor.bearing),
    distance: distanceBucket(actor.distance),
    meters: Math.round(actor.distance / 10) / 10,
    height: actor.dz > 150 ? 'above' : actor.dz < -150 ? 'below' : 'level',
    visible: actor.visible,
    ...(actor.is_pawn ? { is_pawn: true } : {}),
    ...(actor.tags?.length ? { tags: actor.tags } : {}),
    location: actor.location
  }))
  return { directions, nearby }
}

// ---------------------------------------------------------------------------
// 合法动作集 —— 「坏行为靠改提供的选项来修」
// ---------------------------------------------------------------------------

export type ActionSpec =
  | { kind: 'move'; dir: DirName; angle: number }
  | { kind: 'jump_move'; dir: DirName; angle: number }
  /** 后退一步拉开距离，冲到边缘起跳，空中继续往前 —— 跨沟 */
  | { kind: 'run_jump'; dir: DirName; angle: number }
  /** 往前走的同时连跳两次 —— 上比一段跳高的台子 */
  | { kind: 'double_jump'; dir: DirName; angle: number }
  /** 明知前面有落差、下面有地，主动走下去 */
  | { kind: 'drop_down'; dir: DirName; angle: number }
  | { kind: 'goto'; target: string; location: Vec3; radius?: number }
  | { kind: 'press'; action: string }
  | { kind: 'click'; id: string; text: string }
  | { kind: 'wait' }

export interface OfferedAction {
  id: string
  spec: ActionSpec
  /** 给判定模型读的说明：做什么、此刻那个方向/对象是什么情况 */
  description: string
}

const MAX_GOTO = 12
const MAX_PRESS = 8

export interface OfferContext {
  directions: DirectionView[]
  nearby: NearbyView[]
  /** 屏幕上挡着的按钮（只有界面挡住输入时才给） */
  blockingButtons?: ButtonInfo[]
  /** 可以按的输入动作（已经排除了移动、视角、跳跃） */
  pressable: InputActionInfo[]
  canJump: boolean
  /** 刚试过没效果的动作，冷却中不提供 */
  cooling: ReadonlySet<string>
  /** 组合动作要的角色能力；不给就只有原地跳 */
  caps?: MoveCaps
}

function describeDirection(view: DirectionView): string {
  const ground = {
    flat: 'ground ahead is flat',
    step_down: 'ground ahead steps down a little',
    big_drop: 'there is a big drop ahead',
    cliff: 'there is no ground ahead (cliff or edge of the world)',
    unknown: 'ground ahead unknown'
  }[view.ground]
  const area = {
    unexplored: 'that way is unexplored',
    partly_explored: 'that way is partly explored',
    explored: 'that way has already been explored'
  }[view.area]
  return `${ground}; ${area}`
}

/**
 * 这个方向上有哪些东西。
 *
 * 「前方」是相对说法 —— 判定模型第一轮在拉杆前连选十几次「往前走」，
 * 而出口在身后右边：选项里没写「往前走是离出口越来越远」，它就没有依据选别的。
 */
function describeThingsThatWay(dir: DirName, all: NearbyView[]): string {
  // 试过没用的东西不写：不然「大致朝向门」会一直把探索拽回那扇锁着的门
  const nearby = all.filter((a) => !a.exhausted)
  const index = DIRS.findIndex((d) => d.name === dir)
  const neighbours = new Set([dir, DIRS[(index + 1) % 8].name, DIRS[(index + 7) % 8].name])
  const ahead = nearby.filter((a) => a.where === dir).map((a) => `${a.name} (${a.distance})`)
  const roughly = nearby
    .filter((a) => a.where !== dir && neighbours.has(a.where))
    .map((a) => `${a.name} (${a.distance})`)
  const parts: string[] = []
  if (ahead.length > 0) parts.push(`heads toward ${ahead.join(', ')}`)
  if (roughly.length > 0) parts.push(`roughly toward ${roughly.join(', ')}`)
  return parts.length > 0 ? `; ${parts.join('; ')}` : '; no known objects that way'
}

export function offerActions(ctx: OfferContext): OfferedAction[] {
  const offered: OfferedAction[] = []
  const add = (action: OfferedAction): void => {
    if (!ctx.cooling.has(action.id)) offered.push(action)
  }

  // 界面挡着输入的时候，走路没有意义（§12.8：注入照样生效，但那不是玩家能做的事）。
  // 只提供点按钮，危险按钮不提供
  if (ctx.blockingButtons && ctx.blockingButtons.length > 0) {
    for (const button of ctx.blockingButtons) {
      if (!button.enabled || isDeniedButton(button.text)) continue
      add({
        id: `click:${button.id}`,
        spec: { kind: 'click', id: button.id, text: button.text },
        description: button.text
          ? `Click the on-screen button labelled "${button.text}"`
          : 'Click an on-screen button that has no text'
      })
    }
    if (offered.length === 0) {
      offered.push({
        id: 'wait',
        spec: { kind: 'wait' },
        description: 'Wait and do nothing this step'
      })
    }
    return offered
  }

  for (const view of ctx.directions) {
    const angle = DIRS.find((d) => d.name === view.dir)?.angle ?? 0
    // 悬崖和大落差不提供：掉下去这一局就废了，而且那通常不是测试想测的
    if (view.path === 'open' && view.ground !== 'cliff' && view.ground !== 'big_drop') {
      add({
        id: `move:${view.dir}`,
        spec: { kind: 'move', dir: view.dir, angle },
        description:
          `Walk a short distance to the ${view.dir.replace('_', '-')}: ${describeDirection(view)}` +
          describeThingsThatWay(view.dir, ctx.nearby)
      })
    }
    for (const maneuver of maneuversFor(
      view,
      ctx.caps ?? { jumpHeight: 0, runJumpReach: 0, doubleJumpHeight: 0, canJump: ctx.canJump }
    )) {
      add(maneuver)
    }
  }

  // 导航网格说走不到的照样提供：导航网格按默认迈步高度（35 厘米）建，
  // 50~80 厘米的台阶在它眼里是断的，角色却跳得上去 —— 真机上就是这样把出口从选项里弄丢的。
  // 到底走不走得到，交给插件的多层网格规划器按角色真实的跳跃能力算
  const gotoCandidates = ctx.nearby.filter((a) => a.distance !== 'touching' && !a.exhausted)
  for (const actor of gotoCandidates.slice(0, MAX_GOTO)) {
    add({
      id: `goto:${actor.name}`,
      spec: {
        kind: 'goto',
        target: actor.name,
        location: actor.location,
        // 触发区要真的走进去，不是走到旁边
        ...(actor.trigger ? { radius: 60 } : {})
      },
      description:
        `Walk up to "${actor.name}" (${actor.class}${actor.is_pawn ? ', a character' : ''}), ` +
        `${actor.where.replace('_', '-')}, ${actor.distance} (~${actor.meters} m)` +
        `${actor.height === 'level' ? '' : `, ${actor.height}`}` +
        (actor.remembered
          ? ', seen earlier and remembered (out of sensor range now)'
          : actor.visible
            ? ''
            : ', not in direct sight') +
        describePath(actor) +
        (actor.hints?.length ? `; ${actor.hints.join('; ')}` : '') +
        describeState(actor)
    })
  }

  const touching = ctx.nearby.filter((a) => a.distance === 'touching').map((a) => `"${a.name}"`)
  for (const action of ctx.pressable.slice(0, MAX_PRESS)) {
    add({
      id: `press:${action.name}`,
      spec: { kind: 'press', action: action.name },
      description:
        `Press the game input "${action.name}" once` +
        (touching.length > 0
          ? ` (right next to ${touching.join(', ')})`
          : ' (nothing is within reach right now)')
    })
  }

  // 「等待」只在别的都不行时才提供 —— 公开项目里 Jev 连选五次等待就是这么修好的
  if (offered.length === 0) {
    offered.push({
      id: 'wait',
      spec: { kind: 'wait' },
      description: 'Wait and do nothing this step'
    })
  }
  return offered
}

// ---------------------------------------------------------------------------
// 大脑 —— 规则基线与判定模型，同一个接口
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  action: string
  result: string
  /** 按输入时挨着的是谁 —— 规则基线靠它避免在同一个东西前反复按 */
  at?: string
}

export interface ControllerTick {
  objective: string
  /** 发给判定模型的整份状态（也原样进 trace） */
  state: Record<string, unknown>
  offered: OfferedAction[]
  nearby: NearbyView[]
  directions: DirectionView[]
  history: HistoryEntry[]
}

export interface ControllerDecision {
  actionId: string
  source: 'judge' | 'rule'
  reason: string
  confidence?: number
  probabilities?: Record<string, number>
  /** 判定模型认为目标已经完成的概率 */
  done?: number
  /** 0~4 档进展 */
  progress?: number
  ms?: number
}

export interface ControllerBrain {
  readonly name: string
  decide(tick: ControllerTick): Promise<ControllerDecision>
}

/** 把一份感知组成发给判定模型的状态。字段名就是线索，所以用英文、有层次 */
export function buildControllerState(input: {
  objective: string
  step: number
  secondsLeft: number
  movement: string
  directions: DirectionView[]
  nearby: NearbyView[]
  menuButtons?: string[]
  recentPrints: string[]
  history: HistoryEntry[]
  /** 玩家身上的蓝图变量（背包、血量、拿没拿到钥匙） */
  playerVars?: Record<string, unknown>
}): Record<string, unknown> {
  const surroundings: Record<string, unknown> = {}
  for (const view of input.directions) {
    const { dir, ...rest } = view
    surroundings[dir] = rest
  }
  return {
    objective: input.objective,
    step: input.step,
    seconds_left: Math.max(0, Math.round(input.secondsLeft)),
    character: {
      movement: input.movement,
      ...(input.playerVars && Object.keys(input.playerVars).length > 0
        ? { vars: input.playerVars }
        : {})
    },
    surroundings,
    // 世界坐标不给判定模型：它不会算数，给了只会让它去比数字（方位和远近已经是类别了）
    // 整关对象可能有几十个：只给最相关的 25 个（没试废的优先、近的优先），
    // state 越大判定越不准（厂商 jaggedness 第一条）
    nearby: [...input.nearby]
      .sort(
        (a, b) => Number(Boolean(a.exhausted)) - Number(Boolean(b.exhausted)) || a.meters - b.meters
      )
      .slice(0, 25)
      .map((actor) => {
        const rest: Partial<NearbyView> = { ...actor }
        delete rest.location
        return rest
      }),
    ...(input.menuButtons
      ? { screen: { menu_blocks_play: true, buttons: input.menuButtons } }
      : {}),
    recent_prints: input.recentPrints,
    history: input.history
  }
}

const INTERACT_LIKE = /interact|use|pick|grab|activate|open|交互|拾取|使用|互动|打开/i

/** 把 BP_Door_C_2 这类名字拆成可以和目标文字比对的词 */
function nameTokens(name: string): string[] {
  return name
    .replace(/^(BP|B|SM|SK)_/i, '')
    .replace(/_C(_\d+)?$/i, '')
    .replace(/_?\d+$/, '')
    .split(/[_\s-]+|(?=[A-Z][a-z])/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2)
}

/**
 * 规则基线：目标文字里提到了附近哪个 Actor 的名字就走过去，挨着了就按交互，
 * 否则往没去过的方向走。判定模型要明显打败它才算数。
 */
export const ruleBrain: ControllerBrain = {
  name: 'rule',
  async decide(tick) {
    const byId = new Map(tick.offered.map((o) => [o.id, o]))
    const clicks = tick.offered.filter((o) => o.spec.kind === 'click')
    if (clicks.length > 0) {
      const progress = clicks.find(
        (o) => o.spec.kind === 'click' && PROGRESS_BUTTON_PATTERN.test(o.spec.text)
      )
      return {
        actionId: (progress ?? clicks[0]).id,
        source: 'rule',
        reason: '界面挡着，点像「开始」的那个'
      }
    }

    const objective = tick.objective.toLowerCase()
    const mentioned = tick.nearby
      .filter((a) => !a.exhausted)
      .filter((a) => nameTokens(a.name).some((token) => objective.includes(token)))
    const pressedAt = new Set(
      tick.history.filter((h) => h.action.startsWith('press:') && h.at).map((h) => h.at)
    )
    const touchingMentioned = mentioned.find((a) => a.distance === 'touching')
    if (touchingMentioned) {
      const interact = tick.offered.find(
        (o) => o.spec.kind === 'press' && INTERACT_LIKE.test(o.spec.action)
      )
      if (interact && !pressedAt.has(touchingMentioned.name)) {
        return {
          actionId: interact.id,
          source: 'rule',
          reason: `挨着目标里提到的「${touchingMentioned.name}」，按交互`
        }
      }
    }
    const visitedTargets = new Set(
      tick.history.filter((h) => h.action.startsWith('goto:')).map((h) => h.action.slice(5))
    )
    const nextTarget = mentioned.find(
      (a) => a.distance !== 'touching' && !visitedTargets.has(a.name)
    )
    if (nextTarget && byId.has(`goto:${nextTarget.name}`)) {
      return {
        actionId: `goto:${nextTarget.name}`,
        source: 'rule',
        reason: `目标里提到了「${nextTarget.name}」`
      }
    }

    const moves = tick.offered.filter((o) => o.spec.kind === 'move')
    const areaOf = (o: OfferedAction): DirectionView['area'] | undefined => {
      const spec = o.spec
      return spec.kind === 'move'
        ? tick.directions.find((d) => d.dir === spec.dir)?.area
        : undefined
    }
    const fresh = moves.find((o) => areaOf(o) === 'unexplored')
    const pick =
      fresh ?? moves[0] ?? tick.offered.find((o) => o.spec.kind === 'jump_move') ?? tick.offered[0]
    return {
      actionId: pick.id,
      source: 'rule',
      reason: fresh ? '往没去过的方向走' : '没有新方向，随便走'
    }
  }
}

// ---------------------------------------------------------------------------
// 判定模型大脑
// ---------------------------------------------------------------------------

export interface JudgeAnswerLike {
  type: string
  choice?: string
  probabilities?: Record<string, number>
  confidence?: number
  noul?: number
  score?: number
}

export type AskJudgeRaw = (
  state: Record<string, unknown>,
  questions: Record<string, unknown>
) => Promise<{ answers: Record<string, unknown> } | null>

const ACTION_INSTRUCTIONS =
  'You control a character in a video game to accomplish `objective`. Pick the single next action. ' +
  'Use `nearby` to find the things the objective talks about (names may be in a different language than the objective), ' +
  'walk up to them, and press an interaction input when right next to them. ' +
  '`history` shows your last actions and what happened; do not repeat an action that had no effect. ' +
  'When nothing relevant is nearby, explore toward areas that have not been visited.'

/**
 * 第一版：所有合法动作平铺成一道多选题，同一次调用顺带问完成与否、进展。
 *
 * 留着做对照。假世界里它在「拉杆开闸门」上卡住：拉完拉杆在「往前走」（0.45）和
 * 「去出口」（0.23–0.33）之间摇摆，连选十几次往前走。一道题里塞了「下一步做哪件事」
 * 「往哪走」两个判断 —— 厂商文档说的「宽问题把几个判断藏在一个答案后面」。
 * 现在用的是下面拆开的 `createJudgeBrain`。
 *
 * **不拿 confidence 卡动作**：选项表已经保证了每个动作都合法，
 * 卡掉的话只会把控制权还给更笨的规则。confidence 进 trace，事后看。
 * 调用失败才退回规则。
 */
export function createFlatJudgeBrain(ask: AskJudgeRaw): ControllerBrain {
  return {
    name: 'judge-flat',
    async decide(tick) {
      if (tick.offered.length === 1) {
        return { actionId: tick.offered[0].id, source: 'rule', reason: '只有一个能做的动作' }
      }
      const criteria: Record<string, string> = {}
      for (const option of tick.offered) criteria[option.id] = option.description
      const started = Date.now()
      const result = await ask(tick.state, {
        action: { type: 'choice', instructions: ACTION_INSTRUCTIONS, criteria },
        done: {
          type: 'noul',
          instructions:
            'Judging only from `recent_prints`, `history` and `nearby`, has `objective` been fully accomplished?',
          criteria: {
            true: 'There is concrete evidence (a message, an effect) that every part of the objective happened',
            false:
              'Some part of the objective has not visibly happened yet, or there is no evidence'
          }
        },
        progress: {
          type: 'score',
          instructions: 'How far along is the character toward `objective`?',
          criteria: [
            'Nothing relevant found yet',
            'Something relevant is nearby or in sight',
            'Right next to something the objective needs',
            'Part of the objective is done',
            'The objective appears complete'
          ]
        }
      })
      const ms = Date.now() - started
      const answers = result?.answers as Record<string, JudgeAnswerLike> | undefined
      const action = answers?.action
      if (!action || action.type !== 'choice' || !action.choice || !criteria[action.choice]) {
        const fallback = await ruleBrain.decide(tick)
        return { ...fallback, reason: `判定器没回答，按规则：${fallback.reason}`, ms }
      }
      return {
        actionId: action.choice,
        source: 'judge',
        reason: `判定器选择（confidence ${(action.confidence ?? 0).toFixed(2)}）`,
        confidence: action.confidence,
        probabilities: action.probabilities,
        done: answers?.done?.type === 'noul' ? answers.done.noul : undefined,
        progress: answers?.progress?.type === 'score' ? answers.progress.score : undefined,
        ms
      }
    }
  }
}

const EXPLORE = '__explore__'

const DONE_QUESTION = {
  type: 'noul',
  instructions:
    'Judging only from `recent_prints`, `history` and `nearby`, has `objective` been fully accomplished?',
  criteria: {
    true: 'There is concrete evidence (a message, an effect) that every part of the objective happened',
    false: 'Some part of the objective has not visibly happened yet, or there is no evidence'
  }
}

const PROGRESS_QUESTION = {
  type: 'score',
  instructions: 'How far along is the character toward `objective`?',
  criteria: [
    'Nothing relevant found yet',
    'Something relevant is nearby or in sight',
    'Right next to something the objective needs',
    'Part of the objective is done',
    'The objective appears complete'
  ]
}

function describePath(actor: NearbyView): string {
  switch (actor.path) {
    case 'reachable':
      return actor.path_m !== undefined ? `, walkable (~${actor.path_m} m by path)` : ', walkable'
    case 'partial':
      return ', the path to it is blocked partway'
    case 'unreachable':
      return ', no walking path on the navigation mesh (may need jumping or climbing)'
    case 'off_navmesh':
      return ', not on the navigation mesh (may be on a ledge or platform)'
    default:
      return ''
  }
}

function describeState(actor: NearbyView): string {
  const entries = Object.entries(actor.state ?? {}).slice(0, 6)
  if (entries.length === 0) return ''
  return `; state ${entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}`
}

function describeTarget(actor: NearbyView, history: HistoryEntry[]): string {
  // 上次和它交互的结果挂在它自己身上：「门锁着」只留在历史记录里的话，
  // 判定模型要自己把那条记录和这个选项对上 —— 假世界里它没对上，反复回去按门
  const tried = [...history].reverse().find((h) => h.at === actor.name)
  return (
    `${actor.name} (${actor.class}${actor.is_pawn ? ', a character' : ''}): ${actor.where.replace('_', '-')}, ` +
    (actor.distance === 'touching'
      ? 'right next to the character'
      : `${actor.distance}, ~${actor.meters} m`) +
    (actor.remembered ? ', seen earlier (out of sensor range now)' : '') +
    describePath(actor) +
    (actor.hints?.length ? `; ${actor.hints.join('; ')}` : '') +
    describeState(actor) +
    (tried ? `; last interaction: ${tried.result}` : '')
  )
}

/**
 * 拆开问：一次调用里并行问五六道**原子**题，代码把答案拼成动作。
 *
 *   next_target  下一个该去处理哪个东西（或者先探索）
 *   use_now      挨着的那个东西，现在是不是该交互
 *   press_which  交互按哪个输入（不止一个时才问）
 *   explore_dir  要探索的话往哪走（选项里写着每个方向上有什么）
 *   done / progress
 *
 * 这是厂商文档的两条建议合在一起：「宽问题拆成原子问题」+「speculative fan-out」——
 * 有些题的答案用不上（没挨着东西时 use_now 就作废），但多问几道题几乎不加钱也不加时间。
 *
 * 不拿 confidence 卡：所有落地的动作都来自合法动作表。拼不出合法动作时退回规则。
 */
export function createJudgeBrain(ask: AskJudgeRaw): ControllerBrain {
  return {
    name: 'judge',
    async decide(tick) {
      const offered = new Map(tick.offered.map((o) => [o.id, o]))
      if (tick.offered.length === 1) {
        return { actionId: tick.offered[0].id, source: 'rule', reason: '只有一个能做的动作' }
      }

      const clicks = tick.offered.filter((o) => o.spec.kind === 'click')
      const presses = tick.offered.filter((o) => o.spec.kind === 'press')
      const moves = tick.offered.filter(
        (o) => o.spec.kind === 'move' || o.spec.kind === 'jump_move'
      )
      const targets = tick.nearby.filter(
        (a) => !a.exhausted && (a.distance === 'touching' || offered.has(`goto:${a.name}`))
      )
      const touching = tick.nearby.filter((a) => a.distance === 'touching')

      const questions: Record<string, unknown> = {
        done: DONE_QUESTION,
        progress: PROGRESS_QUESTION
      }
      if (clicks.length > 0) {
        questions.click = {
          type: 'choice',
          instructions:
            'A menu blocks play. Which button should be clicked to get on with `objective`?',
          criteria: Object.fromEntries(clicks.map((o) => [o.id, o.description]))
        }
      } else {
        if (targets.length > 0) {
          const criteria: Record<string, string> = Object.fromEntries(
            targets.map((a) => [a.name, describeTarget(a, tick.history)])
          )
          criteria[EXPLORE] =
            'None of the listed objects is needed next; explore to find something new'
          questions.next_target = {
            type: 'choice',
            instructions:
              'Which object in `nearby` should the character go to or use next to make progress on `objective`? ' +
              'Object names may be in a different language than the objective. ' +
              'Use `history` and `recent_prints` to tell which steps are already done, and do not pick an object whose step is already done.',
            criteria
          }
        }
        if (touching.length > 0 && presses.length > 0) {
          questions.use_now = {
            type: 'noul',
            instructions:
              `The character is right next to ${touching.map((a) => a.name).join(', ')}. ` +
              'Is interacting with it the next step toward `objective`, and not already done according to `history` and `recent_prints`?'
          }
          if (presses.length > 1) {
            questions.press_which = {
              type: 'choice',
              instructions:
                'Which game input most likely interacts with (uses, opens, picks up) the object next to the character?',
              criteria: Object.fromEntries(presses.map((o) => [o.id, o.description]))
            }
          }
        }
        if (moves.length > 1) {
          questions.explore_dir = {
            type: 'choice',
            instructions:
              'If the character has to explore, which way is most promising for `objective`? ' +
              'Prefer directions toward objects the objective needs, then areas not visited yet.',
            criteria: Object.fromEntries(moves.map((o) => [o.id, o.description]))
          }
        }
      }

      const started = Date.now()
      const result = await ask(tick.state, questions)
      const ms = Date.now() - started
      const answers = result?.answers as Record<string, JudgeAnswerLike> | undefined
      const fallback = async (why: string): Promise<ControllerDecision> => {
        const rule = await ruleBrain.decide(tick)
        return { ...rule, reason: `${why}，按规则：${rule.reason}`, ms }
      }
      if (!answers) return fallback('判定器没回答')

      const done = answers.done?.type === 'noul' ? answers.done.noul : undefined
      const progress = answers.progress?.type === 'score' ? answers.progress.score : undefined
      const decided = (
        actionId: string,
        reason: string,
        head: JudgeAnswerLike | undefined
      ): ControllerDecision => ({
        actionId,
        source: 'judge',
        reason,
        ...(head?.confidence !== undefined ? { confidence: head.confidence } : {}),
        ...(head?.probabilities ? { probabilities: head.probabilities } : {}),
        ...(done !== undefined ? { done } : {}),
        ...(progress !== undefined ? { progress } : {}),
        ms
      })

      if (clicks.length > 0) {
        const pick = answers.click?.choice
        return pick && offered.has(pick)
          ? decided(pick, '判定器选了按钮', answers.click)
          : fallback('按钮题没答')
      }

      const target = answers.next_target?.choice
      const targetActor = tick.nearby.find((a) => a.name === target)
      const useNow = answers.use_now?.type === 'noul' ? (answers.use_now.noul ?? 0) : 0
      const pressWhich = answers.press_which?.choice
      const pressId = pressWhich && offered.has(pressWhich) ? pressWhich : presses[0]?.id

      // 要处理的就是挨着的那个，而且现在该交互 → 按
      const useTouching = targetActor?.distance === 'touching' && useNow >= 0.5
      const useUnnamed = !targetActor && useNow >= 0.8
      if (pressId && (useTouching || useUnnamed)) {
        return decided(
          pressId,
          `挨着 ${targetActor?.name ?? touching[0]?.name}，交互`,
          answers.next_target ?? answers.use_now
        )
      }
      // 要去的东西还没挨着 → 走过去
      if (targetActor && targetActor.distance !== 'touching') {
        const gotoId = `goto:${targetActor.name}`
        if (offered.has(gotoId)) {
          return decided(gotoId, `下一个处理 ${targetActor.name}`, answers.next_target)
        }
      }
      // 探索
      const dir = answers.explore_dir?.choice
      if (dir && offered.has(dir)) return decided(dir, '探索', answers.explore_dir)
      if (moves.length === 1) return decided(moves[0].id, '探索（只剩一个方向）', undefined)
      return fallback('拼不出合法动作')
    }
  }
}

// ---------------------------------------------------------------------------
// 局部导航 —— 没有导航网格时，一步一步绕开障碍走向目标
// ---------------------------------------------------------------------------

export interface NavStep {
  action: string
  result: string
}

export interface NavTick {
  target: { name: string; where: DirName; meters: number }
  /** 目标相对朝向的方位角（度） */
  bearing: number
  directions: DirectionView[]
  /** 只有此刻合法的几步：通的方向走一步、矮障碍跳过去 */
  offered: OfferedAction[]
  steps: NavStep[]
}

export interface NavDecision {
  actionId: string
  source: 'judge' | 'rule'
  confidence?: number
  probabilities?: Record<string, number>
  ms?: number
}

export interface Navigator {
  readonly name: string
  decide(tick: NavTick): Promise<NavDecision>
}

function angleBetween(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180)
}

/** 这一步的方向和目标方向的关系，落成类别（判定模型不比角度） */
export function relationToTarget(stepAngle: number, targetBearing: number): string {
  const diff = angleBetween(stepAngle, targetBearing)
  if (diff <= 22.5) return 'straight toward the target'
  if (diff <= 67.5) return 'roughly toward the target'
  if (diff <= 112.5) return 'sideways to the target'
  if (diff <= 157.5) return 'mostly away from the target'
  return 'directly away from the target'
}

/** 走一步用的合法动作 + 给判定模型读的说明 */
export function offerNavSteps(
  directions: DirectionView[],
  targetBearing: number,
  canJump: boolean,
  caps?: MoveCaps
): OfferedAction[] {
  const offered: OfferedAction[] = []
  for (const view of directions) {
    const angle = DIRS.find((d) => d.name === view.dir)?.angle ?? 0
    const relation = relationToTarget(angle, targetBearing)
    const dir = view.dir.replace('_', '-')
    if (view.path === 'open' && view.ground !== 'cliff' && view.ground !== 'big_drop') {
      offered.push({
        id: `move:${view.dir}`,
        spec: { kind: 'move', dir: view.dir, angle },
        description: `Step ${dir}: ${relation}; the way is open; ${view.area.replace('_', ' ')}`
      })
    }
    offered.push(
      ...maneuversFor(
        view,
        caps ?? { jumpHeight: 0, runJumpReach: 0, doubleJumpHeight: 0, canJump },
        relation
      )
    )
  }
  return offered
}

function blockedSummary(directions: DirectionView[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const view of directions) {
    out[view.dir] =
      view.path === 'open'
        ? view.ground === 'cliff' || view.ground === 'big_drop'
          ? 'open but a drop/cliff ahead'
          : 'open'
        : view.obstacle === 'jumpable'
          ? `low obstacle${view.blocked_by ? ` (${view.blocked_by})` : ''}`
          : `wall${view.blocked_by ? ` (${view.blocked_by})` : ''}`
  }
  return out
}

const NAV_INSTRUCTIONS =
  'The character must walk to `target`, and there may be obstacles in between. Pick the next single step. ' +
  'If the way straight toward the target is open, take it. If it is blocked, go around the obstacle: ' +
  'step to a side that is open and still roughly toward the target, and keep following the obstacle edge on that same side. ' +
  'Use `recent_steps`: do not repeat a step that just got blocked, do not undo the previous step, ' +
  'and if steps stopped bringing the character closer, try the other side of the obstacle.'

/**
 * 判定模型当局部导航：每一步问一次「往哪迈」。
 *
 * 和控制器一样的原则：选项只有此刻合法的几步（悬崖方向根本不给），
 * 不拿 confidence 卡；调用失败退回「最朝向目标的那一步」。
 */
export function createJudgeNavigator(ask: AskJudgeRaw): Navigator {
  return {
    name: 'judge',
    async decide(tick) {
      const fallback = (): NavDecision => ({ actionId: ruleNavigatorPick(tick), source: 'rule' })
      if (tick.offered.length <= 1) return fallback()
      const started = Date.now()
      const result = await ask(
        {
          target: {
            name: tick.target.name,
            direction: tick.target.where,
            distance_m: Math.round(tick.target.meters)
          },
          surroundings: blockedSummary(tick.directions),
          recent_steps: tick.steps.slice(-6)
        },
        {
          step: {
            type: 'choice',
            instructions: NAV_INSTRUCTIONS,
            criteria: Object.fromEntries(tick.offered.map((o) => [o.id, o.description]))
          }
        }
      )
      const ms = Date.now() - started
      const answer = (result?.answers as Record<string, JudgeAnswerLike> | undefined)?.step
      if (!answer?.choice || !tick.offered.some((o) => o.id === answer.choice)) {
        return { ...fallback(), ms }
      }
      return {
        actionId: answer.choice,
        source: 'judge',
        ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
        ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
        ms
      }
    }
  }
}

/** 规则兜底：选最朝向目标的那一步 */
export function ruleNavigatorPick(tick: NavTick): string {
  let best = tick.offered[0]
  let bestDiff = Infinity
  for (const option of tick.offered) {
    const spec = option.spec
    if (!('angle' in spec) || spec.kind === 'drop_down') continue
    const diff = angleBetween(spec.angle, tick.bearing)
    if (diff < bestDiff) {
      bestDiff = diff
      best = option
    }
  }
  return best?.id ?? 'wait'
}

export const ruleNavigator: Navigator = {
  name: 'rule',
  async decide(tick) {
    return { actionId: ruleNavigatorPick(tick), source: 'rule' }
  }
}

// ---------------------------------------------------------------------------
// 组合动作 —— 由代码按物理条件决定此刻能不能做，判定模型只在能做的里面挑
// ---------------------------------------------------------------------------

export interface MoveCaps {
  jumpHeight: number
  /** 助跑跳大致能跳多远（厘米）：跑速 × 滞空时间，打个折 */
  runJumpReach: number
  /** 二段跳大致能上多高；不能二段跳为 0 */
  doubleJumpHeight: number
  canJump: boolean
}

/** 从 sensors 算角色能力。老插件没有这些参数时，助跑跳和二段跳都不提供 */
export function moveCaps(sensors: Sensors, canJump: boolean): MoveCaps {
  const gravity = sensors.gravity ?? 0
  const airtime = gravity > 0 && sensors.jump_z ? (2 * sensors.jump_z) / gravity : 0
  return {
    jumpHeight: sensors.jump_height,
    // 七五折：起跳点不一定正好在边缘，空中也不一定一直满速
    runJumpReach: canJump ? (sensors.max_speed ?? 0) * airtime * 0.75 : 0,
    doubleJumpHeight: canJump && (sensors.jump_max_count ?? 1) > 1 ? sensors.jump_height * 1.8 : 0,
    canJump
  }
}

/** 主动往下跳最多跳多高（厘米）。再高就算有地也不跳：多半摔伤或回不来 */
export const SAFE_DROP = 800

/** 某个方向上此刻能做的组合动作（普通「走一步」不在这里） */
export function maneuversFor(
  view: DirectionView,
  caps: MoveCaps,
  relation?: string
): OfferedAction[] {
  const angle = DIRS.find((d) => d.name === view.dir)?.angle ?? 0
  const dir = view.dir.replace('_', '-')
  const rel = relation ? `: ${relation}` : ''
  const out: OfferedAction[] = []
  if (view.path === 'blocked' && view.obstacle === 'jumpable' && caps.canJump) {
    out.push({
      id: `jump:${view.dir}`,
      spec: { kind: 'jump_move', dir: view.dir, angle },
      description: `Jump ${dir} over / onto the low obstacle${view.blocked_by ? ` "${view.blocked_by}"` : ''}${rel}`
    })
  }
  if (
    view.path === 'blocked' &&
    view.obstacle === 'wall' &&
    caps.doubleJumpHeight > 0 &&
    view.obstacle_top !== undefined &&
    view.obstacle_top < caps.doubleJumpHeight
  ) {
    out.push({
      id: `double_jump:${view.dir}`,
      spec: { kind: 'double_jump', dir: view.dir, angle },
      description: `Double-jump ${dir} onto the ledge${view.blocked_by ? ` "${view.blocked_by}"` : ''} (too high for one jump)${rel}`
    })
  }
  const gap = view.ground === 'cliff' || view.ground === 'big_drop'
  if (
    view.path === 'open' &&
    gap &&
    view.landing_cm !== undefined &&
    caps.runJumpReach > 0 &&
    view.landing_cm <= caps.runJumpReach &&
    (view.landing_dz ?? 0) < caps.jumpHeight * 0.8
  ) {
    out.push({
      id: `run_jump:${view.dir}`,
      spec: { kind: 'run_jump', dir: view.dir, angle },
      description: `Running jump ${dir} across the gap to the ground about ${Math.round(view.landing_cm / 100)} m ahead${rel}`
    })
  }
  if (
    view.path === 'open' &&
    view.ground === 'big_drop' &&
    view.drop_cm !== undefined &&
    view.drop_cm > 0 &&
    view.drop_cm <= SAFE_DROP
  ) {
    out.push({
      id: `drop_down:${view.dir}`,
      spec: { kind: 'drop_down', dir: view.dir, angle },
      description: `Drop down ${dir} about ${(view.drop_cm / 100).toFixed(1)} m to the lower ground (you may not be able to climb back)${rel}`
    })
  }
  return out
}
