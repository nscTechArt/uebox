/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import type { CrashSummary } from './crashReport'
import { crashNotice } from './notice'
import type { UnrealProcessRow } from './processes'
import {
  EditorCrashWatch,
  INSPECT_DEADLINE_MS,
  type CrashWatchDeps,
  type EditorCrash,
  type WatchedEditor
} from './watch'

const EDITOR: WatchedEditor = {
  connectionId: 'conn-1',
  projectName: 'TDGuardians',
  projectDir: 'D:\\Projects\\TDGuardians',
  uprojectPath: 'D:\\Projects\\TDGuardians\\TDGuardians.uproject',
  editorPid: 100,
  connectedAt: 1_000
}

const editorRow: UnrealProcessRow = {
  pid: 100,
  name: 'UnrealEditor.exe',
  commandLine: '"D:\\UE_5.5\\UnrealEditor.exe" "D:\\Projects\\TDGuardians\\TDGuardians.uproject"',
  executablePath: 'D:\\UE_5.5\\UnrealEditor.exe'
}

/** 守着编辑器的那个崩溃报告程序 */
function reporterRow(pid: number, monitors: number): UnrealProcessRow {
  return {
    pid,
    name: 'CrashReportClientEditor.exe',
    commandLine: `CrashReportClientEditor.exe -READ=1 -WRITE=2 -MONITOR=${monitors} -ProcessGroupId=x`,
    executablePath: 'D:\\UE_5.5\\CrashReportClientEditor.exe'
  }
}

const REPORT: CrashSummary = {
  folder: 'D:\\Projects\\TDGuardians\\Saved\\Crashes\\UECC-Windows-ABC_0000',
  crashType: 'Crash',
  errorMessage: 'Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x38',
  callStackHead: 'UnrealEditor_Engine\nUnrealEditor_AssetRegistry',
  time: 5_000
}

/**
 * 假的依赖。时间由 `sleep` 推着走，这样「盯 30 秒」在测试里是瞬间的。
 * `processes` 按调用次数给进程表，给完了一直给最后一份。
 */
interface Harness {
  deps: CrashWatchDeps
  watch: EditorCrashWatch
  crashes: EditorCrash[]
  advance: (ms: number) => void
}

function harness(
  options: {
    processes?: UnrealProcessRow[][]
    report?: CrashSummary | null
    autoRecover?: boolean
    openError?: string
  } = {}
): Harness {
  let time = 10_000
  let call = 0
  const snapshots = options.processes ?? [[reporterRow(200, 100)]]
  const crashes: EditorCrash[] = []
  const deps: CrashWatchDeps = {
    listProcesses: vi.fn(async () => snapshots[Math.min(call++, snapshots.length - 1)]),
    findFreshCrash: vi.fn(async () => (options.report === undefined ? REPORT : options.report)),
    stashRestoreData: vi.fn(async () => ({
      backupDir: 'D:\\Projects\\TDGuardians\\Saved\\UEBoxCrashRecovery\\20260925-101500',
      packageCount: 2,
      missingFiles: []
    })),
    unstashRestoreData: vi.fn(async () => undefined),
    findUproject: vi.fn(async () => null),
    openProject: vi.fn(async () => options.openError),
    killProcess: vi.fn(() => true),
    autoRecover: () => options.autoRecover ?? true,
    onCrash: (crash) => crashes.push(crash),
    now: () => time,
    sleep: async (ms) => {
      time += ms
    }
  }
  const watch = new EditorCrashWatch(deps)
  return {
    deps,
    watch,
    crashes,
    advance: (ms: number) => {
      time += ms
    }
  }
}

describe('认崩溃', () => {
  it('编辑器没了、有崩溃报告：关掉报告窗口，备份存档记录，重开工程', async () => {
    const { deps, watch, crashes } = harness()
    watch.track(EDITOR)
    watch.disconnected('conn-1', false)

    const text = await watch.explain('conn-1')

    expect(deps.killProcess).toHaveBeenCalledWith(200)
    expect(deps.stashRestoreData).toHaveBeenCalledWith(EDITOR.projectDir)
    expect(deps.openProject).toHaveBeenCalledWith(EDITOR.uprojectPath)
    expect(crashes).toHaveLength(1)
    expect(crashes[0]).toMatchObject({ relaunch: 'relaunched', reporterClosed: true })
    // 给模型的：原因、下一步、别原样重试、备份在哪
    expect(text).toMatch(/EXCEPTION_ACCESS_VIOLATION/)
    expect(text).toMatch(/wait_seconds=180/)
    expect(text).toMatch(/不要用同样的参数重试/)
    expect(text).toMatch(/UEBoxCrashRecovery/)
    expect(watch.recent()).toHaveLength(1)
  })

  it('插件先报过 project.closed 的是正常关闭，连进程都不查', async () => {
    const { deps, watch } = harness()
    watch.track(EDITOR)
    watch.disconnected('conn-1', true)

    expect(await watch.explain('conn-1')).toBeUndefined()
    expect(deps.listProcesses).not.toHaveBeenCalled()
  })

  it('进程被人结束（没有报告、也没有报告程序守着）不算崩溃，不重开', async () => {
    const { deps, watch, crashes } = harness({ processes: [[]], report: null })
    watch.track(EDITOR)
    watch.disconnected('conn-1', false)

    expect(await watch.explain('conn-1')).toBeUndefined()
    expect(deps.openProject).not.toHaveBeenCalled()
    expect(crashes).toHaveLength(0)
  })

  /**
   * 正常关闭后报告程序也会多留一会儿，而 project.closed 可能没赶在断线前到。
   * 只凭它下结论，就是把用户刚关掉的工程又打开。
   */
  it('没找到报告、只有报告程序还守着死 pid：不算崩溃', async () => {
    const { deps, watch } = harness({ report: null })
    watch.track(EDITOR)
    watch.disconnected('conn-1', false)

    expect(await watch.explain('conn-1')).toBeUndefined()
    expect(deps.killProcess).not.toHaveBeenCalled()
    expect(deps.openProject).not.toHaveBeenCalled()
  })

  it('编辑器一直活着（卡住了或正在关）：盯满就放手，什么都不动', async () => {
    const { deps, watch } = harness({ processes: [[editorRow, reporterRow(200, 100)]] })
    watch.track(EDITOR)
    watch.disconnected('conn-1', false)

    // 编辑器还活着就不压着这条命令的失败，第一眼之后立刻放行
    expect(await watch.explain('conn-1')).toBeUndefined()
    // 看门人自己还会盯满，但什么都不动
    await vi.waitFor(() =>
      expect(vi.mocked(deps.listProcesses).mock.calls.length).toBeGreaterThan(
        INSPECT_DEADLINE_MS / 2_000
      )
    )
    expect(deps.killProcess).not.toHaveBeenCalled()
    expect(deps.openProject).not.toHaveBeenCalled()
  })

  it('没见过的连接（无头进程、看门人启动之前连上的）不解释', async () => {
    const { watch } = harness()
    watch.disconnected('conn-unknown', false)
    expect(await watch.explain('conn-unknown')).toBeUndefined()
  })
})

describe('收拾现场的闸', () => {
  it('设置里关了自动重开：报告窗口留给用户，工程不开', async () => {
    const { deps, watch } = harness({ autoRecover: false })
    watch.track(EDITOR)
    watch.disconnected('conn-1', false)

    const text = await watch.explain('conn-1')

    expect(deps.killProcess).not.toHaveBeenCalled()
    expect(deps.openProject).not.toHaveBeenCalled()
    expect(deps.stashRestoreData).not.toHaveBeenCalled()
    expect(text).toMatch(/设置里关掉了/)
  })

  it('5 分钟内重开过又崩了：不再重开，免得一打开就崩地循环', async () => {
    const { deps, watch, advance } = harness()
    watch.track(EDITOR)
    watch.disconnected('conn-1', false)
    await watch.explain('conn-1')

    advance(60_000)
    watch.track({ ...EDITOR, connectionId: 'conn-2', connectedAt: 70_000 })
    watch.disconnected('conn-2', false)
    const text = await watch.explain('conn-2')

    expect(deps.openProject).toHaveBeenCalledTimes(1)
    expect(text).toMatch(/没有再开/)
  })

  it('用户已经自己开回来了（点了 Send and Restart）：不再开第二个', async () => {
    const { deps, watch } = harness({
      processes: [[reporterRow(200, 100)], [{ ...editorRow, pid: 300 }, reporterRow(200, 100)]]
    })
    watch.track(EDITOR)
    watch.disconnected('conn-1', false)

    const text = await watch.explain('conn-1')

    expect(deps.openProject).not.toHaveBeenCalled()
    expect(text).toMatch(/已经重新开起来了/)
  })

  it('没查到 pid 时不关任何报告窗口 —— 那个窗口可能是别的工程的', async () => {
    const { deps, watch } = harness({ processes: [[reporterRow(201, 101)]] })
    watch.track({ ...EDITOR, editorPid: undefined })
    watch.disconnected('conn-1', false)

    await watch.explain('conn-1')

    expect(deps.killProcess).not.toHaveBeenCalled()
    expect(deps.openProject).toHaveBeenCalled()
  })

  it('没查到 .uproject 时去工程目录里找', async () => {
    const { deps, watch } = harness()
    vi.mocked(deps.findUproject).mockResolvedValue(
      'D:\\Projects\\TDGuardians\\TDGuardians.uproject'
    )
    watch.track({ ...EDITOR, uprojectPath: undefined })
    watch.disconnected('conn-1', false)

    await watch.explain('conn-1')

    expect(deps.findUproject).toHaveBeenCalledWith(EDITOR.projectDir, EDITOR.projectName)
    expect(deps.openProject).toHaveBeenCalledWith('D:\\Projects\\TDGuardians\\TDGuardians.uproject')
  })

  it('重开失败要说出原因，并把恢复记录放回去', async () => {
    const { deps, watch, crashes } = harness({ openError: '找不到关联的程序' })
    watch.track(EDITOR)
    watch.disconnected('conn-1', false)

    const text = await watch.explain('conn-1')

    expect(text).toMatch(/自动重开失败：找不到关联的程序/)
    // 用户自己打开时引擎照常问要不要恢复，所以不再提「已备份、不会弹窗」
    expect(deps.unstashRestoreData).toHaveBeenCalled()
    expect(crashes[0].restore).toBeNull()
    expect(text).not.toMatch(/UEBoxCrashRecovery/)
  })

  it('同一条连接重报工程信息，不丢已经查到的进程号', () => {
    const { watch } = harness()
    watch.track({ ...EDITOR, editorPid: undefined, uprojectPath: undefined })
    watch.attachProcess('conn-1', 100, EDITOR.uprojectPath!)
    watch.track({ ...EDITOR, editorPid: undefined, uprojectPath: undefined, connectedAt: 99_000 })
    expect(watch.hasProcess('conn-1')).toBe(true)
  })
})

describe('系统通知', () => {
  const crash: EditorCrash = {
    editor: EDITOR,
    report: REPORT,
    reporterClosed: true,
    restore: { backupDir: 'x', packageCount: 1, missingFiles: [] },
    relaunch: 'relaunched',
    at: 0
  }

  it('按界面语言出文案，提到存档已备份', () => {
    expect(crashNotice(crash, 'zh-CN')).toEqual({
      title: 'TDGuardians 的编辑器崩溃了',
      body: '已自动重新打开。未保存的自动存档已备份到 x'
    })
    expect(crashNotice(crash, 'en-US').body).toBe(
      'Reopened automatically. Unsaved autosaves were backed up to x'
    )
  })

  it('没重开时说清楚为什么', () => {
    expect(crashNotice({ ...crash, relaunch: 'crash_loop', restore: null }, 'zh-CN').body).toBe(
      '5 分钟内第二次崩溃，这次没有自动重开。'
    )
  })
})
