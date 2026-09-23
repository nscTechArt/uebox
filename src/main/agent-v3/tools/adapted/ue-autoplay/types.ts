/**
 * 试玩机器人用到的插件返回形状，以及机器人自己的决策记录格式。
 *
 * 零依赖：这些类型要被纯函数（策略、判定、摘要）和测试里的假世界共用，
 * 不能沾上 `services`（AGENTS §7 那个段错误的坑）。
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Rot3 {
  pitch: number
  yaw: number
  roll: number
}

export interface PawnState {
  name: string
  class: string
  location: Vec3
  rotation: Rot3
  velocity: Vec3
  speed: number
  /** walking / falling / swimming / flying / custom / none / unknown */
  movement_mode: string
  is_falling?: boolean
  can_jump?: boolean
}

export interface ButtonInfo {
  /** `<UserWidget 实例名>/<按钮名>`，点的时候原样传回 */
  id: string
  owner: string
  text: string
  enabled: boolean
}

export interface TargetInfo {
  query: string
  found: boolean
  name?: string
  label?: string
  class?: string
  location?: Vec3
  distance?: number
  match_count?: number
}

export interface LogLine {
  seq: number
  /** 开跑后第几秒（墙钟） */
  at: number
  kind: 'print' | 'error' | 'warning'
  text: string
}

export interface InputModeState {
  viewport_ignores_input: boolean
  move_input_ignored: boolean
  look_input_ignored: boolean
  show_mouse_cursor: boolean
  cinematic_mode: boolean
}

/** 八个方向之一上的射线读数。距离单位是虚幻单位（厘米），没撞到就没有那个字段 */
export interface SensorRay {
  /** 相对朝向的偏角：0 前、90 右、180 后、-90 左 */
  angle: number
  /** 台阶高度之上那一层撞到东西的距离 —— 角色走不过去 */
  low?: number
  /** 跳到最高点那一层撞到的距离。low 撞了而 jump 没撞（或更远）= 跳得过去 */
  jump?: number
  head?: number
  hit?: string
  hit_class?: string
  /** 往这个方向走一步之后脚下落差；-1 = 3000 单位以下都没有地 */
  drop?: number
  /** 前方是沟时，对面第一个能落脚的地方离角色多远（厘米） */
  landing?: number
  /** 那个落脚点比脚底高多少（负数 = 更低） */
  landing_dz?: number
  /** 前面障碍顶部比脚底高多少；高墙（头顶也撞）不量 */
  obstacle_top?: number
}

export interface NearbyActor {
  name: string
  class: string
  distance: number
  /** 相对朝向的方位角，-180~180，正为右 */
  bearing: number
  dz: number
  location: Vec3
  is_pawn?: boolean
  tags?: string[]
  visible: boolean
}

export interface Sensors {
  heading_yaw: number
  jump_height: number
  step_height: number
  capsule_radius: number
  capsule_height: number
  /** 以下是组合动作要的能力参数（老插件没有） */
  max_speed?: number
  jump_z?: number
  gravity?: number
  air_control?: number
  jump_max_count?: number
  rays: SensorRay[]
  nearby: NearbyActor[]
}

/** pie.scene 里的一个玩法对象 */
export interface SceneActor {
  name: string
  class: string
  /** 父类链（到第一个 C++ 类为止） */
  parents: string[]
  location: Vec3
  extent: Vec3
  distance: number
  bearing: number
  dz: number
  is_pawn?: boolean
  /** 有「重叠」碰撞 —— 走进去就会触发 */
  trigger?: boolean
  reacts_to_overlap?: boolean
  reacts_to_hit?: boolean
  tags?: string[]
  /** 「类型:名字」 */
  components?: string[]
  interfaces?: string[]
  /** 蓝图里写了的事件 / 函数名 */
  events?: string[]
  /** 蓝图变量当前值 */
  vars?: Record<string, unknown>
  /** 从玩家走过去：reachable / partial（半路被挡）/ unreachable / off_navmesh；没有导航网格时没有这个字段 */
  nav?: 'reachable' | 'partial' | 'unreachable' | 'off_navmesh'
  path_length?: number
}

export interface SceneSnapshot {
  ok: boolean
  level: string
  has_navmesh: boolean
  heading_yaw: number
  total_relevant: number
  truncated?: boolean
  player: {
    location?: Vec3
    pawn_vars?: Record<string, unknown>
    controller_vars?: Record<string, unknown>
    state_vars?: Record<string, unknown>
  }
  actors: SceneActor[]
}

/** pie.observe 的返回 */
export interface Observation {
  ok: boolean
  playing: boolean
  game_time: number
  frame: number
  paused: boolean
  session_active: boolean
  session_elapsed?: number
  kill_z?: number
  pawn: PawnState | null
  has_controller: boolean
  control_rotation?: Rot3
  input?: InputModeState
  buttons?: ButtonInfo[]
  buttons_truncated?: boolean
  targets?: TargetInfo[]
  logs?: LogLine[]
  log_cursor?: number
  logs_dropped?: boolean
  /** 只有请求里带 sensors:true 才有 */
  sensors?: Sensors
  /** 连续移动（pie.move_to）的进度；老插件没有 */
  move?: MoveStatus
}

export interface MoveStatus {
  active: boolean
  /** running / reached / blocked / edge / timeout / cancelled / replaced / no_pawn / idle */
  status: string
  detail?: string
  index: number
  points: number
  travelled: number
  jumps: number
  elapsed: number
  /** 最近发生的事：起跳、量到的障碍高度、在哪里被挡 */
  events?: string[]
}

/** pie.plan_path 的返回：没有导航网格时的网格 A* */
export interface PlanResult {
  ok: boolean
  found: boolean
  /** 找不到完整路线时，走到离目标最近那一格的半截路线 */
  partial: boolean
  points: Vec3[]
  length: number
  /** 路线上要跳上去的台阶数 */
  jumps: number
  ms: number
  /** 诊断：能走的格子数、起终点地面高度、原始格子路线 */
  walkable?: number
  start_floor?: number
  goal_floor?: number
  goal_walkable?: boolean
  raw?: Array<{ x: number; y: number; z: number; link?: number }>
}

export interface MoveRequest {
  points: Vec3[]
  accept_radius?: number
  final_radius?: number
  max_seconds?: number
  auto_jump?: boolean
  jump_gaps?: boolean
  stop_at_edge?: boolean
  edge_drop?: number
}

export interface InjectResult {
  ok: boolean
  error?: string
  injected_at?: 'action' | 'key'
  accepted?: boolean
  interrupted?: boolean
  viewport_ignores_input?: boolean
  move_input_ignored?: boolean
  warnings?: string[]
}

export interface NavResult {
  ok: boolean
  has_navmesh: boolean
  found?: boolean
  point?: Vec3
  points?: Vec3[]
  is_partial?: boolean
  length?: number
}

export interface BehaviourJson {
  type: string
  params?: Record<string, number | boolean | string>
}

export interface InputActionInfo {
  name: string
  value_type: string
  keys?: Array<{ key: string }>
  triggers?: BehaviourJson[]
}

export interface InputMapInfo {
  source: 'runtime' | 'asset'
  input_system: 'enhanced' | 'legacy' | 'both' | 'none'
  actions: InputActionInfo[]
  legacy_axes?: Array<{ name: string; keys: Array<{ key: string; scale: number }> }>
}

/** `pie.run` 的最终报告（只列机器人用得上的字段） */
export interface PieRunReport {
  ok: boolean
  error?: string
  ran?: boolean
  ended_by?: string
  elapsed_seconds?: number
  fixed_fps?: number
  print_strings?: string[]
  errors?: string[]
  warnings?: string[]
  error_count?: number
  warning_count?: number
  screenshot_path?: string
  screenshot_error?: string
  levels?: { editor_only_levels?: string[] }
}

// ---------------------------------------------------------------------------
// 决策点 —— 策略可替换的那个接缝
// ---------------------------------------------------------------------------

/**
 * 机器人在这些地方要「选一个」：
 *
 * - `ui`：屏幕上有按钮挡着，点哪个
 * - `waypoint`：探索时下一个去哪
 * - `unstick`：卡住了，怎么脱困
 *
 * 每一个决策点连同当时的状态、全部选项、选了哪个、为什么，都原样落进 trace。
 * 以后换策略（判定模型、大模型）时，拿同一批决策点离线回放就能比出谁更好 ——
 * 这是这份记录存在的全部理由，所以字段要够一个**没看过现场**的策略做判断。
 */
export type DecisionKind = 'ui' | 'waypoint' | 'unstick'

export interface DecisionOption {
  id: string
  label: string
  /** 策略能用的结构化特征（距离、访问次数、按钮是否启用……） */
  features?: Record<string, number | string | boolean>
}

export interface DecisionState {
  mode: 'explore' | 'goal' | 'objective'
  location?: Vec3
  yaw?: number
  movement_mode?: string
  input?: Partial<InputModeState>
  /** 目标（若有）的位置与距离 */
  goal?: { label: string; location?: Vec3; distance?: number }
  /** 最近几条 PrintString，给判「现在在哪个阶段」用 */
  recent_prints?: string[]
  /** 这个界面上已经点过的按钮 */
  tried?: string[]
}

export interface DecisionPoint {
  kind: DecisionKind
  state: DecisionState
  options: DecisionOption[]
}

export interface Choice {
  /** null = 一个都不选（比如按钮全被拦了） */
  optionId: string | null
  reason: string
}

export interface AutoplayPolicy {
  readonly name: string
  choose(point: DecisionPoint): Choice | Promise<Choice>
}
