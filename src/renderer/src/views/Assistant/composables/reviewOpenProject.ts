import type { ComputedRef, InjectionKey } from 'vue'
import type { ChatSessionProject } from '@renderer/store/modules/chatSessions'
import { projectDirectory } from '@renderer/views/AssetManagement/utils/importProjectChoices'

/**
 * 审查时引擎没连上：替用户把这条对话的工程打开，连上后接着审查。
 *
 * 只认对话自己的工程 —— 没绑工程的对话、库里找不到 .uproject 的工程，
 * 都不知道该开哪个，照旧只说一句「引擎没连上」。
 */

/** 页面把当前对话的工程递给气泡 —— 气泡只看得见自己那一条消息 */
export const SESSION_PROJECT_KEY: InjectionKey<ComputedRef<ChatSessionProject | null>> =
  Symbol('sessionProject')

type ProjectRow = Pick<ProjectRecord, 'projectName' | 'projectPath' | 'originPath'>

/** 对话工程对应的 .uproject。先按目录对，对不上再按名字 —— 老对话可能只存了名字 */
export function findSessionUproject(
  project: ChatSessionProject | null | undefined,
  rows: ProjectRow[]
): string | null {
  if (!project?.projectName) return null
  const dir = projectDirectory(project.projectPath).toLowerCase()
  const withUproject = rows.filter((row) => /\.uproject$/i.test(row.originPath || ''))
  const byDir = dir
    ? withUproject.find(
        (row) => projectDirectory(row.projectPath || row.originPath).toLowerCase() === dir
      )
    : undefined
  const match = byDir ?? withUproject.find((row) => row.projectName === project.projectName)
  return match?.originPath || null
}

/** 这条对话的工程现在连着盒子没有 */
export function isSessionProjectConnected(
  project: ChatSessionProject | null | undefined,
  connected: Pick<ConnectedProject, 'projectName' | 'projectPath' | 'isConnected'>[]
): boolean {
  if (!project?.projectName) return false
  const dir = projectDirectory(project.projectPath).toLowerCase()
  return connected.some(
    (item) =>
      item.isConnected !== false &&
      (dir
        ? projectDirectory(item.projectPath).toLowerCase() === dir
        : item.projectName === project.projectName)
  )
}
