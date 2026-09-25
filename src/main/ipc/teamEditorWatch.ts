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
import { projectPathKey } from '../agent-v3/core/projectPathKey'
import { serviceManager } from '../services'
import { INSPECT_DEADLINE_MS, recentEditorCrashes } from '../services/editorCrashWatch/watch'
import { projectManager } from '../services/project'
import UnrealProcessDetector from '../utils/UnrealProcessDetector'

/**
 * 装插件那一步按需再加载：它所在的模块一加载就要连数据库、读应用设置，
 * 静态引进来会让只想测 IPC 的单测也得先搭一整套 electron 环境。
 */
async function ensurePlugin(uproject: string): Promise<void> {
  const { ensureUnrealAgentLinkPlugin } = await import('../sqliteDataBase/ipc/project')
  await ensureUnrealAgentLinkPlugin(uproject)
}

/** 重开之后最多等插件多久。大工程冷启动（着色器编译）要好几分钟 */
const RECONNECT_WAIT_MS = 8 * 60_000

/** 等盒子看门人下结论最多多久：它自己最多查 30 秒，留点余量 */
const CRASH_VERDICT_WAIT_MS = INSPECT_DEADLINE_MS + 10_000

/**
 * 盒子看门人对这次崩溃的处理结果（见 `EditorWatchDeps.crashHandledElsewhere`）。
 * 用户关了「编辑器崩溃后自动重开」时，工作室模式也不重开 —— 那是用户的设置。
 */
async function crashHandledElsewhere(
  projectDir: string,
  since: number
): Promise<'reopening' | { declined: string } | null> {
  const { appSettingsManager } = await import('../appSettingsManager')
  if (!appSettingsManager.getAutoRecoverEditorCrash()) {
    return { declined: '用户在设置里关了「编辑器崩溃后自动重开」，需要用户自己打开工程' }
  }
  const key = projectPathKey(projectDir)
  const deadline = Date.now() + CRASH_VERDICT_WAIT_MS
  for (;;) {
    const crash = recentEditorCrashes().find(
      (c) => c.at >= since && projectPathKey(c.editor.projectDir) === key
    )
    if (crash) {
      switch (crash.relaunch) {
        case 'relaunched':
        case 'already_running':
          return 'reopening'
        case 'crash_loop':
          return { declined: '5 分钟内又崩了一次，不再自动重开，需要人看一眼' }
        case 'no_uproject':
          return { declined: '找不到工程的 .uproject，没法重开' }
        case 'failed':
          return { declined: `重开失败：${crash.relaunchError ?? '原因未知'}` }
        default:
          return { declined: '用户在设置里关了「编辑器崩溃后自动重开」，需要用户自己打开工程' }
      }
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

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
        await ensurePlugin(uproject)
        const error = await shell.openPath(uproject)
        if (error) throw new Error(error)
      },
      waitLive: async (projectDir) =>
        (await awaitProjectLive({ projectPath: projectDir, timeoutMs: RECONNECT_WAIT_MS })).live,
      crashReason,
      isOurs,
      crashHandledElsewhere
    },
    options
  )
}
