/**
 * 崩溃日志 IPC Handler
 * 提供给渲染进程读取 UE 项目崩溃日志的能力
 * 复用 Agent 工具中的文件系统读取逻辑
 */
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { projectManager } from '../../services/project'

/**
 * 崩溃报告数据结构
 */
interface CrashReport {
  timestamp: string
  error: string
  callStack: string
  logSnippet: string
  source: 'CrashContext' | 'LogFile'
}

/**
 * 简单的 XML 实体解码
 */
function decodeXML(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
}

/**
 * 截断文本以防止内容过长
 */
function truncate(str: string, maxLength: number): string {
  if (!str) return ''
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength) + `\n... (截断, 剩余 ${str.length - maxLength} 字符)`
}

/**
 * 验证路径是否为有效的 UE 项目目录
 */
function isValidProjectPath(dirPath: string): boolean {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return false
  }
  const files = fs.readdirSync(dirPath)
  return files.some((file) => file.endsWith('.uproject'))
}

/**
 * 尝试从多种来源获取项目路径
 */
function resolveProjectPath(providedPath?: string): string | null {
  // 1. 如果提供了路径，直接使用
  if (providedPath && isValidProjectPath(providedPath)) {
    return providedPath
  }

  // 2. 从 ProjectManager 获取已连接的项目
  const projects = projectManager.getInteractiveProjects()
  const connectedProject = projects.find((p) => p.projectPath)
  if (connectedProject?.projectPath && isValidProjectPath(connectedProject.projectPath)) {
    return connectedProject.projectPath
  }

  // 3. 从 WebSocket 连接的项目信息已经通过 projectManager 获取（在步骤 2 中处理）
  // WebSocketService 不直接提供项目列表接口

  // 4. 尝试从 ProjectManager 获取所有项目（包括离线的）
  for (const project of projects) {
    if (project.projectPath && isValidProjectPath(project.projectPath)) {
      return project.projectPath
    }
  }

  return null
}

/**
 * 获取崩溃日志
 * @param projectPath 可选的项目路径
 * @param maxLogs 最大日志数量
 */
async function getCrashLogs(
  projectPath?: string,
  maxLogs: number = 3
): Promise<{
  success: boolean
  reports?: CrashReport[]
  projectPath?: string
  message?: string
  error?: string
}> {
  const reports: CrashReport[] = []

  try {
    // 解析项目路径
    const resolvedPath = resolveProjectPath(projectPath)

    if (!resolvedPath) {
      return {
        success: false,
        error: '无法自动获取项目路径，请确保 UE 编辑器已连接或手动指定项目路径'
      }
    }

    // 验证路径有效性
    if (!isValidProjectPath(resolvedPath)) {
      return {
        success: false,
        error: `路径无效或不是有效的 UE 项目目录: ${resolvedPath}`
      }
    }

    // Limit constants
    const MAX_ERROR_LEN = 1000
    const MAX_STACK_LEN = 2000
    const MAX_LOG_SNIPPET_LEN = 3000

    const crashesDir = path.join(resolvedPath, 'Saved', 'Crashes')
    const logsDir = path.join(resolvedPath, 'Saved', 'Logs')

    // 检查 Crashes 目录
    if (fs.existsSync(crashesDir)) {
      const crashFolders = fs
        .readdirSync(crashesDir)
        .map((name) => path.join(crashesDir, name))
        .filter((fullPath) => fs.statSync(fullPath).isDirectory())
        .map((fullPath) => ({ path: fullPath, mtime: fs.statSync(fullPath).mtime }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, maxLogs)

      for (const crashFolder of crashFolders) {
        const xmlPath = path.join(crashFolder.path, 'CrashContext.runtime-xml')

        if (fs.existsSync(xmlPath)) {
          try {
            const xmlContent = fs.readFileSync(xmlPath, 'utf-8')
            const errorMatch = xmlContent.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/s)
            const stackMatch = xmlContent.match(/<CallStack>(.*?)<\/CallStack>/s)

            reports.push({
              timestamp: crashFolder.mtime.toISOString(),
              error: truncate(
                errorMatch ? decodeXML(errorMatch[1]) : '未找到错误信息',
                MAX_ERROR_LEN
              ),
              callStack: truncate(
                stackMatch ? decodeXML(stackMatch[1]) : '未找到调用堆栈',
                MAX_STACK_LEN
              ),
              logSnippet: '详情请查看完整日志文件',
              source: 'CrashContext'
            })
          } catch (e) {
            console.warn(`Error parsing crash log at ${xmlPath}:`, e)
          }
        }
      }
    }

    // 检查 Logs 目录（读取最新的日志）
    if (fs.existsSync(logsDir)) {
      const logFiles = fs
        .readdirSync(logsDir)
        .filter((name) => name.endsWith('.log'))
        .map((name) => path.join(logsDir, name))
        .map((fullPath) => ({ path: fullPath, mtime: fs.statSync(fullPath).mtime }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, 1)

      if (logFiles.length > 0) {
        const latestLog = logFiles[0]
        try {
          const stats = fs.statSync(latestLog.path)
          const fileSize = stats.size
          const readSize = Math.min(fileSize, 10 * 1024) // 最多读 10KB
          const buffer = Buffer.alloc(readSize)

          const fd = fs.openSync(latestLog.path, 'r')
          fs.readSync(fd, buffer, 0, readSize, fileSize - readSize)
          fs.closeSync(fd)

          const content = buffer.toString('utf-8')
          const lastLines = content.split('\n').slice(-50).join('\n')

          reports.push({
            timestamp: latestLog.mtime.toISOString(),
            error: '请查看下方日志片段',
            callStack: '请查看下方日志片段',
            logSnippet: truncate(lastLines, MAX_LOG_SNIPPET_LEN),
            source: 'LogFile'
          })
        } catch (e) {
          console.warn(`Error reading log file at ${latestLog.path}:`, e)
        }
      }
    }

    if (reports.length === 0) {
      return {
        success: true,
        message: '在 Saved/Crashes 和 Saved/Logs 中未发现崩溃记录',
        projectPath: resolvedPath
      }
    }

    return {
      success: true,
      reports,
      projectPath: resolvedPath,
      message: `成功获取 ${reports.length} 条相关日志记录`
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 注册崩溃日志相关的 IPC Handler
 */
export function registerCrashLogsIpc(): void {
  /**
   * 获取 UE 项目崩溃日志
   */
  ipcMain.handle(
    'ue:crashLogs:get',
    async (
      _,
      params: { projectPath?: string; maxLogs?: number }
    ): Promise<{
      success: boolean
      reports?: CrashReport[]
      projectPath?: string
      message?: string
      error?: string
    }> => {
      return getCrashLogs(params?.projectPath, params?.maxLogs || 3)
    }
  )
}
