/**
 * 编辑器看护（`core/team/editorWatch.ts`）接到真实的服务上。
 *
 * 看护本身不碰任何服务，这里把它要的几样东西一一接上：WebSocket 事件、
 * 已连接工程、编辑器进程、打开工程、等插件连回来、读崩溃报告。
 */

import { shell } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

import { awaitProjectLive } from '../agent-v3/tools/adapted/project/awaitProjectLive'
import { watchEditorCrashes, type EditorWatchOptions } from '../agent-v3/core/team/editorWatch'
import { serviceManager } from '../services'
import { projectManager } from '../services/project'
import { ensureUnrealAgentLinkPlugin } from '../sqliteDataBase/ipc/project'
import UnrealProcessDetector from '../utils/UnrealProcessDetector'

/** 重开之后最多等插件多久。大工程冷启动（着色器编译）要好几分钟 */
const RECONNECT_WAIT_MS = 8 * 60_000

async function findUproject(projectDir: string): Promise<string | null> {
  try {
    const name = (await fs.readdir(projectDir)).find((entry) => entry.endsWith('.uproject'))
    return name ? join(projectDir, name) : null
  } catch {
    return null
  }
}

/**
 * 开跑之后新出现的那次崩溃写了什么。`Saved/Crashes/<目录>/CrashContext.runtime-xml`
 * 里的 `ErrorMessage` 就是编辑器崩溃弹窗上那句话。
 */
async function crashReason(projectDir: string, since: number): Promise<string | null> {
  const root = join(projectDir, 'Saved', 'Crashes')
  let newest: { dir: string; at: number } | undefined
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const at = (await fs.stat(dir)).mtimeMs
    if (at >= since && (!newest || at > newest.at)) newest = { dir, at }
  }
  if (!newest) return null
  const xml = await fs
    .readFile(join(newest.dir, 'CrashContext.runtime-xml'), 'utf8')
    .catch(() => '')
  const message = /<ErrorMessage>([\s\S]*?)<\/ErrorMessage>/.exec(xml)?.[1]?.trim()
  return message ? message.slice(0, 400) : null
}

export function startTeamEditorWatch(
  isOurs: (projectDir: string) => boolean,
  options: EditorWatchOptions
): () => void {
  const ws = serviceManager.getWebSocketService()
  return watchEditorCrashes(
    {
      onEvent: (method, callback) => ws.onEvent(method, callback),
      connectedProjects: () =>
        projectManager
          .getInteractiveProjects()
          .map((p) => ({ connectionId: p.connectionId, projectPath: p.projectPath })),
      findUproject,
      isRunning: async (uproject) =>
        (await UnrealProcessDetector.findRunningProjectByPath(uproject)) !== null,
      reopen: async (uproject) => {
        await ensureUnrealAgentLinkPlugin(uproject)
        const error = await shell.openPath(uproject)
        if (error) throw new Error(error)
      },
      waitLive: async (projectDir) =>
        (await awaitProjectLive({ projectPath: projectDir, timeoutMs: RECONNECT_WAIT_MS })).live,
      crashReason,
      isOurs
    },
    options
  )
}
