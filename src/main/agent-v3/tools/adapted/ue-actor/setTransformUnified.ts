/**
 * 统一 Actor 变换工具
 * 适配新的 actor.set_transform 接口
 * 支持 targets（选择器） + operation（操作）结构
 *
 * targets 字段：
 *   - names: 字符串数组，指定 Actor 名称
 *   - paths: 字符串数组，指定 Actor 路径
 *   - filter: 筛选器对象，支持 class (包含匹配), name_pattern (通配符), exclude_classes (排除类名数组)
 *
 * operation 字段：
 *   - space: "World" (默认) 或 "Local"
 *   - snap_to_floor: true (执行贴地)
 *   - set: 绝对值设置 (location, rotation, scale)
 *   - add: 增量设置 (location, rotation, scale)，支持负数
 *   - multiply: 倍乘设置 (location, rotation, scale)
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import type { ActorInfoItem, GetActorInfoPayload } from './getActor'
import { worldFields, describeWorld, type WorldScopedResponse } from '../../worldScope'
import { UE_UNIT_NOTE, describePlacementScale } from '../../ueUnits'
import {
  UE_ROTATION_NOTE,
  describeOrientations,
  directionToRotator,
  sunToRotator,
  type SunInput
} from '../../ueOrientation'
import { describeToolError } from '../../engineErrors'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { withPartialHeadline, describeFailures, type PartialFailure } from '../../partialResult'
import {
  describeUnmatchedTargets,
  unmatchedTargetFields,
  type UnmatchedTargetsResponse
} from '../../unmatchedTargets'

/** UE 侧失败响应的字段。历史原因不统一，四种都可能出现 */
type RpcFailureShape =
  | {
      ok?: boolean
      success?: boolean
      __rpc?: { code?: string | number }
      code?: string | number
      error?: string
      message?: string
      details?: unknown
    }
  | null
  | undefined

/**
 * 统一变换请求参数
 * 注意：某些 AI 模型可能将嵌套对象序列化为 JSON 字符串传入，
 * 因此使用 z.unknown() 接受任意输入，在 execute 中手动解析和验证
 */
const SetTransformUnifiedParamsSchema = z.object({
  targets: z.unknown().describe('选择器：指定要操作的 Actor (对象或 JSON 字符串)'),
  operation: z.unknown().describe('操作：要执行的变换操作 (对象或 JSON 字符串)')
})

type ParsedTargets = {
  selection?: boolean
  names?: string[]
  paths?: string[]
  filter?: {
    class?: string
    name_pattern?: string
    exclude_classes?: string[]
  }
}

type RotatorInput = { pitch?: number; yaw?: number; roll?: number }
type Vec3Input = { x?: number; y?: number; z?: number }

type TransformSet = {
  location?: Vec3Input
  rotation?: RotatorInput
  scale?: Vec3Input
  /** 方向光专用：太阳在哪，工具算成 rotation */
  sun?: SunInput
  /** 让 +X 指向这个世界方向向量，工具算成 rotation（roll 归零） */
  face_direction?: Vec3Input
}

type Axis = 'x' | 'y' | 'z'

/** 运行时判轴。`Axis` 这个类型在这里是纸糊的 —— 入参走的是 z.unknown() + as 断言 */
function isAxis(value: unknown): value is Axis {
  return value === 'x' || value === 'y' || value === 'z'
}

/** 三个分量都在且都是有限数才算拿到了坐标：缺一个轴会算出 NaN，JSON 出去变 null */
function isFiniteVec(vec: { x?: number; y?: number; z?: number } | undefined): boolean {
  return !!vec && Number.isFinite(vec.x) && Number.isFinite(vec.y) && Number.isFinite(vec.z)
}

/** 真数字，不含 "200" 这种字符串。入参没有 schema 把关，这层要自己判 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * names 必须是一串非空字符串。
 *
 * `targets` 是 `z.unknown()` 断言来的，什么都可能进来。`names: "MyCube"` 的
 * `.length` 是 6，`for...of` 会把它拆成六个字符，回执变成「没找到：M、y、C、u、b、e」；
 * `names: ["A", 123]` 则会在不分大小写那步抛 TypeError，掉进外层 catch，
 * 连「这是 arrange 出的错」都看不出来。
 */
function isNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  )
}

/**
 * 沿一根轴把一批物体排开，间距按**包围盒边到边**算。
 *
 * 这个字段只在盒子这一侧存在，插件不认识它 —— 和 `sun` / `face_direction` 同一个路子：
 * 让调用方说意图，容易出错的那步算术由代码来背。
 *
 * 要背的是哪一步：`location` 填的是**原点**，而原点在几何体的哪个位置全看美术怎么做的
 * （引擎自带 SM_Cube 在角上，外部资产常在几何中心）。于是「沿街摆一排房子」写成
 * `x += 房子长度 + 间距` 对一半的资产是错的，而且摆歪了不报错，只能截图看。
 * 真机上为这个连试五次：固定槽位塞不下、按标称尺寸算把长宽看反、动态游标和探针法
 * 都栽在原点偏移上，最后靠拉大间距蒙混过去。
 *
 * 这里全程只碰包围盒：把每个物体的 min 边推到游标上，游标再前进「这个物体的实际尺寸 + gap」。
 * 原点偏移多少完全不参与计算，所以它是什么根本不重要 —— 那五次失败的根因在这个写法下不存在。
 */
type ArrangeInput = {
  /** 沿哪根轴排开 */
  axis?: Axis
  /** 相邻两个之间留多少厘米。**边到边**，不是中心到中心。默认 0 = 严丝合缝挨着 */
  gap?: number
  /** 第一个物体的起始边坐标（厘米）。不给就从这批物体当前最小的那条边开始，原地排齐 */
  start?: number
  /** 在另一根轴上对齐到一条线：把每个物体的 min / max / 中心贴到 value 上 */
  align?: { axis?: Axis; edge?: 'min' | 'max' | 'center'; value?: number }
}

type ParsedOperation = {
  space?: 'World' | 'Local'
  snap_to_floor?: boolean
  /** 盒子侧算完再发，插件不认识这个字段 */
  arrange?: ArrangeInput
  set?: TransformSet
  add?: { location?: Vec3Input; rotation?: RotatorInput; scale?: Vec3Input }
  multiply?: { location?: Vec3Input; rotation?: RotatorInput; scale?: Vec3Input }
  /** 也接受写在 operation 顶层，等价于 set.sun */
  sun?: SunInput
  /** 也接受写在 operation 顶层，等价于 set.face_direction */
  face_direction?: Vec3Input
}

/**
 * 把 sun / face_direction 换成 set.rotation，并从发给插件的 payload 里摘掉。
 *
 * 这两个字段存在的理由只有一个：方向光的 pitch 正负号是真机上反复出错的那一步
 * （`Pitch=+30` 是仰照，太阳在天上要写 -30）。让调用方说「太阳在哪」，正负号由代码来背。
 * 插件不认识这两个键，所以必须在这里消化掉，不能透传。
 *
 * 和 rotation 同时给是矛盾的，直接拒绝 —— 二选一比「谁覆盖谁」的规则好记。
 */
function resolveSemanticRotation(
  operation: ParsedOperation
): { operation: ParsedOperation; usedSemantic: boolean } | { error: string } {
  const sun = operation.sun ?? operation.set?.sun
  const face = operation.face_direction ?? operation.set?.face_direction
  if (!sun && !face) return { operation, usedSemantic: false }
  if (sun && face)
    return { error: 'sun 和 face_direction 只能给一个：方向光用 sun，其他东西用 face_direction' }
  if (operation.set?.rotation) {
    return {
      error: `set.rotation 和 ${sun ? 'sun' : 'face_direction'} 只能给一个，不然不知道听谁的`
    }
  }

  let rotation: RotatorInput
  if (sun) {
    if (typeof sun.elevation !== 'number' || !Number.isFinite(sun.elevation)) {
      return { error: 'sun.elevation 必填：太阳离地平线多高（度），黄昏 5～15，正午 60～90' }
    }
    if (sun.elevation <= 0) {
      return {
        error: `sun.elevation=${sun.elevation} 意味着太阳在地平线以下，光会从地底往上照。要的是黄昏就给 5～15`
      }
    }
    rotation = sunToRotator(sun)
  } else {
    const r = directionToRotator(face!)
    if (!r)
      return {
        error:
          'face_direction 是零向量，没有方向。给一个世界方向，比如「朝向相机」= 相机位置 - 自己位置'
      }
    rotation = r
  }

  const restOp: ParsedOperation = { ...operation }
  delete restOp.sun
  delete restOp.face_direction
  const restSet: TransformSet = { ...(operation.set ?? {}) }
  delete restSet.sun
  delete restSet.face_direction
  return {
    operation: { ...restOp, set: { ...restSet, rotation } },
    usedSemantic: true
  }
}

/**
 * 贴地到底贴上了没有 —— 必须说，而且必须说在正文里。
 *
 * 贴地是「命中了才有效」的操作：正下方没有碰撞体就一动不动。插件以前用一条
 * 不存在的 Exec 命令做这件事，于是每次都是「报 success、位置没变」，调用方
 * 只能靠反复回读位置才能发现（只能靠反复回读才能发现）。
 * 现在插件如实回 `snap.hit`，这里把它翻成人话 —— 没命中要连「下一步试什么」
 * 一起给，不然模型拿到 false 也只会再调一次。
 */
function describeSnap(response: SetTransformUnifiedResponse): string {
  const actors = response.actors ?? []
  const snaps = actors.map((a) => a.snap).filter((s): s is NonNullable<typeof s> => Boolean(s))
  if (snaps.length === 0) return ''

  const hit = snaps.filter((s) => s.hit)
  const missed = snaps.length - hit.length

  const parts: string[] = []
  if (hit.length > 0) {
    const first = hit[0]
    const surface = typeof first.surface_z === 'number' ? `${first.surface_z.toFixed(1)}` : '?'
    const dz = typeof first.moved_dz === 'number' ? first.moved_dz.toFixed(1) : '?'
    parts.push(
      `\n贴地：${hit.length} 个落到了地面上` +
        `（第一个落在 z=${surface}，挪动 ${dz} 厘米，打到 ${first.hit_actor || '未知物体'}` +
        `，走 ${first.channel} 碰撞通道）`
    )
  }
  if (missed > 0) {
    parts.push(
      `\n⚠️ 贴地：${missed} 个正下方没有碰撞体，**位置没有变**。` +
        `地面网格可能没做碰撞 —— 先确认那块地有碰撞，或者读一个明显已经落地的道具的 bounds_min.z 当地面高度直接摆。`
    )
  }
  return parts.join('')
}

/** 这次操作动了旋转没有 —— 动了才值得在回读里说朝向，光挪位置就不刷屏 */
function touchesRotation(operation: ParsedOperation): boolean {
  return Boolean(operation.set?.rotation || operation.add?.rotation || operation.multiply?.rotation)
}

/**
 * Actor 结果结构
 */
interface ActorResult {
  name?: string
  path?: string
  class?: string
  location?: { x: number; y: number; z: number }
  rotation?: { pitch: number; yaw: number; roll: number }
  scale?: { x: number; y: number; z: number }
  /** 只有请求了 snap_to_floor 才有：贴地这一步的实际结果 */
  snap?: {
    hit?: boolean
    channel?: string
    surface_z?: number
    moved_dz?: number
    bottom_offset?: number
    hit_actor?: string
    reason?: string
  }
  /** 新插件：这个 Actor 没落到目标值上时为 false，并附目标值和原因。location 等仍是引擎回读值 */
  applied?: boolean
  warning?: string
  requested?: {
    location?: { x: number; y: number; z: number }
    rotation?: { pitch: number; yaw: number; roll: number }
    scale?: { x: number; y: number; z: number }
  }
}

/**
 * 统一变换响应数据
 * 注意：插件端返回的 JSON-RPC 响应中，result 对象包含这些字段
 * 插件端不会显式返回 ok/success 字段，需要通过 count 来判断成功
 */
interface SetTransformUnifiedResponse extends WorldScopedResponse, UnmatchedTargetsResponse {
  ok?: boolean
  success?: boolean
  count?: number
  reported?: number
  report_limit?: number
  actors?: ActorResult[]
  /** 新插件：没落到目标变换上的 Actor 个数和名单（名单有上限，个数没有） */
  failed_count?: number
  failed?: Array<{ name?: string; path?: string; reason?: string }>
  error?: string
  /** 插件有时把失败原因放在 message 而不是 error 上，两个都要看 */
  message?: string
}

/** actor.get_info 回的字段里，排布要用到的那几个 */
/**
 * 排布要用到的那几个字段，**从 `getActor.ts` 的那份派生**，不要另写一份。
 *
 * 同一条 `actor.get_info` 命令原来在两个文件里各有一份字段表。改名一个协议键
 * （`return_bounds`、`include_system_actors`）时，getActor 那边的调用点会当场
 * 编译不过，而这边照发那个已经没人认的键、静默拿不到包围盒，最后报成
 * 「这个 Actor 没有几何体」—— 错得离真因很远。派生就不会有第二份可漂移的真相。
 *
 * `bounds` 留在表里是**诊断要用**：插件只在 `Bounds.IsValid` 时才发 min/max，
 * 而 `bounds` 是无条件发的。两者一起看才分得清「插件太旧」和「没有几何体」。
 *
 * **但要包一层 `Partial`。** `ActorInfoItem` 把 name / path / transform.location
 * 都声明成必填，那是「插件正常时长什么样」的描述，不是校验过的事实 ——
 * 这是 WebSocket 上过来的 JSON，没有任何运行时校验。直接 Pick 会让
 * `actor.name?.toLowerCase()`、`actor.path ? … : …`、`isFiniteVec(actor.transform?.location)`
 * 这些守卫在编译器眼里变成多余（eslint 的 no-unnecessary-condition 会这么报），
 * 下一个人顺手删掉一个，遇到老插件就在 `actor.transform!.location!` 上炸 ——
 * 而那正是「没回包围盒」那道守卫要拦的情况。派生要，假保证不要。
 */
type ArrangeActorInfo = Partial<
  Pick<ActorInfoItem, 'name' | 'path' | 'bounds' | 'bounds_min' | 'bounds_max'>
> & {
  /** location 也得是可选的：老插件不回 transform，回了也可能缺 location */
  transform?: Partial<NonNullable<ActorInfoItem['transform']>>
}

/** 名字列表最多列几个。和 `unmatchedTargets.ts` 的 MAX_LISTED 同一个数 */
const MAX_LISTED_NAMES = 8

/**
 * 名字列表折一下再进错误信息。
 *
 * `MAX_ARRANGE` 是 100，不折的话一次写错的批量就能把 100 个 Actor 名字
 * 整段塞进模型的上下文里 —— 而看前八个就足够认出自己写错了什么。
 */
function listNames(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED_NAMES).join('、')
  const rest = names.length - MAX_LISTED_NAMES
  // 省略号也要跟 unmatchedTargets.ts 一致，免得同一份回执里出现两种写法
  return rest > 0 ? `${shown} …（还有 ${rest} 个）` : shown
}

/** get_info 的回包：除了 actors，世界归属和没对上的名字都要带出来 */
interface ArrangeInfoResponse extends WorldScopedResponse, UnmatchedTargetsResponse {
  ok?: boolean
  success?: boolean
  actors?: ArrangeActorInfo[]
  total_found?: number
  error?: string
  message?: string
}

/**
 * 一次最多排几个。
 *
 * 排布是**一个物体一次 set_transform**（每个的目标位置都不一样，插件那条命令
 * 一次只能设一个位置），所以这个数就是往返次数。和 `ue_spawn_actor` 的 50 同一个道理：
 * 与其让一次工具调用堵上好几分钟，不如让调用方分批、每批都看得见结果。
 */
const MAX_ARRANGE = 100

/**
 * 单个 Actor 挪一次给多久。
 *
 * **不要沿用批量那条路的 120 秒。** 那边一次命令动整批，慢是应该的；这边一次只动
 * 一个，而且最多要发 100 次 —— 120 秒乘 100 是 3.3 小时，正好和 `MAX_ARRANGE`
 * 注释里「别让一次工具调用堵上好几分钟」那句话相反。取 30 秒，和上面那次
 * `actor.get_info` 一致（它还要扫全关卡，比这个重）。
 */
const ARRANGE_STEP_TIMEOUT = 30_000

/**
 * 整个排布的总时限。
 *
 * 光有单步超时是兜不住的：100 步 × 30 秒还是 50 分钟，比 `MAX_ARRANGE` 注释里
 * 承诺的「好几分钟」大一个数量级，也比 `ue_run_python_script` 对外写的 5 分钟上限
 * 长十倍。单步超时只能保证「不会卡在某一个上」，管不住「一步一步慢慢耗光一小时」。
 * 超了就从 `partial()` 那条路出去 —— 已经挪了几个、重试要带什么 start，都在那儿。
 */
const ARRANGE_TOTAL_BUDGET = 5 * 60_000

/**
 * 这一次 set_transform 到底动成了没有。
 *
 * 引擎报错是 **resolve 不是 throw**：`services/websocket/server.ts` 把 code>=400
 * 规范化成 `{ ok:false, success:false, error }` 原样返回。所以「await 了没抛异常」
 * 完全不等于「改成功了」—— 不看回包的话，404（这个 Actor 刚被改名/卸载了）
 * 和真的挪好了长得一模一样。
 *
 * **和非 arrange 那条路共用一个判据。** 这里原来漏了 `ok === true` 那一支，于是
 * 一个只回 `{ok:true}`、不带 count 的老插件在 set/add 那边算成功、在 arrange 这边
 * 算「引擎没确认挪动」—— 而 arrange 失败即停，整排会在第一个之后放弃，回执还说
 * 「前 N 个已经挪到新位置了」。同一份回包不能有两种读法，所以抽成一个函数两边都用。
 */
function transformApplied(
  response: Pick<SetTransformUnifiedResponse, 'ok' | 'success' | 'count' | 'actors'> | undefined
): boolean {
  if (response?.ok === false || response?.success === false) return false
  if (response?.ok === true || response?.success === true) return true
  const affected = response?.count ?? response?.actors?.length ?? 0
  return affected > 0
}

/**
 * 沿一根轴排开，全程只用包围盒。
 *
 * 三步：读回各自的真实包围盒 → 把每个物体的 min 边推到游标上 → 游标前进「实际尺寸 + gap」。
 * 原点在哪不参与计算，所以「原点在角上还是在中心」这个最常见的摆放事故在这里不存在。
 */
async function arrangeActors(
  wsService: ReturnType<typeof serviceManager.getWebSocketService>,
  targets: ParsedTargets,
  arrange: ArrangeInput,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const axis = arrange.axis
  if (!isAxis(axis)) {
    return { success: false, error: 'arrange.axis 必填，取 "x" / "y" / "z" 之一：沿哪根轴排开。' }
  }

  /*
   * 数字字段给错类型要**报错**，不能悄悄用默认值顶上。
   *
   * 模型把嵌套对象序列化成 JSON 字符串是这个文件从头就在防的事（execute 里那一大段
   * JSON.parse 兜底就是为它写的），所以 `gap: "200"` 是个现实输入。而它原来会静默
   * 变成 `gap = 0`：20 栋楼严丝合缝贴在一起，success 照报，回执还说「间距 0 厘米」——
   * 自洽得看不出毛病，只有截图才发现。`start: "-800"` 同理，整排落在原地。
   * 下面 align 的三个字段都是硬拒绝的，这两个没道理宽松。
   */
  if (arrange.gap !== undefined && !isFiniteNumber(arrange.gap)) {
    return {
      success: false,
      error: `arrange.gap 要是数字（厘米），收到的是 ${JSON.stringify(arrange.gap)}。字符串不会被当成数字。`
    }
  }
  if (arrange.start !== undefined && !isFiniteNumber(arrange.start)) {
    return {
      success: false,
      error: `arrange.start 要是数字（厘米），收到的是 ${JSON.stringify(arrange.start)}。字符串不会被当成数字。`
    }
  }
  const gap = isFiniteNumber(arrange.gap) ? arrange.gap : 0

  /*
   * align 的三个字段都要真校验，不能只看「给没给」。
   *
   * `inputSchema` 是 `z.unknown()`、`operation` 是个裸 `as` 断言，所以 `Axis`
   * 那个类型在运行时一点保护都没有。写成 `axis: "X"`（大写，而且工具自己的
   * 消息就印大写的「已沿 Y 轴」）会一路滑过去：`min["X"]` 是 undefined，
   * 算出 NaN 写进一个叫 "X" 的野键，JSON 出去变成 null，插件忽略它 ——
   * 什么都没对齐，回执却照样说「对齐到 X=-1310」。edge 拼错同理，会静默退回 min。
   */
  const align = arrange.align
  const alignAxis = align?.axis
  const alignValue = align?.value
  const alignEdge = align?.edge ?? 'min'
  if (align) {
    if (!isAxis(alignAxis)) {
      return {
        success: false,
        error: `arrange.align.axis 要是 "x" / "y" / "z" 之一（小写），收到的是 ${JSON.stringify(alignAxis)}。`
      }
    }
    if (typeof alignValue !== 'number' || !Number.isFinite(alignValue)) {
      return {
        success: false,
        error:
          'arrange.align.value 必填且要是有限数字，例如 { axis: "x", edge: "min", value: -1310 }。'
      }
    }
    if (align.edge !== undefined && !['min', 'max', 'center'].includes(align.edge)) {
      return {
        success: false,
        error: `arrange.align.edge 要是 "min" / "max" / "center" 之一，收到的是 ${JSON.stringify(align.edge)}。`
      }
    }
    if (alignAxis === axis) {
      return {
        success: false,
        error: `arrange.align.axis 不能和 arrange.axis 都是 ${axis}：同一根轴既要排开又要对齐到一点，做不到。`
      }
    }
  }

  // names 的形状要在发命令之前定下来：下面整段排序逻辑都按「一串字符串」写的
  if (targets.names !== undefined && !isNameList(targets.names)) {
    return {
      success: false,
      error:
        `targets.names 要是字符串数组（如 ["A", "B"]），收到的是 ${JSON.stringify(targets.names)}。` +
        '单个名字也要写成数组。'
    }
  }
  const wantedNames = isNameList(targets.names) ? targets.names : undefined

  // 标上 GetActorInfoPayload：协议键改名时这里要和 getActor 一起编译不过，
  // 而不是默默发一个没人认的键、再把拿不到的包围盒报成「没有几何体」
  const infoPayload: GetActorInfoPayload = {
    targets,
    return_transform: true,
    return_bounds: true,
    limit: MAX_ARRANGE + 1,
    // 显式发 false：这是跨进程的协议字段，别让「默认值由谁负责」跨两层去推断。
    // 用 filter:{} 排整个关卡时，漏掉它会把 HLOD 之类的系统 Actor 也排进去
    include_system_actors: false
  }
  const info = await wsService.callRequest<ArrangeInfoResponse>(
    'actor.get_info',
    infoPayload,
    getTargetConnectionId(),
    30000
  )

  /*
   * 查询失败和「一个都没选中」必须分开报。
   *
   * 引擎报错是 resolve 不是 throw，失败的回包里没有 `actors`，于是「插件太旧、
   * filter 键名写错、编辑器里没有世界」全都会被当成「你的选择条件不对」。
   * 模型照这句话去 ue_get_actor 查一遍（那个会成功），确认选择条件没问题，
   * 再来调 arrange —— 死循环。真实错误要原样带出去。
   */
  if (info?.ok === false || info?.success === false) {
    const failure = info as RpcFailureShape
    const code = failure?.__rpc?.code ?? failure?.code
    /*
     * 点名的名字**一个都没对上**时，引擎回的是 404，不是「200 + 空 actors」。
     *
     * 插件那侧分得很细：`ResolveTargetsToActors` 对显式 targets 全空时写的是
     * "No actor found matching the specified names/paths"，而 `Handle_GetActorInfo`
     * 只把 filter 那条（"No actor matched targets"）翻译成 200 空列表，其余一律
     * SendError(404)。于是「名字写错」这个最常见的情况会走到这里，拿到一句英文，
     * 下面那段「arrange 不会少排几个凑合过去」的中文指引反而只在**部分**没对上时才出现。
     * 更糟的是 404 = RPC_NOT_FOUND，适配层会把它抛成 EngineNotFoundError
     * （那个类型的定义是「按条件没查到，不是故障」）—— 名字写错却报成查询无结果。
     * 所以这里把它接回同一句话。
     */
    if (code === 404 && wantedNames?.length) {
      return {
        success: false,
        error:
          `这些名字在关卡里一个都没对上：${listNames(wantedNames)}。` +
          'arrange 不会少排几个凑合过去 —— 名字核对好再重发（ue_get_actor 可以查真实名字）。',
        unmatched_targets: wantedNames,
        unmatched_count: wantedNames.length
      }
    }
    return {
      success: false,
      error: `arrange 查询 Actor 失败：${failure?.error || failure?.message || '未收到有效响应'}`,
      code,
      details: failure?.details
    }
  }

  const found = info?.actors ?? []
  if (found.length === 0) {
    return {
      success: false,
      error: 'arrange 没有选中任何 Actor，先用 ue_get_actor 确认选择条件。',
      ...unmatchedTargetFields(info)
    }
  }
  if (found.length > MAX_ARRANGE) {
    // limit 把回包截到 MAX_ARRANGE+1，所以 found.length 不是真实总数；
    // 有 total_found 就报它，否则说「至少」，别让调用方照一个截断数去分批
    const total = info?.total_found
    const howMany = typeof total === 'number' ? `${total}` : `至少 ${found.length}`
    return {
      success: false,
      error: `选中了 ${howMany} 个，一次最多排 ${MAX_ARRANGE} 个（每个都要一次往返）。分批来。`
    }
  }

  /*
   * 给了 names 就按 names 的顺序排 —— 「这条街从南到北依次是这几栋」是调用方的意图，
   * 按当前坐标重排会把它丢掉。没给 names（filter / selection）时才按现在的位置排序，
   * 那种情况下调用方本来也说不出顺序。
   *
   * 两件事不能用 `find` 一把梭：
   * 1. **名字不唯一**（getActor.ts 里明写着「path 是唯一的，名字不是」）。`find`
   *    对重复的名字每次都返回同一个对象，于是那一个被摆两次、它的同名兄弟一次没动，
   *    而回执按 names 的条数报「排了 2 个」。所以取一个就划掉一个。
   * 2. **引擎的名字匹配不分大小写**，回给我们的是 GetActorLabel() 的原样大小写。
   *    调用方写 "wall_a"、引擎回 "Wall_A"，严格 === 会全军覆没。先原样匹配，
   *    再退回到不分大小写 —— 和引擎那侧的规则对齐。
   */
  const missingNames: string[] = []
  const exhaustedNames: string[] = []
  let ordered: ArrangeActorInfo[]
  if (wantedNames?.length) {
    const pool = [...found]
    /*
     * 「池子里没了」和「关卡里没有」是两回事，报错要分开说。
     *
     * 引擎把名字解析成 `TSet<AActor*>`，而 `FindActorByLabel` 对一个名字只返回
     * **第一个**命中、且不分大小写。所以 names:["Wall","Wall"]（重名在 UE 里合法）
     * 只会回一个 Actor：第一个 "Wall" 把它取走，第二个就什么都拿不到。
     * 这时候说「这个名字在关卡里没找到」是假的 —— 它明明在，刚还被匹配过一次。
     * 用整批 found 再查一遍就能分辨：查得到 = 名字不唯一/点名次数超过了实际数量。
     */
    const existsInBatch = (name: string): boolean =>
      found.some((actor) => actor.name?.toLowerCase() === name.toLowerCase())
    ordered = []
    for (const name of wantedNames) {
      let index = pool.findIndex((actor) => actor.name === name)
      if (index < 0) {
        index = pool.findIndex((actor) => actor.name?.toLowerCase() === name.toLowerCase())
      }
      if (index < 0) {
        if (existsInBatch(name)) exhaustedNames.push(name)
        else missingNames.push(name)
        continue
      }
      ordered.push(pool[index]!)
      pool.splice(index, 1)
    }
    /*
     * names 和 paths/selection/filter 混着给时，非 names 命中的那些会落在 pool 里。
     * 它们被查出来、被算进 MAX_ARRANGE，然后一声不响地丢掉 —— 那是「少办了一件事
     * 还报成功」，直接拒绝，让调用方把话说清楚。
     *
     * 只在**真的混着给**的时候这么说。targets 里只有 names 却剩下东西，
     * 那是名字对不上（引擎按别的规则匹配到了别人），该报的是下面那条
     * 「这些名字没找到」—— 报成「你混着给了」会把人往完全错的方向带。
     */
    const mixedSelectors = Boolean(targets.paths?.length || targets.selection || targets.filter)
    if (pool.length > 0 && mixedSelectors) {
      return {
        success: false,
        error:
          `targets 里 names 和 paths/selection/filter 混着给了：names 之外还选中了 ${pool.length} 个` +
          `（${pool
            .slice(0, 5)
            .map((a) => a.name ?? '(无名)')
            .join('、')}${pool.length > 5 ? ' 等' : ''}）。` +
          'arrange 按 names 的顺序排，这些没法排进去。要么只给 names，要么去掉 names 只用筛选。'
      }
    }
  } else {
    ordered = [...found].sort((a, b) => (a.bounds_min?.[axis] ?? 0) - (b.bounds_min?.[axis] ?? 0))
  }

  /*
   * 名字没对上就停，不要「少排几个也算成功」。
   *
   * 这正是 `unmatchedTargets.ts` 那个文件头记的事故：少办了一件事而回执看不出来。
   * 排布尤其不能含糊 —— 少一栋楼，整条街的间距全是对的，唯独缺了一个口子，
   * 而回执说「已排开 2 个」，看起来完全正常。
   */
  if (missingNames.length > 0 || exhaustedNames.length > 0) {
    const parts: string[] = []
    if (missingNames.length > 0) {
      parts.push(`这些名字在关卡里没找到：${listNames(missingNames)}`)
    }
    if (exhaustedNames.length > 0) {
      // 名字在，但指不到那么多个 —— 重名或大小写变体，引擎按名字只认得出一个
      parts.push(
        `这些名字点到的 Actor 不够用：${listNames(exhaustedNames)}` +
          '（名字不唯一，或同一个名字点了多次，而引擎按名字只解析得出一个）。' +
          '要分别指定就改用 targets.paths，path 才是唯一的'
      )
    }
    return {
      success: false,
      error: `${parts.join('；')}。arrange 不会少排几个凑合过去 —— 核对好再重发（ue_get_actor 可以查真实名字和 path）。`,
      unmatched_targets: [...missingNames, ...exhaustedNames],
      unmatched_count: missingNames.length + exhaustedNames.length
    }
  }

  if (ordered.length === 0) {
    return { success: false, error: 'arrange 没有可排的 Actor，先用 ue_get_actor 确认选择条件。' }
  }

  const incomplete = ordered.filter(
    (actor) =>
      !isFiniteVec(actor.bounds_min) ||
      !isFiniteVec(actor.bounds_max) ||
      !isFiniteVec(actor.transform?.location)
  )
  if (incomplete.length > 0) {
    /*
     * 「插件太旧」和「这个 Actor 没有几何体」要分开说。
     *
     * 插件无条件发 `bounds`，只在 `Bounds.IsValid` 时才发 min/max，而
     * `GetComponentsBoundingBox` 对没有 Primitive 组件的 Actor（点光源、相机、
     * 空的 AActor 标记、纯逻辑蓝图）在**任何版本**上都是无效的。原来那句话
     * 一律劝人去升级插件，等于让用户为一个换多少版都不会变的事重装一遍。
     * 有 bounds 没 min/max = 插件是新的，是这个 Actor 本身没有可量的体积。
     */
    const noGeometry = incomplete.filter((actor) => actor.bounds)
    const names = (list: ArrangeActorInfo[]): string =>
      list.map((a) => a.name ?? '(无名)').join('、')
    return {
      success: false,
      error:
        noGeometry.length === incomplete.length
          ? `这些 Actor 没有可量的包围盒：${names(noGeometry)}。` +
            '它们没有任何带体积的组件（点光源、相机、空 Actor、纯逻辑蓝图都是这样），' +
            'arrange 按包围盒排布，排不了没有体积的东西 —— 用 ue_set_transform 的 set.location 直接给坐标。'
          : `这些 Actor 没回包围盒：${names(incomplete)}。` +
            (noGeometry.length > 0
              ? `其中 ${names(noGeometry)} 是没有带体积的组件；其余` + '可能是引擎插件太旧'
              : 'bounds_min / bounds_max 是后加的字段，插件太旧就没有') +
            ' —— 先确认插件版本，再决定要不要把没体积的那些从 targets 里去掉。'
    }
  }

  const startEdge = isFiniteNumber(arrange.start)
    ? arrange.start
    : Math.min(...ordered.map((actor) => actor.bounds_min![axis]))

  let cursor = startEdge
  const placed: Array<{ name?: string; location: { x: number; y: number; z: number } }> = []
  const deadline = Date.now() + ARRANGE_TOTAL_BUDGET

  /*
   * 半路停下时统一从这里出去。
   *
   * 要交代的东西**必须写进 `error` 这一句里**：适配层的 `describeV2Failure` 只转发
   * error / code / diagnostics / details / nextStepHint，其余顶层字段（moved、
   * requested、actors、world）在模型看到之前就被丢掉了。所以结构化数据放 `details`
   * （那个会转发），人要读的那几句放 `error`。
   *
   * 重试那句还得说「按 names 重发」：没给 names 时顺序是按**当前坐标**排的，
   * 而这会儿前半排已经挪走了，同一个 start 再跑一次会得到另一种顺序。
   */
  const partial = (reason: string, extra?: Record<string, unknown>): Record<string, unknown> => {
    const done = placed.length
    const head =
      done > 0
        ? `arrange 停在第 ${done + 1} 个（共 ${ordered.length} 个）：${reason}。**前 ${done} 个已经挪到新位置了，不会回滚。**`
        : `arrange 在第 1 个就停了（共 ${ordered.length} 个）：${reason}。场景没有任何改动。`
    const retry =
      done > 0
        ? `重试请带 start: ${startEdge}（不带的话游标会从已经挪过的那批重新起算，整排再推一次）` +
          (wantedNames?.length
            ? '。' // names 已经钉死了顺序，照原样重发即可
            : '，并且改用 targets.names 按你要的顺序点名 —— 现在这批是按当前坐标排序的，' +
              '前半排已经挪走，同一个 start 再跑一次顺序会变。')
        : ''
    return {
      success: false,
      error: head + retry,
      details: {
        moved: done,
        requested: ordered.length,
        retry_start: startEdge,
        moved_actors: placed,
        ...worldFields(info)
      },
      ...(extra ?? {})
    }
  }

  for (const actor of ordered) {
    /*
     * 用户按了停止就别再往场景里写了。
     *
     * **只有「停止继续写」这一半是有效的。** 回执那一半到不了模型：适配层把
     * execute 包在 `runAbortable` 里，那是一场 `Promise.race`，abort 事件一触发
     * 就立刻 reject 成 ToolAbortedError —— 我们这个 return 慢一个微任务，永远输。
     * 所以下面这些话是写给日志和排查的人看的，模型只会拿到通用的「已停止」。
     * 想让模型知道已经挪了几个，得让插件支持一次调用摆多个位置（见文件末尾的说明）。
     */
    if (signal?.aborted) {
      const stopped = partial('用户中止')
      console.warn('[SetTransformUnifiedTool] arrange 被中止：', stopped.error)
      return { ...stopped, aborted: true }
    }

    // 单步超时挡不住「一步一步慢慢耗光一小时」，总时限才行
    if (Date.now() > deadline) {
      return partial(
        `整批超过 ${ARRANGE_TOTAL_BUDGET / 60_000} 分钟总时限（引擎一直在忙，不是某一步卡住）`
      )
    }

    const min = actor.bounds_min!
    const max = actor.bounds_max!
    const loc = actor.transform!.location!
    const size = max[axis] - min[axis]

    // 位移量按边算：要把 min 边挪到 cursor，原点就跟着挪同样多。原点偏移自动抵消。
    const location = { x: loc.x, y: loc.y, z: loc.z }
    location[axis] = loc[axis] + (cursor - min[axis])

    if (isAxis(alignAxis) && typeof alignValue === 'number') {
      const current =
        alignEdge === 'max'
          ? max[alignAxis]
          : alignEdge === 'center'
            ? (min[alignAxis] + max[alignAxis]) / 2
            : min[alignAxis]
      location[alignAxis] = loc[alignAxis] + (alignValue - current)
    }

    let response: SetTransformUnifiedResponse | undefined
    try {
      response = await wsService.callRequest<SetTransformUnifiedResponse>(
        'actor.set_transform',
        {
          // path 唯一，名字不唯一 —— 有 path 就绝不拿名字去指
          targets: actor.path ? { paths: [actor.path] } : { names: [actor.name] },
          operation: { set: { location } }
        },
        getTargetConnectionId(),
        ARRANGE_STEP_TIMEOUT
      )
    } catch (error) {
      /*
       * 抛出来的错要过 `describeToolError`，不能只取 message。
       *
       * 少了它就少了 `code` —— 超时那一档（V2_TIMEOUT_CODE）全靠它才会被适配层
       * 认成 EngineTimeoutError。丢掉之后宿主一律盖成 TOOL_FAILED，调用方读到
       * 「确定失败了」就重试，而超时那一刻这个 Actor 很可能已经挪过去了，于是挪两次。
       * `tools/engineErrors.ts` 的文件头写的就是这件事，本函数外层的 catch 也是这么做的。
       */
      const described = describeToolError(error)
      return partial(String(described.error ?? error), { code: described.code })
    }

    if (!transformApplied(response)) {
      /*
       * 一个没挪动，后面全都不能接着排。
       *
       * 游标是按「上一个占了多少」往前推的，跳过一个继续排，剩下的位置就全是
       * 按一个并不存在的布局算出来的 —— 场景里会得到一排看着整齐、实际和请求
       * 对不上的东西。停在这儿，把已经挪了几个说清楚。
       */
      const who = actor.name ?? actor.path ?? '(无名)'
      const why = response?.error || response?.message || '引擎没确认挪动'
      return partial(`${who}：${why}`)
    }

    placed.push({ name: actor.name, location })
    cursor += size + gap
  }

  const endEdge = cursor - gap
  const alignNote = isAxis(alignAxis)
    ? `，每个的 ${alignEdge === 'center' ? '中心' : alignEdge === 'max' ? 'max 边' : 'min 边'}` +
      ` 对齐到 ${alignAxis.toUpperCase()}=${alignValue}`
    : ''

  return {
    success: true,
    count: placed.length,
    actors: placed,
    ...worldFields(info),
    message:
      `已沿 ${axis.toUpperCase()} 轴排开 ${placed.length} 个 Actor：` +
      `占 ${axis.toUpperCase()} ${startEdge.toFixed(1)} → ${endEdge.toFixed(1)} 厘米` +
      `（共 ${((endEdge - startEdge) / 100).toFixed(2)} 米），间距 ${gap} 厘米（边到边）${alignNote}。` +
      '位置按各自回读的真实包围盒算，没有用原点或标称尺寸推算。' +
      describeWorld(info) +
      describeUnmatchedTargets(info) +
      describePlacementScale(placed.map((item) => item.location)) +
      /*
       * 撤销那句话**必须放在 message 里，不能放 `_aiInstruction`**。
       *
       * `adaptV2Tool` 的 `toText` 会 `delete rest._aiInstruction` 再序列化
       * （那个字段是 V2 用来驱动 Router 的，V3 没有 done 工具），所以写在那儿
       * 等于没写 —— 而这句话是这个设计缺陷唯一的兜底。
       *
       * 缺陷本身：插件的 `actor.set_transform` 在 `for (AActor* ...)` 外面开事务，
       * 本来给的是「一次调用一个撤销组」，而这里一个 Actor 发一次命令，等于主动拆了它。
       * 排 20 栋楼就是 20 条同名撤销记录，`ue_undo` 退一步只退回一栋，而
       * `ue_undo_history` 默认只看 20 条 —— 一次排布正好把整个默认窗口占满。
       * 要真修得让插件收一份「每个 Actor 各自的位置」的清单（`actor.spawn` 的
       * `instances` 就是这个形状），那要改 C++ 并重出插件包，不在这一层能解决。
       */
      `\n撤销是**一个 Actor 一条记录**（不是一次排布一条）：整排退回去要给 ue_undo 相应的步数，` +
      `这一批是 ${placed.length} 步。`,
    _aiInstruction: '排布完成。要确认就用 ue_screenshot 看一眼。'
  }
}

/**
 * 创建统一变换工具
 * @returns 统一变换工具实例
 */
export function createSetTransformUnifiedTool(): V2Tool {
  return defineV2Tool({
    description: `【推荐】统一变换工具 - 设置虚幻引擎场景中 Actor 的变换（位置、旋转、缩放）。

支持多种选择方式：
- 按当前选中： targets: { selection: true } —— 用户说"把我选中的这个挪一下"时直接用
- 按名称： targets: { names: ["MyCube", "MySphere"] }
- 按路径： targets: { paths: ["/Game/.../Actor1"] }
- 按过滤器： targets: { filter: { class: "Light" } }；反选用 { filter: { exclude_classes: [...] } }，
  整个关卡用 { filter: {} }

支持多种变换操作：
- 绝对设置： operation: { set: { location: { z: 200 } } }      —— 200 厘米 = 2 米
- 增量变换： operation: { add: { location: { z: 500 } } }      —— 上移 5 米，支持负数
- 倍乘缩放： operation: { multiply: { scale: { x: 2, y: 2, z: 2 } } }  —— 倍数，不是长度

支持附加选项：
- 坐标空间： operation: { space: "Local" }
- 贴地操作： operation: { snap_to_floor: true } 可单独给

- 排成一排： operation: { arrange: { axis: "y", gap: 200, start: -800,
    align: { axis: "x", edge: "min", value: -1310 } } }
  **gap 是包围盒边到边的间距**，尺寸不一也不重叠；align 把每个物体的 min/max/center
  贴到另一轴的一条线上（沿街、贴墙）；start 省略就原地排齐；按 targets.names 的顺序排。
  最多 100 个，与其他操作互斥。**一排东西就用它，别自己按尺寸算** —— 它读真实包围盒，
  不受原点位置影响，那正是自己算会摆重叠、摆出界的原因。

不用自己算旋转的两种写法（和 set.rotation 互斥）：
- 方向光/太阳： operation: { set: { sun: { elevation: 8, azimuth: 300 } } }
  elevation = 太阳离地平线多高（黄昏 5～15，正午 60～90）；azimuth = 太阳在哪个方位（0 = +X，90 = +Y）
- 让正面(+X)指向某个方向： operation: { set: { face_direction: { x: -1, y: 0, z: 0 } } }
  例如让雾卡片正对相机：face_direction = 相机位置 - 卡片位置

${UE_UNIT_NOTE}

${UE_ROTATION_NOTE}

整个场景按米摆成了缩小 100 倍，救回来的写法：
targets: { filter: {} }, operation: { multiply: { location: { x: 100, y: 100, z: 100 } } }
`,

    inputSchema: SetTransformUnifiedParamsSchema,
    // 注意：不使用 strict 模式，因为 z.union 与 strict 不兼容
    execute: async (input, options?: { abortSignal?: AbortSignal }) => {
      console.log('[SetTransformUnifiedTool] 收到请求:', JSON.stringify(input, null, 2))

      // 容错处理：某些 AI 模型可能将嵌套对象作为 JSON 字符串传入
      // 如果 targets 或 operation 是字符串，尝试解析为对象
      let targets: ParsedTargets = input.targets as ParsedTargets
      let operation: ParsedOperation = input.operation as ParsedOperation

      if (typeof input.targets === 'string') {
        try {
          console.log('[SetTransformUnifiedTool] targets 是字符串，尝试解析...')
          targets = JSON.parse(input.targets) as ParsedTargets
        } catch (e) {
          return {
            success: false,
            error: `targets 参数解析失败: ${e instanceof Error ? e.message : String(e)}`
          }
        }
      }

      if (typeof input.operation === 'string') {
        try {
          console.log('[SetTransformUnifiedTool] operation 是字符串，尝试解析...')
          operation = JSON.parse(input.operation) as ParsedOperation
        } catch (e) {
          return {
            success: false,
            error: `operation 参数解析失败: ${e instanceof Error ? e.message : String(e)}`
          }
        }
      }

      console.log('[SetTransformUnifiedTool] 解析后的 targets:', JSON.stringify(targets, null, 2))
      console.log(
        '[SetTransformUnifiedTool] 解析后的 operation:',
        JSON.stringify(operation, null, 2)
      )

      // 参数验证：targets 至少需要有一种选择方式
      const hasTargets =
        targets.selection || targets.names?.length || targets.paths?.length || targets.filter
      if (!hasTargets) {
        return {
          success: false,
          error: '必须在 targets 中提供 selection、names、paths 或 filter 之一来选择 Actor'
        }
      }

      // sun / face_direction 在这里换成 rotation，插件只认 rotation
      const resolved = resolveSemanticRotation(operation)
      if ('error' in resolved) {
        return { success: false, error: resolved.error }
      }
      operation = resolved.operation
      if (resolved.usedSemantic) {
        console.log(
          '[SetTransformUnifiedTool] 语义旋转已换算为 rotation:',
          JSON.stringify(operation.set?.rotation)
        )
      }

      // 参数验证：operation 至少需要有一种操作
      const hasOperation =
        operation.set ||
        operation.add ||
        operation.multiply ||
        operation.snap_to_floor ||
        operation.arrange
      if (!hasOperation) {
        return {
          success: false,
          error: '必须在 operation 中提供 set、add、multiply、snap_to_floor 或 arrange 之一'
        }
      }

      /*
       * arrange 要自己算每个物体的位置，和「给所有选中物体设同一个值」是两种操作，
       * 混在一起说不清谁覆盖谁 —— 直接拒绝，比定一套覆盖规则好记。
       * 排完要贴地就再调一次 snap_to_floor，两步各自看得见结果。
       */
      if (
        operation.arrange &&
        (operation.set || operation.add || operation.multiply || operation.snap_to_floor)
      ) {
        return {
          success: false,
          error:
            'arrange 不能和 set / add / multiply / snap_to_floor 同时给：' +
            '排布要给每个物体算各自的位置，和统一设值是两回事。先 arrange，再单独调一次另一个。'
        }
      }

      /*
       * `space` 也要一起拒绝，不能默默丢掉。
       *
       * arrange 逐个发的是 `{ set: { location } }`，从来不带 space，所以写了
       * `space: "Local"` 的调用会按世界坐标排完、回执一个字都不提 —— 而这个文件里
       * 别的冲突组合（sun+face_direction、set.rotation+sun、arrange+set）全是当场拒绝的。
       * 排布本来就是拿世界空间包围盒算的，局部坐标在这儿没有意义。
       */
      if (operation.arrange && operation.space && operation.space !== 'World') {
        return {
          success: false,
          error:
            `arrange 只按世界坐标排（它用的是世界空间包围盒），给不了 space: "${operation.space}"。` +
            '去掉 space 重发；要按局部坐标挪东西请单独用 add / set。'
        }
      }

      try {
        // 获取 WebSocket 服务
        const wsService = serviceManager.getWebSocketService()

        // 检查是否有可用连接
        const connectionCount = wsService.getConnectionCount()
        if (connectionCount === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // arrange 在盒子这侧算完再逐个发，插件不认识这个字段。
        // 中止信号要传进去：它是个最多 100 次往返的循环，不接信号就会在工具
        // 早已返回之后继续往场景里写（见 tools/abortable.ts）
        if (operation.arrange) {
          return await arrangeActors(wsService, targets, operation.arrange, options?.abortSignal)
        }

        // 构建请求 payload（直接透传新结构）
        const payload = {
          targets,
          operation
        }

        console.log(
          '[SetTransformUnifiedTool] 发送 actor.set_transform 请求:',
          JSON.stringify(payload, null, 2)
        )

        // 发送请求到 UE 插件
        const response = await wsService.callRequest<SetTransformUnifiedResponse>(
          'actor.set_transform',
          payload,
          getTargetConnectionId(),
          120000 // 2 分钟超时（批量操作可能较慢）
        )

        console.log('[SetTransformUnifiedTool] 收到响应:', JSON.stringify(response, null, 2))

        // 判断成功的逻辑：
        // 1. 插件端返回 code=200 时，WebSocket 服务会直接返回 result 对象
        // 2. 插件端的 result 对象包含 count 字段表示成功处理的 Actor 数量
        // 3. 兼容旧版本可能返回的 ok/success 字段
        const affectedCount = response?.count ?? response?.actors?.length ?? 0
        // 和 arrange 那条路共用一个判据，否则同一份回包会有两种读法（见 transformApplied）
        const isSuccess = transformApplied(response)

        console.log(
          '[SetTransformUnifiedTool] 成功判断:',
          isSuccess,
          '| ok:',
          response?.ok,
          '| success:',
          response?.success,
          '| count:',
          response?.count
        )

        if (isSuccess) {
          const count = affectedCount

          /*
           * 没落到目标值上的那些（新插件逐个标 applied: false 并给 failed[]）。
           * 老插件不回读，这里自然是空的 —— 不能凭入参替它补。
           */
          const landed = (response.actors ?? []).filter((a) => a.applied !== false)
          const failures: PartialFailure[] =
            Array.isArray(response.failed) && response.failed.length > 0
              ? response.failed.map((f) => ({
                  item: f.name || f.path || '(未命名)',
                  reason: f.reason
                }))
              : (response.actors ?? [])
                  .filter((a) => a.applied === false)
                  .map((a) => ({ item: a.name || a.path || '(未命名)', reason: a.warning }))
          const failedCount = Math.max(response.failed_count ?? 0, failures.length)

          // 构建结果摘要
          let summary = `成功变换 ${count} 个 Actor`
          if (landed.length > 0) {
            const actorNames = landed
              .slice(0, 5)
              .map((a) => a.name)
              .join(', ')
            if (landed.length > 5) {
              summary += `：${actorNames} 等`
            } else if (actorNames) {
              summary += `：${actorNames}`
            }
          }

          /**
           * 明细被截断了要说。
           *
           * 插件对 `actors` 明细有条数上限（`report_limit`），实际改了多少在
           * `count` 里，明细里只有 `reported` 条。这两个字段原来被工具层丢掉，
           * 于是「改了 500 个，明细只给 100 条」和「改了 100 个」在调用方眼里
           * 长得一模一样 —— 它会拿明细去核对，然后以为另外 400 个失败了。
           *
           * 这和 message_log / compile_all 是同一类，那两个都如实报了截断，
           * 只有这里漏了。
           */
          const reported = response.reported ?? response.actors?.length ?? 0
          const truncated = reported > 0 && reported < count
          if (truncated) {
            summary += `（明细只列出 ${reported} 个，上限 ${response.report_limit ?? reported}）`
          }

          /**
           * 变换完的位置按米报一句。
           *
           * 这里用的是引擎回读的 `actors[].location`，和 `ue_spawn_actor` 那边
           * 刻意相反 —— spawn 拦的是「入参量纲写错」，这里报的是「改完之后
           * 场景实际有多大」，后者只有回读值说了算。
           */
          const placement = describePlacementScale(
            (response.actors ?? [])
              .map((actor) => actor.location)
              .filter((loc): loc is NonNullable<typeof loc> => Boolean(loc))
          )

          /**
           * 动了旋转就把朝向翻成人话。
           *
           * 用的是引擎回读的 `actors[].rotation`，不是入参 —— 入参的正负号就是
           * 出事的地方，拿它来算等于让错误给自己签字。方向光 pitch 为正会在这里
           * 直接标 ⚠️，这是那类错误唯一能被自动看见的地方（原委见 `tools/ueOrientation.ts`）。
           */
          const orientation = touchesRotation(operation)
            ? describeOrientations(response.actors ?? [])
            : ''

          const snap = operation.snap_to_floor ? describeSnap(response) : ''

          const body =
            summary +
            describeUnmatchedTargets(response) +
            describeWorld(response) +
            placement +
            orientation +
            snap

          return {
            // 有没到位的就先说部分完成（AGENTS.md §5 第 14 条）。message 放第一个键：
            // 适配层把整个对象 JSON 化给模型，第一眼看到的就是它
            message: withPartialHeadline(
              body,
              {
                succeeded: count,
                failed: failedCount,
                skipped: unmatchedTargetFields(response).unmatched_count ?? 0,
                unit: '个 Actor'
              },
              failures
            ),
            success: true,
            count,
            ...(failedCount > 0 ? { failed_count: failedCount } : {}),
            actors: response.actors,
            ...(truncated
              ? { reported, report_limit: response.report_limit, actors_truncated: true }
              : {}),
            ...(resolved.usedSemantic ? { resolved_rotation: operation.set?.rotation } : {}),
            ...unmatchedTargetFields(response),
            ...worldFields(response),
            _aiInstruction: '变换操作完成。如果所有任务已完成，请调用 done 工具汇报结果。'
          }
        } else {
          const failureList = describeFailures(
            (response?.failed ?? []).map((f) => ({
              item: f.name || f.path || '(未命名)',
              reason: f.reason
            })),
            '没到位的'
          )
          const msg =
            ((response as RpcFailureShape)?.error ||
              (response as RpcFailureShape)?.message ||
              '变换失败，未收到有效响应') + (failureList ? `\n${failureList}` : '')

          const code =
            (response as RpcFailureShape)?.__rpc?.code ?? (response as RpcFailureShape)?.code

          const details = (response as RpcFailureShape)?.details
          return {
            success: false,
            error: `变换失败：${msg}`,
            code,
            details,
            raw: response
          }
        }
      } catch (error) {
        console.error('[SetTransformUnifiedTool] 执行失败:', error)
        // 超时要单独留码，别让调用方拿一个它以为确定的结论去重试
        return describeToolError(error)
      }
    }
  })
}
