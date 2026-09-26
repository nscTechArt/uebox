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
 *
 * ## 和盒子的崩溃看门人的分工
 *
 * 盒子本身也有一个看门人（`services/editorCrashWatch`），它只把崩溃告诉正在等命令的 Agent，
 * 不自己重开。这里是这一局在干的工程，由这里重开；`crashHandledElsewhere` 只用来尊重
 * 用户在设置里关掉重开的选择。
 */

import { projectPathKey } from '../projectPathKey'

/**
 * 盒子自己要关编辑器的时候（回滚快照）先在这里登记一声，看护就不会把那次断开
 * 当成崩溃、抢着再开一个。按工程路径记，到点作废。
 */
const expectedCloses = new Map<string, number>()

export function expectEditorClose(projectDir: string, withinMs = 2 * 60_000): void {
  expectedCloses.set(projectPathKey(projectDir), Date.now() + withinMs)
}

function isExpectedClose(projectDir: string): boolean {
  const key = projectPathKey(projectDir)
  const until = expectedCloses.get(key)
  if (until === undefined) return false
  if (until < Date.now()) {
    expectedCloses.delete(key)
    return false
  }
  return true
}

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
  /**
   * 盒子的崩溃看门人（`services/editorCrashWatch`）对这次崩溃怎么处理的。
   *
   * 它对所有交互式编辑器生效：认出崩溃后关报告窗口、备份自动存档、重开工程。
   * 这里再各自重开一次，同一个工程就会开出两个编辑器 —— 所以重开让给它：
   * - `'reopening'`：它已经重开了（或编辑器已经回来了），这里只等连回来
   * - `{ declined }`：它认了崩溃但不重开（用户关了自动重开、反复崩、重开失败），原因转给制作人
   * - `null`：它没认成崩溃（没有崩溃报告），由这里自己重开
   *
   * 不传就一律自己来（测试、没有看门人的环境）。
   */
  crashHandledElsewhere?: (
    projectDir: string,
    since: number
  ) => Promise<'reopening' | { declined: string } | null>
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
  /** 断开了但进程还在：最多再看多久、多久看一次（见 handleDisconnect） */
  hangWatchMs?: number
  hangPollMs?: number
  maxReopens?: number
  windowMs?: number
}

export function watchEditorCrashes(deps: EditorWatchDeps, options: EditorWatchOptions): () => void {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const graceMs = options.graceMs ?? 5_000
  const hangWatchMs = options.hangWatchMs ?? 5 * 60_000
  const hangPollMs = options.hangPollMs ?? 10_000
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
    if (isExpectedClose(projectDir)) return

    const key = projectPathKey(projectDir)
    if (recovering.has(key)) return
    recovering.add(key)
    const lostAt = now()
    try {
      await sleep(graceMs)
      if (stopped) return
      const uproject = await deps.findUproject(projectDir)
      if (!uproject) return
      /*
       * 进程还在：可能只是卡了一阵（插件缓过来会自己重连），也可能正卡在崩溃处理里
       * （2026-09-26 真机：引擎断言崩了，进程挂着写崩溃报告，socket 被盒子按僵尸连接断掉）。
       * 所以不马上下结论，接着看几分钟：连回来了就没事；进程退了就按崩溃处理；
       * 一直卡着就告诉制作人，别让全队对着一个不答话的编辑器干等。
       */
      if (await deps.isRunning(uproject)) {
        const deadline = now() + hangWatchMs
        for (;;) {
          await sleep(hangPollMs)
          if (stopped) return
          if ([...byConnection.values()].some((dir) => projectPathKey(dir) === key)) return
          if (!(await deps.isRunning(uproject))) break
          if (now() >= deadline) {
            options.onEvent({
              kind: 'gave-up',
              projectDir,
              why: `编辑器进程还在，但 ${Math.round(hangWatchMs / 60_000)} 分钟没答话、也没重连（可能卡在崩溃处理或弹窗上）。没有自动处理，需要人看一眼`
            })
            return
          }
        }
      }

      options.onEvent({
        kind: 'crashed',
        projectDir,
        reason: await deps.crashReason(projectDir, since).catch(() => null)
      })

      const elsewhere = deps.crashHandledElsewhere
        ? await deps.crashHandledElsewhere(projectDir, lostAt)
        : null
      if (stopped) return
      if (elsewhere && elsewhere !== 'reopening') {
        options.onEvent({ kind: 'gave-up', projectDir, why: elsewhere.declined })
        return
      }

      const t = now()
      if (elsewhere !== 'reopening') {
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
      }
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
