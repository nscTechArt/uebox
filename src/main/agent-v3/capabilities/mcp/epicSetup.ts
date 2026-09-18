/**
 * 一键给项目开启 UE 5.8 官方 MCP 服务。
 *
 * ## 为什么要有这个文件
 *
 * 手工流程是：Edit > Plugins 勾两个插件 → 重启编辑器 → Editor Preferences
 * 里找到 Model Context Protocol 勾 Auto Start Server → 再重启。
 * 四步里有三步藏在两个不同的设置面板，**大部分用户走不完**，
 * 走不完就等于这个能力不存在。
 *
 * 这三件事盒子全都能代劳，因为它们最终都只是改文件：
 *
 *   1. 启用插件      = 往 `.uproject` 的 `Plugins` 数组里加两条
 *   2. 开机自动起服务 = 往 `EditorPerProjectUserSettings.ini` 写一个键
 *   3. 立刻起服务    = 经 UnrealAgentLink 发一条控制台命令
 *
 * 第 3 步只在插件**已经加载**时有效。刚写完 `.uproject` 的那一次必须重启编辑器 ——
 * UE 没有热加载新插件模块的能力，这一步骗不过去，只能如实告诉用户。
 *
 * ## 只需要写两条插件依赖
 *
 * 剩下的 UE 自己会解析：
 *
 *   ModelContextProtocol → ToolsetRegistry → PythonScriptPlugin
 *                                          + EditorScriptingUtilities
 *                                          + FileSandbox
 *   AllToolsets          → 21 个工具集插件 → ToolsetRegistry
 *
 * 所以别把 `PythonScriptPlugin` 之类也写进 `.uproject`：多写不会错，但用户
 * 之后想关掉时要在一堆条目里找，而且我们也没有理由替他管这些传递依赖。
 *
 * ## 只改，不删
 *
 * 这里只做「加上」和「设为 true」，没有反向操作。用户想关掉就去 UE 里取消勾选 ——
 * 那是他的项目文件，我们不该有第二个入口去改回来。UnrealAgentLink 自己踩过
 * 这条：只有装没有卸，用户手删之后又被我们装回去。
 */

import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { readUeJsonFile, readUeTextFile } from '../../../utils/ueTextFile'

import {
  EPIC_MCP_DEFAULT_PORT,
  EPIC_MCP_DEFAULT_URL_PATH,
  readEpicMcpSettings,
  supportsOfficialMcp,
  type DiscoverableProject
} from './epicToolsets'

/**
 * 要写进 `.uproject` 的两条。其余靠 UE 的依赖解析，见文件头。
 */
export const REQUIRED_UPROJECT_PLUGINS = ['ModelContextProtocol', 'AllToolsets'] as const

/** 落盘的 ini 段名与键，来自 `ModelContextProtocolSettings.h` */
const INI_SECTION = '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]'
const AUTO_START_KEY = 'bAutoStartServer'

/**
 * 一键之前，项目处在哪个状态。
 *
 * 分这么细是因为**每种状态该给用户的下一步都不一样**：能一键的给按钮，
 * 要重启的说重启，引擎太老的直接说清楚别让人白试。
 */
export type EpicSetupState =
  /** 引擎低于 5.8，没有这个能力 */
  | 'unsupported'
  /** 插件没启用，可以一键 */
  | 'needs-plugins'
  /** 插件写好了但编辑器还没加载，要重启 */
  | 'needs-restart'
  /** 插件在跑，只是服务没起来 —— 一条控制台命令的事，不用重启 */
  | 'needs-start'
  /** 都齐了 */
  | 'ready'

export interface EpicSetupStatus {
  state: EpicSetupState
  /** `.uproject` 里还缺哪几条 */
  missingPlugins: string[]
  /** ini 里有没有开自动启动 */
  autoStartEnabled: boolean
  /** 探到的服务地址，给界面显示 */
  url: string
}

interface UprojectData {
  EngineAssociation?: string
  Plugins?: Array<{ Name: string; Enabled?: boolean }>
  [key: string]: unknown
}

async function readUproject(uprojectPath: string): Promise<UprojectData> {
  return readUeJsonFile<UprojectData>(uprojectPath)
}

/** `.uproject` 里还缺哪几条必需插件（没写、或者写了但 Enabled 不是 true） */
export function missingPluginsIn(data: UprojectData): string[] {
  const entries = Array.isArray(data.Plugins) ? data.Plugins : []
  return REQUIRED_UPROJECT_PLUGINS.filter(
    (name) => !entries.some((p) => p.Name === name && p.Enabled === true)
  )
}

/**
 * ini 文本里 `bAutoStartServer` 是不是 True。
 *
 * 和 `parseEpicMcpIni` 一样只认目标段内的键 —— 同名键出现在别的段里是常事。
 */
export function autoStartEnabledIn(text: string): boolean {
  let inSection = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inSection = line === INI_SECTION
      continue
    }
    if (!inSection) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    if (line.slice(0, eq).trim() === AUTO_START_KEY) {
      return (
        line
          .slice(eq + 1)
          .trim()
          .toLowerCase() === 'true'
      )
    }
  }
  return false
}

/**
 * 往 ini 文本里写入 `bAutoStartServer=True`，返回新文本。
 *
 * 三种情况都要处理，少一种就会写出一份坏配置：
 *   - 段和键都在  → 改值（不能再追加一行，UE 读的是最后一个，但重复键很难排查）
 *   - 段在键不在  → 在段内追加
 *   - 段不在      → 在文件末尾补一整段
 */
export function withAutoStartEnabled(text: string): string {
  const lines = text.split(/\r?\n/)
  let sectionStart = -1
  let sectionEnd = lines.length

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('[')) continue
    if (sectionStart === -1 && line === INI_SECTION) {
      sectionStart = i
    } else if (sectionStart !== -1) {
      sectionEnd = i
      break
    }
  }

  if (sectionStart === -1) {
    const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
    return `${text}${prefix}\n${INI_SECTION}\n${AUTO_START_KEY}=True\n`
  }

  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const eq = lines[i].indexOf('=')
    if (eq > 0 && lines[i].slice(0, eq).trim() === AUTO_START_KEY) {
      lines[i] = `${AUTO_START_KEY}=True`
      return lines.join('\n')
    }
  }

  lines.splice(sectionEnd, 0, `${AUTO_START_KEY}=True`)
  return lines.join('\n')
}

/** 项目的 `EditorPerProjectUserSettings.ini` 路径。Windows 是主力平台 */
export function editorUserIniPath(projectDir: string, platform = 'WindowsEditor'): string {
  return join(projectDir, 'Saved', 'Config', platform, 'EditorPerProjectUserSettings.ini')
}

/**
 * 看一个项目现在处在哪一步。
 *
 * `serverReachable` 由调用方传入 —— 探测要发真实网络请求，放在纯逻辑里
 * 会让这个函数没法在测试里用。
 */
export async function inspectEpicMcpSetup(
  project: DiscoverableProject,
  uprojectPath: string,
  serverReachable: boolean
): Promise<EpicSetupStatus> {
  const { port, urlPath } = await readEpicMcpSettings(project.projectPath)
  const url = `http://127.0.0.1:${port}${urlPath}`

  if (!supportsOfficialMcp(project.engineVersion)) {
    return { state: 'unsupported', missingPlugins: [], autoStartEnabled: false, url }
  }

  let missingPlugins: string[] = [...REQUIRED_UPROJECT_PLUGINS]
  try {
    missingPlugins = missingPluginsIn(await readUproject(uprojectPath))
  } catch {
    // 读不出 .uproject 就按「全缺」处理：一键会重新写一份正确的条目
  }

  let autoStartEnabled = false
  try {
    autoStartEnabled = autoStartEnabledIn(
      await readUeTextFile(editorUserIniPath(project.projectPath))
    )
  } catch {
    // 没有 ini 就是没开过
  }

  if (serverReachable) {
    return { state: 'ready', missingPlugins, autoStartEnabled, url }
  }

  if (missingPlugins.length > 0) {
    return { state: 'needs-plugins', missingPlugins, autoStartEnabled, url }
  }

  // 插件写在 .uproject 里了，但当前跑着的编辑器进程是不是加载了它，
  // 我们从外面看不出来。用「项目上报的已启用插件」当判据 ——
  // 那份列表是编辑器启动时读的，最接近「进程里到底有没有」。
  const loaded = REQUIRED_UPROJECT_PLUGINS.every((name) => project.enabledPlugins.includes(name))
  return {
    state: loaded ? 'needs-start' : 'needs-restart',
    missingPlugins,
    autoStartEnabled,
    url
  }
}

export interface EpicSetupResult {
  success: boolean
  /** 改完之后还需要重启编辑器才能生效 */
  needsRestart: boolean
  /** 这次实际写进 `.uproject` 的插件 */
  addedPlugins: string[]
  /** 这次是否写了自动启动 */
  wroteAutoStart: boolean
  error?: string
}

/**
 * 一键：写 `.uproject` + 写 ini。
 *
 * **不负责起服务**，那是调用方的事（要不要发控制台命令取决于插件加载没有）。
 * 这里只做文件改动，好处是失败可以原样重试，不会留下半开的状态。
 */
export async function applyEpicMcpSetup(
  project: DiscoverableProject,
  uprojectPath: string
): Promise<EpicSetupResult> {
  if (!supportsOfficialMcp(project.engineVersion)) {
    return {
      success: false,
      needsRestart: false,
      addedPlugins: [],
      wroteAutoStart: false,
      error: `虚幻引擎 ${project.engineVersion} 没有官方 MCP 服务，需要 5.8 或更高版本`
    }
  }

  let addedPlugins: string[] = []
  try {
    const data = await readUproject(uprojectPath)
    addedPlugins = missingPluginsIn(data)

    if (addedPlugins.length > 0) {
      if (!Array.isArray(data.Plugins)) data.Plugins = []
      for (const name of addedPlugins) {
        const existing = data.Plugins.find((p) => p.Name === name)
        if (existing) existing.Enabled = true
        else data.Plugins.push({ Name: name, Enabled: true })
      }
      // 缩进用 Tab：UE 自己写 .uproject 就是 Tab，用空格会让整个文件在
      // 版本控制里显示成全量改动
      await fs.writeFile(uprojectPath, JSON.stringify(data, null, '\t'), 'utf8')
    }
  } catch (error) {
    return {
      success: false,
      needsRestart: false,
      addedPlugins: [],
      wroteAutoStart: false,
      error: `写入 .uproject 失败：${(error as Error).message}`
    }
  }

  let wroteAutoStart = false
  try {
    const iniPath = editorUserIniPath(project.projectPath)
    let text = ''
    try {
      text = await readUeTextFile(iniPath)
    } catch {
      // 没有就新建
    }

    if (!autoStartEnabledIn(text)) {
      await fs.mkdir(dirname(iniPath), { recursive: true })
      await fs.writeFile(iniPath, withAutoStartEnabled(text), 'utf8')
      wroteAutoStart = true
    }
  } catch (error) {
    // 自动启动只是便利项：插件已经写进去了，用户手动敲一次控制台命令照样能用。
    // 为了它把整个一键判成失败，反而会让用户以为前面那步也没成。
    console.warn('[AgentV3][MCP] 写入自动启动配置失败:', (error as Error).message)
  }

  const loaded = REQUIRED_UPROJECT_PLUGINS.every((name) => project.enabledPlugins.includes(name))
  return {
    success: true,
    // 只要这次动过 .uproject，当前编辑器进程里就一定没加载这些模块 —— UE 不能热加载
    needsRestart: addedPlugins.length > 0 || !loaded,
    addedPlugins,
    wroteAutoStart
  }
}

/** 默认服务地址，给界面在探测不到时兜底显示 */
export const DEFAULT_EPIC_MCP_URL = `http://127.0.0.1:${EPIC_MCP_DEFAULT_PORT}${EPIC_MCP_DEFAULT_URL_PATH}`
