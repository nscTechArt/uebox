/**
 * 工作室模式的快照：git 那一半在 `core/team/snapshots.ts`，这里补上编辑器那一半。
 *
 * 回滚的顺序不能乱：
 * 1. 先把当前状态也存一份 —— 回滚本身也要能反悔。
 * 2. 编辑器开着就先关掉。开着的编辑器要么占着 .uasset 不让写，要么下次保存把旧的写回来。
 *    关之前跟看护打招呼（`expectEditorClose`），不然它会当成崩溃抢着再开一个。
 * 3. 文件退回去。
 * 4. 重新打开工程，等插件连回来。
 *
 * 关编辑器是直接结束进程：没保存的改动本来就在回滚要丢掉的范围里，
 * 插件那边也没有「优雅退出」的命令可用。
 */

import { execFile } from 'child_process'
import { shell } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

import { getTargetProjectPath } from '../agent-v3/core/projectTargetContext'
import { expectEditorClose } from '../agent-v3/core/team/editorWatch'
import {
  createSnapshotStore,
  type GitRunner,
  type SnapshotStore,
  type TeamSnapshots
} from '../agent-v3/core/team/snapshots'
import { awaitProjectLive } from '../agent-v3/tools/adapted/project/awaitProjectLive'
import UnrealProcessDetector from '../utils/UnrealProcessDetector'

const gitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || '') })
      }
    )
  })

/**
 * 装插件那一步按需再加载：它所在的模块一加载就要连数据库、读应用设置，
 * 静态引进来会让只想测 IPC 的单测也得先搭一整套 electron 环境。
 */
async function ensurePlugin(uproject: string): Promise<void> {
  const { ensureUnrealAgentLinkPlugin } = await import('../sqliteDataBase/ipc/project')
  await ensureUnrealAgentLinkPlugin(uproject)
}

/** 回滚后等编辑器重新连上的上限。大工程冷启动要编译着色器 */
const RECONNECT_WAIT_MS = 8 * 60_000

async function findUproject(projectDir: string): Promise<string | null> {
  const name = (await fs.readdir(projectDir).catch(() => [] as string[])).find((entry) =>
    entry.endsWith('.uproject')
  )
  return name ? join(projectDir, name) : null
}

async function waitUntilClosed(uproject: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await UnrealProcessDetector.findRunningProjectByPath(uproject))) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

export function createTeamSnapshots(): TeamSnapshots {
  const stores = new Map<string, SnapshotStore>()
  const storeFor = (projectDir: string): SnapshotStore => {
    let store = stores.get(projectDir)
    if (!store) {
      store = createSnapshotStore(projectDir, gitRunner)
      stores.set(projectDir, store)
    }
    return store
  }
  const currentProject = (): string => {
    const dir = getTargetProjectPath()
    if (!dir) throw new Error('这一轮还没有连着的工程，没有东西可以快照')
    return dir
  }

  return {
    async save(message) {
      const dir = getTargetProjectPath()
      if (!dir) return null
      return storeFor(dir).save(message)
    },
    list: (limit) => storeFor(currentProject()).list(limit),
    async rollback(id, report) {
      const dir = currentProject()
      const store = storeFor(dir)
      const uproject = await findUproject(dir)
      if (!uproject) throw new Error(`${dir} 里没有 .uproject`)
      // 先确认有这一份，再动编辑器 —— 编号写错不该白白关掉编辑器
      try {
        await store.resolve(id)
      } catch (error) {
        const known = await store.list(5).catch(() => [])
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}。最近的：${
            known.map((s) => s.id).join('、') || '（无）'
          }`
        )
      }

      const before = await store.save('回滚前的状态（自动存）')
      const running = await UnrealProcessDetector.findRunningProjectByPath(uproject)
      if (running) {
        report('关闭编辑器…')
        expectEditorClose(dir)
        process.kill(running.pid)
        if (!(await waitUntilClosed(uproject))) {
          throw new Error('编辑器一分钟内没关掉，没有回滚。请手动关掉编辑器再试')
        }
      }

      report(`退回快照 ${id}…`)
      // 编辑器已经关了：退回失败也要把它重新打开，不能让用户对着一个关掉的编辑器
      let restoreError: unknown
      await store.restore(id).catch((error: unknown) => {
        restoreError = error
      })

      report('重新打开工程…')
      await ensurePlugin(uproject)
      const opened = await shell.openPath(uproject)
      if (restoreError) {
        const reason = restoreError instanceof Error ? restoreError.message : String(restoreError)
        throw new Error(
          `退回快照 ${id} 失败：${reason}。${opened ? `重新打开工程也失败了：${opened}` : '已经把工程重新打开。'}`
        )
      }
      if (opened) throw new Error(`文件已经退回快照 ${id}，但打开工程失败：${opened}`)
      const live = await awaitProjectLive({ projectPath: dir, timeoutMs: RECONNECT_WAIT_MS })

      return [
        `已退回快照 ${id}。`,
        before ? `回滚前的状态存成了快照 ${before.id}，想反悔就退回它。` : '回滚前没有未存的改动。',
        live.live ? '编辑器已重新打开并连上。' : '文件已经退回，但编辑器还没连上，等它起来再继续。'
      ].join('\n')
    }
  }
}
