/**
 * 工具清单与调用范围。
 *
 * ## 判据只有一条：盒子自己的 agent 能用的，外部 harness 也能用
 *
 * 读操作（`risk=safe`）随便调；其余的要这次调用显式给了 `--allow-write`。
 * 命名空间不再参与判断。
 *
 * ## 为什么去掉了 `ue.*` 那道门
 *
 * V1 只放行 `ue.*`，于是外部 harness（Codex、Claude Code 这类）在盒子里
 * **搜不到素材库、也导不进工程**：`search_assets` 是 `asset`、
 * `project_manage` 是 `project`，两个都被命名空间那一刀挡在外面。结果是
 * 「找资产 → 导进工程 → 摆进场景」这条最常用的链子从中间断开，只剩最后一段。
 *
 * 那道门当初是按「CLI 的卖点是虚幻引擎能力」划的。但素材库→工程的导入
 * 恰恰**也是**虚幻引擎能力，只是实现上不经过引擎连接而已 —— 按实现细节
 * 划用户能力边界，划出来的形状用户理解不了，也讲不出道理。
 *
 * ## 为什么去掉了写操作准入表
 *
 * 原来非 `safe` 的工具还要在 `write.ts` 的准入表里逐条点名（进来三条）。
 * 那张表按「失败之后能不能核实」判定，判据本身是对的，但它解决问题的位置
 * 错了：**回读校验是工具自己的责任**，这个仓库的硬规矩就是工具不回读就不许
 * 报 success。CLI 再手写一遍每个工具的回读判据，等于把九十多个工具的语义
 * 抄进 CLI —— 抄不完，抄完了也会漂。
 *
 * 现在的分工：
 *
 *   - **工具**负责回读并如实报成败，返回里写清楚做成了什么。
 *   - **CLI** 负责把「这条会改东西」变成命令行上看得见的一笔（`--allow-write`），
 *     以及超时（`unknown`）时告诉调用方怎么自己核实。
 *   - `write.ts` 里那三个 Actor 操作**留着**，但身份变了：不再是准入表，
 *     而是「CLI 额外再核实一遍」的加强档（白名单重建参数 + 外部回读）。
 *
 * ## 两件仍然不给
 *
 *   - **要求逐次审批的工具**（`requiresExplicitApproval`）：它的前提就是
 *     有人当场看着，CLI 这头没有界面。目前只有 `browser_interact`。
 *   - **`local.*` / `mcp.*` / `core`**：这三类在盒子的 MCP 服务那一层就没暴露
 *     （见 `McpServerHost.selectExposedTools`），CLI 这里看都看不到。理由是
 *     外部 harness 本来就自带跑命令和读写文件的能力，转发我们这一份不增加
 *     任何能力，只多一条追不到源头的路径。
 *
 * ## 元数据缺失一律当成不在范围内
 *
 * 旧盒子的清单里没有 `_meta.unrealBox`。这时候**不能默认它是只读的** ——
 * 把「不知道」当成「安全」，正是这类判断出事的固定方式。没有元数据就报
 * 不兼容，让用户去升级盒子。
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { UeboxError } from './errors.js'

export interface ToolMeta {
  namespace: string
  risk: string
  projectScoped: boolean
  requiresExplicitApproval: boolean
}

export interface CatalogTool {
  name: string
  description: string
  inputSchema: unknown
  meta: ToolMeta
  /** 只读，任何时候都能调 */
  readOnly: boolean
  /** 会改动东西，要 `--allow-write` 才能调 */
  write: boolean
  /** 两者都不是的原因，给用户看 */
  unsupportedReason?: string
}

/**
 * 取完整工具清单。
 *
 * 按协议处理 `nextCursor` 翻页。清单**只在本进程内用**，不落盘 ——
 * 那是一份会过期的权限清单，缓存它等于让 CLI 拿着昨天的授权做今天的判断。
 */
export async function fetchCatalog(client: Client): Promise<CatalogTool[]> {
  const tools: CatalogTool[] = []
  let cursor: string | undefined

  do {
    const page = await client.listTools(cursor ? { cursor } : {})
    for (const tool of page.tools) {
      tools.push(describe(tool))
    }
    cursor = page.nextCursor
  } while (cursor)

  return tools
}

function describe(tool: {
  name: string
  description?: string
  inputSchema: unknown
  _meta?: Record<string, unknown>
}): CatalogTool {
  const raw = tool._meta?.unrealBox as Partial<ToolMeta> | undefined

  const base = {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema
  }

  if (!raw || typeof raw.namespace !== 'string' || typeof raw.risk !== 'string') {
    // 没有元数据就说不清楚这个工具会干什么。说不清楚就不给调。
    return {
      ...base,
      meta: {
        namespace: 'unknown',
        risk: 'unknown',
        projectScoped: false,
        requiresExplicitApproval: false
      },
      readOnly: false,
      write: false,
      unsupportedReason: '这个盒子没有为该工具声明命名空间和风险等级，无法确认它是只读的。'
    }
  }

  const meta: ToolMeta = {
    namespace: raw.namespace,
    risk: raw.risk,
    projectScoped: raw.projectScoped === true,
    requiresExplicitApproval: raw.requiresExplicitApproval === true
  }

  return { ...base, meta, ...evaluateScope(meta) }
}

type Scope = Pick<CatalogTool, 'readOnly' | 'write' | 'unsupportedReason'>

function evaluateScope(meta: ToolMeta): Scope {
  // 审批要求是绝对的：这类工具的前提就是有人当场看着，而 CLI 这头没有界面
  if (meta.requiresExplicitApproval) {
    return {
      readOnly: false,
      write: false,
      unsupportedReason: '这个工具要求每次调用都由用户当场批准，CLI 这一头没有审批界面。'
    }
  }

  if (meta.risk === 'safe') return { readOnly: true, write: false }

  // 其余一律是写操作：能不能调由这次命令上有没有 --allow-write 决定。
  // 不再按名字点名 —— 点名表的那套判据已经交还给工具自己（见文件头）
  return { readOnly: false, write: true }
}

/**
 * 这次调用能用的工具。
 *
 * @param allowWrite 命令行上给了 `--allow-write` 吗
 */
export function supportedTools(catalog: CatalogTool[], allowWrite = false): CatalogTool[] {
  return catalog.filter((tool) => tool.readOnly || (allowWrite && tool.write))
}

/**
 * 找一个能调的工具。
 *
 * 三种失败分开报，因为下一步完全不同：名字写错了（去列清单）、
 * 是写操作但这次没开（加 `--allow-write`）、超出范围（没有下一步）。
 */
export function requireSupported(
  catalog: CatalogTool[],
  name: string,
  allowWrite = false
): CatalogTool {
  const tool = catalog.find((item) => item.name === name)
  if (!tool) {
    throw new UeboxError(
      'TOOL_UNAVAILABLE',
      `工具 ${name} 不在当前开放的清单里。`,
      '运行 uebox tools list 看现在有哪些可用。'
    )
  }

  if (tool.write && !allowWrite) {
    throw new UeboxError(
      'RISK_NOT_SUPPORTED',
      `${name} 会改动东西，这条命令没有开写操作。`,
      `确认要改的话加 --allow-write 重跑一次。` + 'CLI 没有审批弹窗，这个开关就是顶替它的那一下。'
    )
  }

  if (!tool.readOnly && !tool.write) {
    throw new UeboxError(
      'RISK_NOT_SUPPORTED',
      `工具 ${name} 超出 CLI 的调用范围：${tool.unsupportedReason}`,
      '这类操作请在虚幻盒子里做 —— 那边有审批界面和会话上下文。'
    )
  }

  return tool
}

/** `tools list --search` 的匹配：名字和描述都算，大小写不敏感 */
export function search(tools: CatalogTool[], text: string | undefined): CatalogTool[] {
  if (!text) return tools
  const needle = text.toLowerCase()
  return tools.filter(
    (tool) =>
      tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle)
  )
}
