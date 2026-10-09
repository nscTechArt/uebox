/**
 * 顶栏状态监控按钮的数据。
 *
 * 渲染层只知道这条对话归属哪个工程（路径），不知道连接 id —— 在这里按路径找连接。
 * 比路径用 projectPathKey 那把唯一的尺子：对话里记的可能是 .uproject，
 * 插件报上来的是工程目录。
 */

import { ipcMain } from 'electron'
import { projectManager } from '../services/project'
import { fetchEditorHealth, type EditorHealthResult } from '../services/editorHealth'
import { isSameProjectPath } from '../agent-v3/core/projectPathKey'

export function registerEditorHealthIPC(): void {
  ipcMain.handle(
    'ue:editorHealth:get',
    async (_, params: { projectPath?: string }): Promise<EditorHealthResult> => {
      const projectPath = params?.projectPath
      if (!projectPath) return { status: 'not_connected' }
      const connection = projectManager
        .getInteractiveProjects()
        .find((p) => isSameProjectPath(p.projectPath, projectPath))
      if (!connection) return { status: 'not_connected' }
      return fetchEditorHealth(connection.connectionId)
    }
  )
}
