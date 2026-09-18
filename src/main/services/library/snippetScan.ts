/**
 * 蓝图片段：存进库之前扫一遍，判断这段能不能存、存下来该记些什么。
 *
 * ## 这个文件曾经叫 graphTransform.ts，翻译那一半已经删了
 *
 * 旧版的活是「读的形状 → 写的形状」：`blueprint_get_graph` 读回来一堆描述，
 * 照描述让 `blueprint_apply_graph` **重建**一个同类型的节点。
 * 2026-09-12 的真机验证把这条路否了 —— 重建只建默认形态，用户手动加过
 * 引脚的 Sequence 写回去只有两个输出，第三条分支上挂的逻辑静默断开。
 * 为了拦住这种片段，旧版有一张 `DYNAMIC_PIN_DEFAULTS` 表；拦住的意思是
 * 「这段我们搬不了」。
 *
 * 现在片段存的是引擎自己的序列化文本（T3D，编辑器 Ctrl+C 那段），
 * 放回工程时由引擎自己反序列化。**编辑器里复制粘贴保得住的，这条路都保得住**，
 * 所以不需要翻译，也就不需要那张表。同一个 4 引脚 Sequence 实测一字不差。
 *
 * ## 但依赖扫描要留下
 *
 * T3D 保得住**形状**，保不住**外部引用**。一段引用了源蓝图变量的逻辑
 * 粘到另一个工程里，节点是完整的，但引用指向一个不存在的东西 —— 用户看到
 * 一片红。所以存的时候还是要拦，只是拦的理由从「我们搬不动」变成
 * 「搬过去是红的」。
 *
 * ## 为什么扫的是 get_graph 的返回，不是那段 T3D 文本
 *
 * 外部引用在 T3D 文本里当然也有（`/Game/...` 路径、`bSelfContext=True` 之类），
 * 但那是一份要自己解析的格式。`blueprint_get_graph` 已经把同一批信息整理成了
 * 结构化字段，而且这条路有测试。存一段片段要发两条只读命令（`get_graph`
 * 扫依赖、`export_t3d` 取正文），代价是一次额外往返，换来不用维护第二个解析器。
 *
 * ## 支持范围是收窄的，而且是故意的
 *
 * 第一版只收「无外部依赖」的片段。宁可存的时候就说存不了，
 * 也不要存下一个到期才爆的承诺。扩范围（依赖对账）是阶段 2 的活。
 */

// ============================================================
//  读侧（blueprint_get_graph 工具层返回）
// ============================================================

export interface ReadPin {
  name?: string
  dir?: string
  type?: string
  displayed_as?: string
  is_array?: boolean
  is_reference?: boolean
  /** 工具层已经把 default_value / default_object / default_text 合并成这一个 */
  default_value?: string
}

export interface ReadNode {
  id?: string
  /** 引擎类名，如 K2Node_IfThenElse。任何节点都有 */
  class?: string
  /** 本地化的显示名，只用来给用户看 */
  title?: string
  /**
   * 插件给出的「重建这个节点要填什么类型」。
   *
   * 翻译已经不做了，这个字段现在只当**依赖扫描的抓手**用 ——
   * 它把 K2Node_VariableGet 这类归一成 `VariableGet`，正好是要判的那几类。
   */
  write_as?: string
  member_name?: string
  target_class?: string
  struct_type?: string
  pos_x?: number
  pos_y?: number
  pins?: ReadPin[]
}

export interface ReadConnection {
  from_node?: string
  from_pin?: string
  to_node?: string
  to_pin?: string
}

export interface ReadGraph {
  blueprint_path?: string
  graph_name?: string
  nodes?: ReadNode[]
  connections?: ReadConnection[]
}

// ============================================================
//  扫出来的东西
// ============================================================

/** 悬空端口：片段里的某个引脚，原本连到选区外面去了 */
export interface OpenPort {
  nodeId: string
  pinName: string
  dir: 'in' | 'out'
  /** 原来连到哪儿，只作说明用，跨工程没有意义 */
  formerPeer: string
}

/**
 * 片段的摘要。**只作展示与检索，不参与放回工程** ——
 * 放回工程用的是那段 T3D 正文，这里一个字都不参与。
 */
export interface SnippetMeta {
  nodeCount: number
  /** 两端都在选区内的连线条数 */
  connectionCount: number
  /** 用到的节点类型，去重后按出现顺序。能给简名的给简名（Branch），给不出的给引擎类名 */
  classes: string[]
  openPorts: OpenPort[]
}

// ============================================================
//  拒绝原因
// ============================================================

export type RejectCode =
  | 'unscannable'
  | 'dependency-variable'
  | 'dependency-function'
  | 'dependency-component'
  | 'dependency-asset'
  | 'empty-selection'

export interface Rejection {
  code: RejectCode
  /** 卡在哪个节点上，给用户看的 */
  nodeId: string
  nodeLabel: string
  detail: string
}

export interface ScanResult {
  ok: boolean
  meta?: SnippetMeta
  rejections: Rejection[]
}

// ============================================================
//  扫得穿的节点类型
// ============================================================

/**
 * 这些 `write_as` 值的外部依赖我们判得了。
 *
 * **这不再是「写侧能重建的类型」那张表** —— T3D 不重建节点，能不能搬和类型无关。
 * 它现在回答的是另一个问题：*这个节点会不会偷偷引用一个目标工程没有的东西，
 * 而我们看不出来*。在表里 = 下面的分支覆盖得到；不在表里 = 判不了，拒绝。
 *
 * 举一个不在表里的例子：`K2Node_MacroInstance` 的 `write_as` 是宏图自己的名字
 * （`ForLoop` 在表里，用户自建的 `MyAwesomeMacro` 不在）。用户宏存在
 * `/Game` 里的某个宏库资产上，换工程就没了 —— 但光看 `write_as` 分不出
 * 「引擎宏」和「用户宏」，所以只认这张表里的引擎宏。
 */
const SCANNABLE_WRITE_AS = new Set([
  'Event',
  'Function',
  'VariableGet',
  'VariableSet',
  'Branch',
  'Sequence',
  'Cast',
  'SpawnActor',
  'CustomEvent',
  'Select',
  'MakeArray',
  'MakeStruct',
  'BreakStruct',
  'Self',
  'ForLoop',
  'WhileLoop',
  'DoOnce',
  'Gate',
  'FlipFlop',
  'IsValid',
  'ForEachLoop'
])

/**
 * 插件不给 `write_as`，但我们照样确定它没有外部引用的节点类型。
 *
 * 注释框和重路由点（那个把连线拐个弯的小圆点）在选区里太常见了 ——
 * 框选一段逻辑连带框住它头上的注释是日常操作。因为「没有 write_as」
 * 把整段拒掉，用户完全不知道自己做错了什么。
 *
 * 判据是它们**装不下引用**：注释框里只有一串文字和一个颜色，
 * 重路由点只有两个引脚和一条连线。
 */
const DEPENDENCY_FREE_CLASSES = new Set(['EdGraphNode_Comment', 'K2Node_Knot'])

// ============================================================
//  依赖扫描
// ============================================================

/** 引擎内置函数库前缀。`member_name` 是 `Xxx.Func` 形状时取前半段判断 */
const ENGINE_FUNCTION_LIBRARIES = new Set([
  'KismetSystemLibrary',
  'KismetMathLibrary',
  'KismetStringLibrary',
  'KismetTextLibrary',
  'KismetArrayLibrary',
  'KismetGuidLibrary',
  'KismetInputLibrary',
  'KismetMaterialLibrary',
  'KismetRenderingLibrary',
  'GameplayStatics',
  'BlueprintSetLibrary',
  'BlueprintMapLibrary',
  'BlueprintPathsLibrary',
  'Actor',
  'Pawn',
  'Character',
  'SceneComponent',
  'PrimitiveComponent',
  'ActorComponent',
  'MeshComponent',
  'StaticMeshComponent',
  'SkeletalMeshComponent',
  'PlayerController',
  'Controller',
  'GameModeBase',
  'Object',
  'UserWidget'
])

/** 引擎内置事件名 —— 这些不算「自定义事件」 */
const ENGINE_EVENT_PREFIXES = ['Receive', 'K2_', 'BndEvt__']

function isEngineFunction(memberName: string | undefined): boolean {
  if (!memberName) return false
  const dot = memberName.indexOf('.')
  if (dot < 0) {
    // 没有点号的多半是事件名或变量名，交给别的分支判
    return ENGINE_EVENT_PREFIXES.some((prefix) => memberName.startsWith(prefix))
  }
  return ENGINE_FUNCTION_LIBRARIES.has(memberName.slice(0, dot))
}

function looksLikeAssetPath(value: string | undefined): boolean {
  if (!value) return false
  return value.startsWith('/Game/') || value.includes("'/Game/")
}

function nodeLabel(node: ReadNode): string {
  // 给用户看的时候用 title（他在编辑器里看到的就是这个），
  // 没有就退回 class；两个都没有才用 id
  return node.title || node.class || node.id || '未知节点'
}

// ============================================================
//  扫描
// ============================================================

/**
 * 扫一段选区，判断能不能存进库，并算出存下来要记的摘要。
 *
 * @param graph  `blueprint_get_graph` 工具层返回的整张图
 * @param nodeIds 选区。空数组 = 整张图（工具允许，界面上不给这个缺省）
 */
export function scanSnippet(graph: ReadGraph, nodeIds: readonly string[] = []): ScanResult {
  const rejections: Rejection[] = []
  const allNodes = graph.nodes ?? []

  const selected =
    nodeIds.length > 0 ? allNodes.filter((node) => node.id && nodeIds.includes(node.id)) : allNodes

  if (selected.length === 0) {
    return {
      ok: false,
      rejections: [
        {
          code: 'empty-selection',
          nodeId: '',
          nodeLabel: '',
          detail: nodeIds.length > 0 ? '选中的节点在这张图里找不到' : '这张图里没有节点'
        }
      ]
    }
  }

  const selectedIds = new Set(selected.map((node) => node.id).filter(Boolean) as string[])
  const classes: string[] = []

  for (const node of selected) {
    const id = node.id ?? ''
    const label = nodeLabel(node)
    const reject = (code: RejectCode, detail: string): void => {
      rejections.push({ code, nodeId: id, nodeLabel: label, detail })
    }

    const kind = node.write_as || node.class || ''
    if (kind && !classes.includes(kind)) classes.push(kind)

    // —— 这个节点我们看得穿吗 ——

    if (!node.write_as) {
      if (node.class && DEPENDENCY_FREE_CLASSES.has(node.class)) {
        // 注释框、重路由点：装不下引用，直接放行
        continue
      }
      reject(
        'unscannable',
        `这类节点（${node.class || '类型未知'}）我们还查不出它引用了什么，` +
          '所以不敢保证它换个工程还能用'
      )
      continue
    }

    if (!SCANNABLE_WRITE_AS.has(node.write_as)) {
      reject(
        'unscannable',
        `${node.write_as} 不在能查依赖的类型里 —— 比如用户自己建的宏，` +
          '它存在工程的宏库资产上，换工程就没了'
      )
      continue
    }

    // —— 决定 6：有没有外部依赖 ——

    if (node.write_as === 'VariableGet' || node.write_as === 'VariableSet') {
      reject('dependency-variable', `引用了变量「${node.member_name ?? '?'}」`)
      continue
    }

    if (node.write_as === 'Self') {
      // Self 指向的是所在蓝图这个类本身，换个工程就不是同一个东西
      reject('dependency-component', 'Self 节点绑定在当前蓝图上，换工程就不成立')
      continue
    }

    if (
      (node.write_as === 'Function' || node.write_as === 'Event') &&
      !isEngineFunction(node.member_name)
    ) {
      reject(
        'dependency-function',
        `引用了自定义函数或事件「${node.member_name ?? '?'}」—— 目标工程里不一定有`
      )
      continue
    }

    if (node.write_as === 'CustomEvent') {
      reject('dependency-function', '自定义事件要在目标工程里先建出来')
      continue
    }

    /*
     * 指向「某个类型」的槽位一共两个，**两个都要查**。
     *
     * 上一版只查了 target_class，漏了 struct_type —— 于是一个
     * MakeStruct/BreakStruct 引用 `/Game/Structs/ST_Private.ST_Private`
     * 照样存得进库，换个工程没有那个结构体就重建不出来，
     * 而用户是在两周后用的时候才发现。
     */
    const assetRef = [node.target_class, node.struct_type].find((value) =>
      looksLikeAssetPath(value)
    )
    if (assetRef) {
      reject('dependency-asset', `引用了工程内资产 ${assetRef}`)
      continue
    }

    // —— 引脚上填的字面量 ——
    for (const pin of node.pins ?? []) {
      if (!pin.name || !pin.default_value) continue
      if (!looksLikeAssetPath(pin.default_value)) continue

      // 引脚上直接填着一个资产路径。T3D 会原样把这个路径搬过去，
      // 目标工程没有这个资产的话，节点是完整的但引用是断的
      reject('dependency-asset', `引脚「${pin.name}」上填的是资产引用 ${pin.default_value}`)
      break
    }
  }

  if (rejections.length > 0) {
    return { ok: false, rejections }
  }

  // —— 连线：两端都在选区内才算这段自己的 ——

  let connectionCount = 0
  const openPorts: OpenPort[] = []

  for (const link of graph.connections ?? []) {
    const { from_node: fromNode, from_pin: fromPin, to_node: toNode, to_pin: toPin } = link
    if (!fromNode || !fromPin || !toNode || !toPin) continue

    const fromIn = selectedIds.has(fromNode)
    const toIn = selectedIds.has(toNode)

    if (fromIn && toIn) {
      connectionCount += 1
    } else if (fromIn) {
      openPorts.push({
        nodeId: fromNode,
        pinName: fromPin,
        dir: 'out',
        formerPeer: `${toNode}.${toPin}`
      })
    } else if (toIn) {
      openPorts.push({
        nodeId: toNode,
        pinName: toPin,
        dir: 'in',
        formerPeer: `${fromNode}.${fromPin}`
      })
    }
  }

  return {
    ok: true,
    meta: { nodeCount: selected.length, connectionCount, classes, openPorts },
    rejections: []
  }
}

/** 给用户看的拒绝说明。一次列全，别让他改一条试一次 */
export function describeRejections(rejections: readonly Rejection[]): string {
  if (rejections.length === 0) return ''
  return rejections
    .map((item) => (item.nodeLabel ? `「${item.nodeLabel}」：${item.detail}` : item.detail))
    .join('\n')
}
