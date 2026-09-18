/**
 * `epicSetup.ts` 的运行时外壳：查项目、发控制台命令、探服务。
 *
 * 拆成两个文件是为了让 `epicSetup.ts` 保持可测 —— 那边全是文件读写和纯逻辑，
 * 这边才碰 `projectManager`、WebSocket 和真实网络。
 */

import { promises as fs } from 'fs'
import { join } from 'path'

import {
  applyEpicMcpSetup,
  DEFAULT_EPIC_MCP_URL,
  inspectEpicMcpSetup,
  type EpicSetupResult,
  type EpicSetupStatus
} from './epicSetup'
import type { DiscoverableProject } from './epicToolsets'

/** 一个项目的一键状态，加上界面要显示的名字 */
export interface EpicSetupProjectStatus extends EpicSetupStatus {
  connectionId: string
  projectName: string
}

/** 找出项目目录里的 `.uproject`。找不到返回 undefined */
export async function findUprojectFile(projectDir: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(projectDir)
    const name = entries.find((e) => e.toLowerCase().endsWith('.uproject'))
    return name ? join(projectDir, name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 服务通不通。
 *
 * 只发一个 POST 就够判断 —— MCP 的 Streamable HTTP 端点对没带 session 的请求
 * 会回 4xx，但**回了就说明有人在听**。这里要的正是「有没有人听」，
 * 不是「握手能不能成」，所以任何 HTTP 响应都算通。
 *
 * 超时压到 1.5 秒：这是给界面用的探测，端口没人听时 Windows 会立刻拒绝，
 * 拖长只会让面板转圈。
 */
export async function probeEpicMcpServer(url: string, timeoutMs = 1_500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: '{"jsonrpc":"2.0","id":0,"method":"ping"}',
      signal: controller.signal
    })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function connectedProjects(): Promise<Array<DiscoverableProject & { connectionId: string }>> {
  const { projectManager } = await import('../../../services/project/projectManager')
  return projectManager.getInteractiveProjects()
}

/** 所有已连接项目的一键状态。界面进来时调一次 */
export async function inspectAllProjects(): Promise<EpicSetupProjectStatus[]> {
  const projects = await connectedProjects()

  return Promise.all(
    projects.map(async (project) => {
      const uprojectPath = await findUprojectFile(project.projectPath)
      const base: EpicSetupProjectStatus = {
        connectionId: project.connectionId,
        projectName: project.projectName,
        state: 'unsupported',
        missingPlugins: [],
        autoStartEnabled: false,
        url: DEFAULT_EPIC_MCP_URL
      }

      if (!uprojectPath) return base

      const status = await inspectEpicMcpSetup(project, uprojectPath, false)
      // 引擎版本不够就不必探端口，省一次必然失败的连接
      if (status.state === 'unsupported') {
        return { ...status, connectionId: project.connectionId, projectName: project.projectName }
      }

      // 服务通了就是 ready，不用管 .uproject 里写了什么 —— 用户已经在用了
      const reachable = await probeEpicMcpServer(status.url)
      return {
        ...status,
        ...(reachable ? { state: 'ready' as const } : {}),
        connectionId: project.connectionId,
        projectName: project.projectName
      }
    })
  )
}

export interface EpicSetupApplyResult extends EpicSetupResult {
  /** 改完之后服务是不是已经在跑了 */
  running: boolean
  /** 给界面直接显示的一句话 */
  message: string
}

/**
 * 对某个项目执行一键。
 *
 * 顺序是「先改文件，再试着起服务」。起不来不算失败 —— 绝大多数情况下
 * 起不来的原因就是「插件刚写进去、还没重启」，那是预期之内的下一步，
 * 不是错误。
 */
export async function setupProject(connectionId: string): Promise<EpicSetupApplyResult> {
  const projects = await connectedProjects()
  const project = projects.find((p) => p.connectionId === connectionId)

  if (!project) {
    return {
      success: false,
      needsRestart: false,
      addedPlugins: [],
      wroteAutoStart: false,
      running: false,
      error: '项目已断开连接',
      message: '项目已断开连接，请重新在盒子里打开它。'
    }
  }

  const uprojectPath = await findUprojectFile(project.projectPath)
  if (!uprojectPath) {
    return {
      success: false,
      needsRestart: false,
      addedPlugins: [],
      wroteAutoStart: false,
      running: false,
      error: `在 ${project.projectPath} 里找不到 .uproject 文件`,
      message: '找不到项目文件，无法自动配置。'
    }
  }

  const result = await applyEpicMcpSetup(project, uprojectPath)
  if (!result.success) {
    return { ...result, running: false, message: result.error ?? '配置失败。' }
  }

  // 不用重启说明插件本来就加载着，那就直接把服务叫起来，省掉一次重启
  let running = false
  if (!result.needsRestart) {
    const { url } = await inspectEpicMcpSetup(project, uprojectPath, false)
    running = await startServerInEditor(url, connectionId)
  }

  return {
    ...result,
    running,
    message: buildMessage(result, running)
  }
}

function buildMessage(result: EpicSetupResult, running: boolean): string {
  if (running) return '已开启，虚幻引擎的工具集现在可以用了。'
  if (result.needsRestart) {
    const what =
      result.addedPlugins.length > 0 ? `已启用 ${result.addedPlugins.join('、')}` : '已配置'
    return `${what}。请重启虚幻引擎编辑器，重启后服务会自动运行。`
  }
  return '已配置，但服务没能自动启动。请重启虚幻引擎编辑器再试。'
}

/**
 * 让正在跑的编辑器立刻起 MCP 服务。
 *
 * 走 UnrealAgentLink 的控制台命令通道。插件模块没加载时这条命令会被 UE
 * 当成未知命令吞掉（不报错），所以调用方**不能拿返回值当成功凭据** ——
 * 真正的判据是随后探端口通不通。
 */
export async function startServerInEditor(
  url = DEFAULT_EPIC_MCP_URL,
  connectionId?: string
): Promise<boolean> {
  try {
    const { serviceManager } = await import('../../../services')
    const wsService = serviceManager.getWebSocketService()
    if (wsService.getConnectionCount() === 0) return false

    await wsService.callRequest<{ result?: string }>(
      'system.run_console_command',
      { command: 'ModelContextProtocol.StartServer' },
      connectionId,
      15_000
    )
  } catch (error) {
    console.warn('[AgentV3][MCP] 起 UE 官方服务失败:', (error as Error).message)
    return false
  }

  // UE 起 HTTP 监听要一会儿，探几次再判死
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (await probeEpicMcpServer(url)) return true
  }
  return false
}
