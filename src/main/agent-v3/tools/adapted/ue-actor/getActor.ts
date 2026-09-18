/**
 * 获取 Actor 信息工具 (v2.0 统一 Selector)
 * 通过 WebSocket 向虚幻引擎插件发送 actor.get_info 命令，查询 Actor 的详细信息
 * 支持 targets { names | paths | filter } 选择器，兼容旧 name/path 参数
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { worldFields, describeWorld, type WorldScopedResponse } from '../../worldScope'
import { UE_UNIT_NOTE, describePlacementScale } from '../../ueUnits'
import { describeOrientation, orientationWorthReporting } from '../../ueOrientation'
import { describeToolError } from '../../engineErrors'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import {
  describeUnmatchedTargets,
  unmatchedTargetFields,
  type UnmatchedTargetsResponse
} from '../../unmatchedTargets'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * Property Match Rule Schema - 属性匹配规则
 */
const PropertyMatchRuleSchema = z.object({
  name: z.string().describe('属性名（如 StaticMesh, Material）'),
  value: z.string().describe('期望值（模糊包含匹配，忽略大小写）')
})

/**
 * Filter Schema - 场景扫描筛选条件
 */
const FilterSchema = z.object({
  class: z.string().optional().describe('类名包含匹配（模糊，忽略大小写）'),
  name_pattern: z.string().optional().describe('名称通配符匹配（Wildcard，如 *_Debug_*）'),
  exclude_classes: z
    .array(z.string())
    .optional()
    .describe('排除的类名数组（全等匹配，忽略大小写）'),
  property_match: z
    .array(PropertyMatchRuleSchema)
    .optional()
    .describe('属性匹配规则数组。用于按资产/属性值过滤（如 StaticMesh=Cube）')
})

/**
 * Targets Schema - 统一选择器
 */
/**
 * `.strict()` 是有意的。
 *
 * 写错一个键（比如把 `name_pattern` 直接放在 targets 下，而它其实属于
 * `targets.filter`）时，宽松模式会把它当成「没给任何选择条件」，
 * 于是**返回整个关卡的全部 Actor**。调用方要的是 8 个灯，拿回 144 个
 * 什么都有的东西，而且没有任何迹象表明筛选没生效 —— 这是最难查的那种错。
 *
 * 真机任务评测里踩到的：我自己写检查代码时就写错了这个键，
 * 拿到 144 个 Actor 却以为「摆出来 20 个」。模型同样会犯这个错。
 */
const TargetsSchema = z
  .object({
    selection: z
      .boolean()
      .optional()
      .describe('true = 用户此刻在视口/大纲里选中的 Actor。回答「我选的这个是啥」就用它'),
    names: z.array(z.string()).optional().describe('按名称/Label 精准查找'),
    paths: z.array(z.string()).optional().describe('按对象路径查找'),
    filter: FilterSchema.optional().describe(
      '场景扫描筛选条件。注意 name_pattern / class 要放在这一层里面'
    )
  })
  .strict()

/**
 * Get Actor Info 请求参数 (v2.0)
 */
const GetActorInfoParamsSchema = z
  .object({
    targets: TargetsSchema.optional().describe('统一选择器：{ names?, paths?, filter? }'),
    properties: z
      .array(z.string())
      .optional()
      .describe(
        '要读取的属性名数组，如 ["Intensity", "LightColor"]。' +
          '给了这个参数就走属性内省，返回每个 Actor 的 props；不给则返回变换/包围盒。' +
          '留空数组等同于不给'
      ),
    return_transform: z
      .boolean()
      .optional()
      .default(true)
      .describe('是否返回变换信息（location 单位厘米、rotation 单位度、scale 是倍数），默认 true'),
    return_bounds: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        '是否返回包围盒，默认 false。返回世界空间轴对齐包围盒的**完整尺寸**' +
          '（长 × 宽 × 高，单位厘米，不是半长），外加 bounds_min / bounds_max 两个角点和' +
          ' pivot_offset（= 位置 − bounds_min，原点相对几何体的偏移：z≈0 表示原点在底面）。' +
          '都已含进该 Actor 的缩放和旋转'
      ),
    limit: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(50)
      .describe('限制返回数量。设为 0 可启用仅计数模式'),
    include_system_actors: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        '是否把引擎自己的记账 Actor（WorldPartitionHLOD、RecastNavMesh、' +
          'DefaultPhysicsVolume 等）也列出来。默认 false —— 它们对用户和你都没有意义，' +
          '一个大世界能有上百个，会把真正要找的东西埋掉。' +
          '排查「这个 HLOD 怎么回事」这类问题时才需要设为 true。' +
          '只影响 filter 扫描；按 names/paths 点名或 selection 取选中时一律照给'
      ),
    name: z.string().optional().describe('兼容字段：单个 Actor 名称'),
    path: z.string().optional().describe('兼容字段：单个 Actor 路径')
  })
  /*
   * 顶层也 strict。targets 早就是 strict 了，但把 filter 直接写在顶层
   * （{ filter: { class: "BP_JumpPad" } }，少套一层 targets）不会被它拦到：
   * 顶层宽松校验把这个键当空气，targets 缺席又等于「扫全图」，于是模型
   * 想要跳板却拿回按字母排的前 10 个 Actor，还以为筛选坏了。
   * 真机上新用户那一轮「filter 不可靠」就是这么来的。
   */
  .strict()

// ============================================================================
// 类型定义
// ============================================================================

/** Get Actor Info 请求 Payload */
export interface GetActorInfoPayload {
  targets: {
    selection?: boolean
    names?: string[]
    paths?: string[]
    filter?: {
      class?: string
      name_pattern?: string
      exclude_classes?: string[]
      property_match?: Array<{ name: string; value: string }>
    }
  }
  return_transform?: boolean
  return_bounds?: boolean
  limit?: number
  include_system_actors?: boolean
}

/** 单个 Actor 信息项 */
interface ActorInfoItem {
  name: string
  path: string
  class: string
  /** 蓝图实例才有：生成这个 Actor 的蓝图资产路径，可直接用于 blueprint_describe */
  blueprint_path?: string
  folder_path?: string
  transform?: {
    location: { x: number; y: number; z: number }
    rotation: { pitch: number; yaw: number; roll: number }
    scale: { x: number; y: number; z: number }
  }
  /** 世界空间 AABB 的完整尺寸（长宽高，厘米），不是半长 */
  bounds?: { x: number; y: number; z: number }
  /**
   * 世界空间 AABB 的两个角点（厘米）。尺寸答不了「这个实例占的是哪一块」，
   * 也答不了「原点在几何体的哪儿」—— 而把模块化网格拼到一起靠的正是后者。
   * 老插件不回这三个字段，缺省即「这次没给」。
   */
  bounds_min?: { x: number; y: number; z: number }
  bounds_max?: { x: number; y: number; z: number }
  /**
   * Actor 位置减去 `bounds_min`：原点相对几何体的偏移（厘米）。
   * `z ≈ 0` = 原点坐在几何体底面；`z ≈ 高度/2` = 原点在正中。
   */
  pivot_offset?: { x: number; y: number; z: number }
  /**
   * 盒子侧从 rotation 算出来的一句人话：灯/相机说照向哪、方向光说太阳多高，
   * 普通 Actor 只在 pitch/roll 非零时说正面和顶面朝哪。插件不回这个字段。
   */
  orientation?: string
}

/**
 * 给值得说的 Actor 附一句朝向。
 *
 * 三个裸角度对方向光来说等于什么都没说：`pitch=30` 读成「太阳高度 30°」完全合理，
 * 而在 UE 里它是仰照。这一句是从回读的旋转算出来的，和调用方填的没有关系，
 * 所以调用方拿它核对自己的意图时不会「一致但同错」（原委见 `tools/ueOrientation.ts`）。
 */
function withOrientation(actor: ActorInfoItem): ActorInfoItem {
  const rotation = actor.transform?.rotation
  if (!orientationWorthReporting(rotation, actor.class)) return actor
  const report = describeOrientation(rotation!, actor.class)
  const warn = report.warnings.length > 0 ? ` ⚠️ ${report.warnings.join('；')}` : ''
  return { ...actor, orientation: report.text + warn }
}

/**
 * 引擎默认隐藏系统 Actor 后的回报字段。
 *
 * 两条命令（actor.get_info / actor.inspect）都会带，所以抽出来共用。
 * 老版本插件不认这两个字段，缺省即「没隐藏任何东西」——不会误报。
 */
interface SystemActorExclusion {
  /** 被隐藏的系统 Actor 总数 */
  system_actors_excluded?: number
  /** 按真实类名分组的计数，如 { WorldPartitionHLOD: 144 } */
  system_actors_by_class?: Record<string, number>
}

/** Get Actor Info 响应数据 */
interface GetActorInfoResponse
  extends SystemActorExclusion,
    WorldScopedResponse,
    UnmatchedTargetsResponse {
  count: number
  total_found: number
  actors: ActorInfoItem[]
  error?: string
}

/** 单个 Actor 内省结果（actor.inspect 的返回项） */
interface ActorInspectItem {
  name: string
  path: string
  class: string
  props: Record<string, unknown>
  /**
   * `actor.inspect` 自己**不回**这个 —— 它走的是一参数版 `BuildActorInfo`，
   * 只有 name/path/class/folder_path。这里的 transform 是 TS 侧补上去的，
   * 见 `inspectActors` 里那段说明。
   */
  transform?: ActorInfoItem['transform']
}

/** actor.inspect 响应数据 */
interface InspectActorResponse
  extends SystemActorExclusion,
    WorldScopedResponse,
    UnmatchedTargetsResponse {
  count: number
  actors: ActorInspectItem[]
  error?: string
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 解析 targets 输入（支持字符串或对象）
 */
function parseTargetsInput(rawTargets: unknown): unknown {
  if (typeof rawTargets === 'string') {
    try {
      return JSON.parse(rawTargets)
    } catch (e) {
      throw new Error(`targets 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return rawTargets
}

/**
 * 把「隐藏了多少系统 Actor」写成一句人话，接在摘要后面。
 *
 * 这一句不能省。静默过滤会让调用方以为「场景里就这些」，然后据此下结论 ——
 * 那是比满屏 HLOD 更难查的一类错：满屏至少看得见，静默过滤看不见。
 * 所以既报总数，也报按类分项（分项里的类名可以直接抄进 filter.exclude_classes），
 * 并且明说怎么把它们要回来。
 *
 * 老版本插件不回这两个字段，返回空串，摘要保持原样。
 */
function describeSystemActorExclusion(response: SystemActorExclusion | null | undefined): string {
  const excluded = response?.system_actors_excluded
  if (typeof excluded !== 'number' || excluded <= 0) return ''

  const byClass = response?.system_actors_by_class ?? {}
  // 全列不截断：系统类就那么几种，截断反而又制造一次「以为就这些」
  const detail = Object.entries(byClass)
    .sort((a, b) => b[1] - a[1])
    .map(([cls, n]) => `${cls} ${n}`)
    .join('、')

  return (
    ` 另有 ${excluded} 个系统 actor 未列出${detail ? `（${detail}）` : ''}，` +
    `需要它们就传 include_system_actors: true。`
  )
}

/** 把引擎回的隐藏计数原样透出，供调用方自己判断，而不是只能读摘要 */
function systemActorFields(
  response: SystemActorExclusion | null | undefined
): SystemActorExclusion {
  const excluded = response?.system_actors_excluded
  if (typeof excluded !== 'number' || excluded <= 0) return {}
  return {
    system_actors_excluded: excluded,
    system_actors_by_class: response?.system_actors_by_class ?? {}
  }
}

type GetActorInfoInput = z.infer<typeof GetActorInfoParamsSchema>

/**
 * 规范化输入参数，合并兼容字段到 targets
 */
function normalizeGetInfoTargets(input: GetActorInfoInput): GetActorInfoPayload {
  const names = new Set<string>()
  const paths = new Set<string>()
  let filter: GetActorInfoPayload['targets']['filter'] | undefined
  let selection = false

  // 处理 targets 对象/字符串
  if (input.targets !== undefined) {
    const parsed = parseTargetsInput(input.targets)
    if (parsed && typeof parsed === 'object') {
      const result = TargetsSchema.safeParse(parsed)
      if (!result.success) {
        throw new Error(`targets 校验失败: ${result.error.message}`)
      }
      const t = result.data
      if (t.selection) selection = true
      t.names?.forEach((n) => names.add(n))
      t.paths?.forEach((p) => paths.add(p))
      if (t.filter) {
        filter = t.filter
      }
    } else {
      throw new Error('targets 必须是对象或可解析的 JSON 字符串')
    }
  }

  // 兼容旧版单体 name/path
  if (input.name) names.add(input.name)
  if (input.path) paths.add(input.path)

  const hasTargets = selection || names.size > 0 || paths.size > 0 || filter
  if (!hasTargets) {
    // 允许空 targets：默认为全量扫描（配合 limit）
    console.log('[GetActorInfoTool] 未指定 targets，默认为全量扫描')
    filter = {}
  }

  const payload: GetActorInfoPayload = {
    targets: {},
    return_transform: input.return_transform,
    return_bounds: input.return_bounds,
    limit: input.limit,
    // 显式发 false 而不是留空：这是跨进程的协议字段，「默认值由谁负责」
    // 不该跨两层去推断（schema 的 .default 只在适配层 parse 时生效）
    include_system_actors: input.include_system_actors ?? false
  }

  if (selection) payload.targets.selection = true
  if (names.size > 0) payload.targets.names = Array.from(names)
  if (paths.size > 0) payload.targets.paths = Array.from(paths)
  // 确保 filter 被正确赋值 (即使是空对象 {})
  if (filter) payload.targets.filter = filter

  return payload
}

/**
 * 属性内省分支：发 `actor.inspect`，回一个与主分支同形的结果。
 *
 * 返回结构刻意和 get_info 分支保持一致（success / count / actors / message），
 * 只是 actors 里带的是 `props` 而不是 `transform`。同一个工具回两种形状已经
 * 够模型消化了，字段名再不一样就是自找麻烦。
 */
async function inspectActors(
  wsService: ReturnType<typeof serviceManager.getWebSocketService>,
  payload: GetActorInfoPayload,
  properties: string[],
  limit: number | undefined
): Promise<Record<string, unknown>> {
  const inspectPayload = {
    targets: payload.targets,
    properties,
    include_system_actors: payload.include_system_actors
  }
  console.log('[GetActorInfoTool] 发送 actor.inspect 请求:', inspectPayload)

  /*
   * 属性和位置**一起**回，不再二选一。
   *
   * 插件的 `actor.inspect` 走一参数版 `BuildActorInfo`，只有 name/path/class/
   * folder_path，没有 transform（`UAL_CommandUtils.cpp:1178`）；带 transform 的是
   * `BuildActorInfoWithOptions`，只有 `actor.get_info` 在用。于是「这盏灯在哪 +
   * 它多亮」原来必须调两次工具 —— 2026-09-11 盒子自己的 agent 报的就是这条
   * 。
   *
   * 正解是让插件的 inspect 也走 WithOptions，一次 RPC 全带回来。没那么做是因为
   * 那要重编插件包，而当时另一个会话正在刷同一个 zip。这里先用两条并发 RPC 合并：
   * 对模型来说少一轮往返，RPC 次数和它自己调两次工具时一样。
   * 插件那边改完之后，这段可以退回单条调用。
   *
   * `return_transform: false` 时不发第二条 —— 明确说了不要位置就别白花一次。
   */
  const wantTransform = payload.return_transform !== false
  const [response, infoResponse] = await Promise.all([
    wsService.callRequest<InspectActorResponse>(
      'actor.inspect',
      inspectPayload,
      getTargetConnectionId(),
      30000
    ),
    wantTransform
      ? wsService
          .callRequest<GetActorInfoResponse>(
            'actor.get_info',
            payload,
            getTargetConnectionId(),
            30000
          )
          // 位置是**附加**信息：这一条挂了不该把整次属性查询判失败，
          // 少一个 transform 字段比少全部属性值好得多
          .catch((error) => {
            console.warn('[GetActorInfoTool] 取 transform 失败，只回属性:', error)
            return undefined
          })
      : Promise.resolve(undefined)
  ])

  console.log('[GetActorInfoTool] 收到内省响应:', response)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcOk = (response as any)?.ok
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcSuccess = (response as any)?.success
  if (rpcOk === false || rpcSuccess === false) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = (response as any)?.error || (response as any)?.message || '内省失败'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (response as any)?.__rpc?.code ?? (response as any)?.code
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const details = (response as any)?.details
    return { success: false, error: `读取属性失败：${msg}`, code, details, raw: response }
  }

  if (!response?.actors?.length) {
    // 一个都没剩下，但引擎隐藏了系统 Actor —— 这不是「场景里没有」，
    // 而是「匹配到的全是系统 Actor」。不点破的话调用方会以为查询条件写错了，
    // 然后换着花样重查。
    const excludedNote = describeSystemActorExclusion(response)
    return {
      success: false,
      error: (response?.error || '未找到指定的 Actor') + excludedNote,
      ...systemActorFields(response),
      ...worldFields(response),
      raw: response
    }
  }

  const totalFound = response.count ?? response.actors.length
  // inspect 的 RPC 不认 limit，在这边截 —— 不截的话一次全场景内省能回几百条，
  // 每条还带一组属性值，足够把上下文顶掉
  const sliced =
    typeof limit === 'number' && limit > 0 ? response.actors.slice(0, limit) : response.actors

  // 按 path 合并 transform。path 是唯一的，名字不是（同名 Actor 引擎会自己加后缀，
  // 但显示名可能一样），所以只认 path
  const transformByPath = new Map(
    (infoResponse?.actors ?? [])
      .filter((a) => a.transform)
      .map((a) => [a.path, a.transform] as const)
  )
  const actors: ActorInspectItem[] = transformByPath.size
    ? sliced.map((a) => {
        const transform = transformByPath.get(a.path)
        return transform ? { ...a, transform } : a
      })
    : sliced

  const preview = actors
    .slice(0, 3)
    .map((a) => `${a.name} (${a.class}): ${a.props ? Object.keys(a.props).length : 0} 个属性`)

  return {
    success: true,
    count: actors.length,
    total_found: totalFound,
    actors: actors.map((actor) => ({
      ...actor,
      ...(actor.transform
        ? { geometry: { space: 'world', length_unit: 'cm', rotation_unit: 'deg' } }
        : {})
    })),
    ...systemActorFields(response),
    ...unmatchedTargetFields(response),
    ...worldFields(response),
    message:
      `读取了 ${actors.length} 个 Actor 的属性` +
      (totalFound > actors.length ? `（共 ${totalFound} 个，显示前 ${actors.length} 个）` : '') +
      `：${preview.join('; ')}${totalFound > 3 ? ' ...' : ''}` +
      describeSystemActorExclusion(response) +
      describeUnmatchedTargets(response) +
      describeWorld(response)
  }
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建 Get Actor Info 工具 (v2.0)
 * @returns Get Actor Info 工具实例
 */
export function createGetActorTool(): V2Tool {
  return defineV2Tool({
    description: `查询**当前打开的关卡里**摆着的 Actor：找到它们，读取位置或属性。

【对象已经点名就别来这里】"把 SM_Cliff_01 往上抬 200"、"给 SM_Sign_01 挂上 M_Rock"、
"大纲按类型归归类" —— 这类话已经指明了操作对象，直接调那一路的工具
（ue_set_transform / material_apply / level_organize_actors），**不要先来这里"看一眼"**。
那一步答不出任何你还不知道的事，只是多一轮。
「先查再动」的规矩只管**图里的 node id 和 pin 名**，不管 Actor 名字。

【核心功能】：
1. 读当前选中：targets: { selection: true } —— 用户说"我选的这个""这个物体"时，直接用它，
   不要去写 Python 查选中，也不要靠名字猜
2. 搜索与定位：在关卡里按名称、类名、通配符查找 Actor
   （找资产**文件**用 ue_content_search，找素材库用 search_assets，这里只有关卡里的实例）
3. 统计数量：将 limit 设为 0，即可快速获取匹配总数（不返回具体列表）
4. 空间感知：获取位置、旋转、包围盒（Bounds）
5. 属性内省：给 properties 参数，读取 Actor 属性的当前值

${UE_UNIT_NOTE}

bounds 回的是世界空间包围盒的**完整长宽高**（厘米），不是半长、也不是角点坐标。
message 末尾会把这批 Actor 的位置跨度按米报一遍 —— 那一句是用来核对整体尺度的：
和你预期的场景大小差两个数量级，就是米/厘米混了。

【参数详解】：
- targets: 统一选择器
  - selection: true 取用户此刻在视口/世界大纲里选中的 Actor
  - names: ["Cube1"] 精准查找
  - filter: { class: "Light", name_pattern: "*Spot*" } 模糊筛选
  - 注意 name_pattern / class 要放在 targets.filter 里面，放在别处会直接报参数错误

【蓝图实例】：返回的 blueprint_path 就是这个 Actor 的蓝图资产路径
（如 /Game/PartyMVP/Props/BP_Door），可直接喂给 blueprint_describe，
不用再 ue_content_search 去找。
- properties: ["Intensity", "LightColor"] —— 想知道属性值时给它，返回 props，
  **同时也带 transform**（「这盏灯在哪 + 它多亮」一次就够，不用调两次）。
  不需要位置就传 return_transform: false，能省一次内部查询
- limit: 默认为 50。重要：设为 0 时进入计数模式，仅返回 total_found
- return_transform: bool (默认 true)
  灯光/相机/方向光会多带一个 orientation 字段：照向哪、太阳多高、pitch 为正会标 ⚠️。
  普通 Actor 只在 pitch/roll 非零时带（比如用 roll 立起来的雾卡片：顶面朝 -Y，竖立着）。
  核对旋转对不对看这一句，不要自己从三个角度脑算
- return_bounds: bool (默认 false) 用于堆叠计算
- include_system_actors: bool (默认 false)

【系统 Actor 默认不列出】：扫描（filter）时会自动摘掉引擎自己的记账对象 ——
WorldPartitionHLOD、RecastNavMesh、DefaultPhysicsVolume、GameplayDebugger*、
WorldDataLayers 等。一个大世界这类东西能有上百个，不摘掉会把你要找的埋掉。
摘掉多少一定会写在 message 里（"另有 N 个系统 actor 未列出"），
所以 total_found 是**扣掉之后**的数；真要看它们就传 include_system_actors: true。
按 names/paths 点名、或 selection 取选中时不做这个过滤，点名要什么就给什么。

【兼容】：支持旧版 name/path 单体参数`,

    inputSchema: GetActorInfoParamsSchema,

    execute: async (input) => {
      console.log('[GetActorInfoTool] 收到请求:', input)

      // 规范化参数
      let payload: GetActorInfoPayload
      try {
        payload = normalizeGetInfoTargets(input)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 要属性就走内省。
        //
        // 这两条路原来是两个工具（ue_get_actor / ue_inspect_actor），选择器
        // 完全一样，只有返回内容不同 —— 模型得在**还不知道会拿到什么**的时候
        // 二选一，选错就多一轮。合成一个参数之后它只需要说"我想要什么"。
        //
        // 顺带修掉一个隐患：原 inspect 工具的 targets 是宽松校验，键名写错
        // （比如把 name_pattern 放在 targets 下而不是 targets.filter 里）会被
        // 当成"没给筛选条件"，然后返回整个关卡。现在走的是上面那套 .strict()
        // 校验，写错直接报错。
        if (input.properties && input.properties.length > 0) {
          return inspectActors(wsService, payload, input.properties, input.limit)
        }

        console.log('[GetActorInfoTool] 发送 actor.get_info 请求:', payload)

        const response = await wsService.callRequest<GetActorInfoResponse>(
          'actor.get_info',
          payload,
          getTargetConnectionId(),
          30000
        )

        console.log('[GetActorInfoTool] 收到响应:', response)

        if (response) {
          // RPC 错误响应透传
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          if (rpcOk === false || rpcSuccess === false) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '查询 Actor 失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = (response as any)?.details
            return {
              success: false,
              error: `查询 Actor 失败：${msg}`,
              code,
              details,
              raw: response
            }
          }

          const count = response.count ?? 0
          const totalFound = response.total_found ?? count

          // 判断是否是计数模式 (limit === 0)
          const isCountMode = input.limit === 0

          // 构建人类可读摘要。
          //
          // 「按选中查」查不到东西时要单独说清楚 —— 泛泛一句「找到 0 个 Actor」
          // 会让模型以为是自己选择器写错了，然后改用名字猜、写 Python 查选中，
          // 白烧好几轮。真相只有一个：用户此刻什么都没选，该回去问他。
          const summary = isCountMode
            ? `场景中共有 ${totalFound} 个匹配的 Actor。`
            : count === 0 && payload.targets.selection
              ? '编辑器里当前没有选中任何 Actor。请让用户在视口或世界大纲里选中目标后再试，不要改用别的方式去猜。'
              : `找到 ${count} 个 Actor` +
                (totalFound > count ? `（共 ${totalFound} 个，显示前 ${count} 个）` : '。')

          /**
           * 把这批 Actor 的位置跨度按米补一句。
           *
           * 读回来的 location 是一串裸数字，`-19.5` 按米读、按厘米读都成立 ——
           * 这正是「工具全程 success、数据全程自洽、场景全程是错的」那类事故的
           * 温床（原委见 `tools/ueUnits.ts` 文件头）。换算成米就一眼能看出来。
           * 计数模式没有 actors，自然也没有这一句。
           */
          const placement = isCountMode
            ? ''
            : describePlacementScale(
                (response.actors ?? [])
                  .map((actor) => actor.transform?.location)
                  .filter((loc): loc is NonNullable<typeof loc> => Boolean(loc))
              )

          return {
            success: true,
            count,
            total_found: totalFound,
            // 如果是计数模式，强制清空 actors 数组（节省 LLM Token）
            actors: isCountMode
              ? []
              : (response.actors || []).map((actor) => ({
                  ...withOrientation(actor),
                  geometry: { space: 'world', length_unit: 'cm', rotation_unit: 'deg' }
                })),
            ...systemActorFields(response),
            ...unmatchedTargetFields(response),
            ...worldFields(response),
            // 隐藏了多少一定要说 —— 包括计数模式：`total_found` 已经是扣掉系统
            // Actor 之后的数，不说清楚就成了一个对不上的数字
            message:
              summary +
              describeSystemActorExclusion(response) +
              // 点名了却没找到的那几个同理：查询这条路上「少认了一个」会直接变成
              // 下一步「少改了一个」，而调用方看到的是一句没有异常的成功
              describeUnmatchedTargets(response) +
              describeWorld(response) +
              placement
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[GetActorInfoTool] 执行失败:', error)
        // 查询本身超时也要留码：写操作之后的那次回读走的就是这个工具，
        // 压成普通失败的话，「写成功但没核实上」会被报成「写失败」
        return describeToolError(error)
      }
    }
  })
}
