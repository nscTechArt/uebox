/**
 * MCP 能力层入口。
 *
 * 连接生命周期由宿主层管理：会话开始时 `ensureConnected`，应用退出时
 * `shutdownMcp`。连接不随每个 agent 重建 —— 拉子进程 + 握手是有代价的。
 */

import { McpClientManager } from './McpClientManager'
import { discoverEpicMcpServersFromRuntime } from './epicToolsets'
import { McpServerHost, type McpServerHostOptions, type McpServerHostStatus } from './McpServerHost'
import { readHostSettings, writeHostSettings, type McpHostSettings } from './hostStore'
import { readMcpSettings } from './store'
import type { McpServerStatus } from './types'

export { McpClientManager } from './McpClientManager'
export { McpServerHost, selectExposedTools } from './McpServerHost'
export type { McpServerHostOptions, McpServerHostStatus } from './McpServerHost'
export {
  DEFAULT_HOST_PORT,
  mcpHostSettingsPath,
  readHostSettings,
  rotateHostToken,
  writeHostSettings
} from './hostStore'
export type { McpHostSettings } from './hostStore'
export {
  discoverEpicMcpServers,
  discoverEpicMcpServersFromRuntime,
  EPIC_MCP_PLUGIN_NAME,
  EPIC_MCP_READ_ONLY_TOOLS,
  supportsOfficialMcp
} from './epicToolsets'
export { mcpSettingsPath, readMcpSettings, writeMcpSettings } from './store'
export * from './types'

let manager: McpClientManager | undefined
let connecting: Promise<McpClientManager> | undefined

/**
 * 拿到已连接的 manager。
 *
 * 并发调用共用同一次连接（`connecting` 去重）—— 否则多个窗口同时开会话
 * 会把同一批 server 各拉起一份子进程。
 */
export function ensureConnected(): Promise<McpClientManager> {
  if (manager) return Promise.resolve(manager)
  if (connecting) return connecting

  connecting = (async () => {
    const instance = new McpClientManager()
    try {
      const settings = await readMcpSettings()

      // 插件自带的 server 一并连上。serverId 带插件 id 前缀，
      // 不会和用户手配的撞名（见 plugins/registry.ts）。
      const { enabledPluginMcpServers } = await import('../plugins/registry')
      const fromPlugins = await enabledPluginMcpServers().catch(() => ({}))

      // UE 5.8 起引擎内置了官方 MCP server，自动发现、自动接上（见 epicToolsets.ts）。
      // 放在最前面合并 —— 用户在 mcp.json 里手写同名条目就能覆盖掉自动发现的结果，
      // 这是唯一能让他改端口或干脆停掉的口子。
      const fromEngine = await discoverEpicMcpServersFromRuntime()

      const all = { ...fromEngine, ...settings.mcpServers, ...fromPlugins }
      const count = Object.keys(all).length
      if (count > 0) {
        console.log(
          `[AgentV3][MCP] 正在连接 ${count} 个 server` +
            `（用户 ${Object.keys(settings.mcpServers).length}` +
            ` / 插件 ${Object.keys(fromPlugins).length}` +
            ` / 引擎内置 ${Object.keys(fromEngine).length}）…`
        )
        await instance.connectAll(all)
      }
    } catch (error) {
      // 连不上不该让 agent 起不来 —— MCP 是扩展能力，不是必需品
      console.warn('[AgentV3][MCP] 初始化失败，按无 MCP 继续:', (error as Error).message)
    }
    manager = instance
    connecting = undefined
    return instance
  })()

  return connecting
}

/** 配置改动后重连。设置界面保存时调用 */
export async function reconnectMcp(): Promise<McpServerStatus[]> {
  await shutdownMcp()
  const instance = await ensureConnected()
  return instance.getStatuses()
}

export async function shutdownMcp(): Promise<void> {
  if (connecting) await connecting.catch(() => undefined)
  await manager?.disconnectAll()
  manager = undefined
  connecting = undefined
}

export function currentStatuses(): McpServerStatus[] {
  return manager?.getStatuses() ?? []
}

// ── 对外暴露（MCP Server）────────────────────────────────────────────────
//
// 是否开机自启及外部客户端权限都由 hostStore 持久化；外部客户端的配置
// 是长期配置，地址与凭据跨重启保持稳定。

type ToolList = Parameters<McpServerHost['start']>[0]

/**
 * 去掉用户在「设置 → 工具」里关掉的那些。
 *
 * `selectExposedTools` 只按命名空间和风险收窄，看不见那份名单 —— 少了这一道，
 * 用户在设置页关掉整摊内容工具、以为「关掉的完全不给」，外部客户端
 * （Claude Code / Cursor）照样能把资产删掉。**对外的口子不能比盒子自己宽。**
 *
 * 不分全量/工具搜索模式，一律照这份名单滤：那边的开关在搜索模式下换了含义，
 * 而这一头根本没有「按需加载」这回事，只剩「给还是不给」。用户说过关掉的，
 * 在一个无人值守的外部入口上就按关掉算。
 *
 * 动态 import：设置管理器会拉起 services，不能进这个模块的静态依赖图 ——
 * 开机路径正是靠动态 import 才没把整棵工具树拉进来。
 */
export async function withoutDisabledTools(tools: ToolList): Promise<ToolList> {
  const { appSettingsManager } = await import('../../../appSettingsManager')
  const off = new Set(appSettingsManager.getSettings().agentDisabledTools)
  return off.size ? tools.filter((tool) => !off.has(tool.name)) : tools
}

const serverHost = new McpServerHost()

/**
 * 起服务，并把这次的选择记下来。
 *
 * 端口和 token 一律来自持久化配置：调用方只决定「开不开」「开多大范围」，
 * 地址和凭据必须跨重启稳定，否则用户粘进 Claude Code 的那份配置隔天就失效。
 */
export async function startMcpServer(
  tools: ToolList,
  options: McpServerHostOptions = {}
): Promise<McpServerHostStatus> {
  const saved = await readHostSettings()
  const next: McpHostSettings = {
    ...saved,
    ...(options.port ? { port: options.port } : {}),
    includeMutating: options.includeMutating ?? saved.includeMutating
  }

  const status = await serverHost.start(await withoutDisabledTools(tools), {
    ...options,
    port: next.port,
    token: next.token,
    includeMutating: next.includeMutating
  })

  // 只有真起来了才记 enabled —— 端口被占用时记成 true，
  // 下次开机会再失败一次，还多一条摸不着头脑的报错
  await writeHostSettings({ ...next, enabled: status.running })
  return status
}

export async function stopMcpServer(): Promise<void> {
  await serverHost.stop()
}

/**
 * 只存配置，不动服务。
 *
 * 原来端口和「是否开放写工具」**只有 start 会写盘** —— 用户在设置里改完
 * 不点开启就切走，下次回来全变回默认值，看起来就是「配置没有持久化」。
 * 而服务正在跑时这两项是禁用的，等于改了也没处存。
 *
 * 现在界面一改就调这里，所见即所存。
 */
export async function saveMcpServerConfig(
  patch: Partial<Pick<McpHostSettings, 'port' | 'includeMutating'>>
): Promise<McpHostSettings> {
  const next = { ...(await readHostSettings()), ...patch }
  await writeHostSettings(next)
  return next
}

/** 保存后让运行中的服务立即采用新端口或权限；未启动和无变化时不重启。 */
export async function applyMcpServerConfig(
  patch: Partial<Pick<McpHostSettings, 'port' | 'includeMutating'>>,
  buildTools: () => ToolList
): Promise<McpServerHostStatus> {
  const previous = await readHostSettings()
  const next = await saveMcpServerConfig(patch)
  if (
    !serverHost.status().running ||
    (previous.port === next.port && previous.includeMutating === next.includeMutating)
  ) {
    return serverHost.status()
  }
  // 先撤销旧会话的工具权限，再构建新清单；切到只读时不能让旧写会话继续跑。
  await serverHost.stop()
  return startMcpServer(buildTools(), { port: next.port, includeMutating: next.includeMutating })
}

/** 用户在界面上点停止：除了停掉，还要记住「下次别自动起」 */
export async function disableMcpServer(): Promise<McpServerHostStatus> {
  await serverHost.stop()
  await writeHostSettings({ ...(await readHostSettings()), enabled: false })
  return serverHost.status()
}

export function mcpServerStatus(): McpServerHostStatus {
  return serverHost.status()
}

/**
 * 开机自动拉起（仅当用户上次是开着的）。
 *
 * 失败只记日志：对外暴露是可选能力，端口被占用不该让盒子起不来。
 */
export async function autoStartMcpServer(buildTools: () => ToolList): Promise<void> {
  const settings = await readHostSettings().catch(() => undefined)
  if (!settings?.enabled) return

  try {
    const status = await serverHost.start(await withoutDisabledTools(buildTools()), {
      port: settings.port,
      token: settings.token,
      includeMutating: settings.includeMutating
    })
    if (!status.running) {
      console.warn('[AgentV3][MCP-Server] 自动启动失败:', status.error)
    }
  } catch (error) {
    console.warn('[AgentV3][MCP-Server] 自动启动异常:', (error as Error).message)
  }
}
