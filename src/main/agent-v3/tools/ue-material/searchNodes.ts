/**
 * `material_search_nodes` —— 写材质图之前先查一批引脚签名。
 *
 * ## 为什么需要它
 *
 * 蓝图那边有 `blueprint_search_nodes`：给个关键字，回来的是函数的确切名字和
 * 每个引脚的名字/类型/方向，所以「查一批 → 一次写完整张图」成立。
 *
 * 材质这边**什么都没有**。引脚信息只能作为「建节点」的副作用拿到 —— 想知道
 * TextureSample 的 UV 输入叫什么，唯一的办法是先建一个节点再 `material_get_graph`
 * 读回来。真机上一次荷塘材质任务里的实际做法是：新建一个 31 节点的探针材质
 * `M_Probe`，把要用的节点类型各放一个，读回来抄下引脚名，再回去写真正的图。
 * 那次任务三分之一的往返花在这上面，而且探针材质留在了用户工程里
 * （`ue_content_delete` 删不掉被编辑器占着的资产）。
 *
 * 那些名字没有规律可循，猜不出来也推不出来：
 *   · Sine 的输入叫 `Input`，Lerp 的叫 `A` / `B` / `Alpha`
 *   · TextureSample 的 UV 输入叫 **`Coordinates`**，不是 `UVs`
 *   · Constant3Vector 的四个输出**一个名字都没有**（引擎侧按 mask 位推成 R/G/B）
 *
 * ## 它读的是类默认对象
 *
 * 引脚是**类**的属性不是实例的，所以引擎侧读 CDO 就够：不碰任何资产、
 * 不产生垃圾节点、也不需要先打开一个材质。唯一读不到的是「挂上资产之后才
 * 长出来的引脚」（MaterialFunctionCall 的引脚来自它调用的那个函数），
 * 那种情况引擎会在 note 里说清楚。
 */

import { z } from 'zod'

import { callUe } from '../defineUeTool'
import { defineTool } from '../defineTool'

const NAMESPACE = 'ue.material'

interface SearchNodesPin {
  name: string
  type?: string
  index?: number
}

interface SearchNodesEntry {
  node_type: string
  class?: string
  inputs?: SearchNodesPin[]
  outputs?: SearchNodesPin[]
  /** 建这个节点还必须带的字段（function_path / collection_path / node_name / value） */
  requires?: string[]
  /** 能不能用 value 设初始值 */
  has_value?: boolean
  note?: string
}

export interface SearchNodesResponse {
  ok?: boolean
  query?: string
  match_count?: number
  total_types?: number
  truncated?: boolean
  nodes?: SearchNodesEntry[]
}

/** `A float(any)、B float(any)` —— 一行放得下，比每个引脚一行省一大截 */
function formatPins(pins: SearchNodesPin[] | undefined): string {
  if (!pins || pins.length === 0) return '（无）'
  return pins.map((pin) => (pin.type ? `${pin.name} ${pin.type}` : pin.name)).join('、')
}

const SearchNodesSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      '节点类型名的关键字，如 "texture"、"mask"、"noise"、"param"。按名字匹配子串，不是自然语言搜索。' +
        '留空 = 按字母序列出前 limit 种（想要全部就把 limit 提到 100）'
    ),
  /*
   * 默认值和上下限在这里也写一份 —— 引擎侧同样会 clamp，但那边的规则模型看不见。
   * 只写在引擎侧的下场是：query 留空 + 不给 limit，模型以为拿到了全部类型，
   * 实际只有字母序前 12 个（`Abs` … `Constant3Vector`），`Lerp` / `TextureSample`
   * 一个都不在里面，然后它得出「这些节点做不出来」——正好和这个工具的用途相反。
   */
  /*
   * 不加 `.min(1).max(100)`：引擎那边是 `FMath::Clamp(Limit, 1, 100)`，
   * 超范围会被夹回来而不是失败。在这里改成拒绝，工具就比它背后的 RPC 窄了 ——
   * 传 500 本来能拿到 100 条，现在换来一串 ZodError（那是给程序看的，不是给模型看的）。
   * 默认值倒是要写在这儿：那条规则模型看得见才有用。
   */
  limit: z
    .number()
    .int()
    .optional()
    .default(12)
    .describe('最多回几条，默认 12，上限 100（超了按 100 算）。想看全部类型就传 100')
})

/**
 * 老插件没有这条命令时，说人话。
 *
 * 插件装在**用户自己的 UE 工程**里，不随盒子升级。这条是新加的 RPC，
 * 在旧插件上会直接回 `404 Unknown method: material.search_nodes` ——
 * 而系统提示词又明令禁止它用唯一的替代办法（建探针节点试引脚名）。
 * 两边一夾，模型只能猜 `UVs` 这种名字，或者卡在原地。
 *
 * 所以把这个 404 翻译成「插件太旧 + 这一次该怎么办」。
 * 同样的做法 `getProjectInfo.ts` 里已经有一份。
 */
function isUnknownMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Unknown method')
}

export const searchMaterialNodes = defineTool<typeof SearchNodesSchema, SearchNodesResponse>({
  name: 'material_search_nodes',
  namespace: NAMESPACE,
  risk: 'safe',
  description: `按名字搜材质节点类型，连**完整引脚签名**一起回。

写材质图之前用它，别靠猜，也别靠「先建一个节点再读回来」试引脚名。
一次调用能拿回十几个节点类型的确切名字和每个引脚的名字/类型，
拿到之后用 material_apply_graph 一次性把整张图写完。

引脚名没有通用规律，猜必错：
- Sine 的输入叫 Input，Lerp 的叫 A / B / Alpha
- TextureSample 的 UV 输入叫 **Coordinates**，不是 UVs
- Constant3Vector 的四个输出没有真名，这里按通道给出 RGB / R / G / B，
  照着写就能连（连线时写 "节点id.G"）

返回里的 node_type 可以直接填进 material_apply_graph 的 node_type，
inputs/outputs 里的 name 就是连线时用的引脚名。

**requires** 列的是「不给就废」的额外字段：MaterialFunctionCall 少了 function_path
一个引脚都没有，ComponentMask 少了 value 是个恒为 0 的死节点。
**has_value=true** 表示这个类型能用 value 设初始值。

只读，不碰任何资产，也不需要先打开材质。`,
  input: SearchNodesSchema,

  /**
   * 摘要里必须带全每个引脚 —— 这正是调用它的理由。
   *
   * 「完整列表在 details 里」对模型是死路：details 不进上下文。
   * 所以这里宁可长一点，也不能把引脚名留在 details 里。
   */
  execute: async (args, ctx) => {
    let response: SearchNodesResponse
    try {
      // signal 要往下传。`defineUeTool` 原来替我们传了，改成手写 execute 之后
      // 漏掉的话，用户按停止只是把工具结果丢掉，那条 RPC 还在暂存池里占满 30 秒
      response = await callUe<SearchNodesResponse>('material.search_nodes', args, {
        signal: ctx.signal
      })
    } catch (error) {
      if (!isUnknownMethod(error)) throw error
      return {
        text: [
          '这个工程里装的 UnrealAgentLink 插件太旧，还没有 material.search_nodes 这条命令。',
          '这一次先这么绕：引脚名改从现有材质里读 —— 对一张已经有这类节点的材质调 material_get_graph，inputs/outputs 里就是真实引脚名。',
          '几个常用的（UE 5.x 通用）：TextureSample 的 UV 输入叫 Coordinates（不是 UVs），Lerp 是 A / B / Alpha，Sine 是 Input，Multiply、Add 是 A / B。',
          '想用上这个工具，让用户在盒子里重新安装一次插件（设置 → UE 插件）。'
        ].join('\n'),
        details: {} as SearchNodesResponse
      }
    }

    const nodes = response.nodes ?? []
    const matched = response.match_count ?? nodes.length

    if (nodes.length === 0) {
      return {
        text:
          `没有匹配 "${response.query ?? ''}" 的节点类型（一共 ${response.total_types ?? 0} 种）。\n` +
          '换个更短的关键字试试 —— 搜的是类型名的子串，不是自然语言。' +
          '留空 query 可以把全部类型列出来。',
        details: response
      }
    }

    const lines = [
      `匹配 ${matched} 种节点类型（共 ${response.total_types ?? 0} 种）` +
        (response.truncated ? `，下面只列了 ${nodes.length} 种，要更多就加大 limit` : '') +
        '：'
    ]

    for (const node of nodes) {
      lines.push(`\n▸ ${node.node_type}${node.class ? `（${node.class}）` : ''}`)
      lines.push(`  输入：${formatPins(node.inputs)}`)
      lines.push(`  输出：${formatPins(node.outputs)}`)
      if (node.requires?.length) {
        lines.push(`  ⚠️ 建它必须带：${node.requires.join('、')}（不给这个节点是废的）`)
      }
      if (node.has_value) {
        lines.push('  可以用 value 设初始值')
      }
      if (node.note) {
        lines.push(`  ※ ${node.note}`)
      }
    }

    lines.push('\n照着上面的 node_type 和引脚名写 material_apply_graph，不要再自己猜名字。')
    return { text: lines.join('\n'), details: response }
  }
})
