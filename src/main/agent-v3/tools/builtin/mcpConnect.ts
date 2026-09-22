/**
 * `connect_mcp_server` —— 试着连一台第三方 MCP server，连通了就写进配置。
 *
 * 来龙去脉、为什么先连再写、地址怎么猜，全在
 * `capabilities/mcp/addServer.ts` 的文件头。这里只负责三件事：收参数、
 * 按顺序试候选、把结果讲成一段人和模型都能照着做的话。
 *
 * ## 为什么依赖是注进来的
 *
 * 真身要碰三样重东西：`ensureConnected()`（会拉子进程握手）、
 * `store`（读写 userData 里的 mcp.json）、以及它们背后的 electron。
 * 走 `deps` 注入之后，`runConnect` 的全部分支都能直接测 ——
 * 而它恰好是最该被测的那部分：先后顺序错一步，用户盘上就会多一条坏配置。
 *
 * 同样的理由，真身那几个 import 是**函数里的动态 import**：注册表是所有工具
 * 的入口，静态引进来等于让每一个碰注册表的测试都去加载 electron 和 MCP SDK。
 */

import { z } from 'zod'

import {
  buildCandidates,
  formatFailure,
  formatSuccess,
  type Attempt,
  type ConnectRequest
} from '../../capabilities/mcp/addServer'
import type { McpServerConfig, McpServerStatus } from '../../capabilities/mcp/types'
import { defineTool, type ToolOutcome, type UnrealAgentTool } from '../defineTool'

const NAMESPACE = 'mcp'

export interface ConnectDeps {
  /** 真的去握手。失败原样抛，由这里收集成 `Attempt` */
  connect: (
    id: string,
    config: McpServerConfig
  ) => Promise<{
    status: McpServerStatus
    toolNames: string[]
  }>
  /** 盘上已经有哪些 server。只用来挡住「悄悄覆盖掉用户配好的那条」 */
  existingIds: () => Promise<string[]>
  /** 只改这一条，盘上其余内容原样不动（见 store.ts 的 `upsertMcpServer`） */
  persist: (id: string, config: McpServerConfig) => Promise<void>
  settingsPath: () => string
}

export interface ConnectDetails {
  id: string
  connected: boolean
  target?: string
  toolNames?: string[]
  attempts?: Attempt[]
}

export async function runConnect(
  request: ConnectRequest & { overwrite?: boolean },
  deps: ConnectDeps
): Promise<ToolOutcome<ConnectDetails>> {
  const built = buildCandidates(request)
  if ('error' in built) {
    return { text: built.error, isError: true, details: { id: request.id, connected: false } }
  }

  // 同名的已经配过了。**不能默默盖掉** —— 那条可能是用户自己调了半天参数的，
  // 而这次调用的理由往往只是模型随手起了个和它一样的短名字（filesystem、github）。
  if (!request.overwrite && (await deps.existingIds()).includes(request.id)) {
    return {
      text:
        `配置里已经有一台叫「${request.id}」的 server 了，这次什么都没做。\n` +
        '要接的是另一台就换个标识重来；确实是要替换掉那一台（用户明说了要改地址、' +
        '换命令、或者修一台连不上的），把 overwrite 设成 true 再调一次。',
      isError: true,
      details: { id: request.id, connected: false }
    }
  }

  const attempts: Attempt[] = []
  for (const candidate of built.candidates) {
    let connected: Awaited<ReturnType<ConnectDeps['connect']>>
    try {
      connected = await deps.connect(request.id, candidate.config)
    } catch (error) {
      attempts.push({ target: candidate.target, error: (error as Error).message })
      continue
    }

    // 握手成功才落盘。写失败不回滚连接：这一轮它是真的能用，
    // 谎称失败反而更糟 —— 由 `formatSuccess` 把「重启后就没了」说清楚
    let persistError: string | undefined
    try {
      await deps.persist(request.id, candidate.config)
    } catch (error) {
      persistError = (error as Error).message
    }

    return {
      text: formatSuccess({
        id: request.id,
        target: candidate.target,
        toolCount: connected.status.toolCount,
        toolNames: connected.toolNames,
        ...(connected.status.serverName ? { serverName: connected.status.serverName } : {}),
        ...(connected.status.serverVersion
          ? { serverVersion: connected.status.serverVersion }
          : {}),
        settingsPath: deps.settingsPath(),
        ...(persistError ? { persistError } : {})
      }),
      details: {
        id: request.id,
        connected: true,
        target: candidate.target,
        toolNames: connected.toolNames
      }
    }
  }

  return {
    text: formatFailure(request.id, attempts),
    isError: true,
    details: { id: request.id, connected: false, attempts }
  }
}

/** 真身。三样重依赖全部在这里动态 import，理由见文件头 */
async function liveDeps(): Promise<ConnectDeps> {
  const [{ ensureConnected }, store] = await Promise.all([
    import('../../capabilities/mcp'),
    import('../../capabilities/mcp/store')
  ])

  return {
    connect: async (id, config) => {
      const manager = await ensureConnected()
      const status = await manager.addServer(id, config)
      return { status, toolNames: manager.toolsOf(id).map((tool) => tool.name) }
    },
    existingIds: async () => Object.keys((await store.readMcpSettings()).mcpServers),
    persist: (id, config) => store.upsertMcpServer(id, config),
    settingsPath: () => store.mcpSettingsPath()
  }
}

const connectMcpServerTool = defineTool({
  name: 'connect_mcp_server',
  namespace: NAMESPACE,
  // 第三方 server 进来之后带的工具一律按最危险处理（见 McpClientManager 文件头），
  // 那么"决定放哪台 server 进来"本身至少也是这个等级。
  risk: 'destructive',
  // 每次的参数就是风险本身：这一次是本机的文件服务，下一次可能是一条从网页上
  // 抄来的地址。批准过一次不代表批准下一次 —— 同 `browser_*` 的理由。
  requiresExplicitApproval: true,
  // 动的是同一份 mcp.json
  concurrency: 'sequential',
  description: `接入一台第三方 MCP server：先握手验证，连得通才写进盒子的配置。

【什么时候用】用户说「我装了 xxx MCP」「帮我连一下 xxx」「端口 9876 你试试」
「把这个 server 加上」，或者他贴来一段 MCP 配置/一行启动命令让你接。

【两种接法，二选一】
- 本地进程（stdio，**绝大多数 server 是这种**）：给 command，参数放 args。
  例：command="npx"，args=["-y","@modelcontextprotocol/server-filesystem","D:/assets"]
- 远程服务（Streamable HTTP）：给 url。可以是完整地址 http://127.0.0.1:9876/mcp，
  也可以只给 localhost:9876 或者 9876 —— 只给端口时会依次试 /mcp 和根路径。

【先问清楚再调】用户只说了个名字（「我装了 blender MCP」）时，别自己编一行命令去试。
向他要 server 说明文档里那行启动命令，或者一个地址。编出来的命令十有八九是 ENOENT，
而那条报错会被当成「这个 server 有问题」。

【连不上不会写配置】失败只回报原因，盘上不留任何东西，可以放心重试。

【接上之后的关键一步】新工具**本轮不会出现在你的工具清单里**——清单在每条消息
开头装配一次。所以：告诉用户接好了、让他发下一条消息，从那条起才能调
\`mcp_<标识>_*\`。这一轮硬调只会拿到"工具不存在"。

【Blender 和 UE 官方 server 不走这里】偏好设置 → MCP 里有它们的一键接入，
那边会连安装脚本和环境变量一起办好。让用户去点那个按钮。

【标识（id）怎么起】短、全小写、见名知意（filesystem / github / figma），
它会成为工具名前缀。已经存在的标识不会被覆盖，除非用户明确要替换那一台。`,
  input: z.object({
    id: z
      .string()
      .describe('server 标识，会成为工具名前缀 mcp_<id>_。字母数字下划线连字符，最长 32'),
    url: z.string().optional().describe('远程形态的地址。完整 URL、host:port、或者只给端口号都行'),
    command: z.string().optional().describe('本地形态的启动命令，例如 npx、uvx、python'),
    args: z.array(z.string()).optional().describe('启动命令的参数，按顺序一项一个'),
    env: z.record(z.string(), z.string()).optional().describe('环境变量，常用于 API key'),
    cwd: z.string().optional().describe('启动命令的工作目录。省略则用盒子的工作目录'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('远程形态的附加请求头，通常是鉴权'),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe('只接入点名的这几个工具。server 工具太多（超过 120 个）被拒时用它收窄'),
    overwrite: z
      .boolean()
      .optional()
      .describe('同名 server 已存在时是否替换。默认 false，不会悄悄盖掉用户配好的那条')
  }),
  execute: async (args): Promise<ToolOutcome<ConnectDetails>> =>
    runConnect(args as ConnectRequest & { overwrite?: boolean }, await liveDeps())
})

export const mcpTools: UnrealAgentTool<never>[] = [
  connectMcpServerTool as unknown as UnrealAgentTool<never>
]
