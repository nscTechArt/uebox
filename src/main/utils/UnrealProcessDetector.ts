/**
 * UnrealProcessDetector - 检测当前运行的虚幻引擎项目
 *
 * Windows 使用 PowerShell，macOS 使用 ps 与 lsof 读取编辑器进程及项目路径。
 */

import { exec } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { promisify } from 'util'
import { getMacEditorProjects, listMacEditorProcesses } from './macUnrealProcesses'

const execAsync = promisify(exec)

/**
 * 运行中的虚幻项目信息
 */
export interface RunningUnrealProject {
  /** 进程ID */
  pid: number
  /** 进程名称 */
  processName: string
  /** 项目文件完整路径 (.uproject) */
  projectPath: string
  /** 项目名称 (不含扩展名) */
  projectName: string
  /** 项目目录 */
  projectDir: string
  /** 引擎版本 (从 uproject 文件解析) */
  engineVersion?: string
}

/**
 * uproject 文件结构
 */
interface UProjectFile {
  FileVersion?: number
  EngineAssociation?: string
  Category?: string
  Description?: string
}

/**
 * 虚幻引擎进程检测器
 */
const UnrealProcessDetector = {
  /**
   * 获取当前运行的所有虚幻引擎项目
   * @returns Promise<RunningUnrealProject[]> 运行中的项目列表
   */
  async getRunningProjects(): Promise<RunningUnrealProject[]> {
    try {
      if (process.platform === 'darwin') {
        return await Promise.all(
          (await getMacEditorProjects()).map(async (editor) => ({
            pid: editor.pid,
            processName: editor.processName,
            projectPath: editor.projectPath,
            projectName: path.basename(editor.projectPath, path.extname(editor.projectPath)),
            projectDir: path.dirname(editor.projectPath),
            engineVersion: await this.getEngineVersionFromProject(editor.projectPath)
          }))
        )
      }
      // 使用 PowerShell 获取 UnrealEditor.exe 进程及其命令行参数
      // 使用 Base64 编码命令以避免引号转义问题
      const psCommand = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'"|Select-Object ProcessId,Name,CommandLine|ConvertTo-Json -Compress`
      const encodedCommand = Buffer.from(psCommand, 'utf16le').toString('base64')

      const { stdout } = await execAsync(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`,
        {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        }
      )

      if (!stdout || stdout.trim() === '' || stdout.trim() === 'null') {
        return []
      }

      // 解析 JSON 输出，清理可能的换行和多余空格
      const cleanedStdout = stdout
        .trim()
        .replace(/\r?\n/g, '')
        .replace(/\s{2,}/g, ' ')

      const parsed = JSON.parse(cleanedStdout)
      // PowerShell 返回单个对象时不是数组，需要处理
      const processes: Array<{
        ProcessId: number
        Name: string
        CommandLine: string
      }> = Array.isArray(parsed) ? parsed : [parsed]

      // 清理每个进程的命令行字符串中的额外空白
      for (const proc of processes) {
        if (proc.CommandLine) {
          proc.CommandLine = proc.CommandLine.replace(/\r?\n/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
        }
      }

      const projects: RunningUnrealProject[] = []

      for (const proc of processes) {
        if (!proc.CommandLine) continue

        // 从命令行参数中提取 .uproject 文件路径
        const projectPath = this.extractProjectPath(proc.CommandLine)

        if (projectPath && fs.existsSync(projectPath)) {
          const projectName = path.basename(projectPath, '.uproject')
          const projectDir = path.dirname(projectPath)

          // 尝试读取引擎版本
          const engineVersion = await this.getEngineVersionFromProject(projectPath)

          projects.push({
            pid: proc.ProcessId,
            processName: proc.Name,
            projectPath,
            projectName,
            projectDir,
            engineVersion
          })
        }
      }

      return projects
    } catch (error) {
      console.error('[UnrealProcessDetector] 获取运行中项目失败:', error)
      return []
    }
  },

  /**
   * 从命令行参数中提取 .uproject 文件路径
   * @param commandLine 进程命令行
   * @returns 项目路径或 null
   */
  extractProjectPath(commandLine: string): string | null {
    if (!commandLine) return null

    // 匹配 .uproject 文件路径
    // 支持带引号和不带引号的路径格式
    const patterns = [
      // 匹配带引号的完整路径: "C:\path\to\project.uproject"
      /"([^"]+\.uproject)"/i,
      // 匹配不带引号的路径，直到遇到空格或参数
      /([a-zA-Z]:\\[^\s"]+\.uproject)/i,
      // 匹配相对路径
      /([^\s"]+\.uproject)/i
    ]

    for (const pattern of patterns) {
      const match = commandLine.match(pattern)
      if (match && match[1]) {
        const projectPath = match[1]
        // 规范化路径
        return path.normalize(projectPath)
      }
    }

    return null
  },

  /**
   * 从 .uproject 文件读取引擎版本
   * @param projectPath 项目文件路径
   * @returns 引擎版本字符串或 undefined
   */
  async getEngineVersionFromProject(projectPath: string): Promise<string | undefined> {
    try {
      const content = await fs.promises.readFile(projectPath, 'utf8')
      const uproject: UProjectFile = JSON.parse(content)
      return uproject.EngineAssociation
    } catch {
      return undefined
    }
  },

  /**
   * 检查是否有虚幻引擎正在运行
   * @returns Promise<boolean>
   */
  async isUnrealEditorRunning(): Promise<boolean> {
    try {
      if (process.platform === 'darwin') {
        return (await listMacEditorProcesses()).length > 0
      }
      const command = `
        Get-Process -Name "UnrealEditor" -ErrorAction SilentlyContinue |
        Measure-Object |
        Select-Object -ExpandProperty Count
      `

      const { stdout } = await execAsync(`powershell -NoProfile -Command "${command}"`, {
        encoding: 'utf8'
      })

      const count = parseInt(stdout.trim(), 10)
      return count > 0
    } catch {
      return false
    }
  },

  /**
   * 根据项目名称查找运行中的项目
   * @param projectName 项目名称（不含扩展名）
   * @returns Promise<RunningUnrealProject | null>
   */
  async findRunningProjectByName(projectName: string): Promise<RunningUnrealProject | null> {
    const projects = await this.getRunningProjects()
    return projects.find((p) => p.projectName.toLowerCase() === projectName.toLowerCase()) || null
  },

  /**
   * 根据项目路径查找运行中的项目
   * @param projectPath 项目文件路径
   * @returns Promise<RunningUnrealProject | null>
   */
  async findRunningProjectByPath(projectPath: string): Promise<RunningUnrealProject | null> {
    if (process.platform === 'darwin') {
      // lsof reports physical paths (/private/var vs /var); compare actual files.
      const target = await fs.promises.realpath(projectPath).catch(() => null)
      if (!target) return null
      for (const project of await this.getRunningProjects()) {
        const actual = await fs.promises.realpath(project.projectPath).catch(() => null)
        if (actual === target) return project
      }
      return null
    }
    const normalizedPath = path.normalize(projectPath).toLowerCase()
    const projects = await this.getRunningProjects()
    return (
      projects.find((p) => path.normalize(p.projectPath).toLowerCase() === normalizedPath) || null
    )
  },

  /**
   * 获取主要运行的项目（如果有多个，返回第一个）
   * @returns Promise<RunningUnrealProject | null>
   */
  async getPrimaryRunningProject(): Promise<RunningUnrealProject | null> {
    const projects = await this.getRunningProjects()
    return projects.length > 0 ? projects[0] : null
  }
}

export default UnrealProcessDetector
