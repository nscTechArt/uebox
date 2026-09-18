/**
 * 工程管理器
 * 维护已连接的 Unreal Engine 工程全局列表
 */
import { sendToAppWindows } from '../../appWindows'
import { ProjectInfo, ProjectInfoResponse } from './types'
import { logger } from '../logger'

/**
 * 工程管理器类
 * 负责管理通过 WebSocket 连接的所有 UE 工程项目
 */
export class ProjectManager {
  /** 工程列表：connectionId -> ProjectInfo */
  private projects = new Map<string, ProjectInfo>()

  /**
   * 归一化插件名列表：
   * - 优先使用 enabledPluginNames（插件侧提供）
   * - 否则从 enabledPlugins 兼容解析（string[] 或 {name}[]）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private normalizeEnabledPluginNames(info: any): string[] {
    const namesFromField = info?.enabledPluginNames
    if (Array.isArray(namesFromField) && namesFromField.every((x) => typeof x === 'string')) {
      return namesFromField
    }

    const plugins = info?.enabledPlugins
    if (!Array.isArray(plugins)) return []

    if (plugins.every((x) => typeof x === 'string')) {
      return plugins as string[]
    }

    return (plugins as Array<{ name?: unknown }>)
      .map((p) => (typeof p?.name === 'string' ? p.name : ''))
      .filter((x) => x.length > 0)
  }

  /**
   * 添加或更新工程信息
   * @param connectionId WebSocket 连接 ID
   * @param info 工程信息响应
   */
  addProject(connectionId: string, info: ProjectInfoResponse): void {
    const projectInfo: ProjectInfo = {
      connectionId,
      projectName: info.projectName || 'Unknown',
      projectVersion: info.projectVersion || '0.0.0',
      engineVersion: info.engineVersion || 'Unknown',
      projectPath: info.projectPath || '',
      defaultMap: info.defaultMap || '',
      enabledPlugins: this.normalizeEnabledPluginNames(info),
      connectedAt: Date.now(),
      isConnected: true,
      // `!== false` 而不是 `=== true`：旧插件不发这个字段，那时候只有交互式
      // 编辑器会连上来，按 true 处理才是「行为不变」
      interactive: info.interactive !== false,
      ...(info.runMode ? { runMode: info.runMode } : {})
    }

    this.projects.set(connectionId, projectInfo)
    logger.info(
      `[ProjectManager] 工程已添加: ${projectInfo.projectName} (${connectionId}), 引擎版本: ${projectInfo.engineVersion}` +
        // 无头进程一定要在日志里认出来 —— 否则下次又是「盒子说连着、用户说没开」
        // 的对峙，而日志里两种连接长得一模一样
        (projectInfo.interactive
          ? ''
          : `, 运行模式: ${projectInfo.runMode || '非交互'}（不计入当前工程）`)
    )

    // 通知渲染进程工程列表变化
    this.notifyProjectsChanged()
  }

  /**
   * 移除工程 (改为标记为离线)
   * @param connectionId WebSocket 连接 ID
   * @returns 是否成功更新状态
   */
  removeProject(connectionId: string): boolean {
    const project = this.projects.get(connectionId)
    if (project) {
      // 逻辑移除：保留信息，但标记为断开
      project.isConnected = false
      logger.info(`[ProjectManager] 工程已标记为离线: ${project.projectName} (${connectionId})`)

      // 通知渲染进程工程列表变化
      this.notifyProjectsChanged()
      return true
    }
    return false
  }

  /**
   * 删除工程（真正从列表中移除）
   * 当收到 project.closed 事件时调用
   * @param connectionId WebSocket 连接 ID
   * @returns 是否成功删除
   */
  deleteProject(connectionId: string): boolean {
    const project = this.projects.get(connectionId)
    if (project) {
      this.projects.delete(connectionId)
      logger.info(`[ProjectManager] 工程已删除: ${project.projectName} (${connectionId})`)

      // 通知渲染进程工程列表变化
      this.notifyProjectsChanged()
      return true
    }
    return false
  }

  /**
   * 获取指定连接的工程信息
   * @param connectionId WebSocket 连接 ID
   */
  getProject(connectionId: string): ProjectInfo | undefined {
    return this.projects.get(connectionId)
  }

  /**
   * 获取所有已连接的工程列表
   */
  getAllProjects(): ProjectInfo[] {
    return Array.from(this.projects.values())
  }

  /**
   * 用户真正打开着的工程 —— 连着、而且那头是个能看能点的编辑器。
   *
   * 这是「哪些工程算连着」的**唯一**判据，界面和 Agent 都该问它，
   * 而不是各自去 filter 一遍 `isConnected`：漏掉 `interactive` 的那一处，
   * 就是无头进程重新冒充成当前工程的地方。
   */
  getInteractiveProjects(): ProjectInfo[] {
    return this.getAllProjects().filter((p) => p.isConnected && p.interactive !== false)
  }

  /**
   * 连着、但不是交互式编辑器的那些（commandlet、-unattended、-nullrhi 跑批）。
   *
   * 单独列出来是给「有没有引擎连着」那个判断用的：套接字数里含着它们，
   * 减掉之后剩下的才是用户视角的连接。
   */
  getNonInteractiveProjects(): ProjectInfo[] {
    return this.getAllProjects().filter((p) => p.isConnected && p.interactive === false)
  }

  /**
   * 获取当前打开的项目（仅返回已连接、且是交互式编辑器的项目）
   * @returns 当前打开的项目信息，如果没有则返回 undefined
   */
  getCurrentProject(): ProjectInfo | undefined {
    const connectedProjects = this.getInteractiveProjects()
    if (connectedProjects.length > 0) {
      // 如果有多个已连接的项目，返回最近连接的那个
      return connectedProjects.sort((a, b) => b.connectedAt - a.connectedAt)[0]
    }

    return undefined
  }

  /**
   * 根据 projectPath 查找 connectionId
   * 仅匹配在线、且是交互式编辑器的项目
   * @param projectPath 项目路径
   * @returns 匹配的 connectionId，找不到返回 undefined
   */
  getConnectionIdByPath(projectPath: string): string | undefined {
    return this.getInteractiveProjects().find((info) => info.projectPath === projectPath)
      ?.connectionId
  }

  /**
   * 获取所有已连接项目的摘要信息（供 Agent 系统提示注入）
   * @returns 已连接项目的精简信息数组
   */
  getConnectedProjectSummaries(): Array<{
    projectName: string
    projectPath: string
    engineVersion: string
    connectionId: string
  }> {
    return this.getInteractiveProjects().map((p) => ({
      projectName: p.projectName,
      projectPath: p.projectPath,
      engineVersion: p.engineVersion,
      connectionId: p.connectionId
    }))
  }

  /**
   * 检查指定连接是否有对应的工程
   * @param connectionId WebSocket 连接 ID
   */
  hasProject(connectionId: string): boolean {
    return this.projects.has(connectionId)
  }

  /**
   * 获取工程数量
   */
  getProjectCount(): number {
    return this.projects.size
  }

  /**
   * 清空所有工程
   */
  clear(): void {
    this.projects.clear()
    logger.info('[ProjectManager] 所有工程已清空')
    this.notifyProjectsChanged()
  }

  /**
   * 通知渲染进程工程列表发生变化。
   *
   * 只发交互式的那些。界面上「已连接」这三个字对用户的含义是「这个工程我开着」——
   * 一个跑批的 commandlet 满足不了这句话，把它算进去等于让首页的绿点说谎。
   * 需要看无头连接的场合只有排查，日志里有。
   */
  private notifyProjectsChanged(): void {
    sendToAppWindows('ws:projects-changed', this.getInteractiveProjects())
  }
}

// 创建全局单例
export const projectManager = new ProjectManager()
