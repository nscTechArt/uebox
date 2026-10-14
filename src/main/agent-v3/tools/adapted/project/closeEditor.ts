/**
 * 替用户关掉某个工程的编辑器 —— `cpp_full_rebuild` 和 `project_update_plugin` 共用。
 *
 * ## 为什么要有旧插件那条退路
 *
 * 正路是插件的 `editor.quit`：有未保存的改动就拒绝、把清单交回来，没有就走编辑器自己的
 * 「文件 > 退出」。可这条命令 2026-10-12 才进插件 —— 而「插件太旧，要更新」正是
 * `project_update_plugin` 存在的理由，碰到的几乎都是没有 `editor.quit` 的插件。
 * 只认正路的话，这个工具对它最该服务的那批工程永远走不通。
 *
 * 旧插件（首个公开版起就有）能拼出同一件事：
 *   1. `editor.get_dirty` 列出存得了的未保存改动 —— 有就拒绝，清单交回去，先 ue_save；
 *   2. `system.run_console_command` 发 `CLOSE_SLATE_MAINFRAME` —— 正是 `editor.quit`
 *      内部走的那条编辑器命令。万一还有清单之外的（`/Temp/` 下没落过盘的关卡），
 *      引擎会自己弹「要保存吗」，让用户决定，不会悄悄丢。
 *
 * 插件连不上（编辑器卡死、根本没装插件）时没有优雅退出这条路，只有用户明确同意丢弃
 * 改动才结束进程；否则如实说，请用户自己保存并关掉。
 */

import { serviceManager } from '../../../../services'
import { projectManager } from '../../../../services/project'
import UnrealProcessDetector from '../../../../utils/UnrealProcessDetector'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { projectPathKey } from '../../../core/projectPathKey'
import { expectEditorClose } from '../../../core/team/editorWatch'
import { describeUnsavedRefusal } from '../unsavedRefusal'

/** 编辑器收到关闭命令后最多等多久退出。大工程退出要存配置、停着色器编译 */
export const CLOSE_WAIT_MS = 3 * 60_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 这个工程此刻连着的那条连接（本轮目标优先） */
export function connectionFor(projectDir: string): string | undefined {
  const wanted = projectPathKey(projectDir)
  const current = getTargetConnectionId()
  try {
    if (
      current &&
      projectPathKey(projectManager.getProject(current)?.projectPath ?? '') === wanted
    ) {
      return current
    }
    return projectManager
      .getInteractiveProjects()
      .find((p) => projectPathKey(p.projectPath) === wanted)?.connectionId
  } catch {
    return undefined
  }
}

export async function waitUntilClosed(
  uproject: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    if (!(await UnrealProcessDetector.findRunningProjectByPath(uproject))) return true
    await sleep(1000)
  }
  return false
}

interface RpcReply {
  ok?: boolean
  code?: number
  error?: string
  message?: string
  __rpc?: { code?: number | null }
}

/** 插件路由表里没有这条命令（插件比命令老）：404 `Unknown method: xxx` */
export function isUnknownMethod(reply: unknown): boolean {
  const r = reply as RpcReply | undefined
  if ((r?.__rpc?.code ?? r?.code) !== 404) return false
  return /unknown method/i.test(r?.error || r?.message || '')
}

interface DirtyEntry {
  package?: string
}
interface DirtyReply extends RpcReply {
  touched?: DirtyEntry[]
  other?: DirtyEntry[]
}

/** 旧插件那条路的脏检查：把 `editor.get_dirty` 的两栏并成一张清单 */
export function dirtyPackages(reply: DirtyReply | undefined): string[] {
  return [...(reply?.touched ?? []), ...(reply?.other ?? [])]
    .map((e) => e.package)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
}

const MAX_LISTED = 10

export interface CloseEditorOptions {
  projectDir: string
  uproject: string
  /** 用户明确同意丢掉未保存的改动 */
  discardUnsaved?: boolean
  /** 关掉之后要做的事，用在「没有关掉，所以没有 X」里，如「编译」「更新插件」 */
  purpose: string
  report: (text: string) => void
  signal?: AbortSignal
}

/**
 * 编辑器开着就关掉它并等进程退出；没开着什么都不做。
 *
 * @returns true = 原来开着、现在关了；false = 本来就没开
 * @throws  有未保存的改动、插件连不上又没同意丢改动、等不到退出 —— 文字直接给模型读
 */
export async function closeEditorForProject(opts: CloseEditorOptions): Promise<boolean> {
  const { projectDir, uproject, discardUnsaved, purpose, report, signal } = opts
  const running = await UnrealProcessDetector.findRunningProjectByPath(uproject)
  if (!running) return false

  const connectionId = connectionFor(projectDir)
  if (connectionId) {
    report('关闭编辑器…')
    const ws = serviceManager.getWebSocketService()
    const response = await ws.callRequest<RpcReply>(
      'editor.quit',
      discardUnsaved ? { force: true } : {},
      connectionId,
      30_000
    )
    const refusal = describeUnsavedRefusal(response, '关闭编辑器')
    if (refusal) throw new Error(refusal)

    if (isUnknownMethod(response)) {
      await closeWithOldPlugin(connectionId, running.pid, discardUnsaved)
    } else if (!response?.ok) {
      const message = response?.error
      throw new Error(`编辑器没有接受关闭命令${message ? `：${message}` : ''}，没有${purpose}。`)
    }
  } else if (discardUnsaved) {
    // 插件不在（卡死、没装）就没有优雅退出这条路。用户同意丢改动才直接结束进程
    report('编辑器没有响应，结束编辑器进程…')
    process.kill(running.pid)
  } else {
    throw new Error(
      '编辑器开着，但插件没连上（可能卡住了，或者这个工程还没装上插件），没法替用户关闭它。' +
        '可以问用户：是否同意丢掉编辑器里未保存的改动、直接结束编辑器进程？' +
        '同意就带 discard_unsaved=true 再调；或者请用户自己保存并关掉编辑器后再调。'
    )
  }

  expectEditorClose(projectDir, CLOSE_WAIT_MS + 60_000)
  if (!(await waitUntilClosed(uproject, CLOSE_WAIT_MS, signal))) {
    throw new Error(
      `编辑器 ${Math.round(CLOSE_WAIT_MS / 60_000)} 分钟内没有关掉，没有${purpose}。` +
        '多半是弹了「要保存吗」之类的对话框在等用户点 —— 请用户看一眼编辑器窗口。'
    )
  }
  return true
}

/** 插件不认 `editor.quit`：脏检查 + 编辑器自己的关闭命令（见文件头） */
async function closeWithOldPlugin(
  connectionId: string,
  pid: number,
  discardUnsaved: boolean | undefined
): Promise<void> {
  if (discardUnsaved) {
    // 旧插件没有「不问直接关」，CLOSE_SLATE_MAINFRAME 会弹保存框。用户已经同意丢，就结束进程
    process.kill(pid)
    return
  }

  const ws = serviceManager.getWebSocketService()
  const dirty = await ws
    .callRequest<DirtyReply>('editor.get_dirty', {}, connectionId, 30_000)
    .catch(() => undefined)
  const unsaved = dirtyPackages(dirty)
  if (unsaved.length > 0) {
    const shown = unsaved.slice(0, MAX_LISTED).map((p) => `  ${p}`)
    if (unsaved.length > MAX_LISTED) shown.push(`  …另有 ${unsaved.length - MAX_LISTED} 个`)
    throw new Error(
      [
        `没有关闭编辑器：${unsaved.length} 个包有未保存的改动，关掉会丢。`,
        ...shown,
        '先 ue_save 存好再调。用户明确说可以丢时才带 discard_unsaved=true。'
      ].join('\n')
    )
  }

  // 编辑器一退出连接就断，这条请求多半等不到回话 —— 关没关看进程，不看它
  await ws
    .callRequest(
      'system.run_console_command',
      { command: 'CLOSE_SLATE_MAINFRAME' },
      connectionId,
      15_000
    )
    .catch(() => undefined)
}
