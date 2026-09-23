/**
 * 试玩机器人的假世界 —— 只给测试和离线评测脚本用，产品代码不 import。
 *
 * 平地、几堵墙、一个坑、一扇门、一个可选的主菜单。规则写死在这里，和引擎无关：
 * 测的是决策循环有没有按设计工作（校准、脱困、掉坑、点菜单、目标达成就停），
 * **不是**任何策略在真实游戏里好不好 —— 这里的场景是人想出来的，
 * 拿它比策略优劣会重蹈「合成用例没有预测能力」的覆辙（commit b6860c9）。
 */

import {
  BotRpcError,
  type BotRpc,
  type InjectActionParams,
  type InjectKeyParams,
  type NavQuery
} from './rpc'
import { runAutoplay, type AutoplayOptions, type AutoplayResult, type Clock } from './runner'
import { MemoryTrace } from './trace'
import type {
  AutoplayPolicy,
  ButtonInfo,
  InputActionInfo,
  LogLine,
  NavResult,
  Observation,
  SceneActor,
  SceneSnapshot,
  Vec3
} from './types'

export interface Box {
  minX: number
  maxX: number
  minY: number
  maxY: number
  /** 矮墙：刚跳过就能越过 */
  low?: boolean
  /** 射线撞到它时报的名字 */
  name?: string
  /** 属于哪道闸门：拉杆拉下之后这堵墙消失 */
  gate?: string
}

/**
 * 可交互的物件。靠近（< 2.5 米）按 IA_Interact 触发：
 *
 * - key：捡起来（打印 `Picked up <name>`），物件消失
 * - door：有钥匙就打印 `DoorOpened`，没有就打印 `The door is locked`
 * - lever：打印 `Lever pulled`，同名 gate 的墙消失
 * - chest：打印 `Chest opened`
 * - decor：什么都不发生（干扰项）
 * - goal：走到 2 米以内自动打印 `Reached <name>`（不用按键）
 */
export interface Item {
  name: string
  class: string
  location: Vec3
  kind: 'key' | 'door' | 'lever' | 'chest' | 'decor' | 'goal'
  /** lever 打开哪道闸门 */
  opens?: string
  /**
   * 蓝图语义（pie.scene 里的 parents / events / interfaces）。不给就按 kind 生成一套典型的。
   * 给了可以模拟「名字毫无意义、语义全在蓝图里」的工程
   */
  parents?: string[]
  events?: string[]
  interfaces?: string[]
}

export interface WorldConfig {
  start?: Vec3
  walls?: Box[]
  pit?: Box
  killZ?: number
  navmesh?: boolean
  actors?: Record<string, Vec3>
  door?: Vec3
  menu?: ButtonInfo[]
  /** 开局要过多少毫秒才有 pawn */
  pawnDelayMs?: number
  noPawn?: boolean
  /** 前进是哪根轴：默认 y（模板工程），x 模拟 Swizzle 配置不同的工程 */
  forwardAxis?: 'x' | 'y'
  /** 这个时间（毫秒）之后游戏自己停了 */
  endAtMs?: number
  actions?: InputActionInfo[]
  items?: Item[]
  /** false = 模拟没有 pie.scene 的老插件 */
  scene?: boolean
  /** false = 模拟没有 sensors 的老插件（没有落差探测） */
  sensors?: boolean
}

const KIND_SEMANTICS: Record<
  Item['kind'],
  { parents: string[]; events: string[]; interfaces: string[] }
> = {
  key: {
    parents: ['BP_Pickup_C', 'Actor'],
    events: ['OnPickedUp'],
    interfaces: ['BPI_Interactable_C']
  },
  door: {
    parents: ['BP_InteractableBase_C', 'Actor'],
    events: ['Interact', 'OpenDoor', 'Unlock'],
    interfaces: ['BPI_Interactable_C']
  },
  lever: {
    parents: ['BP_InteractableBase_C', 'Actor'],
    events: ['Interact', 'Pull'],
    interfaces: ['BPI_Interactable_C']
  },
  chest: {
    parents: ['BP_InteractableBase_C', 'Actor'],
    events: ['Interact', 'Open'],
    interfaces: ['BPI_Interactable_C']
  },
  decor: { parents: ['Actor'], events: [], interfaces: [] },
  goal: { parents: ['BP_TriggerZone_C', 'Actor'], events: ['OnPlayerEntered'], interfaces: [] }
}

const SPEED = 600 // 单位/秒
const FPS = 60

export class FakeClock implements Clock {
  t = 0
  now(): number {
    return this.t
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms
  }
}

export class FakeWorld implements BotRpc {
  pawn: { location: Vec3; name: string; velocityZ: number; falling: boolean } | null
  yaw = 0
  logs: LogLine[] = []
  buttons: ButtonInfo[]
  viewportIgnores: boolean
  clicked: string[] = []
  stopped: string | null = null
  respawns = 0
  private jumpedAt = -Infinity
  private seq = 0
  private randomIndex = 0
  private readonly start: Vec3

  constructor(
    private readonly clock: FakeClock,
    private readonly config: WorldConfig = {}
  ) {
    this.start = config.start ?? { x: 0, y: 0, z: 100 }
    this.pawn = config.noPawn
      ? null
      : { location: { ...this.start }, name: 'BP_Char_C_0', velocityZ: 0, falling: false }
    this.buttons = config.menu ? [...config.menu] : []
    this.viewportIgnores = Boolean(config.menu)
    this.items = [...(config.items ?? [])]
  }

  private tick(ms: number): void {
    this.clock.t += ms
  }

  private ended(): boolean {
    return (
      this.stopped !== null ||
      (this.config.endAtMs !== undefined && this.clock.t >= this.config.endAtMs)
    )
  }

  private assertPlaying(): void {
    if (this.ended()) throw new BotRpcError('Play is not running.', 'x', 409)
  }

  private log(kind: LogLine['kind'], text: string): void {
    this.logs.push({ seq: this.seq++, at: this.clock.t / 1000, kind, text })
  }

  private blocked(p: Vec3): Box | undefined {
    return (this.config.walls ?? []).find(
      (w) =>
        !(w.gate && this.openGates.has(w.gate)) &&
        p.x >= w.minX &&
        p.x <= w.maxX &&
        p.y >= w.minY &&
        p.y <= w.maxY
    )
  }

  readonly inventory = new Set<string>()
  readonly openGates = new Set<string>()
  items: Item[] = []

  private inPit(p: Vec3): boolean {
    const pit = this.config.pit
    return Boolean(pit && p.x >= pit.minX && p.x <= pit.maxX && p.y >= pit.minY && p.y <= pit.maxY)
  }

  /** 和插件 `pie.observe` 的 sensors 同形：八个方向的射线、前方落差、附近的物件 */
  sensorsAt(heading: number): Observation['sensors'] {
    if (!this.pawn) return undefined
    const origin = this.pawn.location
    const rays = [0, 45, 90, 135, 180, -135, -90, -45].map((angle) => {
      const rad = ((heading + angle) * Math.PI) / 180
      const ray: NonNullable<Observation['sensors']>['rays'][number] = { angle }
      for (let d = 10; d <= 800; d += 10) {
        const wall = this.blocked({
          x: origin.x + Math.cos(rad) * d,
          y: origin.y + Math.sin(rad) * d,
          z: origin.z
        })
        if (wall) {
          ray.low = d
          ray.hit = wall.name ?? 'Wall'
          ray.hit_class = 'StaticMeshActor'
          if (!wall.low) {
            ray.jump = d
            ray.head = d
          }
          break
        }
      }
      if (ray.low === undefined || ray.low > 144) {
        const ahead = { x: origin.x + Math.cos(rad) * 144, y: origin.y + Math.sin(rad) * 144, z: 0 }
        ray.drop = this.inPit(ahead) ? -1 : 0
      }
      return ray
    })
    const things: Array<{ name: string; class: string; location: Vec3 }> = [
      ...this.items,
      ...Object.entries(this.config.actors ?? {}).map(([name, location]) => ({
        name,
        class: `${name}_C`,
        location
      }))
    ]
    const nearby = things
      .map((thing) => {
        const distance = Math.hypot(thing.location.x - origin.x, thing.location.y - origin.y)
        const bearing =
          (Math.atan2(thing.location.y - origin.y, thing.location.x - origin.x) * 180) / Math.PI -
          heading
        let visible = true
        for (let f = 0.05; f < 1; f += 0.05) {
          const wall = this.blocked({
            x: origin.x + (thing.location.x - origin.x) * f,
            y: origin.y + (thing.location.y - origin.y) * f,
            z: origin.z
          })
          if (wall && !wall.low) visible = false
        }
        return {
          name: thing.name,
          class: thing.class,
          distance,
          bearing: (((bearing % 360) + 540) % 360) - 180,
          dz: thing.location.z - origin.z,
          location: thing.location,
          visible
        }
      })
      .filter((thing) => thing.distance <= 2500)
      .sort((a, b) => a.distance - b.distance)
    return {
      heading_yaw: heading,
      jump_height: 125,
      step_height: 45,
      capsule_radius: 42,
      capsule_height: 192,
      rays,
      nearby
    }
  }

  private interact(): void {
    if (!this.pawn) return
    const here = this.pawn.location
    const item = this.items.find(
      (it) => Math.hypot(it.location.x - here.x, it.location.y - here.y) < 250
    )
    if (!item) return
    switch (item.kind) {
      case 'key':
        this.inventory.add(item.name)
        this.items = this.items.filter((it) => it !== item)
        this.log('print', `Picked up ${item.name}`)
        break
      case 'door':
        if (this.inventory.size > 0) this.activated.add(item.name)
        this.log('print', this.inventory.size > 0 ? 'DoorOpened' : 'The door is locked')
        break
      case 'lever':
        if (item.opens) this.openGates.add(item.opens)
        this.activated.add(item.name)
        this.log('print', 'Lever pulled')
        break
      case 'chest':
        this.activated.add(item.name)
        this.log('print', 'Chest opened')
        break
      case 'decor':
      case 'goal':
        break
    }
  }

  private readonly reached = new Set<string>()

  private checkGoals(): void {
    if (!this.pawn) return
    for (const item of this.items) {
      if (item.kind !== 'goal' || this.reached.has(item.name)) continue
      const d = Math.hypot(
        item.location.x - this.pawn.location.x,
        item.location.y - this.pawn.location.y
      )
      if (d < 200) {
        this.reached.add(item.name)
        this.log('print', `Reached ${item.name}`)
      }
    }
  }

  private move(dirYaw: number, frames: number): void {
    if (!this.pawn) return
    const distance = (SPEED * frames) / FPS
    const rad = (dirYaw * Math.PI) / 180
    // 分小步走，撞墙就停在墙前
    const steps = Math.ceil(distance / 10)
    for (let i = 0; i < steps; i++) {
      const next = {
        x: this.pawn.location.x + (Math.cos(rad) * distance) / steps,
        y: this.pawn.location.y + (Math.sin(rad) * distance) / steps,
        z: this.pawn.location.z
      }
      const wall = this.blocked(next)
      if (wall && !(wall.low && this.clock.t - this.jumpedAt < 400)) break
      this.pawn.location = next
    }
    const pit = this.config.pit
    if (
      pit &&
      this.pawn.location.x >= pit.minX &&
      this.pawn.location.x <= pit.maxX &&
      this.pawn.location.y >= pit.minY &&
      this.pawn.location.y <= pit.maxY
    ) {
      this.pawn.location = { ...this.pawn.location, z: (this.config.killZ ?? -1000) - 50 }
    }
    this.checkGoals()
  }

  async observe(options: {
    targets?: string[]
    logSince?: number
    sensors?: boolean
    headingYaw?: number
  }): Promise<Observation> {
    this.tick(30)
    this.assertPlaying()
    // 掉出世界的角色在下一次观察时被 KillZ 回收并重生
    const killed = this.pawn && this.pawn.location.z < (this.config.killZ ?? -1000)
    const obs: Observation = {
      ok: true,
      playing: true,
      game_time: this.clock.t / 1000,
      frame: Math.round(this.clock.t / 16),
      paused: false,
      session_active: true,
      session_elapsed: this.clock.t / 1000,
      ...(this.config.killZ !== undefined ? { kill_z: this.config.killZ } : {}),
      pawn: null,
      has_controller: true,
      control_rotation: { pitch: 0, yaw: this.yaw, roll: 0 },
      input: {
        viewport_ignores_input: this.viewportIgnores,
        move_input_ignored: false,
        look_input_ignored: false,
        show_mouse_cursor: this.viewportIgnores,
        cinematic_mode: false
      },
      buttons: [...this.buttons]
    }
    const hasPawn = this.pawn && this.clock.t >= (this.config.pawnDelayMs ?? 0)
    if (hasPawn && this.pawn) {
      const falling = this.clock.t - this.jumpedAt < 400
      obs.pawn = {
        name: this.pawn.name,
        class: 'BP_Char_C',
        location: { ...this.pawn.location },
        rotation: { pitch: 0, yaw: this.yaw, roll: 0 },
        velocity: { x: 0, y: 0, z: falling ? 300 : 0 },
        speed: 0,
        movement_mode: falling ? 'falling' : 'walking',
        is_falling: falling,
        can_jump: !falling
      }
    }
    if (killed && this.pawn) {
      this.respawns++
      this.pawn = {
        location: { ...this.start },
        name: `BP_Char_C_${this.respawns}`,
        velocityZ: 0,
        falling: false
      }
    }
    if (options.targets) {
      obs.targets = options.targets.map((query) => {
        const location = this.config.actors?.[query]
        return location
          ? {
              query,
              found: true,
              name: query,
              label: query,
              location,
              ...(this.pawn
                ? {
                    distance: Math.hypot(
                      location.x - this.pawn.location.x,
                      location.y - this.pawn.location.y
                    )
                  }
                : {})
            }
          : { query, found: false }
      })
    }
    if (options.sensors && obs.pawn && this.config.sensors !== false) {
      obs.sensors = this.sensorsAt(options.headingYaw ?? this.yaw)
    }
    if (options.logSince !== undefined) {
      obs.logs = this.logs.filter((l) => l.seq >= (options.logSince ?? 0))
      obs.log_cursor = this.seq
    }
    return obs
  }

  async setView(yaw: number): Promise<void> {
    this.tick(20)
    this.assertPlaying()
    this.yaw = yaw
  }

  async injectAction(params: InjectActionParams): Promise<{ ok: boolean }> {
    this.assertPlaying()
    const frames = params.frames ?? 1
    this.tick((frames / FPS) * 1000 + 20)
    const axis = this.config.forwardAxis ?? 'y'
    switch (params.action) {
      case 'IA_Move': {
        const forward = axis === 'y' ? (params.y ?? 0) : (params.x ?? 0)
        const right = axis === 'y' ? (params.x ?? 0) : (params.y ?? 0)
        if (forward !== 0 || right !== 0) {
          const dir = this.yaw + (Math.atan2(right, forward) * 180) / Math.PI
          this.move(dir, frames)
        }
        break
      }
      case 'IA_Look':
        this.yaw += (params.x ?? 0) * 5
        break
      case 'IA_Jump':
        this.jumpedAt = this.clock.t
        break
      case 'IA_Interact':
        if (this.pawn && this.config.door) {
          const d = Math.hypot(
            this.config.door.x - this.pawn.location.x,
            this.config.door.y - this.pawn.location.y
          )
          if (d < 300) this.log('print', 'DoorOpened')
        }
        this.interact()
        break
      case 'IA_Broken':
        this.log('error', '[LogScript] Accessed None trying to read property CallFunc_GetWeapon')
        break
      case 'IA_Pause':
        this.buttons = [
          { id: 'WBP_Pause_C_0/Btn_Resume', owner: 'WBP_Pause_C_0', text: 'Resume', enabled: true }
        ]
        this.viewportIgnores = true
        break
    }
    return { ok: true }
  }

  async injectKey(params: InjectKeyParams): Promise<{ ok: boolean }> {
    this.assertPlaying()
    this.tick(((params.frames ?? 1) / FPS) * 1000 + 20)
    return { ok: true }
  }

  async click(id: string): Promise<{ text?: string }> {
    this.tick(20)
    this.assertPlaying()
    this.clicked.push(id)
    const button = this.buttons.find((b) => b.id === id)
    if (/start|resume|开始|继续/i.test(button?.text ?? '')) {
      this.buttons = []
      this.viewportIgnores = false
    }
    return { text: button?.text }
  }

  async navPath(query: NavQuery): Promise<NavResult> {
    this.tick(10)
    this.assertPlaying()
    if (!this.config.navmesh) return { ok: true, has_navmesh: false }
    if ('randomRadius' in query) {
      const ring = [
        { x: 1500, y: 0, z: 100 },
        { x: 0, y: 1500, z: 100 },
        { x: -1500, y: 0, z: 100 },
        { x: 0, y: -1500, z: 100 }
      ]
      return {
        ok: true,
        has_navmesh: true,
        found: true,
        point: ring[this.randomIndex++ % ring.length]
      }
    }
    const from = this.pawn?.location ?? this.start
    return { ok: true, has_navmesh: true, found: true, points: [from, query.to] }
  }

  async inputMap(): Promise<{
    source: 'runtime'
    input_system: 'enhanced'
    actions: InputActionInfo[]
  }> {
    this.tick(20)
    return {
      source: 'runtime',
      input_system: 'enhanced',
      actions: this.config.actions ?? [
        { name: 'IA_Look', value_type: 'Axis2D' },
        { name: 'IA_Move', value_type: 'Axis2D' },
        { name: 'IA_Jump', value_type: 'Boolean' },
        { name: 'IA_Interact', value_type: 'Boolean' },
        { name: 'IA_Broken', value_type: 'Boolean' }
      ]
    }
  }

  async stop(reason: string): Promise<void> {
    this.stopped = reason
  }

  /** 门开了、拉杆拉了、箱子开了 */
  readonly activated = new Set<string>()

  /** 这条线段上有没有挡路的墙（没开的闸门算） */
  private pathBlocked(from: Vec3, to: Vec3): boolean {
    for (let f = 0.02; f < 1; f += 0.02) {
      const wall = this.blocked({
        x: from.x + (to.x - from.x) * f,
        y: from.y + (to.y - from.y) * f,
        z: from.z
      })
      if (wall && !wall.low) return true
    }
    return false
  }

  async scene(headingYaw: number): Promise<SceneSnapshot> {
    this.tick(15)
    this.assertPlaying()
    if (this.config.scene === false)
      throw new BotRpcError('Unknown method: pie.scene', 'pie.scene', 404)
    const origin = this.pawn?.location ?? this.start
    const describe = (name: string, className: string, location: Vec3, item?: Item): SceneActor => {
      const semantics = item
        ? KIND_SEMANTICS[item.kind]
        : { parents: ['Actor'], events: [], interfaces: [] }
      const distance = Math.hypot(location.x - origin.x, location.y - origin.y)
      const bearing =
        (Math.atan2(location.y - origin.y, location.x - origin.x) * 180) / Math.PI - headingYaw
      const vars: Record<string, unknown> = {}
      if (item?.kind === 'door') {
        vars.bLocked = !this.activated.has(item.name)
        vars.bOpen = this.activated.has(item.name)
      }
      if (item?.kind === 'lever') vars.bPulled = this.activated.has(item.name)
      if (item?.kind === 'chest') vars.bOpened = this.activated.has(item.name)
      return {
        name,
        class: className,
        parents: item?.parents ?? semantics.parents,
        location,
        extent: { x: 50, y: 50, z: 100 },
        distance,
        bearing: (((bearing % 360) + 540) % 360) - 180,
        dz: location.z - origin.z,
        ...(item?.kind === 'goal' ? { trigger: true, reacts_to_overlap: true } : {}),
        ...((item?.events ?? semantics.events).length
          ? { events: item?.events ?? semantics.events }
          : {}),
        ...((item?.interfaces ?? semantics.interfaces).length
          ? { interfaces: item?.interfaces ?? semantics.interfaces }
          : {}),
        ...(Object.keys(vars).length ? { vars } : {}),
        ...(this.config.navmesh === false
          ? {}
          : {
              nav: this.pathBlocked(origin, location)
                ? ('partial' as const)
                : ('reachable' as const),
              path_length: distance
            })
      }
    }
    const actors = [
      ...this.items.map((item) => describe(item.name, item.class, item.location, item)),
      ...Object.entries(this.config.actors ?? {}).map(([name, location]) =>
        describe(name, `${name}_C`, location)
      )
    ].sort((a, b) => a.distance - b.distance)
    return {
      ok: true,
      level: 'FakeMap',
      has_navmesh: this.config.navmesh !== false,
      heading_yaw: headingYaw,
      total_relevant: actors.length,
      player: {
        location: origin,
        pawn_vars: { HasKey: this.inventory.size > 0, Health: 100 }
      },
      actors
    }
  }
}

export async function playInFakeWorld(
  config: WorldConfig,
  options: Partial<AutoplayOptions>,
  policy: AutoplayPolicy
): Promise<{ result: AutoplayResult; world: FakeWorld; trace: MemoryTrace }> {
  const clock = new FakeClock()
  const world = new FakeWorld(clock, config)
  const trace = new MemoryTrace()
  const result = await runAutoplay(
    { rpc: world, policy, trace, clock },
    { mode: 'explore', durationSeconds: 20, ...options }
  )
  return { result, world, trace }
}
