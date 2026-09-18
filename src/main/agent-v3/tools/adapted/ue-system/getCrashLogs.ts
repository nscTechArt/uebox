import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { serviceManager } from '../../../../services'
import { projectManager } from '../../../../services/project'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
// Schema
const GetCrashLogsParamsSchema = z.object({
  projectPath: z
    .string()
    .optional()
    .describe(
      'Unreal Engine 项目的根目录路径（包含 .uproject 文件的文件夹）。如果未提供，将自动尝试多种方式获取：1) 当前连接的项目 2) 项目历史记录 3) 扫描常见位置'
    ),
  maxLogs: z.number().optional().default(1).describe('要获取的最近崩溃记录数量')
})

interface CrashReport {
  timestamp: string
  error: string
  callStack: string
  logSnippet: string
  source: 'CrashContext' | 'LogFile' | 'PluginRPC'
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
 * 截断文本以防止 Token 爆炸
 */
function truncate(str: string, maxLength: number): string {
  if (!str) return ''
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength) + `\n... (截断, 剩余 ${str.length - maxLength} 字符)`
}

/**
 * 从项目历史记录文件中读取最近的项目路径
 */
function getProjectHistory(): string[] {
  try {
    const userDataPath = app.getPath('userData')
    const historyFile = path.join(userDataPath, 'project-history.json')

    if (fs.existsSync(historyFile)) {
      const content = fs.readFileSync(historyFile, 'utf-8')
      const history = JSON.parse(content) as { projects: Array<{ path: string; lastUsed: number }> }
      return history.projects
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .map((p) => p.path)
        .filter((p) => fs.existsSync(p))
    }
  } catch {
    // 忽略错误，静默失败
  }
  return []
}

/**
 * 保存项目路径到历史记录
 */
function saveProjectToHistory(projectPath: string): void {
  try {
    const userDataPath = app.getPath('userData')
    const historyFile = path.join(userDataPath, 'project-history.json')

    let history: { projects: Array<{ path: string; lastUsed: number }> } = { projects: [] }

    if (fs.existsSync(historyFile)) {
      const content = fs.readFileSync(historyFile, 'utf-8')
      history = JSON.parse(content)
    }

    // 移除已存在的相同路径
    history.projects = history.projects.filter((p) => p.path !== projectPath)

    // 添加到开头
    history.projects.unshift({
      path: projectPath,
      lastUsed: Date.now()
    })

    // 只保留最近 20 个项目
    history.projects = history.projects.slice(0, 20)

    // 确保目录存在
    const dir = path.dirname(historyFile)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf-8')
  } catch {
    // 忽略错误，静默失败
  }
}

/**
 * 验证路径是否为有效的 UE 项目目录
 */
function isValidProjectPath(dirPath: string): boolean {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return false
  }

  // 检查是否包含 .uproject 文件
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

  // 3. 从历史记录中获取
  const history = getProjectHistory()
  for (const historyPath of history) {
    if (isValidProjectPath(historyPath)) {
      return historyPath
    }
  }

  // 4. 尝试从 ProjectManager 获取所有项目（包括离线的）
  for (const project of projects) {
    if (project.projectPath && isValidProjectPath(project.projectPath)) {
      return project.projectPath
    }
  }

  return null
}

export function createGetCrashLogsTool(): V2Tool {
  return defineV2Tool({
    description: `获取虚幻引擎项目的崩溃日志。

【功能】：
1. 优先尝试通过插件连接获取实时崩溃/报错信息（如果编辑器还活着）。
2. 读取 Saved/Crashes 目录下的最新崩溃报告（XML）。
3. 读取 Saved/Logs 目录下的最新日志文件。
4. 自动截断过长的日志堆栈，防止 Token 溢出。

【使用场景】：
- 当用户询问“为什么项目崩了”、“查看崩溃日志”时使用
- 需要用户提供项目根目录路径`,

    inputSchema: GetCrashLogsParamsSchema,

    execute: async ({ projectPath, maxLogs = 1 }) => {
      const reports: CrashReport[] = []

      try {
        // 尝试从多种来源解析项目路径
        const resolvedPath = resolveProjectPath(projectPath)

        if (!resolvedPath) {
          // 提供详细的错误信息和解决建议
          const suggestions = [
            '1. 手动提供项目路径参数（项目根目录，包含 .uproject 文件）',
            '2. 打开虚幻引擎编辑器并连接到应用',
            '3. 确保项目路径正确且包含 .uproject 文件'
          ]

          return {
            success: false,
            error: '无法自动获取项目路径。请尝试以下方法：',
            suggestions: suggestions,
            help: '崩溃日志通常位于项目的 Saved/Crashes 和 Saved/Logs 目录下。请提供项目根目录路径（包含 .uproject 文件的文件夹）以继续分析。'
          }
        }

        // 验证路径有效性
        if (!isValidProjectPath(resolvedPath)) {
          return {
            success: false,
            error: `路径无效或不是有效的 UE 项目目录: ${resolvedPath}`,
            help: '请确保路径指向包含 .uproject 文件的项目根目录'
          }
        }

        // 保存到历史记录
        saveProjectToHistory(resolvedPath)

        // Limit constants
        const MAX_ERROR_LEN = 1000
        const MAX_STACK_LEN = 2000
        const MAX_LOG_SNIPPET_LEN = 3000

        // 1. 尝试通过插件获取（如果在线）
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() > 0) {
          try {
            // 尝试调用插件 RPC 获取最近的 Crash/Error 信息
            // 注意：这依赖于插件侧实现了 system.get_latest_crash_info 协议
            // 如果插件未实现，会抛错或返回空，我们捕获后降级到读文件
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rpcResponse = await wsService.callRequest<any>(
              'system.get_latest_crash_info',
              {},
              getTargetConnectionId(),
              2000 // 快速超时，避免阻塞
            )

            if (rpcResponse && rpcResponse.success && rpcResponse.data) {
              reports.push({
                timestamp: new Date().toISOString(),
                error: truncate(rpcResponse.data.error || 'Unknown Error (Plugin)', MAX_ERROR_LEN),
                callStack: truncate(rpcResponse.data.callStack || '', MAX_STACK_LEN),
                logSnippet: truncate(rpcResponse.data.log || '', MAX_LOG_SNIPPET_LEN),
                source: 'PluginRPC'
              })
              // 如果插件返回了信息，可能不需要再读历史文件了，或者仍然补充？
              // 策略：如果插件返回了有效 ERROR，就以此为主
              if (reports.length > 0 && reports[0].error) {
                return {
                  success: true,
                  reports,
                  projectPath: resolvedPath,
                  message: '成功从插件获取到最新崩溃/报错信息'
                }
              }
            }
          } catch {
            // RPC 调用失败是预期的（如果插件没实现），忽略并继续读文件
            // console.debug('Plugin fetch failed, falling back to file system', e)
          }
        }

        // 2. 文件系统回退逻辑
        const crashesDir = path.join(resolvedPath, 'Saved', 'Crashes')
        const logsDir = path.join(resolvedPath, 'Saved', 'Logs')

        // 2a. 检查 Crashes 目录
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
                // 简单正则提取
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

        // 2b. 检查 Logs 目录 (读取最新的日志)
        if (fs.existsSync(logsDir)) {
          const logFiles = fs
            .readdirSync(logsDir)
            .filter((name) => name.endsWith('.log'))
            .map((name) => path.join(logsDir, name))
            .map((fullPath) => ({ path: fullPath, mtime: fs.statSync(fullPath).mtime }))
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
            .slice(0, 1) // 只取最新的一个日志文件作为参考

          if (logFiles.length > 0) {
            const latestLog = logFiles[0]
            try {
              // 读取文件最后 N 字节，避免读取整个大文件
              const stats = fs.statSync(latestLog.path)
              const fileSize = stats.size
              const readSize = Math.min(fileSize, 10 * 1024) // 最多读 10KB
              const buffer = Buffer.alloc(readSize)

              const fd = fs.openSync(latestLog.path, 'r')
              fs.readSync(fd, buffer, 0, readSize, fileSize - readSize)
              fs.closeSync(fd)

              const content = buffer.toString('utf-8')
              // 只需要最后的行
              const lastLines = content.split('\n').slice(-50).join('\n') // 取最后 50 行

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
            message: '在 Saved/Crashes 和 Saved/Logs 中未发现明显的崩溃记录',
            projectPath: resolvedPath
          }
        }

        // 「读了日志尾巴」和「真的崩过」必须分清楚。
        //
        // 没有崩溃记录时会退回读当前运行日志的最后 50 行，那条目的 error 字段
        // 是「请查看下方日志片段」—— 形状和真崩溃报告一模一样。
        // 调用方问「有没有崩溃过」，拿到的永远是「有一条」，于是把正常的
        // 运行日志当成崩溃去分析。真机上就是这样：引擎跑得好好的，
        // 工具报了一条「崩溃」，内容是我自己的 WebSocket 重连日志。
        const realCrashes = reports.filter((r) => r.source !== 'LogFile')
        const onlyLogTail = realCrashes.length === 0 && reports.length > 0

        return {
          success: true,
          reports,
          crash_report_count: realCrashes.length,
          projectPath: resolvedPath,
          message: onlyLogTail
            ? '没有找到任何崩溃报告（Saved/Crashes 为空）。下面附的是当前运行日志的最后几十行，' +
              '仅供排查参考 —— **不要**把它当成崩溃来分析或向用户汇报。'
            : realCrashes.length > 0
              ? `找到 ${realCrashes.length} 条崩溃报告。`
              : '没有找到任何崩溃报告，也没有可读的日志。'
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
