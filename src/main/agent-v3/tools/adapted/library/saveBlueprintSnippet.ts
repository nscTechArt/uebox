/**
 * `blueprint_library_save` —— 把工程里的一段蓝图逻辑存进库。
 *
 * ## 存的是「一段」，不是「一整张图」
 *
 * `node_ids` 圈定范围。不圈就是整张 EventGraph —— 用户说「存受击闪红」
 * 结果带走了整张图，那不是他要的。界面上不给这个缺省。
 *
 * ## 两条只读命令，各干各的
 *
 * 1. `blueprint.export_t3d` 取**正文** —— 引擎自己的节点序列化，
 *    也就是编辑器 Ctrl+C 那段文本。存进库的就是它，一个字不改。
 * 2. `blueprint.get_graph` 取**依赖和摘要** —— 那段文本里当然也有这些信息，
 *    但那是一份要自己解析的格式，而 get_graph 已经整理好了。
 *
 * 多一次往返，换来不用维护第二个 T3D 解析器。两条都是只读，都发给同一条连接。
 *
 * ## 存不了就当场说，别留个到期才爆的承诺
 *
 * 依赖扫描（见 `services/library/snippetScan.ts`）任何一条不过，这里就拒绝
 * 并**一次列全**是哪几个节点、卡在哪一条。第一版的范围是「无外部依赖」，
 * 收窄是故意的：一段引用了源蓝图变量的片段粘到另一个工程，节点是完整的，
 * 但引用指向一个不存在的东西 —— 用户看到一片红，而他是两周后才发现。
 *
 * 只读引擎、只写本地保管库，不改用户工程，所以不进审批门。
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { serviceManager } from '../../../../services'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { resolveBlueprintPathInput } from '../ue-blueprint/resolveBlueprintPath'
import {
  describeRejections,
  scanSnippet,
  type ReadGraph
} from '../../../../services/library/snippetScan'
import { saveSnippetEntry } from '../../../../services/library/libraryEntryStore'
import { toPackagePath } from '../../../../utils/uePackagePath'
import { sendToAppWindows } from '../../../../appWindows'
import { requireVaultRoot } from './vaultRoot'

const SaveSchema = z.object({
  blueprint_path: z
    .string()
    .describe('蓝图路径，如 "/Game/Blueprints/BP_Player" 或短名 "BP_Player"'),
  graph_name: z.string().optional().describe('图表名，默认 EventGraph'),
  node_ids: z
    .array(z.string())
    .optional()
    .describe(
      '要存的节点 id（先用 blueprint_get_graph 拿）。不填=整张图，' +
        '但用户说「存某一段」时一定要填，否则会把整张图带走'
    ),
  entry_name: z.string().describe('存进库之后叫什么名字，如 "受击闪红"')
})

/** `blueprint.export_t3d` 的回执 */
interface ExportT3dResponse {
  ok?: boolean
  graph_name?: string
  node_count?: number
  text?: string
  text_length?: number
  /** 超了长度上限被截断。**截断过的文本粘不回去**，只能拒绝 */
  truncated?: boolean
  /** 点名要但图里没有的 node id */
  not_found?: string[]
  error?: string
  message?: string
}

export function createBlueprintLibrarySaveTool(): V2Tool {
  return defineV2Tool({
    description: `把当前工程里的一段蓝图逻辑存进蓝图库，以后能放进别的工程。

【先圈范围】
用 blueprint_get_graph 读到图之后，把用户要的那几个节点的 id 填进 node_ids。
不填就是整张图 —— 用户说「存受击闪红」时不要这么做。

【存的是什么】
引擎自己的节点序列化（编辑器 Ctrl+C 那段文本）。**节点长什么样就存什么样** ——
用户手动加过引脚的 Sequence、折叠起来的逻辑块，原样保住。

【第一版只收无外部依赖的片段】
不引用变量、自定义函数、自定义事件、组件、/Game 资产。
不满足就**拒绝并列出是哪几个节点**，不会偷偷存一个残缺的。
这不是暂时的限制而是说好的范围：带变量的片段粘到别的工程，节点是完整的
但引用是断的，用户看到一片红。

【存到哪】
当前活跃的保管库，一个条目一个 .ueblueprint 目录。拷得走、备份得到。`,

    inputSchema: SaveSchema,

    execute: async (input) => {
      const vault = requireVaultRoot()
      if ('error' in vault) return { success: false, error: vault.error }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return {
          success: false,
          error: '没有连上虚幻编辑器。请打开工程，并确认 UnrealAgentLink 插件已连接，再存一次。'
        }
      }

      try {
        const resolvedBlueprint = await resolveBlueprintPathInput(input.blueprint_path)
        const resolved = resolvedBlueprint.blueprintPath
        if (!resolved) {
          return {
            success: false,
            error: resolvedBlueprint.wasPlaceholder
              ? '认不出「当前蓝图」是哪个。在 UE 里打开目标蓝图再试，或者直接给出路径。'
              : '缺少必填参数：blueprint_path'
          }
        }

        const connectionId = getTargetConnectionId()
        const nodeIds = input.node_ids ?? []

        // ── 一、扫依赖 ──
        const params: Record<string, unknown> = { blueprint_path: resolved }
        if (input.graph_name) params.graph_name = input.graph_name

        const graph = await wsService.callRequest<Record<string, unknown>>(
          'blueprint.get_graph',
          params,
          connectionId,
          20_000
        )

        if (!graph) {
          return { success: false, error: '插件没有响应（blueprint.get_graph）' }
        }

        // 注意：这里吃的是插件原始返回，字段名是 node_id / linked_to。
        // 扫描器要的是工具层的形状（id / 顶层 connections），所以先过一道。
        const toolShaped = normalizePluginGraph(graph)

        const scan = scanSnippet(toolShaped, nodeIds)
        if (!scan.ok || !scan.meta) {
          return {
            success: false,
            error: `这段逻辑存不进库：\n${describeRejections(scan.rejections)}`,
            rejections: scan.rejections.map((item) => ({
              node: item.nodeLabel,
              code: item.code,
              detail: item.detail
            }))
          }
        }

        // ── 二、取正文 ──
        const exportParams: Record<string, unknown> = { blueprint_path: resolved }
        if (input.graph_name) exportParams.graph_name = input.graph_name
        if (nodeIds.length > 0) exportParams.node_ids = nodeIds

        const exported = await wsService.callRequest<ExportT3dResponse>(
          'blueprint.export_t3d',
          exportParams,
          connectionId,
          30_000
        )

        if (!exported) {
          return { success: false, error: '插件没有响应（blueprint.export_t3d）' }
        }

        if (!exported.text) {
          return {
            success: false,
            error: `导出这段逻辑失败：${exported.error || exported.message || '插件没有给出原因'}`
          }
        }

        /*
         * 截断过的 T3D **粘不回去** —— 那是一段半截的对象文本，
         * 引擎的 CanImportNodesFromText 会直接拒绝。存下来等于存了一个
         * 打不开的条目，而用户是两周后才发现。宁可现在就说「太大了」。
         */
        if (exported.truncated) {
          return {
            success: false,
            error:
              `这段逻辑太大（${exported.text_length ?? '?'} 字符），导出时被截断了，` +
              '截断过的文本放不回工程。请分成几段分别保存。'
          }
        }

        if (exported.not_found?.length) {
          return {
            success: false,
            error:
              `有 ${exported.not_found.length} 个节点在图里找不到 —— ` +
              '手上这份图可能已经过期，重新读一次再存。',
            not_found: exported.not_found
          }
        }

        // ── 三、落库 ──
        const entryId = randomUUID()
        const saved = await saveSnippetEntry({
          vaultRoot: vault.vaultRoot,
          library: 'blueprint',
          entryId,
          name: input.entry_name,
          t3d: exported.text,
          meta: scan.meta,
          sourceBlueprintPath: toPackagePath(resolved),
          sourceGraphName: exported.graph_name || toolShaped.graph_name,
          now: Date.now()
        })

        if (!saved) {
          return { success: false, error: '写入保管库失败（路径检查没通过）' }
        }

        /*
         * 告诉界面「磁盘上多了一条」。
         *
         * 库的渲染层 store 不经手这次写入 —— 它只在创建时 hydrate 一次。
         * 不发这条的话，AI 说「已存进蓝图库」，用户回列表什么都没有，
         * 要重开应用才看得见。
         *
         * **发在这里而不是等那一轮 agent 跑完**：`appExecuteAgent` 是后台
         * 发起、立刻返回的，界面那边 await 完的时候多半还没存；
         * 而且一轮里可能存好几条，每条落盘就该刷一次。
         */
        sendToAppWindows('library:entry-saved', { library: 'blueprint', entryId })

        const openPorts = scan.meta.openPorts
        return {
          success: true,
          entry_id: entryId,
          entry_name: input.entry_name,
          node_count: scan.meta.nodeCount,
          connection_count: scan.meta.connectionCount,
          ...(openPorts.length > 0
            ? {
                open_ports: openPorts.map((port) => `${port.nodeId}.${port.pinName}`),
                open_port_note: '这些引脚原本连到选区外面，片段里是断的。放回工程后需要手动接上。'
              }
            : {}),
          summary:
            `已存进蓝图库：「${input.entry_name}」（${scan.meta.nodeCount} 个节点）。` +
            (openPorts.length > 0 ? ` 有 ${openPorts.length} 个悬空端口。` : '')
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}

/**
 * 插件原始返回 → 工具层形状。
 *
 * 插件那边节点键是 `node_id`，而且**不发顶层 connections** —— 连线全挂在
 * `pins[].linked_to` 里。这个转换和 `getBlueprintGraph.ts` 里做的是同一件事，
 * 只是那边的结果没有作为函数导出。
 *
 * 连线**只从输出端发出**：一根线在两端的 `linked_to` 里各出现一次，
 * 两端都收就会得到两条重复的连线。
 */
function normalizePluginGraph(raw: Record<string, unknown>): ReadGraph {
  const rawNodes = Array.isArray(raw.nodes) ? (raw.nodes as Record<string, unknown>[]) : []

  const nodes = rawNodes.map((node) => ({
    id: (node.node_id as string) ?? (node.id as string) ?? '',
    class: node.class as string | undefined,
    title: node.title as string | undefined,
    write_as: node.write_as as string | undefined,
    member_name: node.member_name as string | undefined,
    target_class: node.target_class as string | undefined,
    struct_type: node.struct_type as string | undefined,
    pos_x: node.pos_x as number | undefined,
    pos_y: node.pos_y as number | undefined,
    pins: Array.isArray(node.pins)
      ? (node.pins as Record<string, unknown>[]).map((pin) => ({
          name: pin.name as string | undefined,
          dir: pin.dir as string | undefined,
          type: pin.category as string | undefined,
          // 三个默认值槽位合成一个
          default_value:
            (pin.default_value as string | undefined) ||
            (pin.default_object as string | undefined) ||
            (pin.default_text as string | undefined)
        }))
      : []
  }))

  const connections: ReadGraph['connections'] = []
  for (const node of rawNodes) {
    const nodeId = (node.node_id as string) ?? (node.id as string) ?? ''
    const pins = Array.isArray(node.pins) ? (node.pins as Record<string, unknown>[]) : []
    for (const pin of pins) {
      if (pin.dir !== 'Output') continue
      const links = Array.isArray(pin.linked_to) ? (pin.linked_to as Record<string, unknown>[]) : []
      for (const link of links) {
        if (!link?.node_id) continue
        connections.push({
          from_node: nodeId,
          from_pin: pin.name as string,
          to_node: link.node_id as string,
          to_pin: link.pin_name as string
        })
      }
    }
  }

  return {
    blueprint_path: raw.blueprint_path as string | undefined,
    graph_name: raw.graph_name as string | undefined,
    nodes,
    connections
  }
}

export { normalizePluginGraph }
