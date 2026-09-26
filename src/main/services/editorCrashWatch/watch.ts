/**
 * 编辑器崩溃看门人：连接断了，认一下是不是崩了；崩了就收拾现场。
 *
 * ## 这件事原来是什么样
 *
 * 连接一断，正在执行的命令当场报「引擎断开了」，模型知道出了事。但接下来没人管：
 * 崩溃报告窗口一直亮着等人点，编辑器没人重开，模型分不清是崩了还是被人关了，
 * 用户在别的窗口里也不知道。这一轮活就停在那儿。
 *
 * ## 这里做的
 *
 * 1. **认**：断线后盯一会儿编辑器进程。它没了，并且这次连接期间出现了一份致命崩溃报告
 *    （ensure、卡顿、AbnormalShutdown 不算），就是崩了。进程被人结束、正常退出、
 *    盒子自己停服都不动。
 * 2. **说**：只有 Agent 正在控制这个编辑器（有命令在等结果，会来 `explain`）才算数：
 *    把崩溃原因告诉它，问它要不要重开。用户自己操作崩的，Agent 没在用，盒子什么都不做 ——
 *    不弹通知、不重开、不关报告窗口（2026-09-26 真机反馈：用户自己弄崩的，盒子替他重开，
 *    他又点了重启，开出两个编辑器）。
 * 3. **重开交给 Agent**：它调 `ue_session_health` 传 `relaunch_crashed_editor` 才开
 *    （`relaunch`）。开之前关掉那个崩溃报告窗口；把「恢复未保存的包」的记录备份后挪走
 *    （见 `restoreData.ts`，否则重开后又停在一个等人点的窗口上）。
 *
 * 重开有三道闸：设置里能关；5 分钟内同一个工程已经重开过一次又崩了就不再开
 * （很可能一打开就崩，重开只会循环）；编辑器已经被用户自己开回来了就不再开。
 *
 * ## 为什么依赖全靠注入
 *
 * 真正的依赖（PowerShell 查进程、shell.openPath、设置）在 `index.ts` 里接上。
 * 这个文件不碰 electron 也不碰 `appSettingsManager` —— `ue_session_health` 要从这里读
 * 最近的崩溃，而工具注册表里静态引 `appSettingsManager` 会让测试进程段错误退出
 * （AGENTS.md 第 7 节）。
 */

import type { CrashSummary } from './crashReport'
import { monitoredPid, type UnrealProcessRow } from './processes'
import type { StashedRestoreData } from './restoreData'

/** 一个连着的交互式编辑器，连上时记下来，断线时要用 */
export interface WatchedEditor {
  connectionId: string
  projectName: string
  /** 工程根目录 */
  projectDir: string
  /** 连上时从进程表里查到的，查不到就是 undefined */
  uprojectPath?: string
  editorPid?: number
  connectedAt: number
}

export type RelaunchResult =
  /** 还没人要求重开（等 Agent 决定） */
  | 'not_requested'
  | 'relaunched'
  | 'disabled'
  | 'crash_loop'
  | 'already_running'
  | 'no_uproject'
  | 'failed'

export interface EditorCrash {
  editor: WatchedEditor
  /** 认定崩溃所凭的那份报告 */
  report: CrashSummary
  reporterClosed: boolean
  restore: StashedRestoreData | null
  relaunch: RelaunchResult
  relaunchError?: string
  at: number
}

export interface CrashWatchDeps {
  listProcesses(): Promise<UnrealProcessRow[]>
  findFreshCrash(
    projectDir: string,
    projectName: string,
    sinceMs: number
  ): Promise<CrashSummary | null>
  stashRestoreData(projectDir: string): Promise<StashedRestoreData | null>
  /** 重开失败时把挪走的记录放回去，用户手动打开时引擎照常弹恢复窗口 */
  unstashRestoreData(projectDir: string, stashed: StashedRestoreData): Promise<void>
  /** 找工程的 .uproject（进程表里没查到时用） */
  findUproject(projectDir: string, projectName: string): Promise<string | null>
  /** 打开工程。成功返回 undefined，失败返回原因 */
  openProject(uprojectPath: string): Promise<string | undefined>
  killProcess(pid: number): boolean
  autoRecover(): boolean
  now(): number
  sleep(ms: number): Promise<void>
  log?(message: string): void
}

/** 断线后最多盯多久。崩溃报告程序写 dump、回话让编辑器退出，正常几秒 */
export const INSPECT_DEADLINE_MS = 30_000
export const POLL_INTERVAL_MS = 1_500
/** 编辑器没了、也没有任何崩溃痕迹，连着看到几次就下结论「不是崩溃」 */
const CLEAN_EXIT_CONFIRMATIONS = 2
/** 同一个工程这么久之内自动重开过又崩了，就不再重开 */
export const CRASH_LOOP_WINDOW_MS = 5 * 60_000
/** 模型那边最多为了等结论多等多久 */
export const EXPLAIN_TIMEOUT_MS = 20_000
/** `ue_session_health` 报多久以内的崩溃 */
export const RECENT_CRASH_MS = 10 * 60_000

function isEditorRow(row: UnrealProcessRow): boolean {
  return /^UnrealEditor/i.test(row.name) && !/-Cmd/i.test(row.name)
}

function sameProject(row: UnrealProcessRow, editor: WatchedEditor): boolean {
  const line = row.commandLine.toLowerCase().replace(/\\/g, '/')
  if (editor.uprojectPath) {
    return line.includes(editor.uprojectPath.toLowerCase().replace(/\\/g, '/'))
  }
  return line.includes(`/${editor.projectName.toLowerCase()}.uproject`)
}

export class EditorCrashWatch {
  private readonly editors = new Map<string, WatchedEditor>()
  private readonly verdicts = new Map<
    string,
    { verdict: Promise<EditorCrash | null>; editorAliveAtFirstLook: Promise<boolean> }
  >()
  private readonly lastRelaunch = new Map<string, number>()
  private readonly crashes: EditorCrash[] = []

  constructor(private readonly deps: CrashWatchDeps) {}

  /** 一个交互式编辑器连上了 */
  track(editor: WatchedEditor): void {
    // 同一条连接重报工程信息：已经查到的进程号和最早的连接时间留着
    const previous = this.editors.get(editor.connectionId)
    this.editors.set(
      editor.connectionId,
      previous
        ? {
            ...editor,
            connectedAt: previous.connectedAt,
            editorPid: editor.editorPid ?? previous.editorPid,
            uprojectPath: editor.uprojectPath ?? previous.uprojectPath
          }
        : editor
    )
  }

  /** 这条连接查过进程号没有 */
  hasProcess(connectionId: string): boolean {
    return this.editors.get(connectionId)?.editorPid !== undefined
  }

  /** 连上之后查到了进程号（异步补上，没查到就不补） */
  attachProcess(connectionId: string, pid: number, uprojectPath: string): void {
    const editor = this.editors.get(connectionId)
    if (editor) this.editors.set(connectionId, { ...editor, editorPid: pid, uprojectPath })
  }

  /**
   * 连接断了。`closedCleanly` = 插件先报过 project.closed，那是正常关闭，不用看。
   *
   * 结论存进 `verdicts`，正在等命令结果的那条调用会来 `explain` 取。
   */
  disconnected(connectionId: string, closedCleanly: boolean): void {
    const editor = this.editors.get(connectionId)
    this.editors.delete(connectionId)
    if (!editor || closedCleanly) return

    let firstLook: (alive: boolean) => void = () => {}
    const editorAliveAtFirstLook = new Promise<boolean>((resolve) => {
      firstLook = resolve
    })
    const verdict = this.inspect(editor, firstLook)
      .then((report): EditorCrash | null =>
        report
          ? {
              editor,
              report,
              reporterClosed: false,
              restore: null,
              relaunch: 'not_requested',
              at: this.deps.now()
            }
          : null
      )
      .catch((error) => {
        this.deps.log?.(`检查崩溃失败：${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      .finally(() => firstLook(false))
    this.verdicts.set(connectionId, { verdict, editorAliveAtFirstLook })
    // 结论只给这一次断线用。留十分钟够所有在途的请求来取，之后不留着占内存
    void verdict.then(() => {
      setTimeout(() => this.verdicts.delete(connectionId), RECENT_CRASH_MS).unref?.()
    })
  }

  /**
   * 给模型的补充说明。这条连接不是崩掉的、或者等不到结论，返回 undefined。
   *
   * 只有正在等命令结果的调用会来问 —— 这就是「Agent 在控制这个编辑器」的判据。
   * 崩溃只在这里记下来，没人问的崩溃（用户自己弄崩的）不留记录、不做任何事。
   */
  async explain(connectionId: string): Promise<string | undefined> {
    const entry = this.verdicts.get(connectionId)
    if (!entry) return undefined
    /*
     * 断线时编辑器还活着（心跳超时、正在关）：崩溃要等进程没了才谈得上，
     * 不为一个大概率不是崩溃的结论把这条命令的失败压 20 秒。
     * 真崩的时候套接字是跟着进程一起没的，第一眼就看得到进程不在了。
     */
    if (await entry.editorAliveAtFirstLook) return undefined
    const { verdict } = entry
    // 真计时器而不是 deps.sleep：后者在测试里是「推时钟」，会抢在结论前面
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), EXPLAIN_TIMEOUT_MS)
    })
    const crash = await Promise.race([verdict, timeout]).finally(() => clearTimeout(timer))
    if (!crash) return undefined
    if (!this.crashes.includes(crash)) {
      this.crashes.push(crash)
      if (this.crashes.length > 20) this.crashes.shift()
      this.deps.log?.(
        `${crash.editor.projectName} 崩溃（${crash.report.crashType || '类型未知'}），已告诉 Agent`
      )
    }
    return describeCrashForAgent(crash)
  }

  /** 最近的崩溃，新的在前 */
  recent(): EditorCrash[] {
    const cutoff = this.deps.now() - RECENT_CRASH_MS
    return this.crashes.filter((crash) => crash.at >= cutoff).reverse()
  }

  /**
   * 认崩溃**只认崩溃报告**。报告程序守着死 pid 不算证据：正常退出后它也会多留一会儿
   * （合并分析数据），而插件的 project.closed 可能没赶在断线前到 —— 凭它下结论，
   * 就是把用户刚关掉的工程又打开。它在的时候只说明「报告可能还在写」，多等一会儿。
   */
  private async inspect(
    editor: WatchedEditor,
    onFirstLook: (editorAlive: boolean) => void
  ): Promise<CrashSummary | null> {
    const started = this.deps.now()
    // 报告目录的时间戳和连接时间来自两个时钟，留一点余量
    const since = editor.connectedAt - 5_000
    let cleanExits = 0
    let first = true

    while (this.deps.now() - started < INSPECT_DEADLINE_MS) {
      const rows = await this.deps.listProcesses().catch(() => [] as UnrealProcessRow[])
      const editorAlive = rows.some(
        (row) =>
          isEditorRow(row) &&
          (editor.editorPid ? row.pid === editor.editorPid : sameProject(row, editor))
      )
      if (first) {
        first = false
        onFirstLook(editorAlive)
      }
      if (!editorAlive) {
        const report = await this.deps
          .findFreshCrash(editor.projectDir, editor.projectName, since)
          .catch(() => null)
        if (report) return report

        const reporterStillUp =
          Boolean(editor.editorPid) && rows.some((row) => monitoredPid(row) === editor.editorPid)
        if (!reporterStillUp && ++cleanExits >= CLEAN_EXIT_CONFIRMATIONS) return null
      }
      // 盯满了还活着：卡住了、或者正在关，都不是这里该管的
      await this.deps.sleep(POLL_INTERVAL_MS)
    }
    return null
  }

  /**
   * Agent 要求重开这个工程。只认告诉过 Agent、还没重开的那次崩溃；没有就返回 null。
   */
  async relaunch(projectDir: string): Promise<EditorCrash | null> {
    const key = projectDir.toLowerCase()
    const crash = [...this.crashes]
      .reverse()
      .find(
        (c) =>
          c.editor.projectDir.toLowerCase() === key &&
          c.relaunch !== 'relaunched' &&
          c.relaunch !== 'already_running'
      )
    if (!crash) return null

    const { deps } = this
    const { editor } = crash
    const rows = await deps.listProcesses().catch(() => [] as UnrealProcessRow[])
    const last = this.lastRelaunch.get(key)
    const now = deps.now()
    crash.relaunchError = undefined

    if (!deps.autoRecover()) {
      crash.relaunch = 'disabled'
    } else if (last !== undefined && now - last < CRASH_LOOP_WINDOW_MS && last < crash.at) {
      crash.relaunch = 'crash_loop'
    } else if (rows.some((row) => isEditorRow(row) && sameProject(row, editor))) {
      crash.relaunch = 'already_running'
    } else {
      // 只关守着**这个**编辑器 pid 的报告窗口；pid 没查到就不关，不替别的工程的窗口做决定
      for (const row of rows) {
        if (editor.editorPid && monitoredPid(row) === editor.editorPid) {
          crash.reporterClosed = deps.killProcess(row.pid) || crash.reporterClosed
        }
      }
      const uproject =
        editor.uprojectPath ?? (await deps.findUproject(editor.projectDir, editor.projectName))
      if (!uproject) {
        crash.relaunch = 'no_uproject'
      } else {
        crash.restore = await deps.stashRestoreData(editor.projectDir).catch((error) => {
          deps.log?.(`备份自动存档记录失败，重开后引擎会照常弹恢复窗口：${String(error)}`)
          return null
        })
        const error = await deps.openProject(uproject)
        if (error) {
          crash.relaunch = 'failed'
          crash.relaunchError = error
          // 没开成就把记录放回去：用户自己打开时引擎照常问要不要恢复
          if (crash.restore) {
            const stashed = crash.restore
            crash.restore = await deps
              .unstashRestoreData(editor.projectDir, stashed)
              .then(() => null)
              .catch(() => stashed)
          }
        } else {
          crash.relaunch = 'relaunched'
          this.lastRelaunch.set(key, now)
        }
      }
    }
    deps.log?.(`Agent 要求重开 ${editor.projectName}：${crash.relaunch}`)
    return crash
  }
}

/** 写给模型的那段。它拿去决定下一步，也要转述给用户 */
export function describeCrashForAgent(crash: EditorCrash): string {
  const { editor, report } = crash
  const lines = [
    `【编辑器崩溃】${editor.projectName} 的编辑器崩了` +
      (report?.crashType ? `（${report.crashType}）` : '') +
      '，不是被人关掉的。'
  ]
  if (report) {
    if (report.errorMessage) lines.push(`错误：${report.errorMessage}`)
    if (report.callStackHead) lines.push(`调用栈开头：\n${report.callStackHead}`)
    lines.push(`崩溃报告目录：${report.folder}`)
  }

  lines.push(describeRelaunch(crash))

  if (crash.restore) {
    lines.push(
      `崩溃前有 ${crash.restore.packageCount} 个改过没存的包留了自动存档，已经备份到 ` +
        `${crash.restore.backupDir}，所以这次启动不会弹「恢复包」窗口。` +
        '要恢复的话，把备份里的 Autosaves 文件夹拷回工程的 Saved 目录再打开编辑器，引擎会弹出恢复窗口让用户自己挑。' +
        '把这件事告诉用户。'
    )
  }

  lines.push(
    '连上之后先查清刚才那一步做到了哪，再决定怎么继续。**不要用同样的参数重试** —— ' +
      '很可能就是它把编辑器弄崩的，重试就是再崩一次。'
  )
  return lines.join('\n')
}

let active: EditorCrashWatch | null = null

export function setActiveCrashWatch(watch: EditorCrashWatch | null): void {
  active = watch
}

/** 重开这件事到了哪一步，写给模型的一句话 */
export function describeRelaunch(
  crash: Pick<EditorCrash, 'relaunch' | 'relaunchError' | 'reporterClosed'>
): string {
  switch (crash.relaunch) {
    case 'not_requested':
      return (
        '盒子没有自动重开。如果是你刚才的操作把它弄崩的、还要接着干活，' +
        '调 ue_session_health 并传 relaunch_crashed_editor=true 让盒子重开，再传 wait_seconds=180 等它连回来' +
        '（不要让用户去开）；如果不打算继续，就不用管。'
      )
    case 'relaunched':
      return (
        `盒子已经${crash.reporterClosed ? '关掉崩溃报告窗口、' : ''}重新打开了这个工程。` +
        '调 ue_session_health 并传 wait_seconds=180 等它连回来（大工程加载要一两分钟）。'
      )
    case 'disabled':
      return '重开崩溃编辑器在设置里关掉了。请用户自己重新打开工程，再用 ue_session_health 等它连上。'
    case 'crash_loop':
      return (
        '这个工程 5 分钟内已经重开过一次，又崩了，所以这次没有再开 —— 可能一打开就崩。' +
        '把错误告诉用户，由他决定怎么办。'
      )
    case 'already_running':
      return '编辑器已经重新开起来了（可能是用户点了重启）。用 ue_session_health 等它连上。'
    case 'no_uproject':
      return '没找到这个工程的 .uproject，没法重开。请用户手动打开工程。'
    case 'failed':
      return `重开失败：${crash.relaunchError ?? '原因未知'}。请用户手动打开工程。`
  }
}

/** 最近十分钟的崩溃。看门人没启动时是空表 */
export function recentEditorCrashes(): EditorCrash[] {
  return active?.recent() ?? []
}

/** Agent 要求重开崩掉的工程。看门人没启动、或这个工程没有告诉过 Agent 的崩溃，返回 null */
export function relaunchCrashedEditor(projectDir: string): Promise<EditorCrash | null> {
  return active?.relaunch(projectDir) ?? Promise.resolve(null)
}
