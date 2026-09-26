/**
 * 把崩溃看门人接到真东西上：连接事件、进程表、shell.openPath、设置。
 *
 * 判定和收拾现场的逻辑在 `watch.ts`（依赖全注入，可测）；这里只做接线。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { shell } from 'electron'

import { appSettingsManager } from '../../appSettingsManager'
import UnrealProcessDetector from '../../utils/UnrealProcessDetector'
import { logger } from '../logger'
import { serviceManager } from '..'
import { projectManager } from '../project'
import type { ProjectInfo } from '../project/types'
import { findFreshCrash } from './crashReport'
import { killProcess, listUnrealProcesses } from './processes'
import { stashPackageRestoreData, unstashPackageRestoreData } from './restoreData'
import { EditorCrashWatch, setActiveCrashWatch } from './watch'

function normalizeDir(value: string): string {
  return path
    .normalize(value)
    .toLowerCase()
    .replace(/[\\/]+$/, '')
}

async function findUproject(projectDir: string, projectName: string): Promise<string | null> {
  const names = await fs.readdir(projectDir).catch(() => [] as string[])
  const projects = names.filter((name) => name.toLowerCase().endsWith('.uproject'))
  const preferred =
    projects.find((name) => name.toLowerCase() === `${projectName.toLowerCase()}.uproject`) ??
    (projects.length === 1 ? projects[0] : undefined)
  return preferred ? path.join(projectDir, preferred) : null
}

/**
 * 连上之后去进程表里认一下是哪个 pid。同一个工程开了两个就不认，免得认错。
 * 用本模块自己那一次进程查询，不走 `getRunningProjects`（它还要逐个读 .uproject 取引擎版本）
 */
async function attachProcess(watch: EditorCrashWatch, project: ProjectInfo): Promise<void> {
  if (!project.projectPath || watch.hasProcess(project.connectionId)) return
  const dir = normalizeDir(project.projectPath)
  const matches: Array<{ pid: number; uproject: string }> = []
  for (const row of await listUnrealProcesses()) {
    // 和 watch.ts 的 isEditorRow 同一个口径：UnrealEditor-Cmd 是跑批的命令行，不是这个编辑器
    if (!/^UnrealEditor/i.test(row.name) || /-Cmd/i.test(row.name)) continue
    const uproject = UnrealProcessDetector.extractProjectPath(row.commandLine)
    if (uproject && normalizeDir(path.dirname(uproject)) === dir) {
      matches.push({ pid: row.pid, uproject })
    }
  }
  if (matches.length === 1) {
    watch.attachProcess(project.connectionId, matches[0].pid, matches[0].uproject)
  }
}

export function startEditorCrashWatch(): () => void {
  const ws = serviceManager.getWebSocketService()
  const watch = new EditorCrashWatch({
    listProcesses: listUnrealProcesses,
    findFreshCrash,
    stashRestoreData: (projectDir) => stashPackageRestoreData(projectDir),
    unstashRestoreData: unstashPackageRestoreData,
    findUproject,
    openProject: async (uprojectPath) => (await shell.openPath(uprojectPath)) || undefined,
    killProcess,
    autoRecover: () => appSettingsManager.getAutoRecoverEditorCrash(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
    log: (message) => logger.info(`[EditorCrashWatch] ${message}`)
  })
  setActiveCrashWatch(watch)

  const track = (project: ProjectInfo): void => {
    // 无头进程（commandlet、-unattended）是盒子自己跑的批处理，崩了不该替用户重开
    if (!project.interactive || !project.projectPath) return
    watch.track({
      connectionId: project.connectionId,
      projectName: project.projectName,
      projectDir: project.projectPath,
      connectedAt: project.connectedAt
    })
    void attachProcess(watch, project).catch((error) =>
      logger.warn('[EditorCrashWatch] 查编辑器进程号失败:', error)
    )
  }
  const offAdded = projectManager.onProjectAdded(track)
  // WebSocket 服务比窗口先起，看门人挂上之前可能已经有编辑器连上来了
  for (const project of projectManager.getInteractiveProjects()) track(project)

  const offDisconnected = ws.onEvent('system.disconnected', (payload, clientId) => {
    const event = payload as
      | { connectionId?: string; project?: ProjectInfo; serverStopping?: boolean }
      | undefined
    const connectionId = event?.connectionId ?? clientId
    // 没有工程记录 = 插件先报过 project.closed；serverStopping = 盒子自己停服。都不是崩溃
    if (connectionId) {
      watch.disconnected(connectionId, !event?.project || event.serverStopping === true)
    }
  })

  ws.setDisconnectExplainer((connectionId) => watch.explain(connectionId))

  return () => {
    offAdded()
    offDisconnected()
    ws.setDisconnectExplainer(undefined)
    setActiveCrashWatch(null)
  }
}
