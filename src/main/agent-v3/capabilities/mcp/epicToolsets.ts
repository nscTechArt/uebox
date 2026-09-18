/**
 * 自动发现 UE 5.8 内置的官方 MCP server，把它接成一个 MCP client 连接。
 *
 * ## 背景
 *
 * UE 5.8（2026-06-17）在引擎里内置了三个 Experimental 插件：
 *
 *   - `ModelContextProtocol` —— 编辑器进程内起一个 MCP server
 *   - `ToolsetRegistry`      —— 工具注册表
 *   - `AIAssistant`          —— Epic 开发者助手（套壳 Epic 云端服务）
 *
 * `Engine/Plugins/Experimental/Toolsets/` 下有 27 个工具集插件，约 900 个工具
 * （Python `@tool_call` 596 + C++ `AICallable` 298），含完整的蓝图 DSL、材质、
 * 材质实例、贴图、Actor、场景、静态/骨骼网格、数据表。详见
 *
 * 接进来的价值：**我们出大脑（多模型、可离线、审批门、素材库），Epic 出手脚。**
 * 而且 Epic 后续每次更新工具集，我们不改一行代码就跟着受益。
 *
 * ## 为什么 900 个工具不会撑爆上下文
 *
 * Epic 的 `bEnableToolSearch` 默认为 `true`，此时 `tools/list` **只返回 3 个**：
 * `list_toolsets` / `describe_toolset` / `call_tool`。模型按需发现、经 `call_tool`
 * 派发，那 900 个工具从不注册成原生 MCP 工具。所以接入成本几乎是零 token。
 *
 * 用户如果手动关掉 `bEnableToolSearch`，900 个会一次性铺开 —— 这种情况由
 * `McpClientManager` 的 `MAX_TOOLS_PER_SERVER` 挡住并给出可操作的报错。
 *
 * ## 为什么用「读 ini + 试连」而不是扫端口
 *
 * 扫端口会在用户机器上产生一串对本机端口的主动连接，既慢又容易被安全软件盯上。
 * 这里只在**明确知道某个已连接项目启用了该插件**时，才按它的配置连一次。
 *
 * ## 安全
 *
 * Epic 的 server **没有任何鉴权**，只靠绑定 127.0.0.1 自保。接进来等于把这个口子
 * 纳入盒子的信任域，所以：
 *
 *   - 只连 `127.0.0.1`（`isLoopbackUrl`），配置被改成外网地址就拒绝
 *   - 只有 `list_toolsets` / `describe_toolset` 降级为 `safe`；真正干活的
 *     `call_tool` 保持 `destructive`，每次都过审批门
 *   - 项目没在 `.uproject` 里启用该插件就完全不尝试，不留失败状态
 */

import { promises as fs } from 'fs'
import { join } from 'path'

import type { McpServerConfig } from './types'

/** Epic 官方 server 的插件名，与 `.uproject` 里的条目一致 */
export const EPIC_MCP_PLUGIN_NAME = 'ModelContextProtocol'

/** 自动发现出来的 serverId 前缀 */
export const EPIC_SERVER_ID_PREFIX = 'ue-official'

/** 默认端口与路径，来自 `ModelContextProtocolSettings.h` */
export const EPIC_MCP_DEFAULT_PORT = 8000
export const EPIC_MCP_DEFAULT_URL_PATH = '/mcp'

/**
 * 纯发现类工具，降级为 `safe` 不弹审批。
 *
 * 这两个只读取能力清单，不碰项目。模型**每次动手前都得先调它们**，
 * 全弹审批的话用户在真正的操作出现之前就已经点了两三次确认 ——
 * 审批门被点烦了就等于没有。`call_tool` 不在此列。
 */
export const EPIC_MCP_READ_ONLY_TOOLS = ['list_toolsets', 'describe_toolset']

/** UE 5.8 起才有官方 MCP */
const MIN_MAJOR = 5
const MIN_MINOR = 8

/** `EditorPerProjectUserSettings.ini` 里的段名，按 UE 的 `/Script/<模块>.<类>` 约定 */
const INI_SECTION = '/Script/ModelContextProtocolEngine.ModelContextProtocolSettings'

/**
 * 编辑器平台目录。Windows 是主力平台，另两个顺带试一下 ——
 * 探测失败只是回退到默认端口，代价很低。
 */
const EDITOR_PLATFORMS = ['WindowsEditor', 'MacEditor', 'LinuxEditor']

/** 判断引擎版本是否 >= 5.8。认不出的版本号一律当作「没有」 */
export function supportsOfficialMcp(engineVersion: string): boolean {
  const match = /^\s*(\d+)\.(\d+)/.exec(engineVersion)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major > MIN_MAJOR) return true
  return major === MIN_MAJOR && minor >= MIN_MINOR
}

export interface EpicMcpServerSettings {
  port: number
  urlPath: string
}

/**
 * 从一段 ini 文本里取 MCP 的端口与路径。
 *
 * 只认目标段内的键：同名键在别的段里出现是常事（`ServerPortNumber` 尤其），
 * 全文匹配会读到别人的值，连到一个毫不相干的端口上去。
 *
 * 文件不存在或段不存在都返回默认值 —— UE 只在用户**改过**设置后才落盘，
 * 一直用默认配置的项目根本没有这一段，那恰恰说明默认值是对的。
 */
export function parseEpicMcpIni(text: string): EpicMcpServerSettings {
  const result: EpicMcpServerSettings = {
    port: EPIC_MCP_DEFAULT_PORT,
    urlPath: EPIC_MCP_DEFAULT_URL_PATH
  }

  let inSection = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inSection = line === `[${INI_SECTION}]`
      continue
    }
    if (!inSection) continue

    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()

    if (key === 'ServerPortNumber') {
      const port = Number(value)
      // 端口非法就留着默认值：拿一个 0 或 NaN 去拼 URL 只会得到一条
      // 看不懂的报错，而默认端口至少还有连上的可能
      if (Number.isInteger(port) && port > 0 && port <= 65535) result.port = port
    } else if (key === 'ServerUrlPath' && value) {
      result.urlPath = value.startsWith('/') ? value : `/${value}`
    }
  }

  return result
}

/** 读某个项目的 MCP 设置。读不到就是默认值，不是错误 */
export async function readEpicMcpSettings(projectDir: string): Promise<EpicMcpServerSettings> {
  for (const platform of EDITOR_PLATFORMS) {
    const path = join(projectDir, 'Saved', 'Config', platform, 'EditorPerProjectUserSettings.ini')
    try {
      return parseEpicMcpIni(await fs.readFile(path, 'utf8'))
    } catch {
      // 换下一个平台目录
    }
  }
  return { port: EPIC_MCP_DEFAULT_PORT, urlPath: EPIC_MCP_DEFAULT_URL_PATH }
}

/** 发现所需的项目信息。只取用得上的字段，方便测试构造 */
export interface DiscoverableProject {
  projectName: string
  projectPath: string
  engineVersion: string
  enabledPlugins: string[]
  isConnected?: boolean
}

/**
 * serverId → 工具名前缀的一部分，必须过 `mcp.json` 的
 * `^[a-zA-Z0-9_-]{1,32}$`，也要让用户在设置页一眼认出是哪个项目。
 */
export function epicServerId(projectName: string, unique: boolean): string {
  if (unique) return EPIC_SERVER_ID_PREFIX
  const slug = projectName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 20)
  return slug ? `${EPIC_SERVER_ID_PREFIX}-${slug}` : EPIC_SERVER_ID_PREFIX
}

/**
 * 这条 server 是不是引擎内置的官方 MCP。
 *
 * 按 id 前缀认，而不是另存一个标记：用户在 `mcp.json` 里用同一个 id 覆盖配置
 * （改端口、临时停用）时，它**仍然是**那台 server，提示词里该说的话一句不能少。
 */
export function isEpicServerId(id: string): boolean {
  return id === EPIC_SERVER_ID_PREFIX || id.startsWith(`${EPIC_SERVER_ID_PREFIX}-`)
}

/**
 * 只允许回环地址。
 *
 * Epic 的 server 没有鉴权，唯一的保护就是「只有本机能连」。如果哪天配置来源
 * （ini、未来的用户覆盖）被写成了外网地址，我们就成了帮凶 —— 把一个无鉴权的
 * 引擎控制面从公网代理进来。宁可不连。
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * 把符合条件的已连接项目变成 MCP client 配置。
 *
 * 三道门，任何一道不过就跳过（**不留失败状态**）：
 *   1. 项目当前连着盒子
 *   2. 引擎 >= 5.8
 *   3. `.uproject` 里启用了 `ModelContextProtocol`
 *
 * 第 3 道是关键。不加的话，所有 5.8 用户都会多出一条连不上的 server ——
 * 它会出现在设置页、也会进系统提示词，对 99% 没开这个插件的人纯属噪音。
 *
 * 端口撞车是正常现象：Epic 的 server 在编辑器进程内，两个编辑器抢同一个端口时
 * 只有一个能起来。所以这里按 URL 去重，撞上的后来者直接丢掉。
 */
export async function discoverEpicMcpServers(
  projects: DiscoverableProject[]
): Promise<Record<string, McpServerConfig>> {
  const candidates = projects.filter(
    (p) =>
      p.isConnected !== false &&
      supportsOfficialMcp(p.engineVersion) &&
      p.enabledPlugins.includes(EPIC_MCP_PLUGIN_NAME) &&
      p.projectPath
  )
  if (candidates.length === 0) return {}

  const servers: Record<string, McpServerConfig> = {}
  const seenUrls = new Set<string>()

  for (const project of candidates) {
    const { port, urlPath } = await readEpicMcpSettings(project.projectPath)
    const url = `http://127.0.0.1:${port}${urlPath}`

    if (seenUrls.has(url)) continue
    if (!isLoopbackUrl(url)) {
      console.warn(`[AgentV3][MCP] 跳过 UE 官方 server：${url} 不是回环地址`)
      continue
    }
    seenUrls.add(url)

    const id = epicServerId(project.projectName, candidates.length === 1)
    servers[id] = {
      type: 'http',
      url,
      readOnlyTools: EPIC_MCP_READ_ONLY_TOOLS
    }
  }

  if (Object.keys(servers).length > 0) {
    console.log(
      `[AgentV3][MCP] 发现 ${Object.keys(servers).length} 个 UE 5.8 官方 MCP server：` +
        Object.values(servers)
          .map((s) => (s as { url: string }).url)
          .join('、')
    )
  }

  return servers
}

/**
 * 从运行时的项目管理器发现。
 *
 * 动态 import 是为了让本文件的纯函数部分能在不起 Electron 的情况下被测试 ——
 * `projectManager` 会一路拉进 `electron` 的 `BrowserWindow`。
 */
export async function discoverEpicMcpServersFromRuntime(): Promise<
  Record<string, McpServerConfig>
> {
  try {
    const { projectManager } = await import('../../../services/project/projectManager')
    return await discoverEpicMcpServers(projectManager.getInteractiveProjects())
  } catch (error) {
    // 发现失败按「没有」处理：这是增强能力，不该影响 agent 启动
    console.warn('[AgentV3][MCP] 发现 UE 官方 server 失败:', (error as Error).message)
    return {}
  }
}
