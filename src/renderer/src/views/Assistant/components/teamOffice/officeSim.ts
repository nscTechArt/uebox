/**
 * 团队办公室的模拟：谁在哪、往哪走、摆什么姿势、头顶冒什么。
 *
 * 思路学自 pixel-agents（一个 agent 一个小人，动作跟着它真实在干的事走），
 * 画风和场景是自己的：侧视剖面的一间小办公室，墨线单色 + 每人一种衬衫颜色。
 *
 * 这里只有数据和规则，不碰 DOM 和画布，测试里能一帧一帧推。
 *
 * ## 动作从哪来
 *
 * 每个人有一个「此刻该干嘛」（`Mode`，由任务板的实时数据推出来，见 officeInput.ts），
 * 和一个「手头正在干嘛」（走路、坐下、冲咖啡……）。Mode 是硬的：要干活就回工位，
 * 手上的闲事立刻放下；只有闲着的时候才自己找事做 —— 冲咖啡、浇花、看窗外、
 * 找另一个闲着的人聊两句。闲事的挑法带随机，但同一个地方一次只站一个人。
 */

import type { ToolKind } from './officeActivity'
import type { ModelLook } from './modelLook'

export type Mode =
  | { kind: 'work'; tool: ToolKind | 'think' }
  /** 发了话在等回 */
  | { kind: 'wait' }
  /** 停工了（比如模型额度用完）：趴在桌上睡 */
  | { kind: 'out' }
  | { kind: 'idle' }
  /** 制作人在跑：站在白板前写写画画 */
  | { kind: 'board' }
  /** 制作人卡在等某个队员交活：站在那人工位后面看着 */
  | { kind: 'awaiting'; on: string }

export type Pose =
  | 'stand'
  | 'walk'
  | 'sit'
  | 'type'
  | 'read'
  | 'lean'
  | 'look'
  | 'play'
  | 'sleep'
  | 'cheer'
  | 'drink'
  | 'water'
  | 'gaze'
  | 'write'
  | 'facepalm'
  | 'chat'
  | 'stretch'

export type BubbleIcon = 'dots' | 'bang' | 'mail' | 'note' | 'heart' | 'check' | 'cross' | 'q'

export interface Bubble {
  icon: BubbleIcon
  until: number
  /** 危险色（受阻、停工），其余用墨色 */
  alert?: boolean
}

export interface Actor {
  id: string
  name: string
  producer: boolean
  /** 发型，0..7 */
  style: number
  /** 衬衫颜色序号，制作人是 -1（用强调色） */
  crew: number
  /** 认得出是哪家模型：发色、配件照那家画，发型不再按 style 挑 */
  look?: ModelLook
  mode: Mode
  x: number
  vx: number
  facing: 1 | -1
  targetX: number | null
  /** 到了之后朝哪边 */
  arriveFacing: 1 | -1 | null
  hurry: boolean
  pose: Pose
  seated: boolean
  /** 走路相位，每走 3 像素进一格 */
  stride: number
  errand: Errand | null
  bubble: Bubble | null
  /** 起跳剩余时间（秒）。>0 时整个人往上弹 */
  hop: number
  carrying: 'cup' | 'can' | 'book' | null
  /** 下次眨眼的时刻 */
  blinkAt: number
  /** 站起 / 坐下的过渡剩余时间 */
  settle: number
  /** 刚进门：从画面外走进来 */
  entering: boolean
}

export type ErrandKind =
  | 'coffee'
  | 'water'
  | 'plant'
  | 'window'
  | 'sofa'
  | 'desk'
  | 'chat'
  | 'stretch'
  | 'board'
  | 'peek'
  | 'pace'

export interface Errand {
  kind: ErrandKind
  /** 占着的地点（同一地点一次一人） */
  spot: string | null
  x: number
  facing: 1 | -1
  pose: Pose
  /** 到了之后待多久（秒）；到之前不计时 */
  stay: number
  arrived: boolean
  /** chat：跟谁 */
  partner?: string
  /** 冲完咖啡要不要端着杯子走 */
  then?: 'cup'
}

export interface Particle {
  kind: 'steam' | 'z' | 'spark' | 'confetti' | 'leaf' | 'drop' | 'plane' | 'bubble'
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  /** 颜色序号（confetti 用衬衫色，-1 强调色） */
  tone?: number
  /** 纸飞机：起点终点 */
  from?: { x: number; y: number }
  to?: { x: number; y: number; id: string }
}

export interface DeskSlot {
  /** 这一格的左边 */
  x: number
  width: number
  /** 坐下时小人的 x（精灵左边） */
  seatX: number
  deskX: number
  deskW: number
  monitorX: number
  /** 桌上放着一杯咖啡（冒热气到这个时刻） */
  mugUntil: number
}

export interface Layout {
  width: number
  height: number
  /** 脚踩的那条线 */
  floorY: number
  /** 墙和地板的分界 */
  wallY: number
  machineX: number
  coolerX: number
  plantX: number
  sofaX: number | null
  boardX: number
  boardW: number
  clockX: number
  windows: number[]
  desks: Map<string, DeskSlot>
  /** 制作人站的地方 */
  producerX: number
  profile: OfficeProfile
}

/**
 * 一套画风的几何：场景多高、人多大、家具摆在哪、人站在哪干闲事。
 * 模拟只认这些数，不认画法 —— 简约版和豪华版共用同一套模拟，各给一份几何。
 */
export interface OfficeProfile {
  sceneH: number
  floorY: number
  wallY: number
  spriteW: number
  spriteH: number
  /** 坐下比站着矮几格 */
  sitDrop: number
  machineX: number
  coolerX: number
  plantX: number
  /** 工位区从哪开始 */
  deskStart: number
  boardW: number
  /** 制作人离右边多远 */
  producerInset: number
  /** 工位区离白板多远 */
  boardGap: number
  slotMin: number
  slotMax: number
  /** 桌子在格子里从哪开始；坐下的人在格子里的 x */
  deskOffset: number
  seatOffset: number
  deskWMin: number
  deskWMax: number
  /** 格子比桌子宽多少 */
  deskPad: number
  monitorW: number
  /** 剩多宽才摆沙发 */
  sofaNeed: number
  windowW: number
  /** 窗户从哪开始排 */
  windowStart: number
  /** 平均多宽一扇窗 */
  windowEvery: number
  walkSpeed: number
  hurrySpeed: number
  /** 闲事站的位置（相对家具的 x） */
  spots: {
    machine: number
    cooler: number
    plant: number
    sofa: number
    /** 站在别人工位后面看：相对那人坐的位置 */
    peek: number
  }
  /** 冒热气的地方：[x, y]，x 相对家具（杯子相对桌子右端），y 相对地面 */
  steam: { machine: [number, number]; mug: [number, number] }
  /** 点得中的范围：[左, 右, 上, 下]，左右相对家具，上下相对地面 */
  hit: { plant: [number, number, number, number]; machine: [number, number, number, number] }
}

/** 简约版（墨线单色）的几何 */
export const V1_PROFILE: OfficeProfile = {
  sceneH: 72,
  floorY: 64,
  wallY: 52,
  spriteW: 9,
  spriteH: 19,
  sitDrop: 4,
  machineX: 6,
  coolerX: 22,
  plantX: 34,
  deskStart: 44,
  boardW: 30,
  producerInset: 13,
  boardGap: 6,
  slotMin: 28,
  slotMax: 48,
  deskOffset: 9,
  seatOffset: 1,
  deskWMin: 14,
  deskWMax: 26,
  deskPad: 11,
  monitorW: 11,
  sofaNeed: 34,
  windowW: 18,
  windowStart: 44,
  windowEvery: 64,
  walkSpeed: 20,
  hurrySpeed: 34,
  spots: { machine: 10, cooler: 9, plant: 9, sofa: 8, peek: -10 },
  steam: { machine: [4, -25], mug: [-5, -10] },
  hit: { plant: [-1, 8, -20, 0], machine: [-1, 10, -24, -10] }
}

export const SPRITE_W = V1_PROFILE.spriteW
export const SPRITE_H = V1_PROFILE.spriteH
/** 坐下比站着矮几格 */
export const SIT_DROP = V1_PROFILE.sitDrop
export const SCENE_H = V1_PROFILE.sceneH
const ACCEL = 90

/** 至少要多宽才摆得下：厨房、白板、每人一格 */
export function minSceneWidth(desks: number, profile: OfficeProfile = V1_PROFILE): number {
  const P = profile
  return P.deskStart + P.boardW + P.producerInset + P.boardGap + 4 + Math.max(1, desks) * P.slotMin
}

export function computeLayout(
  width: number,
  deskIds: string[],
  profile: OfficeProfile = V1_PROFILE
): Layout {
  const P = profile
  const producerX = width - P.producerInset
  // 白板右边正好挨着制作人伸出去的手
  const boardX = producerX - P.boardW + 1
  const start = P.deskStart
  const end = boardX - P.boardGap
  const room = Math.max(0, end - start)
  const count = Math.max(1, deskIds.length)
  const slot = Math.max(P.slotMin, Math.min(P.slotMax, Math.floor(room / count)))
  const used = slot * deskIds.length
  // 工位排完还剩够一张沙发的地方，就在工位左边摆一张
  const sofaX = room - used >= P.sofaNeed ? start + 2 : null
  const deskStart = sofaX === null ? start + Math.max(0, Math.floor((room - used) / 2)) : end - used
  const desks = new Map<string, DeskSlot>()
  deskIds.forEach((id, index) => {
    const x = deskStart + index * slot
    const deskX = x + P.deskOffset
    const deskW = Math.max(P.deskWMin, Math.min(P.deskWMax, slot - P.deskPad))
    desks.set(id, {
      x,
      width: slot,
      seatX: x + P.seatOffset,
      deskX,
      deskW,
      monitorX: deskX + Math.floor((deskW - P.monitorW) / 2) + 1,
      mugUntil: 0
    })
  })
  const windows: number[] = []
  const windowSpan = boardX - 8 - P.windowStart
  const windowCount = Math.max(1, Math.min(4, Math.floor(windowSpan / P.windowEvery)))
  for (let i = 0; i < windowCount; i++) {
    windows.push(Math.round(P.windowStart + ((i + 0.5) * windowSpan) / windowCount - P.windowW / 2))
  }
  return {
    width,
    height: P.sceneH,
    floorY: P.floorY,
    wallY: P.wallY,
    machineX: P.machineX,
    coolerX: P.coolerX,
    plantX: P.plantX,
    sofaX,
    boardX,
    boardW: P.boardW,
    clockX: boardX + Math.floor(P.boardW / 2) - 3,
    windows,
    desks,
    producerX,
    profile: P
  }
}

export interface MemberInput {
  id: string
  name: string
  style: number
  crew: number
  look?: ModelLook
  mode: Mode
}

export interface SimOptions {
  random?: () => number
  /** 画风的几何，默认简约版 */
  profile?: OfficeProfile
  /** 减少动效：不走路（瞬移）、不放粒子 */
  reduced?: boolean
}

/** 可复现的随机数（测试里固定种子） */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const PRODUCER_ID = 'producer'

export class OfficeSim {
  layout: Layout
  actors = new Map<string, Actor>()
  particles: Particle[] = []
  time = 0
  /** 白板上制作人写到第几笔（制作人在跑时一直往上涨，满了擦掉重来） */
  boardInk = 0
  /** 验收没过：白板上空下一会儿小雨 */
  rainUntil = 0
  /** 咖啡机正在出咖啡 */
  brewUntil = 0
  /** 盆栽被戳了一下，晃到这个时刻 */
  plantShakeUntil = 0
  private random: () => number
  reduced: boolean
  readonly profile: OfficeProfile
  private taken = new Map<string, string>()

  constructor(width: number, options: SimOptions = {}) {
    this.random = options.random ?? Math.random
    this.reduced = !!options.reduced
    this.profile = options.profile ?? V1_PROFILE
    this.layout = computeLayout(width, [], this.profile)
  }

  /** 名册或宽度变了：重排工位。已经在场的人原地不动，下次走动时去新位置 */
  resize(width: number): void {
    const ids = [...this.actors.values()].filter((a) => !a.producer).map((a) => a.id)
    const mugs = new Map([...this.layout.desks].map(([id, desk]) => [id, desk.mugUntil]))
    this.layout = computeLayout(width, ids, this.profile)
    for (const [id, desk] of this.layout.desks) desk.mugUntil = mugs.get(id) ?? 0
    for (const actor of this.actors.values()) {
      actor.x = Math.max(-this.profile.spriteW, Math.min(width, actor.x))
      if (actor.seated) this.placeAtWork(actor)
    }
  }

  /**
   * 把这一刻每个人「该干嘛」交进来。新来的从左边门口走进来；
   * 名册里没了的直接离场。
   */
  sync(members: MemberInput[], producer: Mode, options: { fresh?: boolean } = {}): void {
    const ids = new Set(members.map((m) => m.id))
    let changed = false
    for (const id of [...this.actors.keys()]) {
      if (id !== PRODUCER_ID && !ids.has(id)) {
        this.release(id)
        this.actors.delete(id)
        changed = true
      }
    }
    for (const member of members) {
      const existing = this.actors.get(member.id)
      if (existing) {
        existing.name = member.name
        existing.style = member.style
        existing.crew = member.crew
        existing.look = member.look
        this.setMode(existing, member.mode)
        continue
      }
      changed = true
      const actor = this.spawn(member.id, member.name, member.style, member.crew, false)
      actor.mode = member.mode
      actor.look = member.look
      if (!options.fresh && !this.reduced) {
        // 新招来的：从门口走进来，挥挥手
        actor.x = -this.profile.spriteW - 2
        actor.entering = true
        actor.bubble = { icon: 'heart', until: this.time + 2.5 }
      }
      this.actors.set(member.id, actor)
    }
    if (!this.actors.has(PRODUCER_ID)) {
      const boss = this.spawn(PRODUCER_ID, '', 6, -1, true)
      boss.x = this.layout.producerX
      this.actors.set(PRODUCER_ID, boss)
    }
    this.setMode(this.actors.get(PRODUCER_ID)!, producer)
    if (changed) {
      this.resize(this.layout.width)
      if (options.fresh) for (const actor of this.actors.values()) this.snapToGoal(actor)
    }
  }

  private spawn(id: string, name: string, style: number, crew: number, producer: boolean): Actor {
    return {
      id,
      name,
      producer,
      style,
      crew,
      mode: { kind: 'idle' },
      x: 60 + this.random() * 40,
      vx: 0,
      facing: this.random() < 0.5 ? 1 : -1,
      targetX: null,
      arriveFacing: null,
      hurry: false,
      pose: 'stand',
      seated: false,
      stride: 0,
      errand: null,
      bubble: null,
      hop: 0,
      carrying: null,
      blinkAt: this.time + 1 + this.random() * 4,
      settle: 0,
      entering: false
    }
  }

  private setMode(actor: Actor, mode: Mode): void {
    const before = actor.mode
    actor.mode = mode
    if (sameMode(before, mode)) return
    // 要干活了：闲事放下（端着的咖啡带回工位）
    if (mode.kind !== 'idle' && actor.errand) {
      if (actor.errand.kind === 'chat' && actor.errand.partner) this.endChat(actor.errand.partner)
      this.dropErrand(actor)
    }
    if (mode.kind === 'work' && before.kind !== 'work') actor.hurry = true
    if (before.kind === 'out' && mode.kind !== 'out') actor.bubble = null
  }

  /** 测试和首帧用：直接摆到该在的位置 */
  private snapToGoal(actor: Actor): void {
    const goal = this.goalFor(actor)
    if (!goal) return
    actor.x = goal.x
    actor.facing = goal.facing
    actor.targetX = null
    actor.seated = goal.seat
    actor.pose = goal.pose
  }

  // ── 事件 ────────────────────────────────────────────────────────────

  /** 有人发了留言：一架纸飞机从发信人飞到收信人 */
  mail(from: string, to: string): void {
    const a = this.actors.get(from)
    const b = this.actors.get(to)
    if (!a || !b || a === b) return
    if (this.reduced) {
      b.bubble = { icon: 'mail', until: this.time + 2 }
      return
    }
    const start = this.headOf(a)
    const end = this.headOf(b)
    this.particles.push({
      kind: 'plane',
      x: start.x,
      y: start.y,
      vx: 0,
      vy: 0,
      life: 0,
      max: Math.max(0.9, Math.abs(end.x - start.x) / 70),
      from: start,
      to: { ...end, id: b.id }
    })
  }

  /** 某人标了完成：蹦两下，冒星星 */
  done(id: string): void {
    const actor = this.actors.get(id)
    if (!actor) return
    actor.bubble = { icon: 'check', until: this.time + 2.4 }
    if (this.reduced) return
    actor.hop = 0.9
    const head = this.headOf(actor)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
      this.particles.push({
        kind: 'spark',
        x: head.x,
        y: head.y - 2,
        vx: Math.cos(angle) * 18,
        vy: Math.sin(angle) * 14 - 6,
        life: 0,
        max: 0.7
      })
    }
  }

  /** 某人的活卡住了 */
  blocked(id: string): void {
    const actor = this.actors.get(id)
    if (actor) actor.bubble = { icon: 'bang', until: this.time + 3.5, alert: true }
  }

  /** 验收结论下来了 */
  verdict(result: 'pass' | 'fail'): void {
    const boss = this.actors.get(PRODUCER_ID)
    if (result === 'fail') {
      this.rainUntil = this.time + 6
      if (boss) boss.bubble = { icon: 'cross', until: this.time + 3, alert: true }
      return
    }
    for (const actor of this.actors.values()) {
      actor.bubble = { icon: 'heart', until: this.time + 3 }
      if (!this.reduced) actor.hop = 1.2
    }
    if (this.reduced) return
    for (let i = 0; i < 70; i++) {
      this.particles.push({
        kind: 'confetti',
        x: this.random() * this.layout.width,
        y: -this.random() * 30,
        vx: (this.random() - 0.5) * 12,
        vy: 14 + this.random() * 16,
        life: 0,
        max: 3.5 + this.random() * 1.5,
        tone: Math.floor(this.random() * 7) - 1
      })
    }
  }

  /** 用户点了一个小人：跳一下 */
  poke(id: string): void {
    const actor = this.actors.get(id)
    if (!actor) return
    if (!this.reduced) actor.hop = 0.45
    if (!actor.bubble || actor.bubble.until < this.time)
      actor.bubble = { icon: this.random() < 0.5 ? 'note' : 'q', until: this.time + 1.4 }
  }

  /** 用户点了场景里的物件 */
  pokeProp(prop: 'plant' | 'machine'): void {
    if (prop === 'plant') {
      this.plantShakeUntil = this.time + 0.8
      if (!this.reduced)
        this.particles.push({
          kind: 'leaf',
          x: this.layout.plantX + 3,
          y: this.layout.floorY - 16,
          vx: 6,
          vy: -4,
          life: 0,
          max: 2.2
        })
    } else {
      this.brewUntil = this.time + 2.5
    }
  }

  // ── 每一帧 ──────────────────────────────────────────────────────────

  step(dt: number): void {
    const d = Math.min(0.1, Math.max(0, dt))
    this.time += d
    for (const actor of this.actors.values()) this.think(actor)
    for (const actor of this.actors.values()) this.move(actor, d)
    this.ambient(d)
    this.stepParticles(d)
    const boss = this.actors.get(PRODUCER_ID)
    if (boss?.pose === 'write') {
      this.boardInk += d * 3
      if (this.boardInk > 40) this.boardInk = 0
    }
  }

  /** 这一刻该往哪去、到了摆什么姿势 */
  private goalFor(actor: Actor): { x: number; facing: 1 | -1; pose: Pose; seat: boolean } | null {
    const mode = actor.mode
    if (actor.producer) {
      if (mode.kind === 'board')
        return { x: this.layout.producerX, facing: -1, pose: 'write', seat: false }
      if (mode.kind === 'awaiting') {
        const desk = this.layout.desks.get(mode.on)
        if (desk)
          return { x: desk.seatX + this.profile.spots.peek, facing: 1, pose: 'stand', seat: false }
        return { x: this.layout.producerX, facing: -1, pose: 'stand', seat: false }
      }
      return null
    }
    const desk = this.layout.desks.get(actor.id)
    if (!desk) return null
    if (mode.kind === 'work')
      return { x: desk.seatX, facing: 1, pose: workPose(mode.tool), seat: true }
    if (mode.kind === 'wait') return { x: desk.seatX, facing: 1, pose: 'sit', seat: true }
    if (mode.kind === 'out') return { x: desk.seatX, facing: 1, pose: 'sleep', seat: true }
    return null
  }

  private think(actor: Actor): void {
    if (actor.bubble && actor.bubble.until < this.time) actor.bubble = null
    if (actor.mode.kind === 'wait' && !actor.bubble)
      actor.bubble = { icon: 'dots', until: Number.POSITIVE_INFINITY }
    if (actor.mode.kind !== 'wait' && actor.bubble?.icon === 'dots') actor.bubble = null
    if (actor.producer && actor.mode.kind === 'awaiting' && !actor.bubble)
      actor.bubble = { icon: 'dots', until: Number.POSITIVE_INFINITY }
    if (actor.producer && actor.mode.kind !== 'awaiting' && actor.bubble?.icon === 'dots')
      actor.bubble = null

    const goal = this.goalFor(actor)
    if (goal) {
      if (Math.abs(actor.x - goal.x) > 0.5) {
        this.walkTo(actor, goal.x, goal.facing)
      } else if (actor.targetX === null) {
        actor.facing = goal.facing
        if (goal.seat && !actor.seated) this.sitDown(actor)
        if (!goal.seat && actor.seated) this.standUp(actor)
        if (actor.settle <= 0) actor.pose = goal.pose
        actor.hurry = false
        if (actor.carrying === 'cup') {
          const desk = this.layout.desks.get(actor.id)
          if (desk) desk.mugUntil = this.time + 25
          actor.carrying = null
        }
      }
      return
    }

    // 闲着：手上没事就找点事
    if (!actor.errand) {
      if (actor.entering) {
        actor.entering = false
      }
      actor.errand = this.pickErrand(actor)
      if (!actor.errand) return
    }
    const errand = actor.errand
    if (!errand.arrived) {
      if (Math.abs(actor.x - errand.x) > 0.5) {
        this.walkTo(actor, errand.x, errand.facing)
        return
      }
      if (actor.targetX !== null) return
      errand.arrived = true
      actor.facing = errand.facing
      if (errand.kind === 'desk' || errand.kind === 'sofa') this.sitDown(actor)
      if (errand.kind === 'coffee') this.brewUntil = this.time + errand.stay
      if (errand.kind === 'plant') actor.carrying = 'can'
      if (errand.kind === 'sofa') actor.carrying = 'book'
      if (errand.kind === 'chat') actor.bubble = { icon: 'note', until: this.time + 1.5 }
      errand.stay += this.time
    }
    if (actor.settle <= 0) actor.pose = this.errandPose(actor, errand)
    if (this.time >= errand.stay) {
      if (errand.then === 'cup') actor.carrying = 'cup'
      else if (actor.carrying === 'can' || actor.carrying === 'book') actor.carrying = null
      this.dropErrand(actor)
    }
  }

  private errandPose(actor: Actor, errand: Errand): Pose {
    if (errand.kind === 'desk') {
      // 工位上待命：大多坐着，偶尔喝口咖啡、伸个懒腰
      const desk = this.layout.desks.get(actor.id)
      const phase = (this.time + actor.style * 1.7) % 9
      if (desk && desk.mugUntil > this.time && phase < 1.6) return 'drink'
      if (phase > 7.8) return 'stretch'
      return 'sit'
    }
    if (errand.kind === 'chat') {
      const partner = errand.partner ? this.actors.get(errand.partner) : undefined
      if (!partner || partner.errand?.partner !== actor.id) return 'stand'
      // 两人轮流说话
      const turn = Math.floor((this.time + (actor.id < partner.id ? 0 : 1.6)) / 1.6) % 2 === 0
      if (turn && (!actor.bubble || actor.bubble.until < this.time))
        actor.bubble = { icon: this.random() < 0.7 ? 'note' : 'q', until: this.time + 1.2 }
      return 'chat'
    }
    return errand.pose
  }

  private pickErrand(actor: Actor): Errand | null {
    const L = this.layout
    const S = this.profile.spots
    const desk = L.desks.get(actor.id)
    const options: { weight: number; make: () => Errand | null }[] = []
    const at = (
      kind: ErrandKind,
      spot: string | null,
      x: number,
      facing: 1 | -1,
      pose: Pose,
      stay: [number, number],
      then?: 'cup'
    ): Errand | null => {
      if (spot && this.taken.has(spot)) return null
      if (spot) this.taken.set(spot, actor.id)
      return {
        kind,
        spot,
        x: Math.round(x),
        facing,
        pose,
        stay: stay[0] + this.random() * (stay[1] - stay[0]),
        arrived: false,
        ...(then ? { then } : {})
      }
    }
    if (actor.producer) {
      options.push({
        weight: 3,
        make: () => at('board', 'board', L.producerX, -1, 'stand', [4, 8])
      })
      const busy = [...this.actors.values()].filter(
        (a) => !a.producer && a.mode.kind === 'work' && L.desks.has(a.id)
      )
      if (busy.length) {
        const target = busy[Math.floor(this.random() * busy.length)]!
        const targetDesk = L.desks.get(target.id)!
        options.push({
          weight: 2,
          make: () => at('peek', `peek:${target.id}`, targetDesk.seatX + S.peek, 1, 'stand', [3, 5])
        })
      }
      options.push({
        weight: 1,
        make: () =>
          at(
            'pace',
            null,
            L.boardX - 10 - this.random() * 30,
            this.random() < 0.5 ? 1 : -1,
            'stand',
            [1, 2.5]
          )
      })
    } else if (desk) {
      options.push({
        weight: 5,
        make: () => at('desk', `desk:${actor.id}`, desk.seatX, 1, 'sit', [6, 14])
      })
      options.push({
        weight: 1,
        make: () => at('stretch', null, actor.x, actor.facing, 'stretch', [1.2, 2])
      })
    }
    options.push({
      weight: 2,
      make: () => at('coffee', 'machine', L.machineX + S.machine, -1, 'stand', [2.2, 3.2], 'cup')
    })
    options.push({
      weight: 1.5,
      make: () => at('water', 'cooler', L.coolerX + S.cooler, -1, 'drink', [1.8, 3])
    })
    options.push({
      weight: 1,
      make: () => at('plant', 'plant', L.plantX + S.plant, -1, 'water', [2.5, 4])
    })
    L.windows.forEach((x, index) => {
      options.push({
        weight: 1,
        make: () => at('window', `window:${index}`, x + 6, 1, 'gaze', [3, 6])
      })
    })
    if (L.sofaX !== null) {
      options.push({
        weight: 1.5,
        make: () => at('sofa', 'sofa', L.sofaX! + S.sofa, 1, 'read', [6, 12])
      })
    }
    const partners = [...this.actors.values()].filter(
      (a) => a !== actor && a.mode.kind === 'idle' && !a.seated && !a.errand?.partner && !a.entering
    )
    if (partners.length) {
      options.push({
        weight: 1.5,
        make: () => {
          const partner = partners[Math.floor(this.random() * partners.length)]!
          if (partner.errand) this.dropErrand(partner)
          const meet = Math.max(8, Math.min(L.width - 16, Math.round((actor.x + partner.x) / 2)))
          const left = actor.x <= partner.x
          partner.errand = {
            kind: 'chat',
            spot: null,
            x: left ? meet + 5 : meet - 5,
            facing: left ? -1 : 1,
            pose: 'chat',
            stay: 3 + this.random() * 3,
            arrived: false,
            partner: actor.id
          }
          return {
            kind: 'chat',
            spot: null,
            x: left ? meet - 5 : meet + 5,
            facing: left ? 1 : -1,
            pose: 'chat',
            stay: partner.errand.stay,
            arrived: false,
            partner: partner.id
          }
        }
      })
    }
    const total = options.reduce((sum, o) => sum + o.weight, 0)
    for (let tries = 0; tries < 4; tries++) {
      let roll = this.random() * total
      for (const option of options) {
        roll -= option.weight
        if (roll > 0) continue
        const errand = option.make()
        if (errand) return errand
        break
      }
    }
    return null
  }

  private endChat(id: string): void {
    const partner = this.actors.get(id)
    if (partner?.errand?.kind === 'chat') this.dropErrand(partner)
  }

  private dropErrand(actor: Actor): void {
    if (actor.errand?.spot && this.taken.get(actor.errand.spot) === actor.id)
      this.taken.delete(actor.errand.spot)
    actor.errand = null
    if (actor.carrying === 'can' || actor.carrying === 'book') actor.carrying = null
  }

  private release(id: string): void {
    for (const [spot, owner] of [...this.taken]) if (owner === id) this.taken.delete(spot)
  }

  private walkTo(actor: Actor, x: number, facing: 1 | -1): void {
    if (actor.seated) {
      this.standUp(actor)
      return
    }
    if (actor.settle > 0) return
    actor.targetX = x
    actor.arriveFacing = facing
  }

  private sitDown(actor: Actor): void {
    if (actor.seated) return
    actor.seated = true
    actor.settle = this.reduced ? 0 : 0.18
    actor.pose = 'sit'
  }

  private standUp(actor: Actor): void {
    if (!actor.seated) return
    actor.seated = false
    actor.settle = this.reduced ? 0 : 0.22
    actor.pose = 'stand'
  }

  private placeAtWork(actor: Actor): void {
    const goal = this.goalFor(actor)
    if (goal?.seat) actor.x = goal.x
  }

  private move(actor: Actor, dt: number): void {
    if (actor.hop > 0) actor.hop = Math.max(0, actor.hop - dt)
    if (actor.settle > 0) {
      actor.settle = Math.max(0, actor.settle - dt)
      return
    }
    if (actor.targetX === null) {
      actor.vx = 0
      return
    }
    const dx = actor.targetX - actor.x
    if (this.reduced || Math.abs(dx) < 0.5) {
      actor.x = actor.targetX
      actor.vx = 0
      actor.targetX = null
      if (actor.arriveFacing) actor.facing = actor.arriveFacing
      actor.pose = 'stand'
      return
    }
    const top = actor.hurry ? this.profile.hurrySpeed : this.profile.walkSpeed
    // 快到了就慢下来：v² = 2as，停得住
    const brake = Math.sqrt(2 * ACCEL * Math.abs(dx))
    const want = Math.sign(dx) * Math.min(top, brake + 2)
    const change = Math.max(-ACCEL * dt, Math.min(ACCEL * dt, want - actor.vx))
    actor.vx += change
    const stepX = actor.vx * dt
    actor.x = Math.abs(stepX) >= Math.abs(dx) ? actor.targetX : actor.x + stepX
    actor.facing = actor.vx >= 0 ? 1 : -1
    actor.stride += Math.abs(stepX) / 3
    actor.pose = 'walk'
  }

  private ambient(dt: number): void {
    if (this.reduced) return
    const L = this.layout
    // 咖啡机出咖啡、桌上的热咖啡、睡着的人：冒点东西
    if (this.brewUntil > this.time && this.random() < dt * 8)
      this.particles.push(
        steam(
          L.machineX + this.profile.steam.machine[0] + this.random() * 2,
          L.floorY + this.profile.steam.machine[1]
        )
      )
    for (const desk of L.desks.values()) {
      if (desk.mugUntil > this.time && this.random() < dt * 2)
        this.particles.push(
          steam(
            desk.deskX + desk.deskW + this.profile.steam.mug[0],
            L.floorY + this.profile.steam.mug[1]
          )
        )
    }
    for (const actor of this.actors.values()) {
      if (actor.pose === 'sleep' && this.random() < dt * 0.9) {
        const head = this.headOf(actor)
        this.particles.push({
          kind: 'z',
          x: head.x + 4,
          y: head.y - 3,
          vx: 3,
          vy: -5,
          life: 0,
          max: 2.4
        })
      }
      if (actor.pose === 'water' && this.random() < dt * 10) {
        const dir = actor.facing
        this.particles.push({
          kind: 'drop',
          x: actor.x + (dir === 1 ? 9 : -3),
          y: L.floorY - 9,
          vx: dir * 2,
          vy: 10,
          life: 0,
          max: 0.5
        })
      }
      if (actor.pose === 'drink' && actor.errand?.kind === 'water' && this.random() < dt * 3)
        this.particles.push({
          kind: 'bubble',
          x: L.coolerX + 2 + this.random() * 3,
          y: L.floorY - 18,
          vx: 0,
          vy: -6,
          life: 0,
          max: 0.8
        })
    }
  }

  private stepParticles(dt: number): void {
    const keep: Particle[] = []
    for (const p of this.particles) {
      p.life += dt
      if (p.life >= p.max) {
        if (p.kind === 'plane' && p.to) {
          const target = this.actors.get(p.to.id)
          if (target) target.bubble = { icon: 'mail', until: this.time + 1.6 }
        }
        continue
      }
      if (p.kind === 'plane' && p.from && p.to) {
        const k = p.life / p.max
        const ease = k * k * (3 - 2 * k)
        p.x = p.from.x + (p.to.x - p.from.x) * ease
        // 抛物线：中间高出一截
        p.y = p.from.y + (p.to.y - p.from.y) * ease - Math.sin(Math.PI * k) * 14
        p.vx = p.to.x >= p.from.x ? 1 : -1
      } else {
        if (p.kind === 'confetti') p.vx += Math.sin((p.life + p.x) * 3) * dt * 20
        if (p.kind === 'spark') p.vy += 30 * dt
        if (p.kind === 'leaf') {
          p.vy = Math.min(8, p.vy + 10 * dt)
          p.vx = Math.sin(p.life * 4) * 8
        }
        p.x += p.vx * dt
        p.y += p.vy * dt
        if (p.kind === 'confetti' && p.y > this.layout.floorY + 4) p.vy = 0
      }
      keep.push(p)
    }
    this.particles = keep
  }

  /** 头顶的位置（纸飞机的起落点、气泡的位置） */
  headOf(actor: Actor): { x: number; y: number } {
    const P = this.profile
    const sitDrop = actor.seated ? P.sitDrop : 0
    return {
      x: Math.round(actor.x + Math.floor(P.spriteW / 2)),
      y: this.layout.floorY - (P.spriteH - 1) + sitDrop
    }
  }

  /** 这一帧眨不眨眼 */
  blinking(actor: Actor): boolean {
    if (this.time > actor.blinkAt + 0.14) actor.blinkAt = this.time + 2 + this.random() * 4
    return this.time >= actor.blinkAt
  }

  /** 鼠标在 (x, y) 时指着谁（场景坐标） */
  hit(x: number, y: number): Actor | null {
    let best: Actor | null = null
    for (const actor of this.actors.values()) {
      const head = this.headOf(actor)
      const left = Math.round(actor.x) - 2
      if (
        x >= left &&
        x <= left + this.profile.spriteW + 3 &&
        y >= head.y - 3 &&
        y <= this.layout.floorY + 1
      )
        best = actor
    }
    return best
  }

  hitProp(x: number, y: number): 'plant' | 'machine' | null {
    const L = this.layout
    const within = (
      origin: number,
      [left, right, top, bottom]: [number, number, number, number]
    ): boolean =>
      x >= origin + left && x <= origin + right && y >= L.floorY + top && y <= L.floorY + bottom
    if (within(L.plantX, this.profile.hit.plant)) return 'plant'
    if (within(L.machineX, this.profile.hit.machine)) return 'machine'
    return null
  }
}

function steam(x: number, y: number): Particle {
  return { kind: 'steam', x, y, vx: 0, vy: -6, life: 0, max: 1.6 }
}

function workPose(tool: ToolKind | 'think'): Pose {
  switch (tool) {
    case 'read':
      return 'read'
    case 'run':
      return 'lean'
    case 'look':
      return 'look'
    case 'play':
      return 'play'
    default:
      return 'type'
  }
}

function sameMode(a: Mode, b: Mode): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'work' && b.kind === 'work') return a.tool === b.tool
  if (a.kind === 'awaiting' && b.kind === 'awaiting') return a.on === b.on
  return true
}
