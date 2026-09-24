/**
 * UE PCG（程序化内容生成）工具集。
 *
 * ## 为什么值得单独做一套
 *
 * UE 5.8 官方 MCP 里有 PCG 工具集，但那套只在 5.8+ 存在。PCG 这个功能本身是
 * 5.2 引入、5.4–5.6 Beta、5.7 转正式版的 —— 也就是说 **5.4 到 5.7 这四个版本
 * 有 PCG 但没有官方 MCP**，而 5.7 刚好是 PCG 转正式版、项目开始大量用它的版本。
 * 那段窗口只有我们能接。
 *
 * ## 实现约束：引擎侧全程走反射
 *
 * PCG 是可选插件，我们发的又是预编译二进制。插件里的 `pcg.*` 命令没有链接 PCG
 * 模块，全靠反射调（见 `plugin/.../UAL_PCGCommands.cpp` 的文件头注释）。
 * 对这一层的影响只有一个：**PCG 没启用时命令返回 501 而不是崩**，
 * 所以每个工具的描述里都要能引导模型去看 `pcg_status`。
 *
 * ## 节点怎么寻址
 *
 * `node_id` 是引擎给节点起的对象名，一张图内唯一。图自带的输入/输出节点用
 * `"Input"` / `"Output"` 这两个别名访问 —— 它们不在节点列表里，也删不掉。
 */

import { z } from 'zod'

import { layoutPcgNodes, type PcgLayoutEdge, type PcgLayoutNode } from './layout'
import { callUe, defineUeTool } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'
import { withPartialHeadline, type PartialFailure } from '../partialResult'
import { formatCmWithMeters, type Vec3Like } from '../ueUnits'

const NAMESPACE = 'ue.pcg'

/** PCG 生成可能跑很久，别用默认的 30 秒 */
const EXECUTE_TIMEOUT_MS = 300_000

const GraphPathSchema = z
  .string()
  .describe('PCG 图资产路径，如 /Game/PCG/PCG_Forest。不带 /Game/ 前缀会自动补 /Game/PCG/')

/**
 * 属性键名支持路径语法，这段说明在好几个工具的描述里复用。
 *
 * PCG 里真正要配的东西大多埋在几层下面，最典型的是静态网格生成器的树种列表 ——
 * 它在第 4 层。不写清楚这一点，模型只会去试顶层标量，试不通就以为做不到。
 */
const PROPERTY_PATH_HELP = `属性名支持**路径**，穿透嵌套结构体、数组和子对象，例如
\`MeshSelectorParameters.MeshEntries[0].Descriptor.StaticMesh\`（生成器第 1 个网格）和
同一条上的 \`.Weight\`（权重）。下标超长会自动扩容，直接写 [0] [1] [2] 即可。
每一项写完都**回读校验**，返回里带上实际写进去的值。`

/**
 * 属性选择器（`InputSource` / `TargetAttribute` 这类）要写成
 * `"PCGBegin(Distance)PCGEnd"` 这种字符串，写成 `{"AttributeName": ...}` 只会
 * 写进名字、把「属性还是点属性」那一位留在原值 —— 图跑出来 0 个实例且不报错。
 *
 * **这件事刻意不写进工具描述里。** 前缀是每一轮、每个用户、不管用不用得上
 * 都要全额付的（三个工具各 +275 字符）。而这个坑现在有两道更便宜的防线：
 *   - 插件端直接**拒绝**对象写法，并在错误里回显当前值的正确格式
 *     （UAL_PropertyPath.cpp 的 StructHasOwnTextFormat）；
 *   - `resources/skills/ue-pcg-scattering/SKILL.md` 里写全了，
 *     而那份文档只在真的要做 PCG 时才进上下文。
 *
 * 一次「事后报错 + 照抄格式重发」是 1 次往返，比让所有人天天付这 825 字符划算。
 */

// ======================================================================
// 只读
// ======================================================================

const pcgStatus = defineUeTool({
  name: 'pcg_status',
  namespace: NAMESPACE,
  method: 'pcg.status',
  risk: 'safe',
  description: `查这个工程能不能用 PCG，以及 PCG 插件的版本。

**任何 pcg_* 工具报「501」时先调这个**，它会告诉你到底是引擎太老（5.2 以前没有 PCG）
还是插件装了但没在工程里启用（用户需要去 编辑 > 插件 里打开再重启编辑器）。

返回里的 node_type_count 是这个工程实际可用的节点类型数量 —— 它大于 0 就说明 PCG 真的活着。`,
  input: z.object({})
})

interface PcgGraphNode {
  node_id: string
  type: string
  title?: string
  x: number
  y: number
  comment?: string
  input_pins: string[]
  output_pins: string[]
}

interface PcgGraphResponse {
  graph_path: string
  nodes: PcgGraphNode[]
  edges: Array<{ from_node: string; from_pin: string; to_node: string; to_pin: string }>
  node_count: number
  edge_count: number
  /** 图自带的两个端点，它们的真名是 DefaultInputNode / DefaultOutputNode，光看列表分不出来 */
  input_node_id?: string
  output_node_id?: string
}

const GetGraphSchema = z.object({ graph_path: GraphPathSchema })

const pcgGetGraph = defineUeTool<typeof GetGraphSchema, PcgGraphResponse>({
  name: 'pcg_get_graph',
  namespace: NAMESPACE,
  method: 'pcg.get_graph',
  risk: 'safe',
  description: `读一张 PCG 图的完整结构：所有节点（类型、位置、引脚）和所有连线。

改图之前先调它拿当前的 node_id —— 别的工具都靠 node_id 定位节点，
而 node_id 是引擎生成的（如 PCGSurfaceSampler_0），猜不出来。

图自带的输入输出节点也在列表里（真名是 DefaultInputNode / DefaultOutputNode），
返回里的 input_node_id / output_node_id 会点明是哪两个。连线时直接写
"Input" / "Output" 这两个别名就行。

引脚列表只含在编辑器里看得见的那些 —— 那也正是能连的那些。`,
  input: GetGraphSchema,
  toOutcome: (response) => {
    const endpoint = (id: string): string =>
      id === response.input_node_id
        ? '（图的输入端点，别名 Input）'
        : id === response.output_node_id
          ? '（图的输出端点，别名 Output）'
          : ''

    return {
      text:
        `${response.graph_path}：${response.node_count} 个节点，${response.edge_count} 条连线。\n` +
        response.nodes
          .map(
            (n) =>
              `- ${n.node_id}（${n.type}）${endpoint(n.node_id)} ` +
              `in:[${n.input_pins.join(', ')}] out:[${n.output_pins.join(', ')}]`
          )
          .join('\n') +
        (response.edges.length
          ? '\n连线：\n' +
            response.edges
              .map((e) => `- ${e.from_node}.${e.from_pin} → ${e.to_node}.${e.to_pin}`)
              .join('\n')
          : '\n（还没有任何连线）'),
      details: response
    }
  }
})

const pcgListNodeTypes = defineUeTool({
  name: 'pcg_list_node_types',
  namespace: NAMESPACE,
  method: 'pcg.list_node_types',
  risk: 'safe',
  description: `列出这个工程里可用的 PCG 节点类型。

**加节点之前先用它确认类型名存在**，别凭记忆写 —— 不同引擎版本和不同插件组合下
可用的节点差别很大，写一个不存在的类型只会换来一次失败。

带 search 缩小范围（如 search="Spawner" 找生成器、search="Sampler" 找采样器）。
不带 search 时只返回前 120 个，返回里的 truncated_hint 会说明被截断了多少。`,
  input: z.object({
    search: z
      .string()
      .optional()
      .describe('按类型名模糊筛选，不区分大小写。如 "Sampler" / "Spawner" / "Filter"'),
    limit: z.number().int().min(1).max(1000).optional().describe('最多返回几条，默认 120')
  })
})

const pcgGetNodeSchema = defineUeTool({
  name: 'pcg_get_node_schema',
  namespace: NAMESPACE,
  method: 'pcg.get_node_schema',
  risk: 'safe',
  description: `查一个 PCG 节点类型有哪些引脚、哪些属性可以改，以及每个属性的默认值。

**连线之前先查引脚名**：PCG 的引脚名不都是 In / Out，采样器、过滤器、循环节点
各有各的命名，写错了 pcg_connect_pins 会拒绝。

**改属性之前先查属性名**：pcg_add_node 和 pcg_update_node 的 properties 只认这里列出的名字。`,
  input: z.object({
    node_type: z
      .string()
      .describe(
        '节点类型名，如 PCGSurfaceSamplerSettings。也认省略写法 SurfaceSampler，会自动补 PCG 前缀和 Settings 后缀'
      )
  })
})

// ======================================================================
// 建图 / 改图
// ======================================================================

const pcgCreateGraph = defineUeTool({
  name: 'pcg_create_graph',
  namespace: NAMESPACE,
  method: 'pcg.create_graph',
  risk: 'mutating',
  description: `新建一个空的 PCG 图资产。新图自带 Input 和 Output 两个节点。

建完之后典型流程是：pcg_add_node 加节点 → pcg_connect_pins 连起来 →
pcg_spawn_volume 放到关卡里 → pcg_execute 跑一次看结果。`,
  input: z.object({
    name: z.string().describe('图的名字，如 PCG_Forest'),
    path: z.string().optional().describe('存放目录，默认 /Game/PCG')
  })
})

interface PcgNodeWriteResponse {
  node_id?: string
  updated_properties?: unknown[]
  failed_properties?: Array<{ name: string; error?: string }>
}

/**
 * add_node / update_node 的回执。
 *
 * 全成功时原样给 JSON —— 引脚、坐标都是回读的，模型接下来连线要用。
 * 有属性没设上时第一句先说「部分完成」：裸 JSON 里 failed_properties 排在
 * 引脚列表后面，模型常常读不到那儿（AGENTS.md §5 第 14 条）。
 * 全失败由插件回 400，走抛错那条路。
 */
function nodeWriteOutcome(response: PcgNodeWriteResponse): {
  text: string
  details: PcgNodeWriteResponse
} {
  const failed = response.failed_properties ?? []
  const failures: PartialFailure[] = failed.map((f) => ({ item: f.name, reason: f.error }))
  return {
    text: withPartialHeadline(
      JSON.stringify(response),
      { succeeded: response.updated_properties?.length ?? 0, failed: failed.length },
      failures
    ),
    details: response
  }
}

const pcgAddNode = defineUeTool({
  name: 'pcg_add_node',
  namespace: NAMESPACE,
  method: 'pcg.add_node',
  risk: 'mutating',
  description: `往 PCG 图里加一个节点，可以同时设好位置和属性。

**要搭一整张图别用这个** —— 用 pcg_apply_graph 一次写完，逐个加节点既慢又容易在
中途某一步出错而不自知。这里只适合往已有的图上补一个节点。

node_type 先用 pcg_list_node_types 确认存在。

${PROPERTY_PATH_HELP}

部分属性写错时节点照样加上，failed_properties 逐条说明哪个没设上、以及最接近的
正确名字；一个都设不上则整体失败，节点不留。

不指定 x / y 的话节点会全叠在原点，加完记得用 pcg_tidy_graph 排一下。`,
  input: z.object({
    graph_path: GraphPathSchema,
    node_type: z.string().describe('节点类型名，如 PCGSurfaceSamplerSettings'),
    x: z.number().int().optional().describe('节点在图里的 X 坐标'),
    y: z.number().int().optional().describe('节点在图里的 Y 坐标'),
    title: z.string().optional().describe('自定义节点标题，不填用默认的'),
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('要设置的属性，键名来自 pcg_get_node_schema。如 { "PointsPerSquaredMeter": 0.1 }')
  }),
  toOutcome: (response) => nodeWriteOutcome(response as PcgNodeWriteResponse)
})

const pcgUpdateNode = defineUeTool({
  name: 'pcg_update_node',
  namespace: NAMESPACE,
  method: 'pcg.update_node',
  risk: 'mutating',
  description: `改一个已有 PCG 节点的属性、标题或注释。

${PROPERTY_PATH_HELP}

多配几个树种就把下标往后排（\`MeshEntries[1]\`、\`[2]\`…），数组会自动扩容。

所有属性都设不上时整体失败、什么都不改（标题和注释也不改），部分成功时返回
updated_properties 和 failed_properties 两份清单。`,
  input: z.object({
    graph_path: GraphPathSchema,
    node_id: z.string().describe('节点 id，来自 pcg_get_graph'),
    title: z.string().optional().describe('新的节点标题'),
    comment: z.string().optional().describe('节点上的注释文字'),
    properties: z.record(z.string(), z.unknown()).optional().describe('要改的属性')
  }),
  toOutcome: (response) => nodeWriteOutcome(response as PcgNodeWriteResponse)
})

const pcgRemoveNode = defineUeTool({
  name: 'pcg_remove_node',
  namespace: NAMESPACE,
  method: 'pcg.remove_node',
  risk: 'mutating',
  description: `从 PCG 图里删掉一个节点，连着它的线也会断开。可撤销（Ctrl+Z）。

图自带的 Input / Output 节点删不掉。`,
  input: z.object({
    graph_path: GraphPathSchema,
    node_id: z.string().describe('要删的节点 id，来自 pcg_get_graph')
  })
})

const pcgConnectPins = defineUeTool({
  name: 'pcg_connect_pins',
  namespace: NAMESPACE,
  method: 'pcg.connect_pins',
  risk: 'mutating',
  description: `把一个节点的输出引脚连到另一个节点的输入引脚。

**引脚名一般不用填** —— 不填时会自动选那个方向上唯一的可见引脚。有多个候选时
才会要求你指定，并把候选列出来。

⚠️ 别自己猜 "In" / "Out"：图的 Input 节点输出引脚叫 **"In"**、Output 节点输入引脚叫
**"Out"**，跟直觉正好相反。不填让工具去定，比猜可靠。

连完会**回读整张图确认这条边真的存在**才报成功。连不上时明确报错，并附上两端
实际可用的引脚名。`,
  input: z.object({
    graph_path: GraphPathSchema,
    from_node: z.string().describe('上游节点 id，或 "Input" 表示图的输入节点'),
    from_pin: z
      .string()
      .optional()
      .describe('上游节点的输出引脚名。不填则自动选唯一的那个（推荐）'),
    to_node: z.string().describe('下游节点 id，或 "Output" 表示图的输出节点'),
    to_pin: z.string().optional().describe('下游节点的输入引脚名。不填则自动选唯一的那个（推荐）')
  })
})

const pcgDisconnectPins = defineUeTool({
  name: 'pcg_disconnect_pins',
  namespace: NAMESPACE,
  method: 'pcg.disconnect_pins',
  risk: 'mutating',
  description: `断开 PCG 图里的一条连线。断完会回读确认它真的没了。

引脚名同样不用填，规则和 pcg_connect_pins 一致。`,
  input: z.object({
    graph_path: GraphPathSchema,
    from_node: z.string().describe('上游节点 id，或 "Input"'),
    from_pin: z.string().optional().describe('上游输出引脚名。不填则自动选唯一的那个'),
    to_node: z.string().describe('下游节点 id，或 "Output"'),
    to_pin: z.string().optional().describe('下游输入引脚名。不填则自动选唯一的那个')
  })
})

// ======================================================================
// 整图声明式写入
// ======================================================================

interface PcgApplyGraphResponse {
  graph_path: string
  /** 图原本不存在、这次顺手建的 */
  created_graph?: boolean
  mode?: 'merge' | 'replace'
  /** replace 模式下清掉了几个旧节点 */
  cleared_nodes?: number
  nodes: Array<{
    alias: string
    node_id: string
    type: string
    /** 这次新建的（false 表示按别名复用了已有节点） */
    created?: boolean
    applied_properties?: unknown[]
  }>
  edges: Array<{ from: string; from_pin: string; to: string; to_pin: string }>
  graph_edges_after: Array<{ from_node: string; from_pin: string; to_node: string; to_pin: string }>
  /** 写完之后图里**实际**有哪些节点。merge 模式下会包含本次没提到的旧节点 */
  graph_nodes_after?: Array<{ node_id: string; type: string }>
}

const ApplyGraphSchema = z.object({
  graph_path: GraphPathSchema,
  mode: z
    .enum(['replace', 'merge'])
    .optional()
    .describe(
      'replace（默认）先清空图里除 Input/Output 外的一切再按声明重建 —— 声明什么图里就是什么。merge 只新建/更新你声明的节点、其余保留，只在明确要往已有图上补东西时用'
    ),
  nodes: z
    .array(
      z.object({
        id: z
          .string()
          .describe(
            '你给这个节点起的别名，连线时用它引用。重复执行时按别名复用已有节点，不会长出重复的'
          ),
        type: z.string().describe('节点类型名，如 PCGSurfaceSamplerSettings'),
        x: z.number().int().optional().describe('图里的 X 坐标'),
        y: z.number().int().optional().describe('图里的 Y 坐标'),
        properties: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('要设置的属性，键名支持 A.B[0].C 路径语法')
      })
    )
    .optional()
    .describe('要创建或更新的节点'),
  edges: z
    .array(
      z.object({
        from: z.string().describe('上游节点的别名，或 "Input"'),
        from_pin: z.string().optional().describe('上游输出引脚名。不填则自动选'),
        to: z.string().describe('下游节点的别名，或 "Output"'),
        to_pin: z.string().optional().describe('下游输入引脚名。不填则自动选')
      })
    )
    .optional()
    .describe('要建立的连线')
})

const pcgApplyGraph = defineUeTool<typeof ApplyGraphSchema, PcgApplyGraphResponse>({
  name: 'pcg_apply_graph',
  namespace: NAMESPACE,
  method: 'pcg.apply_graph',
  risk: 'mutating',
  // 同一张图并发写会互相覆盖
  concurrency: 'sequential',
  timeoutMs: 60_000,
  description: `**搭 PCG 图的首选工具**：一次调用写完节点、连线和属性。

不要用 pcg_add_node + pcg_connect_pins 一个个搭 —— 那要几十次往返，而且中途任何
一步出问题都要到最后生成 0 个实例才暴露，那时候已经查不出是哪一步断的。

五条重要语义：
1. **图不存在会自动建**，不用先调 pcg_create_graph。返回里的 created_graph
   会告诉你是不是新建的 —— 如果你没想新建却看到 true，多半是路径写错了
2. **默认是重建（replace）**：声明什么，图里就是什么，旧节点先清干净。
   清不干净就停下，声明里的东西一样都不写。
   往已有图上补东西才用 mode="merge"，那时返回的 graph_nodes_after 会点出
   哪些是这次没声明、但还留在图里的节点
3. **可以重复执行**。节点按 id 别名匹配，已存在就复用并更新，不会长出重复节点
4. **失败不回滚**。类型名、id、连线端点这类错误在动图之前查掉，那时图原样不动；
   属性写不进、引脚连不上要写了才知道，那时**图已经改了**，报错里会带着
   graph_nodes_after / graph_edges_after 说明图现在的样子 —— 修好失败项再跑一遍即可
5. **每一项都回读校验**。连线会读回整张图确认边真的在，属性会读回实际值

引脚名一般不用填，工具会自动选那个方向上唯一的可见引脚。

⚠️ **在地形上撒东西，必须用 PCGGetLandscapeSettings 当数据源**，接进
SurfaceSampler 的 Surface 引脚。把图的 Input 直接接进去拿不到地形，而报错
（「没有找到进行生成的表面」）看起来像场景的问题。可照抄的整图见 skill
\`ue-pcg-scattering\` 的 references/wiring.md。`,
  input: ApplyGraphSchema,
  toOutcome: (response) => {
    const after = response.graph_nodes_after ?? []
    // 声明里没提到、但图里还在的节点 —— merge 模式下的残留。
    // 不主动指出来的话，调用方要自己拿两个列表对比才发现，上一轮就是这么绕进去的
    const written = new Set(response.nodes.map((n) => n.node_id))
    const leftovers = after.filter(
      (n) => !written.has(n.node_id) && !n.type.includes('InputOutput')
    )

    const lines = [
      response.created_graph ? `已新建图 ${response.graph_path}。` : '',
      `${response.graph_path} 已写入：${response.nodes.length} 个节点，${response.edges.length} 条连线` +
        (response.mode === 'replace'
          ? `（replace 模式，先清掉了 ${response.cleared_nodes ?? 0} 个旧节点）。`
          : '（merge 模式，未声明的节点保持原样）。'),
      response.nodes.map((n) => `- ${n.alias} → ${n.node_id}（${n.type}）`).join('\n'),
      leftovers.length
        ? `\n⚠️ 图里还留着 ${leftovers.length} 个这次没声明的节点：` +
          leftovers.map((n) => `${n.node_id}（${n.type}）`).join('、') +
          `\n要清掉的话用 mode="replace" 重跑，或者 pcg_remove_node 逐个删。`
        : '',
      `\n图里现有的全部连线（${response.graph_edges_after.length} 条）：\n` +
        response.graph_edges_after
          .map((e) => `- ${e.from_node}.${e.from_pin} → ${e.to_node}.${e.to_pin}`)
          .join('\n')
    ]

    return { text: lines.filter(Boolean).join('\n'), details: response }
  }
})

// ======================================================================
// 诊断
// ======================================================================

interface PcgDiagnoseResponse {
  graph_path: string
  problems: Array<{ severity: string; problem: string; fix: string }>
  node_count: number
  /** 当前关卡是不是 World Partition —— PCG 采不到没流送进来的东西 */
  world_partition?: boolean
  summary?: string
}

const DiagnoseSchema = z.object({ graph_path: GraphPathSchema })

const pcgDiagnose = defineUeTool<typeof DiagnoseSchema, PcgDiagnoseResponse>({
  name: 'pcg_diagnose',
  namespace: NAMESPACE,
  method: 'pcg.diagnose',
  risk: 'safe',
  description: `查一张 PCG 图为什么生成不出东西。**pcg_execute 返回 0 个实例时就调它。**

会按顺序判掉几个常见根因，每条都给出可执行的下一步：
- Output 节点没被连上（图不接 Output 就什么都不产出）
- Input 节点没接出去（采样器拿不到表面）
- 有孤立节点（既无入边也无出边，跑起来等于不存在）
- 生成器节点没指定网格（会跑完但产出 0 个）
- **当前关卡是不是 World Partition** —— 那种关卡里 PCG 只看得到已流送进来的
  actor 和地形，没加载的区域对图来说等于不存在，现象和「采样器什么都没采到」
  一模一样。这一条光看图是绝对看不出来的

图本身没问题时会明说，让你去查关卡那一侧 —— 比如 PCG 体积压根没盖住地形。`,
  input: DiagnoseSchema,
  toOutcome: (response) => {
    if (response.problems.length === 0) {
      return { text: response.summary ?? '这张图结构上没发现问题。', details: response }
    }
    return {
      text:
        `${response.graph_path} 发现 ${response.problems.length} 个问题：\n` +
        response.problems.map((p) => `【${p.severity}】${p.problem}\n  → ${p.fix}`).join('\n\n'),
      details: response
    }
  }
})

// ======================================================================
// 环境与节点详情
// ======================================================================

const SceneReportSchema = z.object({})

interface PcgSceneReportResponse {
  geometry?: { space: 'world'; length_unit: 'cm'; extent: 'half_size' }
  level_package: string
  level_name: string
  world_partition: boolean
  unsaved_temp_level: boolean
  landscape: { main_landscapes: number; streaming_proxies_loaded: number; names: string[] }
  pcg_volumes: Array<{
    actor_label: string
    partitioned?: boolean
    graph?: string
    center?: Vec3Like
    extent?: Vec3Like
  }>
  notes: string[]
}

const pcgSceneReport = defineUeTool<typeof SceneReportSchema, PcgSceneReportResponse>({
  name: 'pcg_scene_report',
  namespace: NAMESPACE,
  method: 'pcg.scene_report',
  risk: 'safe',
  description: `一次问清「我现在在哪、这里 PCG 能采到什么」。

**开始任何 PCG 工作前先调它。** 它回答：
- 当前是哪张关卡，是不是**没保存的临时关卡**（/Temp/Untitled_N）
- 是不是 World Partition
- 地形是一整块主地形，还是流送代理、加载了几块
- 关卡里有哪些 PCG 体积、各自挂了什么图、是否分区

为什么重要：实测里最费时间的从来不是 PCG 本身，是**不知道自己在哪**——
曾经有人以为在干净关卡里做实验，实际编辑器早就切到了一张自带 64 块流送地形的
临时大世界，于是得出「干净关卡也生成不出来」的错误结论，白绕了很久。`,
  input: SceneReportSchema,
  toOutcome: (response) => {
    const land = response.landscape
    const lines = [
      `当前关卡：${response.level_package}` +
        (response.unsaved_temp_level ? ' ⚠️ 未保存的临时关卡' : '') +
        (response.world_partition ? '（World Partition）' : '（普通关卡）'),
      `地形：主地形 ${land.main_landscapes} 块，已加载的流送代理 ${land.streaming_proxies_loaded} 块` +
        (land.names.length ? `（${land.names.join('、')}）` : ''),
      response.pcg_volumes.length
        ? `PCG 体积 ${response.pcg_volumes.length} 个：\n` +
          response.pcg_volumes
            .map(
              (v) =>
                `- ${v.actor_label}${v.partitioned ? '（已分区）' : ''} → ${v.graph ?? '(未挂图)'}` +
                (v.center ? `；center ${formatCmWithMeters(v.center)}` : '') +
                (v.extent ? `；extent（半长）${formatCmWithMeters(v.extent)}` : '')
            )
            .join('\n')
        : '关卡里还没有 PCG 体积。',
      'PCG 体积 center / extent：world 世界空间，厘米；extent 是半长。',
      ...response.notes
    ]
    return {
      text: lines.join('\n'),
      details: { ...response, geometry: { space: 'world', length_unit: 'cm', extent: 'half_size' } }
    }
  }
})

interface PcgDescribeNodeResponse {
  node_id: string
  type: string
  properties: Record<string, unknown>
  property_count: number
  truncated_hint?: string
}

const DescribeNodeSchema = z.object({
  graph_path: GraphPathSchema,
  node_id: z.string().describe('节点 id，来自 pcg_get_graph'),
  limit: z.number().int().min(1).max(1000).optional().describe('最多返回多少条属性，默认 200')
})

const pcgDescribeNode = defineUeTool<typeof DescribeNodeSchema, PcgDescribeNodeResponse>({
  name: 'pcg_describe_node',
  namespace: NAMESPACE,
  method: 'pcg.describe_node',
  risk: 'safe',
  description: `把一个节点的设置**完整**读出来，含嵌套结构体、数组和子对象。

返回的键就是 pcg_update_node / pcg_apply_graph 认的路径写法，所以
「读回来 → 改两个字段 → 整图写回去」是安全的。

比如生成器上配了 12 个树种，这里会一条不落地给出：
\`MeshSelectorParameters.MeshEntries[0].Descriptor.StaticMesh\` = 路径、
\`...[0].Weight\` = 权重、\`...[1]...\` 依此类推。

**改一张已有的图之前先调它。** 读不全就不敢整图重写，只能绕路做增量修改，
而增量修改正是留下脏图的原因。`,
  input: DescribeNodeSchema,
  toOutcome: (response) => ({
    text:
      `${response.node_id}（${response.type}）共 ${response.property_count} 条属性：\n` +
      Object.entries(response.properties)
        .map(([key, value]) => `- ${key} = ${JSON.stringify(value)}`)
        .join('\n') +
      (response.truncated_hint ? `\n${response.truncated_hint}` : ''),
    details: response
  })
})

// ======================================================================
// 图的用户参数
// ======================================================================

interface PcgGraphParameter {
  name: string
  type: string
  value: unknown
}

interface PcgGraphParametersResponse {
  graph_path: string
  parameters: PcgGraphParameter[]
  parameter_count: number
  added: string[]
  updated: string[]
  removed: string[]
  failed?: Array<{ name: string; error: string }>
  /** 有失败时才有 */
  failed_count?: number
}

const GraphParameterTypes = [
  'bool',
  'int32',
  'int64',
  'float',
  'double',
  'name',
  'string',
  'text',
  'object',
  'softobject',
  'class'
] as const

const GraphParametersSchema = z.object({
  graph_path: GraphPathSchema,
  parameters: z
    .array(
      z.object({
        name: z.string().describe('参数名，原样显示在细节面板里'),
        type: z.enum(GraphParameterTypes).optional().describe('新建时必填；已存在时不用给'),
        value: z.unknown().optional().describe('参数值。object 类用资产路径。不给则保持默认值')
      })
    )
    .optional()
    .describe('要新建或改值的参数。不给就是纯读'),
  remove: z.array(z.string()).optional().describe('要删掉的参数名')
})

const pcgGraphParameters = defineUeTool<typeof GraphParametersSchema, PcgGraphParametersResponse>({
  name: 'pcg_graph_parameters',
  namespace: NAMESPACE,
  method: 'pcg.graph_parameters',
  risk: 'mutating',
  description: `读 / 建 / 改 / 删 PCG 图的**用户参数** —— 用户在 PCG 组件细节面板上
直接调的那几个值。**「这几个值我要能在细节面板里调」用的就是它**，别建参数演员绕路。

只给 graph_path 是纯读；给 parameters 则按 type 新建、按 value 改值；给 remove 就删。
无论干了什么都回读完整清单。例：
\`parameters: [{ "name": "Density", "type": "double", "value": 1.0 }]\`

建好后在图里用 PCGUserParameterGetSettings 取出来，接到目标节点的 Overrides 引脚。`,
  input: GraphParametersSchema,
  toOutcome: (response) => {
    const changes = [
      response.added.length
        ? `新建 ${response.added.length} 个（${response.added.join('、')}）`
        : '',
      response.updated.length
        ? `改值 ${response.updated.length} 个（${response.updated.join('、')}）`
        : '',
      response.removed.length
        ? `删掉 ${response.removed.length} 个（${response.removed.join('、')}）`
        : ''
    ].filter(Boolean)

    const list = response.parameters.length
      ? response.parameters
          .map((p) => `- ${p.name}（${p.type}）= ${JSON.stringify(p.value)}`)
          .join('\n')
      : '（这张图现在一个用户参数都没有）'

    // 失败的要进正文，而且**第一句**就要说（AGENTS.md §5 第 14 条）。
    // 上一版失败清单排在「新建 N 个」和整份参数表后面，插件回 207 时
    // 模型读到的开头仍是一句成功，常常看不到末尾
    const failed = response.failed ?? []
    const failures: PartialFailure[] = failed.map((f) => ({ item: f.name, reason: f.error }))
    const succeeded = response.added.length + response.updated.length + response.removed.length

    /**
     * 新建参数时才提示，改值时不提示。
     *
     * 2026-09-18 真机实测：先摆体积、后建参数的话，组件上那份副本会停在
     * `is_overridden=true` 的旧值上，之后在图上怎么改都到不了它（实测 20→20→20）。
     * 顺序反过来就正常。
     *
     * 放在返回文本里而不是工具描述里：这是**事后**才需要知道的一句话，
     * 而工具描述是每一轮都要付的前缀。
     */
    const ordering = response.added.length
      ? '\n\n注意顺序：参数要在 pcg_spawn_volume **之前**建好。' +
        '已经摆在关卡里的体积各自持有一份参数副本，图上的改动不会自动传过去 ——' +
        '那种情况要改组件上的那一份，或者把体积删了重摆。'
      : ''

    const body =
      (changes.length ? `${changes.join('，')}。\n\n` : '') +
      `${response.graph_path} 现在的用户参数（共 ${response.parameter_count} 个）：\n${list}`

    return {
      text:
        withPartialHeadline(
          body,
          { succeeded, failed: response.failed_count ?? failed.length, unit: '个参数' },
          failures
        ) + ordering,
      details: response
    }
  }
})

// ======================================================================
// 关卡里跑起来
// ======================================================================

interface Vec3 {
  x: number
  y: number
  z: number
}

interface PcgSpawnVolumeResponse {
  actor_label: string
  graph_assigned: boolean
  /** 调了 SetGraph，但这版引擎读不回组件上挂的图 —— 没法确认 */
  graph_assigned_unverified?: boolean
  graph_path?: string
  /** 画刷的**真实**包围盒。actor 位置不等于采样盒中心 */
  actual_bounds?: { center: Vec3; extent: Vec3; min: Vec3; max: Vec3 }
}

const SpawnVolumeSchema = z.object({
  graph_path: GraphPathSchema.optional().describe('要挂的 PCG 图，不填就放个空体积'),
  location: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional()
    .describe('体积中心的世界坐标，默认原点'),
  size: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional()
    .describe('体积尺寸（厘米），默认 2000×2000×2000。z 要够高，能穿过地形起伏'),
  label: z.string().optional().describe('这个体积在大纲里显示的名字')
})

const pcgSpawnVolume = defineUeTool<typeof SpawnVolumeSchema, PcgSpawnVolumeResponse>({
  name: 'pcg_spawn_volume',
  namespace: NAMESPACE,
  method: 'pcg.spawn_volume',
  risk: 'mutating',
  description: `在当前关卡里放一个 PCG 体积，并把指定的图挂上去。

PCG 图本身只是资产，不放进关卡是不会生成任何东西的 —— 体积决定了在哪里、
多大范围内生成。放完用 pcg_execute 跑。

**返回里的 actual_bounds 才是采样盒的真实位置**，它和你给的 location 不一定重合
（画刷有自己的枢轴）。盒子没真正罩住地形时，表现不是报错，而是"只采到几个点"——
拿 actual_bounds 跟 pcg_scene_report 报的地形位置比一下，比事后排查便宜得多。

z 也要给够：地形有起伏，盒子太矮会从中间穿过去，只在少数地方相交。`,
  input: SpawnVolumeSchema,
  toOutcome: (response) => {
    const b = response.actual_bounds
    return {
      text:
        `已放置 ${response.actor_label}` +
        (response.graph_assigned
          ? `，已挂图 ${response.graph_path}` +
            (response.graph_assigned_unverified ? '（这版引擎读不回组件上的图，未能确认挂上）' : '')
          : '（未挂图）') +
        (b
          ? `\n采样盒实际范围：中心 (${b.center.x}, ${b.center.y}, ${b.center.z})，` +
            `半径 (${b.extent.x}, ${b.extent.y}, ${b.extent.z})，` +
            `z 从 ${b.min.z} 到 ${b.max.z}`
          : ''),
      details: response
    }
  }
})

interface PcgExecuteResponse {
  actor_label: string
  generated: boolean
  elapsed_seconds: number
  component_count: number
  instance_count: number
  components: Array<{ component: string; mesh: string; instances: number }>
  /** 生成期间引擎自己往 LogPCG 写了什么 —— 产出 0 时答案往往就在这里 */
  engine_log?: string[]
  note?: string
}

const ExecuteSchema = z.object({
  actor_label: z.string().describe('PCG 体积在大纲里的名字，来自 pcg_spawn_volume 的返回'),
  timeout_seconds: z.number().min(1).max(300).optional().describe('最多等多少秒确认完成，默认 30'),
  verbose: z
    .boolean()
    .optional()
    .describe(
      '把图里每个节点的数据描述转储打开，让引擎把各引脚实际收发了多少数据写进日志。查「产出 0」时开 —— 它是判断点有没有真的走到生成器的唯一直接证据'
    )
})

const pcgExecute = defineUeTool<typeof ExecuteSchema, PcgExecuteResponse>({
  name: 'pcg_execute',
  namespace: NAMESPACE,
  method: 'pcg.execute',
  risk: 'mutating',
  // 一次生成可能几十秒，而且会清掉上一轮的产物 —— 两个并发跑同一个体积必然打架
  concurrency: 'sequential',
  timeoutMs: EXECUTE_TIMEOUT_MS,
  description: `让关卡里的一个 PCG 体积重新跑一遍生成，并回报**实际生成了多少东西**。

这是验证图对不对的唯一办法：返回里的 instance_count 是真正落到关卡里的实例数量。

**返回里会带上引擎自己在这次生成期间写进 LogPCG 的内容**（engine_log）。
产出 0 的时候答案往往就在那几行里，不用另去翻日志。

**instance_count 是 0 时的排查顺序：**
1. 先看 engine_log —— 引擎多半已经说了原因
2. 没线索就 \`verbose: true\` 重跑一次，它会让每个节点把各引脚实际收发了多少数据
   打进日志，从而定位是哪一环把数据吞了
3. 再不行调 pcg_diagnose 查图结构和关卡环境

会先清掉这个体积上一轮生成的内容再重新生成。可能要跑几十秒。`,
  input: ExecuteSchema,
  toOutcome: (response) => {
    const head = response.generated
      ? `${response.actor_label} 生成完成，用时 ${response.elapsed_seconds} 秒。`
      : `${response.actor_label} 生成请求已下发，但 ${response.elapsed_seconds} 秒内没等到完成确认。`

    const body =
      response.instance_count > 0
        ? `共生成 ${response.instance_count} 个实例，分布在 ${response.component_count} 个组件里：\n` +
          response.components.map((c) => `- ${c.mesh} × ${c.instances}`).join('\n')
        : '关卡里没有任何生成出来的实例。'

    const log = response.engine_log?.length
      ? `\n引擎在这次生成期间说了：\n${response.engine_log.join('\n')}`
      : response.instance_count === 0
        ? '\n引擎这次没往 LogPCG 写任何东西 —— 加 verbose: true 重跑一次能拿到每个引脚的数据量。'
        : ''

    return {
      text: [head, body, log, response.note].filter(Boolean).join('\n'),
      details: response
    }
  }
})

// ======================================================================
// 排版
// ======================================================================

const TidyGraphSchema = z.object({ graph_path: GraphPathSchema })

interface TidyGraphDetails {
  moved: number
  not_found?: string[]
  failed_count?: number
}

/** pcg.set_node_positions 的回执。failed / skipped / 计数只在有失败时出现 */
interface SetNodePositionsResponse {
  moved?: number
  not_found?: string[]
  /** 找到了节点、写了坐标，但回读对不上 */
  failed?: Array<{ item: string; error?: string }>
  /** 条目格式不对（不是对象、没有 node_id） */
  skipped?: Array<{ item: string; error?: string }>
  /** 所有没挪成的：not_found + failed + skipped */
  failed_count?: number
  skipped_count?: number
}

const pcgTidyGraph = defineTool<typeof TidyGraphSchema, TidyGraphDetails>({
  name: 'pcg_tidy_graph',
  namespace: NAMESPACE,
  risk: 'mutating',
  // 改的是同一份图的坐标，并发会互相覆盖
  concurrency: 'sequential',
  description: `把一张 PCG 图重新排版，让它顺着数据流从左到右排、Input 在最左、Output 在最右。

**只挪位置，不改任何节点、连线和属性。** 图的行为一个字都不会变。

什么时候用：
- 用 pcg_add_node 建完一串节点之后（不指定 x/y 的话它们会全叠在原点）
- 图看起来乱：节点重叠、连线到处交叉

排完可以用 ue_screenshot 看效果。改动可撤销（Ctrl+Z）。`,
  input: TidyGraphSchema,
  execute: async ({ graph_path }) => {
    const graph = await callUe<PcgGraphResponse>('pcg.get_graph', { graph_path })

    const nodes = graph.nodes ?? []
    if (nodes.length === 0) {
      return { text: `${graph_path} 里没有任何节点，不用排版。`, details: { moved: 0 } }
    }

    // 以 Input 节点为锚排完钉回原位。找不到就退回第一个节点 ——
    // 排出来仍然是对的，只是整张图可能整体挪了位置
    const anchor = nodes.find((n) => n.type.includes('InputOutput')) ?? nodes[0]

    const positions = await layoutPcgNodes(
      nodes as PcgLayoutNode[],
      (graph.edges ?? []) as PcgLayoutEdge[],
      anchor.node_id,
      { x: anchor.x, y: anchor.y }
    )

    const applied = await callUe<SetNodePositionsResponse>('pcg.set_node_positions', {
      graph_path,
      positions
    })

    const moved = applied.moved ?? 0
    const notFound = applied.not_found ?? []
    // 没挪成的逐条列，第一句先说部分完成（AGENTS.md §5 第 14 条）。
    // 旧插件只回 not_found、没有 failed_count，那时按 not_found 算
    const failures: PartialFailure[] = [
      ...notFound.map((id) => ({ item: id, reason: '图里没找到（图可能已经变了）' })),
      ...(applied.failed ?? []).map((f) => ({ item: f.item, reason: f.error })),
      ...(applied.skipped ?? []).map((f) => ({ item: f.item, reason: f.error }))
    ]
    const skipped = applied.skipped_count ?? applied.skipped?.length ?? 0
    const failedCount = applied.failed_count ?? failures.length

    return {
      text: withPartialHeadline(
        `已重排 ${moved}/${nodes.length} 个节点。`,
        { succeeded: moved, failed: failedCount - skipped, skipped, unit: '个节点' },
        failures
      ),
      details: {
        moved,
        ...(notFound.length ? { not_found: notFound } : {}),
        ...(failedCount ? { failed_count: failedCount } : {})
      }
    }
  }
})

export const pcgTools: readonly UnrealAgentTool<never>[] = Object.freeze([
  pcgStatus,
  pcgSceneReport,
  pcgCreateGraph,
  pcgApplyGraph,
  pcgGetGraph,
  pcgDescribeNode,
  pcgGraphParameters,
  pcgDiagnose,
  pcgListNodeTypes,
  pcgGetNodeSchema,
  pcgAddNode,
  pcgUpdateNode,
  pcgRemoveNode,
  pcgConnectPins,
  pcgDisconnectPins,
  pcgSpawnVolume,
  pcgExecute,
  pcgTidyGraph
] as unknown as UnrealAgentTool<never>[])
