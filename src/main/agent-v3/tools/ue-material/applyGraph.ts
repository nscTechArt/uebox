/**
 * `material_apply_graph` —— 一次调用写完整张材质图。
 *
 * ## 为什么要有它
 *
 * 蓝图那边早就不给「加一个节点」「连一根线」的工具了：`blueprint_apply_graph`
 * 一次收下全部节点和连线，因为**逐节点编辑**有三个躲不掉的毛病 ——
 * 每个节点一次往返、模型要自己记住一串引擎返回的 node_id、
 * 半路失败留下一张谁也说不清状态的半成品图。
 *
 * 材质一直停在逐节点模式，代价直接写在 skill 里：它得专门教模型
 * 「node_id 不可猜」「先建图最后 tidy 一次」「pin 名逐节点不同」。
 * 那些是工具形状该保证的事，不该由每次对话的上下文来背。
 *
 * ## 为什么 material_add_node / material_connect_pins 也下线了
 *
 * 它们留着当「已有图上的小修小补」，结果真机上的走向是：模型先用本工具建好一张
 * 排过版的图，接着的每一次修改都退回逐节点 —— 而那条路**没有任何一步会排版**。
 * add_node 不传 `position` 就落在 (0,0)，传了就是模型自己瞎猜的坐标。
 * 一次真实会话里 add_node 4 次、connect_pins 14 次、tidy **0 次**，
 * 最后交付的 `M_ToonFace_SDF` 是几个节点叠在一起的一团。
 *
 * 蓝图那边不会这样，不是因为模型在那边更自觉，是因为那边**根本没有逐节点工具** ——
 * 每一次写图都必经 `blueprint_apply_graph`，排版是路上的一步而不是可选的收尾。
 * 靠描述里写「请用整图写入」管不住，只有把另一条路拆掉才管得住。
 *
 * 本工具两端都接受图里已有的真实 node_id，所以「补一根线」「加一个节点」
 * 照样走这里（`nodes: []` 只发连线也合法），能力没有变窄。
 *
 * ## 和 blueprint_apply_graph 的一处**语义差别**
 *
 * 蓝图那条是全有或全无：插件端一次 RPC 收下整张图，失败就什么都没发生，
 * 所以它可以要求「改完重发完整的一份」。
 *
 * 这里做不到 —— 引擎侧只有 `material.add_node` / `material.connect_pins`
 * 这些单步命令，本工具是在主进程里按顺序发的。失败时前面已经落地的节点**不会回滚**。
 *
 * 所以它的约定是：**失败即停，并如实报出已经建成了什么**。
 * 重来的时候不要整张重发（会建出重复节点），按报告里的进度接着做。
 */

import { z } from 'zod'

import { layoutMaterialNodes } from './layout'
import { MaterialValueSchema } from './materialValueSchema'
import { callUe, UeNotConnectedError } from '../defineUeTool'
import { defineTool } from '../defineTool'
import type { UnrealAgentTool } from '../defineTool'
import { WebSocketErrorCode, WebSocketServiceError } from '../../../services/websocket/types'

/**
 * 这个错误说的是「引擎那边没了」，而不是「引擎说这件事不行」。
 *
 * 分界线是：出了这个错之后，「这张图已经写进去了」还站不站得住。
 *
 * **按错误码判，不要匹配错误文案。** 上一版是拿三个中文串去 `includes`，
 * 结果一个都没命中真正要抓的那条路 —— 那三句都是**还没发出去**就失败的
 * （`server.ts` 的 280 / 295 行），而编辑器在 120 秒编译**中途**崩掉时，
 * 请求是被 `requestStateManager` 拒掉的，文案完全是另一句
 * （「引擎在执行 material.compile 的过程中断开了连接」）。于是这个函数返回 false、
 * 异常被吞掉、工具照报成功外加一句「别整张重发」—— 正是它要防的事。
 * 而 `E_CLIENT_NOT_FOUND` 那一条更是死的：错误码在 `.code` 上，从来不在 `.message` 里。
 *
 * 要算失败的两种：
 * - `E_CONNECTION_CLOSED`：执行中途断了。编辑器可能是崩的，那个进程里未保存的
 *   改动一起没了，我们连「图写成了没有」都不知道。
 * - `E_CLIENT_NOT_FOUND` / `UeNotConnectedError`：压根没发出去。
 *
 * 不算失败的：
 * - `E_TIMEOUT`（120 秒没编完）：前面每一次 add_node / connect_pins 都成功返回过，
 *   连接是活的，只是这张图编得慢 ——「图写进去了」站得住，照常进回执。
 * - 引擎回的 400 / 404 / 编译报错：那是结论，同样进回执。
 *
 * **`E_ABORTED` 不在这张表里**，因为它到不了这儿：用户按停止的那一刻
 * `defineTool` 外面的 `runAbortable` 就赢了赛跑、抛出 `ToolAbortedError`，
 * 里面这条 RPC 的拒绝会被 `Promise.race` 当成「已处理」丢掉。
 * 列上它只会让人以为这条路有人走，配的用例也只能靠「不传 signal」才跑得到 ——
 * 那种绿是假的。真要管取消，归 `runAbortable`，不归这里。
 */
const TRANSPORT_CODES = new Set<WebSocketErrorCode>([
  WebSocketErrorCode.E_CONNECTION_CLOSED,
  WebSocketErrorCode.E_CLIENT_NOT_FOUND
])

function isTransportFailure(error: unknown): boolean {
  if (error instanceof UeNotConnectedError) return true
  return error instanceof WebSocketServiceError && TRANSPORT_CODES.has(error.code)
}

const NAMESPACE = 'ue.material'

/** 材质主节点的保留 id。连线目标写 `Material.BaseColor` 就是指它 */
const MATERIAL_OUTPUT = 'Material'

/**
 * 材质图节点类型。**必须与插件 `NodeTypeMap` 一一对应** ——
 * 枚举对模型来说就是能力清单，列一个引擎建不出来的类型，换来的是一次必然的 400；
 * 少列一个，模型就以为那种节点做不出来。
 *
 * 不列的那几个：Custom / SceneTexture / Comment 光有类建出来是废的，
 * ObjectPosition / ActorPosition / Rotator / DepthFade / ScreenPosition
 * 在部分引擎版本上没导出。
 *
 * `MaterialFunctionCall` 一度也在「废的」那一列，理由是「还要函数资产」——
 * 现在建的时候就能用 `function_path` 把函数挂上，节点是完整可用的，所以补了回来。
 * 同理 `CollectionParameter` 配 `collection_path`。
 */
const NODE_TYPES = [
  'Constant',
  'Constant2Vector',
  'Constant3Vector',
  'Constant4Vector',
  'ScalarParameter',
  'VectorParameter',
  'StaticSwitchParameter',
  'StaticBoolParameter',
  'TextureSample',
  'TextureSampleParameter2D',
  'TextureCoordinate',
  'TextureObject',
  'Add',
  'Subtract',
  'Multiply',
  'Divide',
  'Lerp',
  'Clamp',
  'Power',
  'Abs',
  'OneMinus',
  'Saturate',
  'Floor',
  'Ceil',
  'Frac',
  'Min',
  'Max',
  'Sine',
  'Cosine',
  'SquareRoot',
  'ComponentMask',
  'AppendVector',
  'Normalize',
  'DotProduct',
  'CrossProduct',
  'BreakMaterialAttributes',
  'MakeMaterialAttributes',
  'WorldPosition',
  'CameraPosition',
  'VertexNormalWS',
  'PixelNormalWS',
  'Time',
  'Panner',
  'Fresnel',
  'PixelDepth',
  'Noise',
  // 引用材质参数集合里的一个参数。要配套传 collection_path + node_name（参数名），
  // 少任何一样节点建出来是灰的，编译时报 Missing Parameter Collection
  'CollectionParameter',
  // 调用材质函数。要配套传 function_path —— 不传的话节点一个引脚都没有，
  // 症状要到连线那一步才暴露
  'MaterialFunctionCall'
] as const

export interface ApplyGraphNodeSpec {
  id: string
  node_type: string
  node_name?: string
  value?: unknown
  texture_path?: string
  function_path?: string
  collection_path?: string
  group_name?: string
}

interface AddNodeResponse {
  node_id?: string
  /** 稳定 id。删除/撤销之后 node_id 会位移，它不会 */
  guid?: string
  class?: string
  texture_applied?: boolean
  /** 引擎归一化之后真正去加载的那个路径。和发出去的一样时引擎不回这个字段 */
  resolved_texture_path?: string
  initial_value_applied?: boolean
  initial_value_error?: string
  /** 引擎回读出来的节点当前值 —— 拿它确认初始值真落上了，不用再读一次图 */
  value?: unknown
  collection_applied?: boolean
  collection_error?: string
}

interface GraphResponse {
  nodes?: Array<{ node_id: string; class?: string }>
  connections?: Array<{ from_node: string; to_node: string }>
  material_node_position?: { x: number; y: number }
}

interface CompileResponse {
  material_name?: string
  compiled?: boolean
  errors?: string[]
  warnings?: string[]
}

export interface ApplyGraphDetails {
  path: string
  /** 本地 id → 引擎真实 node_id。失败排查全靠它 */
  node_ids: Record<string, string>
  /**
   * 本地 id → 引擎 guid。
   *
   * `node_id` 是数组下标派生的，图里删掉一个节点，后面的全体位移 —— 拿着隔了
   * 几步的 node_id 回来改图，改中的是**另一个**节点，而且不报错。
   * guid 跟着对象走，引擎自己就是用它认节点的。
   */
  node_guids: Record<string, string>
  created: number
  connected: number
  tidied?: number
  compiled?: boolean
  compile_errors?: string[]
  compile_warnings?: string[]
  warnings: string[]
  /** 没做完时停在哪一步 */
  stopped_at?: string
}

/**
 * 连线写成 `节点id.引脚名`。
 *
 * 和 `blueprint_apply_graph` 的 `"begin.then"` 同一种写法 —— 两个图编辑工具
 * 用同一套记法，模型少记一样东西。材质主节点写 `Material.BaseColor`。
 *
 * 只在**第一个点**上切，不对引脚名设字符集：node_id 和 guid 都不含点号，
 * 而引脚名什么样由引擎说了算 —— `material_get_graph` 对没有名字的输入引脚
 * 就回 `<0>` 这种写法。拿正则把引脚名限成 `[A-Za-z0-9_]+`，等于让工具比它
 * 背后的 `material.connect_pins` 窄，那些引脚从此连不上。
 */
const ENDPOINT_NODE = /^[A-Za-z0-9_]+$/

/**
 * 像不像引擎自己发的 node_id。
 *
 * 引擎的 id 只有两种长相：`MaterialExpressionMultiply_5`（类名_序号）和 32 位 GUID。
 * 局部 id 是调用方随口起的（`uvco`、`base`、`tex`），两种都不像 —— 拿这个当判据，
 * 就能在建节点之前认出「上一次调用的局部 id 被拿来这次用了」。
 *
 * 判宽不判严：调用方把局部 id 起成 `tex_1` 会从这里漏过去，那就退回原来的行为
 * （引擎回 404）。反过来误伤一个合法的引擎 id，代价是一条本来能连的线连不上，
 * 那比漏判糟得多。
 */
const ENGINE_NODE_ID = /(_\d+$)|(^[0-9A-Fa-f]{32}$)/

/**
 * 主节点别名在**这一处**归一化，别让各处自己去比大小写。
 *
 * 插件那侧 `TargetNode == TEXT("Material")` 走的是 Stricmp，所以 `"material"`
 * 一直是能连上的。预检和 `connect()` 各写一套比较法的话，两边会错开：预检放行了
 * 小写，`connect()` 却还在用严格 ===，于是它掉进「查局部 id 映射」那条路 ——
 * 恰好有人把某个新节点的局部 id 起名叫 `material` 时，BaseColor 会被悄悄接到
 * 那个节点上，主输出一根线都没有，而且没有任何一处报错。
 * 归一化放在入口，下游一律拿到规范写法，这类错位就不可能发生。
 */
function normalizeEndpointNode(node: string): string {
  return node.toLowerCase() === MATERIAL_OUTPUT.toLowerCase() ? MATERIAL_OUTPUT : node
}

function splitEndpoint(raw: string, side: 'from' | 'to'): { node: string; pin: string } {
  const trimmed = raw.trim()
  const dot = trimmed.indexOf('.')
  const node = dot < 0 ? '' : trimmed.slice(0, dot)
  const pin = dot < 0 ? '' : trimmed.slice(dot + 1)

  if (!ENDPOINT_NODE.test(node) || pin.length === 0) {
    throw new Error(
      `${side} 写法不对：「${raw}」。要写成「节点id.引脚名」，` +
        `例如 "tex.RGB" 或 "${MATERIAL_OUTPUT}.BaseColor"。`
    )
  }
  return { node: normalizeEndpointNode(node), pin }
}

const NodeSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .describe('你自己起的局部 id，只在这一次调用里有效，连线时用它指代这个节点'),
  node_type: z.enum(NODE_TYPES).describe('节点类型，如 Constant3Vector、TextureSample、Lerp'),
  node_name: z.string().optional().describe('参数节点的参数名（ScalarParameter 等必填）'),
  value: MaterialValueSchema.optional().describe(
    '常量/参数节点的初始值。ComponentMask 用它指定取哪几个通道（"R" / "RG" / "RGB"，xyzw 拼法也认；**只能升序不重复**，"GR" 这种换序做不到，' +
      '回读一律换成 RGBA 拼法），不给或给空串会报 400'
  ),
  texture_path: z.string().optional().describe('TextureSample 的贴图资产路径'),
  function_path: z.string().optional().describe('MaterialFunctionCall 的函数资产路径'),
  collection_path: z.string().optional().describe('CollectionParameter 的 MPC 资产路径'),
  group_name: z.string().optional().describe('参数分组名')
})

const InputSchema = z.object({
  path: z.string().describe('材质资产路径，如 /Game/Materials/M_Wood'),
  nodes: z.array(NodeSchema).default([]).describe('这次要新建的节点。已存在的节点不用列'),
  connections: z
    .array(
      z.object({
        from: z.string().describe('源，写成「节点id.引脚名」，如 "tex.RGB"'),
        to: z.string().describe('目标，材质主节点写 "Material.BaseColor"')
      })
    )
    .default([])
    .describe('连线。两端可以用本次新建的 id，也可以用图里已有的真实 node_id'),
  tidy: z.boolean().default(true).describe('完事后自动排版。关掉的话节点会全叠在原点'),
  compile: z.boolean().default(true).describe('完事后自动编译。不编译改动不生效')
})

type Input = z.infer<typeof InputSchema>

/**
 * 参数节点 —— 这些类型不给 `node_name` 引擎会回 400。
 *
 * 和插件 `Handle_AddMaterialNode` 里那道校验对应：`UMaterialExpressionParameter`
 * 的子类，加上另一棵树上的贴图参数。手写一份的理由是这条要在**发第一条命令之前**
 * 就能判 —— 名单漂了最坏也就是少挡一次，仍然由引擎兜底。
 */
const PARAMETER_NODE_TYPES = new Set<string>([
  'ScalarParameter',
  'VectorParameter',
  'StaticSwitchParameter',
  'StaticBoolParameter',
  'TextureSampleParameter2D'
])

/**
 * ComponentMask 的通道串哪里不对，说不出问题就回空串。
 *
 * 规则和插件的 `UAL_ParseChannelMask` 一一对应：只认 RGBA / XYZW 八个字母，
 * 至少一个通道，而且**必须升序不重复** —— 那个节点底下只有四个 bool，
 * 没有 swizzle 的能力，收下 "GR" 就等于把「把 x 和 y 换过来」悄悄做成「取 RG」。
 *
 * 只判类型不判内容是不够的：引擎那道 400 排在 `NewObject` 之前，可它是
 * **逐节点**的，而这边一个一个发、失败即停、不回滚。二十个节点的图里第十二个
 * 写了 "GR"，前十一个就已经落进用户的材质了。
 */
export function describeChannelMaskProblem(value: unknown): string {
  if (typeof value !== 'string') return '没给（或者不是字符串）'

  const order: Record<string, number> = { R: 0, X: 0, G: 1, Y: 1, B: 2, Z: 2, A: 3, W: 3 }
  let last = -1
  for (const ch of value) {
    const rank = order[ch.toUpperCase()]
    if (rank === undefined) return `含有不是通道的字符「${ch}」`
    if (rank <= last) return `重复或换了序（"${value}"）`
    last = rank
  }
  return last < 0 ? '是空的，至少要一个通道' : ''
}

/** 浮点回读永远不会一位不差，差到这个量级才算「没设上」 */
const VALUE_EPSILON = 1e-4

/**
 * 差得够不够多才算「没设上」。**纯相对容差。**
 *
 * 要分的是两件事：float32 存一遍带来的舍入（噪声），和「这个值压根没落上」
 * （回读拿到的是节点默认值）。float32 的相对精度约 1e-7，所以 1e-4 的相对容差
 * 留了三个数量级的余量，够宽也够紧。
 *
 * 绝对容差在**大数**上必然误报：4096.3 存进 float32 再读回来是 4096.2998046875，
 * 差 1.95e-4；8192.35 差 3.9e-4；65536.1 差 1.56e-3 —— 全都超过 1e-4，
 * 而这些都是正常值（世界坐标尺度的常量、大 tiling）。
 *
 * 这里一度写成 `Math.max(1, |a|, |b|)`，想「小数仍按绝对容差判」。那是错的：
 * 那个下限只会在小数上**制造盲区** —— 发 0.0001、回读 0（默认值，也就是真没设上），
 * 差 1e-4 正好卡在绝对阈值上，被当成噪声放过去。而纯相对在每个量级上都对。
 */
function valuesDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) > VALUE_EPSILON * Math.max(Math.abs(a), Math.abs(b))
}

/**
 * 每种节点**装得下几个分量**。回读比对时拿它封顶。
 *
 * 引擎的 `ReadNodeValue` 一律回 `{r,g,b}` 或 `{r,g,b,a}`，不管这个节点
 * 实际存了几个 —— Constant2Vector 回的 b 恒为 0。所以「回读只有两个分量」
 * 这件事从回读的形状上看不出来，得靠类型表。
 *
 * 没列的类型（Multiply、Lerp 这些没有值的，以及 TextureCoordinate /
 * ComponentMask 这些走别的分支的）查不到就不封顶，按两边都有的比。
 */
const VALUE_COMPONENT_CAPACITY: Record<string, number> = {
  Constant: 1,
  ScalarParameter: 1,
  Constant2Vector: 2,
  Constant3Vector: 3,
  Constant4Vector: 4,
  VectorParameter: 4
}

/**
 * 颜色类的值归一成分量数组。不是颜色（数字、字符串、UV）就回 null。
 *
 * 入参这边收 `{r,g,b,a?}`、`{x,y,z?,w?}` 和 2~4 个数的数组三种写法，
 * 引擎回读那边只有一种（`{r,g,b}` 或 `{r,g,b,a}`，见 ReadNodeValue 的 ColorValue）。
 * 归一到同一个形状才比得了。
 */
function toColorComponents(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    // 长度必须在 2~4 之间。空数组照收的话 `every` 是 true、分量数是 0，
    // 比较循环一次都不跑就回「对得上」—— 值根本没设上，而回读校验放行了，
    // 恰好是这个函数存在的理由
    if (value.length < 2 || value.length > 4) return null
    return value.every((n) => typeof n === 'number') ? (value as number[]) : null
  }
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      if (typeof obj[key] === 'number') return obj[key] as number
    }
    return undefined
  }
  const r = pick('r', 'x')
  const g = pick('g', 'y')
  const b = pick('b', 'z')
  const a = pick('a', 'w')
  // 一个分量都没有 —— 那是 UV（u_tiling…）或者别的什么，不是颜色
  if (r === undefined && g === undefined && b === undefined) return null
  return a === undefined ? [r ?? 0, g ?? 0, b ?? 0] : [r ?? 0, g ?? 0, b ?? 0, a]
}

/**
 * 发出去的值和引擎回读的值**对不对得上**。对得上或者压根没法比时回空串。
 *
 * 这才是「回读校验」，而不是「看看有没有回一个字段」—— 后者对
 * 「值没设上但节点有个默认值」这种情况一点用都没有，而那正是要抓的。
 *
 * **只比不会误报的那几种**。假警报比不报更糟：它会让模型掉头去查一个不存在的
 * 问题（本仓库已经栽过一次，见 index.ts 里 from_type/to_type 那段）。所以：
 *
 * - 数字 vs 数字、布尔 vs 数字（引擎把 true 存成 1）、颜色 vs 颜色、UV vs UV
 *   —— 形状对得上，放心比。
 * - **字符串不比内容**。贴图路径发的是 `/Game/T_Rock`、回读的是
 *   `/Game/T_Rock.T_Rock`；ComponentMask 发的可以是 `"xy"`、回读永远是 `"RG"`。
 *   两种都是正常的，照着比就是满屏假警报。
 *   **但空串是例外**，见下面那一段。
 * - 形状对不上（发数字回对象之类）也不比：那多半是这个节点类型本来就这么存的。
 */
export function describeValueMismatch(sent: unknown, readBack: unknown, nodeType?: string): string {
  if (readBack === undefined || readBack === null) return ''

  /*
   * 给了个非空字符串、回读是**空串** —— 这一条要报。
   *
   * 「字符串不比」防的是写法差异（路径带不带资产名、通道拼 xy 还是 RG），
   * 可空串不是另一种写法，它只有一个意思：这个值没落上。
   * 同一个仓库别处早就这么认了 —— index.ts 的 formatNodeValue 把空串印成「(未设置)」。
   *
   * 最要紧的是 ComponentMask：四位全 0 的遮罩回读就是空串，而它编译出来恒为 0、
   * 材质照样编译通过、画面只是不对。本文件反复在防的就是这个静默失败，
   * 结果回读校验这一关自己把它放过去了。
   */
  if (typeof sent === 'string' && sent !== '' && readBack === '') {
    return `发的是 "${sent}"，引擎回读是空的（这个值没设上）`
  }

  // 布尔两边都归一成 0/1：静态开关回读的是 true/false，
  // 而常量类回读的是数字，入参两种写法都收
  const asNumber = (v: unknown): number | undefined => {
    if (typeof v === 'boolean') return v ? 1 : 0
    return typeof v === 'number' ? v : undefined
  }
  const sentNumber = asNumber(sent)
  const readNumber = asNumber(readBack)
  if (sentNumber !== undefined && readNumber !== undefined) {
    return valuesDiffer(sentNumber, readNumber)
      ? `发的是 ${JSON.stringify(sent)}，引擎回读是 ${JSON.stringify(readBack)}`
      : ''
  }

  // UV：两边键名一样，只比入参写了的那几项（没写的那项引擎有自己的默认值）
  const isUv = (v: unknown): boolean =>
    !!v && typeof v === 'object' && !Array.isArray(v) && ('u_tiling' in v || 'v_tiling' in v)
  if (isUv(sent) && isUv(readBack)) {
    const a = sent as Record<string, number>
    const b = readBack as Record<string, number>
    for (const key of ['u_tiling', 'v_tiling']) {
      if (
        typeof a[key] === 'number' &&
        typeof b[key] === 'number' &&
        valuesDiffer(a[key], b[key])
      ) {
        return `${key} 发的是 ${a[key]}，引擎回读是 ${b[key]}`
      }
    }
    return ''
  }

  const sentParts = toColorComponents(sent)
  const readParts = toColorComponents(readBack)
  if (sentParts && readParts) {
    /*
     * 比较的分量个数要**按节点类型封顶**，光靠 `Math.min` 不够。
     *
     * 反例：`Constant2Vector` 只存得下两个分量，可 `ReadNodeValue` 对它回的是
     * `ColorValue(FLinearColor(R, G, 0, 1), false)` —— 也就是 `{r,g,b}`，
     * 三个键，b 恒为 0。于是发 `[1,2,3]` 回读 `[1,2,0]` 时 `Math.min` 是 3，
     * 第三个分量一比就「对不上」，而那个 0 是节点类型决定的、引擎主动丢的，
     * 不是没设上。
     *
     * 那条假警报还附带一句「用 material_set_node_value 单独设一次」——
     * 那个调用回 200、什么也不改（节点根本没有第三个分量），模型会一直重试。
     * 假警报比不报更糟，何况这条还给了个死循环的下一步。
     */
    const capacity = nodeType ? VALUE_COMPONENT_CAPACITY[nodeType] : undefined
    const count = Math.min(sentParts.length, readParts.length, capacity ?? Number.MAX_SAFE_INTEGER)
    for (let i = 0; i < count; i++) {
      if (valuesDiffer(sentParts[i], readParts[i])) {
        return `发的是 [${sentParts.slice(0, count).join(', ')}]，引擎回读是 [${readParts.slice(0, count).join(', ')}]`
      }
    }
    return ''
  }

  return ''
}

/**
 * 建之前先把整批过一遍。
 *
 * 引擎那道 400 是逐节点的，而这里是**一个一个发**、失败即停、不回滚：
 * 二十个节点的图第十二个才违规，前十一个已经落进用户的材质里了，
 * 只能靠回执自己去收拾。能在客户端判的就别让它跑到引擎再说。
 */
function preflight(input: Input): void {
  const seen = new Set<string>()
  /** 「节点类型 + 参数名」→ 第一个用它的局部 id，用来在发命令之前抓同批撞名 */
  const parameterNames = new Map<string, string>()
  for (const node of input.nodes) {
    if (seen.has(node.id)) {
      throw new Error(`节点 id 重复：${node.id}。同一次调用里每个 id 只能出现一次。`)
    }
    seen.add(node.id)

    // `Material`（含大小写变体）是主输出的保留写法，拿它当局部 id 的话
    // 连到它的线会被当成接主输出，这个节点从此指不到 —— 当场说清楚
    if (node.id.toLowerCase() === MATERIAL_OUTPUT.toLowerCase()) {
      throw new Error(
        `节点 id 不能叫「${node.id}」：${MATERIAL_OUTPUT} 是材质主输出的保留写法（不分大小写），` +
          '连线时会被当成主节点。换个 id 重发。'
      )
    }

    if (PARAMETER_NODE_TYPES.has(node.node_type) && !node.node_name) {
      throw new Error(
        `节点 ${node.id}（${node.node_type}）缺 node_name。参数节点不给名字会用引擎默认的 ` +
          '"Param"，material_set_param 之后永远够不着它，而且不报错。' +
          '一个节点都还没建，补上名字重发即可。'
      )
    }

    /*
     * 同类型的参数名在这一批里不能重复。
     *
     * 引擎那边也有一道撞名 400，但它是**逐节点**的：二十个节点的图第十二个才撞，
     * 前十一个已经落进用户的材质里了，而这条路失败即停、不回滚。能在这里判的
     * 就别让它跑到引擎再说 —— 本函数开头那段注释讲的就是这件事。
     *
     * 按「类型 + 名字」判，和引擎的口径一致（`HasClassAndNameCollision` 比的是类）：
     * 一个 ScalarParameter "Tint" 和一个 VectorParameter "Tint" 在 UE 里合法，
     * 拦掉就是拦掉一张本来能用的图。
     *
     * 只管这一批内部。和图里**已有**节点撞名仍然由引擎回 400 —— 那要读一次图才知道，
     * 不值得为它多跑一趟往返。
     */
    if (PARAMETER_NODE_TYPES.has(node.node_type) && node.node_name) {
      const key = `${node.node_type} ${node.node_name}`
      const firstUse = parameterNames.get(key)
      if (firstUse !== undefined) {
        throw new Error(
          `参数名重复：节点 ${node.id} 和 ${firstUse} 都是 ${node.node_type}「${node.node_name}」。` +
            '同名同类型的参数两个都建得出来，但 material_set_param 只够得着其中一个，' +
            '另一个会一直拿旧值喂图，而且不报错。' +
            '一个节点都还没建，改掉其中一个的名字（或者删掉多余那个）重发即可。'
        )
      }
      parameterNames.set(key, node.id)
    }
    if (node.node_type === 'ComponentMask') {
      const problem = describeChannelMaskProblem(node.value)
      if (problem) {
        throw new Error(
          `节点 ${node.id}（ComponentMask）的 value ${problem}。要写成取哪几个通道，` +
            '如 "R" / "RG" / "RGB"（xyzw 拼法也认；只能升序不重复，换序做不到）。' +
            '一个节点都还没建，补上重发即可。'
        )
      }
    }
  }

  /*
   * 连线写法也在这儿判。
   *
   * `splitEndpoint` 是纯客户端的正则检查，一次引擎往返都不用 —— 可它以前跑在
   * `connect()` 里，而 `connect()` 排在 `addNodes()` 后面。于是「二十个节点加一条
   * 少写引脚名的连线」会先把二十个节点建进用户的材质，再报「停在连线」，
   * 不回滚。挪到这里，这一类失败就是干净的。
   */
  for (const conn of input.connections) {
    const from = splitEndpoint(conn.from, 'from')
    const to = splitEndpoint(conn.to, 'to')
    for (const node of [from.node, to.node]) {
      // 大小写已经在 splitEndpoint 里归一化了，这里和 connect() 一样用严格比较
      if (node === MATERIAL_OUTPUT || seen.has(node) || ENGINE_NODE_ID.test(node)) continue
      throw new Error(
        `连线端点「${node}」既不在本次 nodes 里，也不像引擎的 node_id。` +
          '局部 id **只在这一次调用里有效** —— 上一次调用返回的那批，这次已经失效了。' +
          `要连图里已有的节点，先用 material_get_graph 拿真实 node_id（形如 ` +
          `MaterialExpressionMultiply_5）填进来。一个节点都还没建，改完重发即可。`
      )
    }
  }
}

async function addNodes(
  input: Input,
  details: ApplyGraphDetails,
  signal?: AbortSignal
): Promise<void> {
  for (const node of input.nodes) {
    const r = await callUe<AddNodeResponse>(
      'material.add_node',
      {
        material_path: input.path,
        node_type: node.node_type,
        ...(node.node_name !== undefined ? { node_name: node.node_name } : {}),
        ...(node.value !== undefined ? { initial_value: node.value } : {}),
        ...(node.texture_path !== undefined ? { texture_path: node.texture_path } : {}),
        ...(node.function_path !== undefined ? { function_path: node.function_path } : {}),
        ...(node.collection_path !== undefined ? { collection_path: node.collection_path } : {}),
        ...(node.group_name !== undefined ? { group_name: node.group_name } : {})
      },
      { signal }
    )

    if (!r.node_id) throw new Error(`节点 ${node.id}（${node.node_type}）没有返回 node_id。`)
    details.node_ids[node.id] = r.node_id
    if (r.guid) details.node_guids[node.id] = r.guid
    details.created++

    // 「建出来了」和「贴图/值/集合接上了」是两回事，引擎只在响应体里埋一个
    // *_applied: false。逐节点调用时这些警告至少还会各自回一句话，
    // 批量之后如果不收集，它们就彻底消失了 —— 那才是最坏的结果
    if (node.texture_path && r.texture_applied === false) {
      // 引擎会把路径归一化之后再去加载（裸名字会被补成 /Game/Materials/xxx）。
      // 只印发出去的那个，调用方看不到这一步改写，会对着一个自己写对了的名字干瞪眼
      const tried =
        r.resolved_texture_path && r.resolved_texture_path !== node.texture_path
          ? `${node.texture_path} → 实际去找的是 ${r.resolved_texture_path}`
          : node.texture_path
      details.warnings.push(`${node.id}：贴图没设上（${tried} 加载失败），节点是空的。`)
    }
    if (r.collection_applied === false) {
      details.warnings.push(
        `${node.id}：资产没接上（${r.collection_error ?? '未说明原因'}），这个节点是残的，别指望它的引脚。`
      )
    }
    /*
     * 初始值分四种情况收，**别把「有个字段」当成「值对了」**。
     *
     * 1. 明说失败（`=== false`）：照报。
     * 2. 回读的值和发出去的对不上：这是真正的回读校验。插件自己的注释写着
     *    `initial_value` 曾经**从来没生效过、全程 200** —— 那种插件照样会回一个
     *    `value`（ReadNodeValue 读的是节点当前值，没设上就是默认值），
     *    所以只看 `value !== undefined` 等于什么都没验：二十个节点的图每个常量
     *    都停在 0，工具报「✅ 编译通过」，用户拿到一个全黑的材质。
     * 3. 两个字段都没有：老插件，说「确认不了」，别替它断言成功。
     * 4. 对得上：不吭声。
     *
     * 注意 `=== false` 那条单独判：老插件不回这个字段，而 `undefined === false`
     * 是 false，所以缺失必须单独走第 3 条，不能靠它兜。
     */
    if (node.value !== undefined) {
      const mismatch = describeValueMismatch(node.value, r.value, node.node_type)
      if (r.initial_value_applied === false) {
        details.warnings.push(
          `${node.id}：初始值没设上（${r.initial_value_error ?? '未说明原因'}），现在是默认值。`
        )
      } else if (mismatch) {
        /*
         * 让模型去补设的话，得把**它能填进去的那个 id** 一起给。
         *
         * `node.id` 是调用方自己起的局部 id（'base'），引擎不认。
         * 而成功那条路的正文只印局部 id→guid 的映射，`details.node_ids` 不进上下文，
         * `material_set_node_value` 的 schema 又写着 node_id「猜不出来」——
         * 于是「用 material_set_node_value 单独设一次」是句没法执行的话。
         * 这里直接把真实 node_id 放进警告里。
         */
        details.warnings.push(
          `${node.id}（node_id=${r.node_id}）：初始值**回读对不上** —— ${mismatch}。` +
            `这个节点现在的值不是你要的，用 material_set_node_value 对 node_id=${r.node_id} 单独设一次。`
        )
      } else if (r.initial_value_applied === undefined && r.value === undefined) {
        details.warnings.push(
          `${node.id}：初始值**没法确认**落没落上 —— 这个插件版本既不回 initial_value_applied ` +
            '也不回读 value。用 material_get_graph 核一下，或者升级插件。'
        )
      }
    }
  }
}

async function connect(
  input: Input,
  details: ApplyGraphDetails,
  signal?: AbortSignal
): Promise<void> {
  for (const conn of input.connections) {
    const from = splitEndpoint(conn.from, 'from')
    const to = splitEndpoint(conn.to, 'to')

    // 本次新建的用局部 id 映射；图里已有的节点直接按真实 id 传过去
    const sourceNode = details.node_ids[from.node] ?? from.node
    const targetNode =
      to.node === MATERIAL_OUTPUT ? MATERIAL_OUTPUT : (details.node_ids[to.node] ?? to.node)

    await callUe(
      'material.connect_pins',
      {
        material_path: input.path,
        source_node: sourceNode,
        source_pin: from.pin,
        target_node: targetNode,
        target_pin: to.pin
      },
      { signal }
    )
    details.connected++
  }
}

async function tidy(input: Input, details: ApplyGraphDetails, signal?: AbortSignal): Promise<void> {
  const graph = await callUe<GraphResponse>(
    'material.get_graph',
    { path: input.path, include_values: false },
    { signal }
  )
  const nodes = graph.nodes ?? []
  if (nodes.length === 0) return

  const positions = await layoutMaterialNodes(
    nodes,
    graph.connections ?? [],
    graph.material_node_position ?? { x: 0, y: 0 }
  )
  const applied = await callUe<{ moved?: number }>(
    'material.set_node_positions',
    { material_path: input.path, positions },
    { signal }
  )
  details.tidied = applied.moved ?? 0
}

export function createMaterialApplyGraphTool(): UnrealAgentTool<ApplyGraphDetails> {
  return defineTool<typeof InputSchema, ApplyGraphDetails>({
    name: 'material_apply_graph',
    namespace: NAMESPACE,
    risk: 'mutating',
    // 改的是同一份图，并发会互相覆盖
    concurrency: 'sequential',
    description: `一次写完一张材质图：新建全部节点、连好全部线、排版、编译。

**往材质图里加节点、连线，只有这一个工具。** 逐节点加节点、逐根连线的工具
故意没有 —— 那条路不排版，走过一遍的图就是一堆叠在一起的节点。

这里用你自己起的局部 id 连线，真实 id 由工具负责对应。

连线写成「节点id.引脚名」，材质主节点固定写 "Material"：

    nodes: [
      { id: "base", node_type: "Constant3Vector", value: { r: 0.8, g: 0.1, b: 0.1 } },
      { id: "rough", node_type: "ScalarParameter", node_name: "Roughness", value: 0.4 }
    ]
    connections: [
      { from: "base.Default", to: "Material.BaseColor" },
      { from: "rough.Default", to: "Material.Roughness" }
    ]

两端也可以填图里已有节点的真实 node_id 或 guid（先用 material_get_graph 拿），
所以往已有材质上补一段链路、或者只补一根线（nodes 传空数组），同样用这个工具。

【引脚名不要猜】不确定某个节点类型的引脚叫什么，先 material_search_nodes 查 ——
一次能拿回十几个类型的完整签名。猜必错：Sine 的输入叫 Input、Lerp 的叫 A/B/Alpha、
TextureSample 的 UV 输入叫 **Coordinates** 而不是 UVs。

【取分量】要 float2/float3 的某一路，用 ComponentMask，value 写 "R"/"G"/"B"/"RG"。
不带名字的多输出节点（Constant3Vector 等）也可以直接写通道名连出去，
如 from: "c3.G"。不要用 DotProduct 点乘 (1,0) 那种绕法，那会让节点数翻倍。

【排版】
默认排完版（tidy=true）—— 只挪位置，不动逻辑。用户手摆过的图不想被重排的话
传 tidy=false，但那样新节点会落在原点上，记得自己调 material_tidy_graph。

【失败时会怎样】
引擎侧没有整张图的原子写入，本工具是按顺序发的单步命令。**失败即停，
已经建好的节点不会回滚** —— 回执里会写清停在哪一步、哪些 id 已经建成。
重来时不要整张重发（会建出重复节点），接着没做完的那部分做。

【不做的事】
不删节点、不断线（那是 material_delete_node / material_disconnect_pins），
不落盘（完事记得 ue_save）。`,
    input: InputSchema,
    execute: async (input, ctx) => {
      const details: ApplyGraphDetails = {
        path: input.path,
        node_ids: {},
        node_guids: {},
        created: 0,
        connected: 0,
        warnings: []
      }

      const fail = (step: string, error: unknown): { text: string; isError: true } => {
        details.stopped_at = step
        const reason = error instanceof Error ? error.message : String(error)
        const done = Object.entries(details.node_ids)
          .map(([local, real]) => `${local}→${real}`)
          .join('、')

        return {
          text: [
            `❌ 停在「${step}」：${reason}`,
            `已建成 ${details.created} 个节点、连好 ${details.connected} 根线。`,
            done ? `已建节点的真实 id：${done}` : '还没有节点建成。',
            '这些**不会回滚**。修正之后接着没做完的那部分做，不要整张重发 —— 会建出重复节点。'
          ].join('\n'),
          isError: true
        }
      }

      // 一条命令都还没发出去就先整批过一遍 —— 这一步失败是干净的，
      // 用户的材质里不会留下半张图
      try {
        preflight(input)
      } catch (error) {
        return {
          text: `❌ ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          details
        }
      }

      try {
        await addNodes(input, details, ctx.signal)
      } catch (error) {
        return { ...fail('建节点', error), details }
      }

      try {
        await connect(input, details, ctx.signal)
      } catch (error) {
        return { ...fail('连线', error), details }
      }

      if (input.tidy) {
        try {
          await tidy(input, details, ctx.signal)
        } catch (error) {
          /*
           * 排版失败**分两种**，和下面编译那一步同一条分界线（见 isTransportFailure）。
           *
           * 「引擎说排不了」不影响材质本身对不对，吞掉、留个警告就行。
           * 但「引擎那边没了」（编辑器崩在半路 / 连接断了）不是排版的结论 ——
           * 这里一律吞的话，tidy 开着而 compile 关着时，用户会收到一句「已写入」，
           * 而那张图可能根本没落盘。
           *
           * 用户按停止不走这条路：那归 `runAbortable` 管，见文件头 isTransportFailure
           * 那段注释里为什么 `E_ABORTED` 不在表里。
           */
          if (isTransportFailure(error)) {
            return { ...fail('排版', error), details }
          }
          details.warnings.push(
            '自动排版没成功，节点可能叠在一起。可以单独调 material_tidy_graph。'
          )
        }
      }

      /*
       * 编译这一步**也要包起来**。
       *
       * 建节点、连线都走 `fail()`，排版也包了（注释写着「排版失败不影响材质本身
       * 对不对」），只有编译是裸的 —— 而它会 404（材质被改名/回收）、会 400、
       * 还有 120 秒超时。一旦抛出去，整个回执连同 node_id 映射一起没了，
       * 模型只剩一句「material.compile 失败」，然后照着本工具「不要整张重发」
       * 的相反方向把 25 个节点又建了一遍。
       *
       * 编译失败不等于图没写成：节点和线都已经落地了，这一步的结果是**附加信息**，
       * 不该吃掉主报告。
       */
      if (input.compile) {
        try {
          const r = await callUe<CompileResponse>(
            'material.compile',
            { path: input.path, force_recompile: false },
            // signal 一定要带上。这一条是整个工具里最长的一次等待（120 秒），
            // 用户按停止之后还占着串行队列两分钟的就是它
            { timeoutMs: 120_000, signal: ctx.signal }
          )
          details.compiled = r.compiled !== false && (r.errors ?? []).length === 0
          details.compile_errors = r.errors ?? []
          details.compile_warnings = r.warnings ?? []
        } catch (error) {
          /*
           * **引擎没了**要算工具失败，只有引擎自己报的编译失败才能吞。
           *
           * 一律 catch 住的话，编辑器编译到一半崩掉 = 工具报**成功**，正文还写着
           * 「节点和连线都已经写进去了，别整张重发」—— 而那个进程里的未保存改动
           * 已经全没了。模型照做，往一张回到旧状态的材质上接着加东西。
           *
           * 走 `fail()` 而不是 `throw error`：两者都会让 pi 判定失败，但只有
           * `fail()` 把「a→Multiply_3、b→Lerp_7」这份 id 映射带出去，而那正是
           * 这一整个 try 存在的理由 —— 直接 throw 等于一边说「别整张重发」
           * 一边把接着做所需要的 id 全扔了。
           *
           * **注意 id 是靠 `text` 出去的，不是靠 `details`。** `defineTool` 在
           * `if (outcome.isError) throw new ToolFailure(outcome.text)` 这一句就抛了，
           * 排在 `toAgentResult(outcome)` 前面 —— 也就是说失败路径上 `details`
           * 根本不会被送出去（下面那个 `details` 只为类型齐整，不承担传递作用）。
           * 谁要是为了省 token 把 id 从 `fail()` 的正文挪进 `details`，
           * 这份回执当场就空了，而且不会有任何报错。
           *
           * 分界线是「这条消息能不能当结论用」：引擎回的 400/404/编译错误、还有
           * 编译超时都是结论（连接是活的，图确实写进去了），收进回执照常报成功；
           * 连接断了和被取消不是 —— 那种情况下我们连「图写成了没有」都不知道。
           */
          if (isTransportFailure(error)) {
            return { ...fail('编译', error), details }
          }
          details.compiled = false
          details.compile_errors = [
            `没能编译（${error instanceof Error ? error.message : String(error)}）—— ` +
              '节点和连线都已经写进去了，别整张重发。单独调 material_compile 再看一次。'
          ]
        }
      }

      const lines = [
        `已写入 ${input.path}：新建 ${details.created} 个节点，连好 ${details.connected} 根线` +
          (details.tidied !== undefined ? `，排版 ${details.tidied} 个节点` : '') +
          '。'
      ]

      /*
       * 稳定 id 要在这里给出来，不然它只存在于 details 里，模型看不见。
       *
       * 回头再改这张图（删一个节点、加一段链路）时，node_id 早就位移了 ——
       * 那时拿 guid 指节点才指得准。逐节点工具下线之后，这是**唯一**报出
       * guid 的写入路径，漏了它就得靠一次 material_get_graph 补回来。
       */
      const guids = Object.entries(details.node_guids)
      if (guids.length > 0) {
        lines.push(
          '稳定 id（中间做过删除或撤销之后用它指节点，node_id 会位移、guid 不会）：' +
            guids.map(([local, guid]) => `${local}=${guid}`).join('、')
        )
      }

      if (input.compile) {
        lines.push(
          details.compiled
            ? '✅ 编译通过。'
            : `❌ 编译失败，${details.compile_errors?.length ?? 0} 个错误：`
        )
        for (const e of details.compile_errors ?? []) lines.push(`  ${e}`)
      }
      for (const w of details.compile_warnings ?? []) lines.push(`⚠️ ${w}`)
      for (const w of details.warnings) lines.push(`⚠️ ${w}`)

      lines.push('改动还没落盘，完事记得 ue_save。')

      return { text: lines.join('\n'), details }
    }
  })
}
