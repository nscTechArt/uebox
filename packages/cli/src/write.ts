/**
 * 三个 Actor 写操作的**加强档**：CLI 在工具自己的回读之外，再核实一遍。
 *
 * ## 这张表曾经是准入表
 *
 * V1.1 时它决定「哪些写操作 CLI 肯发」，进来的只有三条。那道门已经拆了
 * （见 `tools.ts` 的文件头）：回读校验是工具自己的责任，CLI 不该把九十多个
 * 工具的语义抄一遍。**表留着，身份变了** —— 现在它是三个高频 Actor 操作的
 * 额外一层，不是别人的门槛。别再往里加条目来「放行」某个工具：任何非 `safe`
 * 工具加上 `--allow-write` 就能调，加条目只该出于一个理由 —— 你能为它写出
 * 一个比工具自己更强的外部判据。
 *
 * ## 这一层多做了什么
 *
 * | 工具 | 重发安全 | 外部判据 |
 * |---|---|---|
 * | `ue_set_transform`（仅绝对 `set`） | 是 | 回读变换，和请求值逐项比 |
 * | `ue_destroy_actor`（单个具名） | 是 | 回读那个名字，查不到 = 已删 |
 * | `ue_spawn_actor`（调用方命名） | **否** | 回读那个名字，查到 = 已生成 |
 *
 * 关卡内对象走 `FUAL_ScopedTransaction`，落在 agent 那条独立撤销栈上，
 * `ue_undo_history` 能查、`ue_undo` 能撤 —— 所以这三条还额外有回退路径。
 *
 * ## 收窄参数是这一层的代价，不是通用规矩
 *
 * 同一个工具，换一组参数就会从「能核实」掉进「不能核实」：
 *
 * - `ue_set_transform` 支持 `add` / `multiply`，它们**不幂等** ——
 *   `unknown` 之后重发一次就是移动两倍。只有绝对 `set` 走这一层。
 * - `snap_to_floor` 幂等，但我们说不出期望值（地板在哪个 Z 不知道），
 *   回读也就无从比对。
 * - `ue_spawn_actor` 不给 `name` 时由引擎分配（`Cube_2`），拿到 `unknown`
 *   之后分不清场上那个是这次生成的还是本来就有的。
 *
 * **这些收窄只约束走这一层的调用**。同一个工具要用 `add`、要用
 * `snap_to_floor`，直接 `uebox tools call ue_set_transform --allow-write`
 * 就行 —— 那条路不过这一层，核实由工具自己的返回值负责。
 */

import { UeboxError } from './errors.js'

/** 回读到的一个 Actor（`ue_get_actor` 的公共结果形状） */
export interface ActorReadback {
  name: string | null
  path: string | null
  class: string | null
  transform: {
    location: Record<string, number> | null
    rotation: Record<string, number> | null
    scale: Record<string, number> | null
  } | null
}

/** 回读之后的判定 */
export interface Verdict {
  /** 引擎的当前状态和请求一致吗 */
  done: boolean
  /** 说清楚看到了什么。不一致时这句就是给人的解释 */
  detail: string
}

export interface WriteOp {
  /** 底层工具名 */
  tool: string
  /**
   * `unknown` 之后直接重发安全吗。
   *
   * 幂等的重发一次没有代价；不幂等的必须先回读确认，这条差别会写进
   * 超时提示里（§12.4）。
   */
  idempotent: boolean
  /** 收窄到「回读判据单一确定」的参数子集。不合规抛 INVALID_ARGUMENT */
  constrain(args: Record<string, unknown>): void
  /**
   * 真正发给引擎的参数。**只由这里构造，不转发调用方的原始对象。**
   *
   * ## 为什么校验完还要重建一份
   *
   * 评审抓到的：`constrain` 通过 ≠ 发出去的东西安全。服务端把各路选择器
   * **并集**处理（`destroyActor.ts` 里 `if (input.name) names.add(input.name)`），
   * 所以 `{targets:{names:['A']}, name:'B'}` 两个都会删，而 CLI 只回读 A，
   * 照样报成功 —— 一次静默的多删。
   *
   * 光靠「把已知的坏组合逐个拒掉」堵不住这类洞：漏一个字段就是一个缺口，
   * 而服务端的兼容字段还会继续加。所以改成白名单式重建 —— 发出去的对象里
   * 只有这里明确写下的键，别的一律到不了引擎。
   */
  payload(args: Record<string, unknown>): Record<string, unknown>
  /** 这次动的是哪个 Actor。回读和超时提示都要用它 */
  subject(args: Record<string, unknown>): string
  /** 拿回读结果判定做没做成。`actor` 为 null 表示那个名字查不到 */
  verify(args: Record<string, unknown>, actor: ActorReadback | null): Verdict
  /**
   * 超时（`unknown`）之后，那条回读命令的结果该怎么读（§12.4）。
   *
   * 一句话讲清楚「查到算什么、查不到算什么」。**三条命令的读法各不相同** ——
   * 生成是查到算成功，删除是查不到算成功，变换要查到之后再比对数值。
   * 给一句通用的「查到 = 已生效」会把删除那条讲反。
   */
  readbackMeaning: string
}

// ── 参数取值助手 ────────────────────────────────────────────────────────────

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function reject(message: string, hint: string): never {
  throw new UeboxError('INVALID_ARGUMENT', message, hint)
}

/**
 * 服务端认识的所有「还能再指一个目标」的字段。
 *
 * 这张表是照着 `destroyActor.ts` / `setTransformUnified.ts` 的入参抄的，
 * 服务端把它们**并集**处理。CLI 一次只动一个对象，所以只要出现第二种指法，
 * 无论内容是什么都拒 —— 不去判断「它们是不是恰好指向同一个」，
 * 那种判断本身就会漏。
 */
const EXTRA_SELECTORS = ['path', 'batch', 'paths', 'filter', 'selection', 'instances'] as const

/**
 * 从参数里取出**恰好一个**名字，并且确认没有第二种指目标的方式。
 *
 * ## 评审抓到的两个洞，都在这里
 *
 * 1. `{targets:{names:['A']}, name:'B'}` 原来能过：拿到 `targets` 就不看
 *    `name` 了，而服务端两个都收 —— 删 A 也删 B，CLI 只回读 A，报成功。
 * 2. `{name:'A', targets:'{"filter":{}}'}` 原来能过：`targets` 是**字符串**时
 *    `object()` 返回 null，正好掉进兼容分支；而服务端明确接受 JSON 字符串
 *    （「targets 必须是对象或可解析的 JSON 字符串」），解析出来是个全关卡过滤器。
 *
 * 所以现在：`targets` 存在但不是对象 —— 拒；两种指法同时出现 —— 拒；
 * 出现任何一个额外选择器 —— 拒。
 */
function soleName(args: Record<string, unknown>, tool: string): string {
  for (const key of EXTRA_SELECTORS) {
    if (args[key] !== undefined) {
      reject(
        `${tool} 在 CLI 里不支持顶层 ${key}。`,
        '服务端会把它和其他选择器合并成一个目标集合，一次动到多个对象 —— ' +
          '那就没法在失败之后说清楚到底改了哪些。一次只点名一个 Actor。'
      )
    }
  }

  const hasTargets = args.targets !== undefined
  const compat = args.name

  if (hasTargets && typeof compat === 'string' && compat.trim() !== '') {
    reject(
      `${tool} 不能同时给 targets 和 name。`,
      '服务端会把两者并集处理，于是你以为动的是一个，实际动了两个。只给其中一种。'
    )
  }

  if (!hasTargets) {
    // 兼容字段 name：单个名字，语义和 targets.names 的单元素形式一样
    if (typeof compat === 'string' && compat.trim() !== '') return compat.trim()
    reject(
      `${tool} 需要用 targets: { names: ["名字"] } 点名一个 Actor。`,
      'CLI 只放行点名到单个 Actor 的写操作，见 uebox --help 的「写操作」一节。'
    )
  }

  const targets = object(args.targets)
  if (!targets) {
    // 字符串形式的 targets 服务端会 JSON.parse，等于绕过下面全部检查
    reject(
      `${tool} 的 targets 必须是一个对象。`,
      '服务端也接受 JSON 字符串形式，但那样 CLI 无法在发出前看清它指向谁，所以一律不收。'
    )
  }

  for (const key of ['filter', 'selection', 'paths'] as const) {
    if (targets[key] !== undefined) {
      reject(
        `${tool} 在 CLI 里不支持 targets.${key}。`,
        '它指向的对象集合要到引擎那边才知道，失败之后无法核实到底改了哪些。' +
          '改用 targets: { names: ["名字"] } 点名一个。'
      )
    }
  }

  const names = targets.names
  if (!Array.isArray(names) || names.length !== 1 || typeof names[0] !== 'string') {
    reject(
      `${tool} 在 CLI 里一次只能点名一个 Actor（targets.names 要正好一个名字）。`,
      '批量写操作不进这一版：部分成功会留下一个枚举不出来的状态，' +
        '失败之后说不清哪些做了、哪些没做。多个对象请一条一条发。'
    )
  }

  const name = (names[0] as string).trim()
  if (name === '') reject(`${tool} 的 targets.names 里是个空名字。`, '给一个真实的 Actor 名称。')
  return name
}

const XYZ = ['x', 'y', 'z'] as const
const PITCH_YAW_ROLL = ['pitch', 'yaw', 'roll'] as const

/**
 * 从一个变换里挑出 location / rotation / scale，每一项只留数值分量。
 *
 * 重建而不是转发：调用方给的对象里可能还挂着别的键，转发过去等于让没验证过的
 * 字段直达引擎。
 */
function pickTransform(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const parts = [
    ['location', XYZ],
    ['rotation', PITCH_YAW_ROLL],
    ['scale', XYZ]
  ] as const

  for (const [key, components] of parts) {
    const value = object(source[key])
    if (!value) continue
    const picked: Record<string, number> = {}
    for (const component of components) {
      if (typeof value[component] === 'number') picked[component] = value[component]
    }
    if (Object.keys(picked).length > 0) out[key] = picked
  }
  return out
}

// ── 变换比对 ────────────────────────────────────────────────────────────────

/**
 * 位置和缩放的比对容差。
 *
 * 引擎存的是 float，`200` 发过去回读可能是 `199.99998`。逐位相等会让一次
 * 成功的写操作报成失败，然后调用方去重发一条本来就已经生效的命令。
 */
const LOCATION_EPSILON = 0.01 // 厘米，即 0.1 毫米
const SCALE_EPSILON = 0.0001
const ANGLE_EPSILON = 0.01 // 度

/**
 * 角度差，取绕一圈之后的最短距离。
 *
 * `yaw: 370` 发过去回读是 `10`，`-180` 和 `180` 是同一个朝向。直接相减
 * 会把这些都判成不一致。
 */
function angleDelta(a: number, b: number): number {
  const diff = Math.abs(((a - b) % 360) + 360) % 360
  return Math.min(diff, 360 - diff)
}

/**
 * 请求的分量和回读的分量对得上吗。
 *
 * **只比请求里写了的分量。** 只设 `z` 的时候 `x`/`y` 保持原值，
 * 拿它们去比会把一次正确的写操作判成失败。
 */
function componentsMatch(
  requested: Record<string, unknown>,
  actual: Record<string, number> | null,
  epsilon: number,
  angular: boolean
): { ok: boolean; mismatch: string[] } {
  if (!actual) return { ok: false, mismatch: ['引擎没有回报这一项'] }

  const mismatch: string[] = []
  for (const [key, value] of Object.entries(requested)) {
    if (typeof value !== 'number') continue
    const got = actual[key]
    if (typeof got !== 'number') {
      mismatch.push(`${key}: 引擎没有回报`)
      continue
    }
    const delta = angular ? angleDelta(value, got) : Math.abs(value - got)
    if (delta > epsilon) mismatch.push(`${key}: 要求 ${value}，实际 ${got}`)
  }
  return { ok: mismatch.length === 0, mismatch }
}

// ── 准入表 ──────────────────────────────────────────────────────────────────

const setTransform: WriteOp = {
  tool: 'ue_set_transform',
  // 绝对设置：同样的请求发两次，结果一样
  idempotent: true,

  constrain(args) {
    soleName(args, 'ue_set_transform')

    const operation = object(args.operation)
    if (!operation) {
      reject(
        'ue_set_transform 需要 operation。',
        '这一版只放行绝对设置，形如 operation: { set: { location: { z: 200 } } }。'
      )
    }

    // add / multiply 不幂等 —— 拿到 unknown 之后重发一次就是移动两倍。
    // 这不是「参数校验」，这是准入条件本身（§12.3）
    for (const key of ['add', 'multiply'] as const) {
      if (operation[key] !== undefined) {
        reject(
          `ue_set_transform 在 CLI 里不支持 operation.${key}（增量/倍乘）。`,
          '增量变换不幂等：一次超时之后你无法判断该不该重发，' +
            '重发一次就是改了两倍。改用绝对值 operation: { set: {...} }。'
        )
      }
    }

    // 幂等，但说不出期望值 —— 地板在哪个 Z 只有引擎知道，回读无从比对
    if (operation.snap_to_floor !== undefined) {
      reject(
        'ue_set_transform 在 CLI 里不支持 operation.snap_to_floor。',
        '贴地的落点由引擎算，CLI 说不出期望值，也就没法回读核实。' +
          '先用 uebox actors list 查到地面高度，再用绝对值设置。'
      )
    }

    const set = object(operation.set)
    if (!set || Object.keys(set).length === 0) {
      reject(
        'ue_set_transform 需要 operation.set，且至少给一项 location / rotation / scale。',
        '例如 operation: { set: { location: { x: 0, y: 0, z: 200 } } }。'
      )
    }

    for (const key of Object.keys(set)) {
      if (!['location', 'rotation', 'scale'].includes(key)) {
        reject(
          `ue_set_transform 的 operation.set 里不认识 ${key}。`,
          '只支持 location（厘米）、rotation（度）、scale（倍数）。'
        )
      }
    }
  },

  subject: (args) => soleName(args, 'ue_set_transform'),

  // 只带走名字和 set 三项。space 之类的都不转发 —— 没验证过就不发
  payload: (args) => ({
    targets: { names: [soleName(args, 'ue_set_transform')] },
    operation: { set: pickTransform(object(object(args.operation)?.set) ?? {}) }
  }),

  readbackMeaning:
    '对照返回里的 transform：和你要求的数值一致 = 已生效，不用重发；' +
    '不一致 = 没生效，可以重发（绝对设置重发一次没有代价）。',

  verify(args, actor) {
    if (!actor) {
      return { done: false, detail: '回读时这个 Actor 已经不在关卡里了。' }
    }

    const set = object(object(args.operation)?.set) ?? {}
    const transform = actor.transform
    const problems: string[] = []

    const checks = [
      ['location', transform?.location ?? null, LOCATION_EPSILON, false],
      ['rotation', transform?.rotation ?? null, ANGLE_EPSILON, true],
      ['scale', transform?.scale ?? null, SCALE_EPSILON, false]
    ] as const

    for (const [key, actual, epsilon, angular] of checks) {
      const requested = object(set[key])
      if (!requested) continue
      const { ok, mismatch } = componentsMatch(requested, actual, epsilon, angular)
      if (!ok) problems.push(`${key} —— ${mismatch.join('；')}`)
    }

    return problems.length === 0
      ? { done: true, detail: '回读到的变换和请求一致。' }
      : { done: false, detail: `回读到的变换和请求对不上：${problems.join('；')}` }
  }
}

const destroyActor: WriteOp = {
  tool: 'ue_destroy_actor',
  // 删一个已经删掉的 Actor 是空操作
  idempotent: true,

  constrain(args) {
    if (args.batch !== undefined) {
      reject(
        'ue_destroy_actor 在 CLI 里不支持 batch。',
        '批量删除部分成功之后说不清哪些删了、哪些没删。一条一条发。'
      )
    }
    soleName(args, 'ue_destroy_actor')
  },

  subject: (args) => soleName(args, 'ue_destroy_actor'),

  // 只发 targets.names，一个名字。兼容字段一个都不带过去
  payload: (args) => ({ targets: { names: [soleName(args, 'ue_destroy_actor')] } }),

  // 注意这条和另外两条是反的：查不到才是成功
  readbackMeaning:
    '查不到 = 已经删掉了，不用重发；还查得到 = 没删掉，可以重发（重复删除是空操作）。',

  verify: (_args, actor) =>
    actor === null
      ? { done: true, detail: '回读查不到这个 Actor，已经删掉了。' }
      : { done: false, detail: `回读还能查到 ${actor.name ?? '这个 Actor'}，它还在关卡里。` }
}

const spawnActor: WriteOp = {
  tool: 'ue_spawn_actor',
  /**
   * **不幂等。** 重发一次就是第二个 Actor。
   *
   * 引擎在重名时会退让到 `MyCube_1`（`UAL_ActorCommands.cpp:168-176`），
   * 所以「这个名字在不在」只有在动手前那个名字是空的时候才是有效判据 ——
   * 这就是 `runtime` 那侧要先查一次重名的原因。
   */
  idempotent: false,

  constrain(args) {
    for (const key of ['instances', 'batch'] as const) {
      if (args[key] !== undefined) {
        reject(
          `ue_spawn_actor 在 CLI 里不支持 ${key}（一次生成多个）。`,
          '批量生成部分成功之后说不清生成了哪几个。一条一条发。'
        )
      }
    }

    const name = args.name
    if (typeof name !== 'string' || name.trim() === '') {
      reject(
        'ue_spawn_actor 在 CLI 里必须给 name。',
        '不给名字的话由引擎分配（Cube_2 这种）。一旦超时，你就分不清场上那个' +
          '是这次生成的还是本来就有的 —— 没有名字就没有回读判据。'
      )
    }

    if (!args.asset_id && !args.preset && !args.class) {
      reject(
        'ue_spawn_actor 需要 asset_id / preset / class 之一，说明要生成什么。',
        '推荐用 asset_id，它同时接受别名、资产路径和类名。'
      )
    }
  },

  subject: (args) => (args.name as string).trim(),

  payload: (args) => {
    const transform = pickTransform(object(args.transform) ?? {})
    return {
      name: (args.name as string).trim(),
      // 三个都是「生成什么」的别名，服务端取第一个有值的，这里也一样
      asset_id: (args.asset_id ?? args.preset ?? args.class) as string,
      ...(Object.keys(transform).length > 0 ? { transform } : {})
    }
  },

  // 这条是三条里唯一「重发有代价」的，所以话要说死。
  // 这段最终会打进终端，别在这里写 Markdown —— 终端不渲染，用户看见的就是星号
  readbackMeaning: '查到 = 已经生成了，不要重发（重发会多出第二个）；查不到 = 没生成，可以重发。',

  verify: (args, actor) => {
    const wanted = (args.name as string).trim()
    if (!actor) {
      return { done: false, detail: `回读查不到 ${wanted}，没有生成。` }
    }
    // 引擎重名时会退让到 MyCube_1，那说明我们要的那个名字没拿到。
    // 调用前已经确认过名字是空的，所以走到这里名字对不上就是真出事了
    return actor.name === wanted || actor.name === null
      ? { done: true, detail: `回读到 ${wanted}，已经生成。` }
      : {
          done: false,
          detail: `请求的名字是 ${wanted}，引擎给的是 ${actor.name} —— 多半是撞了重名。`
        }
  }
}

/** 准入表。不在这张表里的写工具一律不给 CLI 调 */
export const WRITE_OPS: Record<string, WriteOp> = {
  ue_set_transform: setTransform,
  ue_destroy_actor: destroyActor,
  ue_spawn_actor: spawnActor
}

/** 这个工具允许 CLI 写吗 */
export function admittedWrite(tool: string): WriteOp | undefined {
  return WRITE_OPS[tool]
}

/** 准入的写工具名，给帮助文本和测试用 */
export const ADMITTED_WRITE_TOOLS = Object.keys(WRITE_OPS)

export const UNDO_TOOL = 'ue_undo'
export const UNDO_HISTORY_TOOL = 'ue_undo_history'

/**
 * 撤销：准入，但**不走 `WriteOp` 那条路**。
 *
 * ## 为什么必须有它
 *
 * 外部评审抓到的：CLI 的写入落在 agent 那条独立撤销栈上，事务结束时
 * `PopScope()` 把 `GEditor->Trans` 还给用户的缓冲（`UAL_AgentUndo.cpp`）。
 * 所以**编辑器里按 Ctrl+Z 撤不到 CLI 的改动** —— 它撤的是用户自己上一步。
 * 之前提示里写「按 Ctrl+Z」，等于把用户往一个会误伤自己操作的动作上推。
 *
 * 能撤 CLI 那一步的只有 `ue_undo`。不给入口的话，写操作就是一条没有回头路的
 * 单行道，而「有回退路径」本来就是 §12.3 的准入条件之一。
 *
 * ## 为什么不塞进 `WRITE_OPS`
 *
 * `WriteOp` 整套是按「点名一个 Actor，回读那个名字」建的：`subject` 返回
 * Actor 名、`verify` 收 Actor 回读结果。撤销的判据完全不同 ——
 * 它比的是撤销栈的深度和栈顶标题。硬塞进去只会把那套接口撑变形。
 *
 * 所以它单独一条命令（`uebox actors undo`），自己做前后比对；
 * `tools call ue_undo` 则明确挡掉，免得绕开核实。
 */
export const UNDO_ADMITTED = new Set([UNDO_TOOL])
