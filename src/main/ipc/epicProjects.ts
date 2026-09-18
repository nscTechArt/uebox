/**
 * Epic Projects IPC Module
 * 读取Epic Launcher引擎配置中的最近打开项目列表
 */
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { decodeUeText } from '../utils/ueTextFile'
import { getPublicDatabase } from '../sqliteDataBase'
import { projectExistsByPath } from '../sqliteDataBase/models/project'

/**
 * 最近打开的项目信息
 */
export interface RecentProject {
  /** 项目路径 (.uproject 文件完整路径) */
  projectPath: string
  /** 项目名称 (从路径提取) */
  projectName: string
  /** 引擎版本 (如 5.3, 4.27) */
  engineVersion: string
  /** 最后打开时间 (ISO 格式) */
  lastOpenTime: string
  /** 是否已导入到项目管理 */
  isImported: boolean
  /** 项目缩略图路径 (可选) */
  thumbnailPath?: string
}

/**
 * 解析 EditorSettings.ini 中的 RecentlyOpenedProjectFiles 条目
 * @param content ini文件内容
 * @returns 解析出的项目列表
 */
function parseRecentlyOpenedProjects(
  content: string,
  engineVersion: string
): Omit<RecentProject, 'isImported'>[] {
  const projects: Omit<RecentProject, 'isImported'>[] = []

  // 匹配格式: RecentlyOpenedProjectFiles=(ProjectName="xxx.uproject",LastOpenTime=2025.09.11-02.17.54)
  const regex =
    /RecentlyOpenedProjectFiles=\(ProjectName="([^"]+)",LastOpenTime=(\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2})\)/g

  let match
  while ((match = regex.exec(content)) !== null) {
    const projectPath = match[1]
    const lastOpenTimeRaw = match[2] // 格式: 2025.09.11-02.17.54

    // 转换时间格式为 ISO
    const [datePart, timePart] = lastOpenTimeRaw.split('-')
    const [year, month, day] = datePart.split('.')
    const [hour, minute, second] = timePart.split('.')
    const lastOpenTime = `${year}-${month}-${day}T${hour}:${minute}:${second}`

    // 提取项目名称
    const projectName = path.basename(projectPath, '.uproject')

    projects.push({
      projectPath,
      projectName,
      engineVersion,
      lastOpenTime
    })
  }

  return projects
}

/**
 * 获取所有引擎版本的最近打开项目
 */
export async function getRecentProjectsFromAllEngines(
  options: { platform?: NodeJS.Platform; home?: string; localAppData?: string } = {}
): Promise<RecentProject[]> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? os.homedir()
  const localAppData =
    options.localAppData ?? process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  const unrealEngineDir =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Epic', 'UnrealEngine')
      : path.join(localAppData, 'UnrealEngine')
  const configFolders = platform === 'darwin' ? ['MacEditor', 'Mac'] : ['WindowsEditor']

  // 检查目录是否存在
  if (!fs.existsSync(unrealEngineDir)) {
    console.log('[epicProjects] UnrealEngine目录不存在:', unrealEngineDir)
    return []
  }

  const allProjects: RecentProject[] = []
  const db = getPublicDatabase()

  try {
    // 读取所有版本目录
    const entries = fs.readdirSync(unrealEngineDir, { withFileTypes: true })
    const versionDirs = entries
      .filter((e) => e.isDirectory())
      .filter((e) => /^\d+\.\d+/.test(e.name)) // 匹配版本号格式如 5.3, 4.27
      .map((e) => e.name)

    console.log('[epicProjects] 发现引擎版本:', versionDirs)

    for (const version of versionDirs) {
      const iniPaths = configFolders.map((folder) =>
        path.join(unrealEngineDir, version, 'Saved', 'Config', folder, 'EditorSettings.ini')
      )
      const iniPath = iniPaths.find((candidate) => fs.existsSync(candidate))

      if (!iniPath) {
        console.log(`[epicProjects] 版本 ${version} 的配置文件不存在:`, iniPaths)
        continue
      }

      try {
        const content = decodeUeText(fs.readFileSync(iniPath))
        const projects = parseRecentlyOpenedProjects(content, version)

        // 检查每个项目是否已导入
        for (const proj of projects) {
          // 检查项目文件是否存在
          if (!fs.existsSync(proj.projectPath)) {
            console.log(`[epicProjects] 项目文件不存在，跳过:`, proj.projectPath)
            continue
          }

          // 检查是否已导入到项目管理
          // 注意：数据库中存储的是项目目录路径（projectPath），不是.uproject文件路径
          const projectDir = path.dirname(proj.projectPath)
          const isImported = projectExistsByPath(db, projectDir)

          // 检查项目缩略图是否存在 - 参考项目导入逻辑
          // 优先同名png，其次 Saved/AutoScreenshot.png
          const projectName = path.basename(proj.projectPath, '.uproject')
          const sameNamePng = path.join(projectDir, `${projectName}.png`)
          const autoShot = path.join(projectDir, 'Saved', 'AutoScreenshot.png')

          let thumbnailPath: string | undefined
          if (fs.existsSync(sameNamePng)) {
            thumbnailPath = sameNamePng
          } else if (fs.existsSync(autoShot)) {
            thumbnailPath = autoShot
          }

          allProjects.push({
            ...proj,
            isImported,
            thumbnailPath
          })
        }
      } catch (err) {
        console.error(`[epicProjects] 读取版本 ${version} 配置失败:`, err)
      }
    }

    // 排序：未导入的在前，已导入的在后；同类按最后打开时间排序（最近的在前）
    allProjects.sort((a, b) => {
      // 先按导入状态排序
      if (a.isImported !== b.isImported) {
        return a.isImported ? 1 : -1
      }
      // 同类按时间排序
      return new Date(b.lastOpenTime).getTime() - new Date(a.lastOpenTime).getTime()
    })

    console.log(`[epicProjects] 共发现 ${allProjects.length} 个最近打开的项目`)
    return allProjects
  } catch (err) {
    console.error('[epicProjects] 获取最近项目失败:', err)
    return []
  }
}

/**
 * 注册Epic Projects相关的IPC处理函数
 */
export function registerEpicProjectsIPC(): void {
  /**
   * 获取所有引擎版本的最近打开项目列表
   */
  ipcMain.handle('epic:getRecentProjects', async () => {
    try {
      const projects = await getRecentProjectsFromAllEngines()
      return {
        success: true,
        projects
      }
    } catch (err) {
      console.error('[epic:getRecentProjects] 失败:', err)
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        projects: []
      }
    }
  })

  console.log('[epicProjects] IPC handlers registered')
}
