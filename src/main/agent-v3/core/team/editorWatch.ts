/**
 * 工作室模式的编辑器看护：编辑器崩了就自动重开工程、等插件连回来，再告诉制作人。
 *
 * ## 怎么分辨「崩了」和「人关的」
 *
 * - 插件正常退出（用户关编辑器、`ue_restart_editor`）会先发 `project.closed`，
 *   再断开连接。收到它的那条连接断了，就当正常关闭，不管。
 * - 没打招呼就断了：看编辑器进程还在不在。
 *   - 还在 —— 是卡住或者网络抖了一下。插件每 5 秒自己重连，这里不插手，
 *     否则会再开一个编辑器出来。
 *   - 不在了 —— 崩了。重开工程、等连回来。
 *
 * ## 一个坑
 *
 * `system.disconnected` 送到订阅者手上时，连接→工程那条记录已经被删了
 * （`websocket/server.ts` 先删再发）。所以这里自己记一份：开跑时从已连接的工程里抄，
 * 之后从每次 `project.info` 里补。
 *
 * ## 只管这一局的工程
 *
 * 用户自己开着的别的工程崩了不归这里管 —— 替用户重开他没让重开的编辑器是越权。
 * 由宿主传一个判断「这是不是这一局在干的工程」的函数进来。
 *
 * 一小时内最多重开 3 次：反复崩就别再拉起来了，停下交给人。
 */

import { projectPathKey } from '../projectPathKey'

export interface EditorWatchDeps {
  /** 订阅 WebSocket 事件，返回退订函数（`websocketService.onEvent`） */
  onEvent: (
    method: string,
    callback: (payload: unknown, connectionId?: string) => void
  ) => () => void
  /** 开跑这一刻已经连着的工程 */
  connectedProjects: () => Array<{ connectionId: string; projectPath: string }>
  /** 工程目录里的 .uproject。找不到给 null */
  findUproject: (projectDir: string) => Promise<string | null>
  /** 这个 .uproject 的编辑器进程还在不在 */
  isRunning: (uprojectPath: string) => Promise<boolean>
  /** 重新打开工程（装插件、交给系统按关联的引擎打开） */
  reopen: (uprojectPath: string) => Promise<void>
  /** 等插件连回来并答一条只读命令 */
  waitLive: (projectDir: string) => Promise<boolean>
  /** 开跑之后新出现的那次崩溃的报错，读不到给 null */
  crashReason: (projectDir: string, since: number) => Promise<string | null>
  /** 这是不是这一局在干的工程 */
  isOurs: (projectDir: string) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type EditorWatchEvent =
  | { kind: 'crashed'; projectDir: string; reason: string | null }
  | { kind: 'recovered'; projectDir: string; waitedMs: number }
  | { kind: 'gave-up'; projectDir: string; why: string }

export interface EditorWatchOptions {
  onEvent: (event: EditorWatchEvent) => void
  /** 断开后等多久再看进程（崩溃报告和进程退出都要一点时间） */
  graceMs?: number
  maxReopens?: number
  windowMs?: number
}

export function watchEditorCrashes(deps: EditorWatchDeps, options: EditorWatchOptions): () => void {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const graceMs = options.graceMs ?? 5_000
  const maxReopens = options.maxReopens ?? 3
  const windowMs = options.windowMs ?? 60 * 60_000
  const since = now()

  const byConnection = new Map<string, string>()
  for (const project of deps.connectedProjects()) {
    byConnection.set(project.connectionId, project.projectPath)
  }
  const graceful = new Set<string>()
  const recovering = new Set<string>()
  const reopens: number[] = []
  let stopped = false

  const handleDisconnect = async (connectionId: string): Promise<void> => {
    const projectDir = byConnection.get(connectionId)
    byConnection.delete(connectionId)
    if (graceful.delete(connectionId) || !projectDir || !deps.isOurs(projectDir)) return

    const key = projectPathKey(projectDir)
    if (recovering.has(key)) return
    recovering.add(key)
    try {
      await sleep(graceMs)
      if (stopped) return
      const uproject = await deps.findUproject(projectDir)
      if (!uproject) return
      // 进程还在：卡住或网络抖动，插件会自己连回来
      if (await deps.isRunning(uproject)) return

      options.onEvent({
        kind: 'crashed',
        projectDir,
        reason: await deps.crashReason(projectDir, since).catch(() => null)
      })

      const t = now()
      while (reopens.length && t - reopens[0]! > windowMs) reopens.shift()
      if (reopens.length >= maxReopens) {
        options.onEvent({
          kind: 'gave-up',
          projectDir,
          why: `一小时内已经重开过 ${reopens.length} 次，反复崩溃，不再自动重开`
        })
        return
      }
      reopens.push(t)

      await deps.reopen(uproject)
      const live = await deps.waitLive(projectDir)
      if (stopped) return
      options.onEvent(
        live
          ? { kind: 'recovered', projectDir, waitedMs: now() - t }
          : { kind: 'gave-up', projectDir, why: '重开了工程，但插件没有在限定时间内连回来' }
      )
    } catch (error) {
      if (!stopped) {
        options.onEvent({
          kind: 'gave-up',
          projectDir,
          why: `重开失败：${error instanceof Error ? error.message : String(error)}`
        })
      }
    } finally {
      recovering.delete(key)
    }
  }

  const offs = [
    deps.onEvent('project.info', (payload, connectionId) => {
      const dir = (payload as { projectPath?: unknown } | undefined)?.projectPath
      if (connectionId && typeof dir === 'string' && dir) byConnection.set(connectionId, dir)
    }),
    // 插件正常退出时先发它，再断开 —— 那条断开不是崩溃
    deps.onEvent('project.closed', (_payload, connectionId) => {
      if (connectionId) graceful.add(connectionId)
    }),
    deps.onEvent('system.disconnected', (payload, connectionId) => {
      const id =
        connectionId ?? (payload as { connectionId?: string } | undefined)?.connectionId ?? ''
      if (id) void handleDisconnect(id)
    })
  ]

  return () => {
    stopped = true
    for (const off of offs) off()
  }
}

/** 崩溃之后告诉制作人的话。以 user 身份进上下文，开头说清不是用户在说话 */
export function buildCrashNotice(event: EditorWatchEvent): string {
  const head = '[team mode · editor watch] This is not the user speaking.'
  if (event.kind === 'crashed') {
    return [
      head,
      `The Unreal editor for ${event.projectDir} crashed${event.reason ? `: ${event.reason}` : '.'}`,
      'Unreal Box is reopening the project. Editor calls in flight failed; teammates may report errors. Unsaved editor changes since the last save are lost.'
    ].join('\n')
  }
  if (event.kind === 'recovered') {
    return [
      head,
      `The editor for ${event.projectDir} is back (reopened in ${Math.round(event.waitedMs / 1000)}s). Check what was lost since the last save before continuing, and avoid repeating whatever crashed it.`
    ].join('\n')
  }
  return [
    head,
    `The editor for ${event.projectDir} is down and was not reopened: ${event.why}.`
  ].join('\n')
}
