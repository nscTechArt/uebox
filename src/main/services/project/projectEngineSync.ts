import type Database from 'better-sqlite3'
import { resolveProjectFilePath } from '../../ipc/projectImportPath'
import { updateProject, type ProjectRecord } from '../../sqliteDataBase/models/project'
import { readUeJsonFile } from '../../utils/ueTextFile'

/**
 * 从磁盘上的 `.uproject` 读当前的 EngineAssociation。
 *
 * 库里存的那份是**登记那一刻**抄下来的。用户在 Launcher 里右键把工程从 5.7
 * 切到 5.8，`.uproject` 立刻变了，库里那条还停在 5.7 —— 首页卡片显示旧版本，
 * 导入闸门拿旧版本比资产，会把 5.8 的资产拦在一个实际已经是 5.8 的工程外面。
 * 按 AGENTS.md 第 5 节第 10 条，磁盘文件才是事实，库只是索引。
 *
 * 读不到（工程目录被挪走、文件坏了）返回 null，调用方沿用库里的值 ——
 * 一个暂时不在的盘不应该把版本标签清成「未知」。
 */
export async function readEngineAssociationFromDisk(project: {
  originPath?: string | null
  projectPath?: string | null
}): Promise<string | null> {
  const uprojectPath = await resolveProjectFilePath(project)
  if (!uprojectPath) return null
  try {
    const data = await readUeJsonFile<{ EngineAssociation?: unknown }>(uprojectPath)
    return typeof data.EngineAssociation === 'string' ? data.EngineAssociation.trim() : ''
  } catch {
    return null
  }
}

/**
 * 把一批工程记录的 EngineAssociation 对齐到磁盘，变了的回写数据库。
 *
 * 每个工程一次文件读，几十个工程也就几毫秒；GUID → 版本号那一步不在这里做
 * （那要起 PowerShell），界面上照旧走 `resolveEngineAssociations` 的缓存。
 *
 * 就地改传入的记录并原样返回，调用方拿到的就是新值。
 *
 * @returns 传入的同一个数组，其中版本变了的记录已被更新
 */
export async function syncProjectEngineAssociations<T extends ProjectRecord>(
  db: Database.Database,
  projects: T[]
): Promise<T[]> {
  await Promise.all(
    projects.map(async (project) => {
      const onDisk = await readEngineAssociationFromDisk(project)
      if (onDisk === null) return
      const stored = String(project.EngineAssociation || '').trim()
      if (onDisk === stored) return
      try {
        updateProject(db, project.projectKey, { EngineAssociation: onDisk })
        project.EngineAssociation = onDisk
      } catch (error) {
        console.warn(
          `[projectEngineSync] 回写引擎版本失败: ${project.projectName || project.projectKey}`,
          error
        )
      }
    })
  )
  return projects
}
