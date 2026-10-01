/**
 * Unreal Insights：录一段 trace，或者把录好的 .utrace 跑一次无头分析。
 *
 * ## 为什么是一个工具两个 action，而不是两个工具
 *
 * 2026-09-11 之前这是 `ue_capture_insights_trace` 和 `ue_analyze_insights_trace`
 * 两个工具，描述互相引用（「拿到 .utrace 之后调另一个」）。它们永远连着用、
 * 风险同档（都 safe）、参数不重叠 —— 拆成两个只是多一个名字给模型挑。
 * 合并的判据和验收。
 *
 * 三条执行路径共用一个入口：
 *
 * - `capture`：让插件在引擎内录 `duration_seconds` 秒，交出 .utrace 路径。
 *   录制前先尝试把编辑器窗口拉到前台（见 foregroundEditorWindow.ts）——窗口被挡在
 *   后面时录出来的渲染线程和 GPU 事件是空的，而且录完还要再分析一遍才知道白录了。
 * - `analyze`：在宿主机上跑随引擎分发的 `UnrealInsights.exe`
 *   （`-NoUI -AutoQuit -ExecOnAnalysisCompleteCmd=@=<响应文件>`），按游戏线程 /
 *   渲染线程 / GPU 各导一份计时器统计，整理见 insightsBreakdown.ts。
 *   .utrace 是逐帧 CPU/GPU 事件的二进制格式，解析它要 TraceAnalysis 那一整套库，
 *   插件里现有的命令没有一个需要它 —— 引擎自带的分析器已经写好了，我们只要会调。
 * - `compare`：两份 trace 各走一遍 analyze 的导出，按每帧自身耗时对齐比较。
 *
 * ## 已知的脆弱点（如实说，不是没验证过就往下写）
 *
 * 1. Epic 论坛上有用户报告过导出结果是空 CSV——不是每次都能复现，原因不明。
 *    遇到空文件时要如实告诉用户这是 Insights CLI 一个没有稳定复现条件的已知问题。
 * 2. 导出命令有自己的参数解析器，CSV 路径需要单独加引号以保留空格。
 * 3. 列名没有官方文档。2026-10 对着 5.1–5.5 源码和一份真实 trace 核对过
 *    （见 insightsBreakdown.ts）；在那之前这里按「total / inclusive」之类的模式猜列，
 *    而真实列名是 `Incl` / `Excl`，一个都匹配不上 —— analyze 一直回的是没排过序的前 30 行。
 * 4. 内存和资产加载没有命令行导出（TimingProfilerManager::Exec 里只有 TimingInsights.* 这几条），
 *    这两类只能录，不能在这里分析。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId, getTargetProjectPath } from '../../../core/projectTargetContext'
import { resolveEngineOutputPath } from './engineOutputPath'
import UnrealPathManagerUtil from '../../../../utils/UnrealPathManager'
import {
  normalizeEngineRoot,
  resolveInsightsExecutable
} from '../../../../utils/unrealEnginePlatform'
import { foregroundUnrealEditorWindow } from './foregroundEditorWindow'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { assertFreshFile } from '../../assertFreshFile'
import { parseGenericCsv } from './insightsCsv'
import {
  diffThread,
  frameStats,
  gameThreadSpikes,
  missingColumns,
  subtractGpuRows,
  summarizeThread,
  THREAD_LABELS,
  toTimerRows,
  type ThreadDiff,
  type ThreadKey,
  type ThreadSummary,
  type TimerRow
} from './insightsBreakdown'

export const INSIGHTS_TRACE_TOOL_NAME = 'ue_insights_trace'

const DEFAULT_DURATION_SECONDS = 10
const DEFAULT_CHANNELS = 'cpu,gpu,frame,bookmark'

const InsightsTraceSchema = z.object({
  action: z
    .enum(['capture', 'analyze', 'compare'])
    .describe(
      'capture=在引擎里录一段 trace，交出 .utrace；analyze=把已有的 .utrace 跑一次无头分析；' +
        'compare=比较两份 .utrace（改之前 vs 改之后）'
    ),
  duration_seconds: z
    .number()
    .optional()
    .describe('capture 用：录制时长，秒。1–120，默认 10。调用会同步等待这么久'),
  channels: z
    .string()
    .optional()
    .describe(
      'capture 用：要录哪些通道，逗号分隔。默认 cpu,gpu,frame,bookmark 覆盖常规性能分析。' +
        '需要内存分配轨迹时可以加 memory（开销明显更大，而且只能在 Unreal Insights 里看，analyze 分析不了）'
    ),
  utrace_path: z
    .string()
    .optional()
    .describe(
      'analyze / compare 用（必填）：.utrace 文件路径，通常来自 capture 返回的 utrace_path。' +
        'compare 时它是改之后的那份'
    ),
  baseline_utrace_path: z
    .string()
    .optional()
    .describe('compare 用（必填）：改之前录的那份 .utrace'),
  start_seconds: z
    .number()
    .min(0)
    .optional()
    .describe('analyze / compare 用：只看 trace 里从这一秒开始的部分'),
  end_seconds: z
    .number()
    .min(0)
    .optional()
    .describe('analyze / compare 用：只看 trace 里到这一秒为止的部分')
})

type InsightsTraceInput = z.infer<typeof InsightsTraceSchema>

interface CaptureInsightsTraceResponse {
  ok?: boolean
  utrace_path?: string
  channels?: string
  requested_duration_seconds?: number
  actual_elapsed_seconds?: number
  note?: string
}

interface ProjectInfoLite {
  ok?: boolean
  engine_major?: number
  engine_minor?: number
  engine_dir?: string
}

/** 给模型看的下一步：怎么调 analyze。字符串只在这里拼一次 */
function analyzeHint(utracePath: string): string {
  return `${INSIGHTS_TRACE_TOOL_NAME}(action="analyze", utrace_path="${utracePath}")`
}

async function runCapture(input: InsightsTraceInput): Promise<Record<string, unknown>> {
  const duration_seconds = input.duration_seconds ?? DEFAULT_DURATION_SECONDS
  const channels = input.channels ?? DEFAULT_CHANNELS
  console.log('[InsightsTraceTool] capture:', { duration_seconds, channels })

  try {
    const wsService = serviceManager.getWebSocketService()
    if (wsService.getConnectionCount() === 0) {
      return { success: false, error: UE_NOT_CONNECTED_MESSAGE }
    }

    // 录制前先尝试把编辑器窗口拉到前台，见文件头说明
    await foregroundUnrealEditorWindow('[InsightsTraceTool]')

    const timeoutMs = duration_seconds * 1000 + 30000

    const since = Date.now()
    const response = await wsService.callRequest<CaptureInsightsTraceResponse>(
      'system.capture_insights_trace',
      { duration_seconds, channels },
      getTargetConnectionId(),
      timeoutMs
    )

    if (!response) {
      return { success: false, error: '服务未返回有效数据' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failed = (response as any)?.ok === false || (response as any)?.success === false
    if (failed) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (response as any)?.error || (response as any)?.message || 'trace 录制失败'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (response as any)?.__rpc?.code ?? (response as any)?.code
      return { success: false, error: msg, code }
    }

    // 同 capturePerfTrace：旧插件可能回相对引擎目录的路径，按工程目录落回去
    const utracePath = resolveEngineOutputPath(response.utrace_path, getTargetProjectPath())
    await assertFreshFile(utracePath, since)
    return {
      success: true,
      action: 'capture',
      utrace_path: utracePath,
      channels: response.channels,
      requested_duration_seconds: response.requested_duration_seconds,
      actual_elapsed_seconds: response.actual_elapsed_seconds,
      message:
        `录制完成：${utracePath}。` +
        `接着调 ${analyzeHint(utracePath ?? '<utrace_path>')} 拿计时器排行，` +
        '或自己在 Unreal Insights 里打开。'
    }
  } catch (error) {
    console.error('[InsightsTraceTool] capture 失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function resolveUnrealInsightsExe(): Promise<{ exePath: string } | { error: string }> {
  const wsService = serviceManager.getWebSocketService()
  if (wsService.getConnectionCount() === 0) {
    return { error: '没有连接的虚幻引擎项目，拿不到引擎版本来定位 UnrealInsights.exe。' }
  }

  const info = await wsService.callRequest<ProjectInfoLite>(
    'system.get_project_info',
    {},
    getTargetConnectionId(),
    15000
  )
  if (!info || info.engine_major == null || info.engine_minor == null) {
    return { error: '拿不到当前项目的引擎版本，没法定位对应版本的 UnrealInsights.exe。' }
  }
  const version = `${info.engine_major}.${info.engine_minor}`

  const engines = info.engine_dir ? [] : await UnrealPathManagerUtil.findUnrealEnginePaths()
  const rootPath = info.engine_dir
    ? normalizeEngineRoot(info.engine_dir)
    : engines.find((e) => e.version.split('.').slice(0, 2).join('.') === version)?.rootPath
  if (!rootPath) {
    return {
      error:
        `本机没有找到 UE ${version} 的安装记录（当前连接的项目用的是这个版本）。` +
        '如果引擎装在非标准位置，请在偏好设置里把它加为自定义引擎路径。'
    }
  }

  const exePath = await resolveInsightsExecutable(rootPath)
  if (!exePath) {
    return {
      error:
        `Unreal Insights 在 ${rootPath} 中不存在或不可执行 —— 这台 UE ${version} 安装时可能没有勾选 ` +
        'Unreal Insights 组件（Epic Games Launcher 的可选功能）。'
    }
  }
  return { exePath }
}

interface ExportRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * 一次 Insights 进程跑多条导出命令。
 *
 * `-ExecOnAnalysisCompleteCmd=@=<文件>` 让它逐行执行响应文件里的命令（引擎自带的
 * 功能测试 MultipleExportCommands 就是这么用的）。分析 trace 是大头，三份导出
 * 只多花零点几秒 —— 起三次进程就是三倍的分析时间。
 *
 * 响应文件放系统临时目录：命令行上这个路径没法再套一层引号，工程路径里又常有空格；
 * 文件里面的导出路径是加了引号的，空格和中文都没问题。
 */
async function runInsightsExport(
  exePath: string,
  utracePath: string,
  commands: string[],
  timeoutMs: number
): Promise<ExportRunResult> {
  const rspDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uebox-insights-'))
  const rspPath = path.join(rspDir, 'export.rsp')
  await fs.promises.writeFile(rspPath, commands.join('\n') + '\n', 'utf-8')

  try {
    return await new Promise((resolve) => {
      const args = [
        `-OpenTraceFile=${utracePath}`,
        '-NoUI',
        '-AutoQuit',
        '-log',
        `-ExecOnAnalysisCompleteCmd=@=${rspPath}`
      ]

      const proc = spawn(exePath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeoutMs)

      proc.stdout?.on('data', (d) => (stdout += d.toString()))
      proc.stderr?.on('data', (d) => (stderr += d.toString()))
      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: timedOut ? -1 : code, stdout, stderr, timedOut })
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: String(err), timedOut })
      })
    })
  } finally {
    await fs.promises.rm(rspDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 每条线程一份导出。GPU 那份为什么这么筛，见 insightsBreakdown.ts 文件头 */
const THREAD_FILTERS: Record<ThreadKey, string> = {
  game: 'GameThread',
  render: 'RenderThread*',
  gpu: 'GPU*'
}

const THREAD_KEYS = Object.keys(THREAD_FILTERS) as ThreadKey[]

const ANALYZE_TIMEOUT_MS = 90000
const TOP_PER_THREAD = 10
const TOP_SPIKES = 5

interface TimeWindow {
  start_seconds?: number
  end_seconds?: number
}

/**
 * UE 用 `FParse::Token(Cmd, bUseEscape=true)` 读文件名：反斜杠是转义符，会被吃掉，
 * `D:\Traces\a.csv` 读成 `D:Tracesa.csv`。Windows 也认正斜杠，一律换成 `/`
 */
function exportCommand(csvPath: string, threads: string, window: TimeWindow): string {
  const file = csvPath.replace(/\\/g, '/').replace(/"/g, '\\"')
  let cmd = `TimingInsights.ExportTimerStatistics "${file}" -threads="${threads}"`
  if (window.start_seconds != null) cmd += ` -startTime=${window.start_seconds}`
  if (window.end_seconds != null) cmd += ` -endTime=${window.end_seconds}`
  return cmd
}

type ExportResult =
  | { ok: true; tables: Record<ThreadKey, TimerRow[]>; csvPaths: Record<ThreadKey, string> }
  | { ok: false; error: string; export_csv_path?: string }

/** 校验 utrace、导出三条线程的计时器统计并解析。analyze 和 compare 共用 */
async function exportThreadTables(
  utracePath: string | undefined,
  argName: string,
  window: TimeWindow,
  exePath: string
): Promise<ExportResult> {
  if (!utracePath) {
    return {
      ok: false,
      error: `必须给 ${argName} —— 通常来自 action="capture" 返回的 utrace_path。还没录的话先 capture。`
    }
  }
  if (!utracePath.toLowerCase().endsWith('.utrace')) {
    return {
      ok: false,
      error: `${argName} 需要一个 .utrace 文件路径，通常来自 ${INSIGHTS_TRACE_TOOL_NAME}(action="capture") 的 utrace_path。`
    }
  }
  try {
    await fs.promises.access(utracePath, fs.constants.F_OK)
  } catch {
    return { ok: false, error: `文件不存在：${utracePath}` }
  }

  const base = utracePath.replace(/\.utrace$/i, '')
  const csvPaths = Object.fromEntries(THREAD_KEYS.map((k) => [k, `${base}.${k}.csv`])) as Record<
    ThreadKey,
    string
  >
  // 导出前先清掉旧文件——UnrealInsights 分析失败时不一定会覆盖，
  // 留着旧文件的话我们会读到上一次的结果却以为是这一次的
  await Promise.all(
    THREAD_KEYS.map((k) => fs.promises.rm(csvPaths[k], { force: true }).catch(() => {}))
  )

  const since = Date.now()
  const run = await runInsightsExport(
    exePath,
    utracePath,
    THREAD_KEYS.map((k) => exportCommand(csvPaths[k], THREAD_FILTERS[k], window)),
    ANALYZE_TIMEOUT_MS
  )
  if (run.timedOut) {
    return {
      ok: false,
      error: `UnrealInsights 处理超时（${ANALYZE_TIMEOUT_MS / 1000} 秒），已终止进程。trace 文件可能太大或太长。`
    }
  }

  const tables = {} as Record<ThreadKey, TimerRow[]>
  for (const k of THREAD_KEYS) {
    // 先看有没有导出文件，再论退出码：UE 的程序走 RequestEngineExit 关掉时
    // 经常回非零，但 CSV 已经好好写出来了。倒过来判会把能用的结果判成失败。
    let csvText: string
    try {
      csvText = await fs.promises.readFile(csvPaths[k], 'utf-8')
    } catch {
      if (run.code !== 0) {
        return {
          ok: false,
          error: `Unreal Insights 退出码 ${run.code ?? 'signal'}，也没有产出导出文件。${run.stderr.slice(-1000)}`
        }
      }
      return {
        ok: false,
        error:
          'UnrealInsights 跑完了但没有生成导出文件。这是 Insights CLI 导出路径的一个已知问题' +
          '（社区反馈过偶发空结果，原因不明，不是这个工具的 bug）。可以重新采集再试一次，' +
          `或者自己在 Unreal Insights 里打开 ${utracePath} 查看。` +
          (run.stderr ? `\n\n进程输出：${run.stderr.slice(-500)}` : '')
      }
    }
    try {
      await assertFreshFile(csvPaths[k], since)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const table = parseGenericCsv(csvText)
    if (!table) {
      return {
        ok: false,
        error: '导出文件是空的（同样是 Insights CLI 的已知问题，见上）。请重新采集再试一次。',
        export_csv_path: csvPaths[k]
      }
    }
    const missing = missingColumns(table)
    if (missing.length > 0) {
      return {
        ok: false,
        error:
          `导出表缺少 ${missing.join('、')} 列，这个引擎版本的列名和已知的不一样。` +
          `实际列名：${table.columns.join('、')}。可以自己在 Unreal Insights 里打开 ${utracePath}。`,
        export_csv_path: csvPaths[k]
      }
    }
    tables[k] = toTimerRows(table)
  }

  // 引擎把 GPU 计时器硬塞进每一份 CPU 线程的导出，减掉
  tables.game = subtractGpuRows(tables.game, tables.gpu)
  tables.render = subtractGpuRows(tables.render, tables.gpu)
  if (THREAD_KEYS.every((k) => tables[k].length === 0)) {
    return {
      ok: false,
      error:
        '三份导出都是空表（同样是 Insights CLI 的已知问题，或者这段 trace 没录 cpu/gpu 通道）。' +
        '请用默认通道重新采集再试一次。'
    }
  }
  return { ok: true, tables, csvPaths }
}

function windowOf(input: InsightsTraceInput): TimeWindow {
  return { start_seconds: input.start_seconds, end_seconds: input.end_seconds }
}

function fmtMs(v: number | null): string {
  return v == null ? '?' : `${v} ms`
}

async function runAnalyze(input: InsightsTraceInput): Promise<Record<string, unknown>> {
  console.log('[InsightsTraceTool] analyze:', { utrace_path: input.utrace_path })
  // 参数错了就别先去问引擎版本
  if (!input.utrace_path) {
    return {
      success: false,
      error:
        'action="analyze" 必须给 utrace_path —— 通常来自 action="capture" 返回的 utrace_path。' +
        '还没录的话先 capture。'
    }
  }
  const resolved = await resolveUnrealInsightsExe()
  if ('error' in resolved) return { success: false, error: resolved.error }

  const exported = await exportThreadTables(
    input.utrace_path,
    'utrace_path',
    windowOf(input),
    resolved.exePath
  )
  if (!exported.ok) {
    return { success: false, error: exported.error, export_csv_path: exported.export_csv_path }
  }
  const { tables, csvPaths } = exported

  const frames = frameStats(tables.game)
  const frameCount = frames?.frames ?? null
  const threads = Object.fromEntries(
    THREAD_KEYS.map((k) => [k, summarizeThread(tables[k], frameCount, TOP_PER_THREAD)])
  ) as Record<ThreadKey, ThreadSummary>
  const spikes = gameThreadSpikes(tables.game, frameCount, TOP_SPIKES)

  const lines: string[] = []
  lines.push(
    frames
      ? `游戏线程 ${frames.frames} 帧，平均 ${fmtMs(frames.avg_ms)}，中位 ${fmtMs(frames.median_ms)}，最长一帧 ${fmtMs(frames.max_ms)}。`
      : '这段 trace 里没有游戏线程的 Frame 计时器，只给各线程的总耗时，不摊到每帧。'
  )
  for (const k of THREAD_KEYS) {
    const top = threads[k].top[0]
    lines.push(
      top
        ? `${THREAD_LABELS[k]}自身耗时最多的是 ${top.name}（合计 ${top.excl_total_ms} ms）。`
        : `${THREAD_LABELS[k]}没有数据（可能没录这个通道）。`
    )
  }

  return {
    success: true,
    action: 'analyze',
    frames,
    threads,
    game_thread_spikes: spikes,
    export_csv_paths: csvPaths,
    message: lines.join('')
  }
}

async function runCompare(input: InsightsTraceInput): Promise<Record<string, unknown>> {
  console.log('[InsightsTraceTool] compare:', {
    baseline: input.baseline_utrace_path,
    current: input.utrace_path
  })
  if (!input.baseline_utrace_path || !input.utrace_path) {
    return {
      success: false,
      error:
        'action="compare" 要两份 trace：baseline_utrace_path 是改之前的，utrace_path 是改之后的。' +
        '缺哪份就先用 capture 录哪份，两次录同一段操作。'
    }
  }
  const resolved = await resolveUnrealInsightsExe()
  if ('error' in resolved) return { success: false, error: resolved.error }

  // 一次一个：两个 Insights 同时分析会和用户手上的编辑器抢 CPU
  const window = windowOf(input)
  const baseline = await exportThreadTables(
    input.baseline_utrace_path,
    'baseline_utrace_path',
    window,
    resolved.exePath
  )
  if (!baseline.ok) return { success: false, error: `基准那份：${baseline.error}` }
  const current = await exportThreadTables(
    input.utrace_path,
    'utrace_path',
    window,
    resolved.exePath
  )
  if (!current.ok) return { success: false, error: `当前那份：${current.error}` }

  const before = frameStats(baseline.tables.game)
  const after = frameStats(current.tables.game)
  if (!before || !after) {
    return {
      success: false,
      error:
        `${!before ? `基准那份（${input.baseline_utrace_path}）` : `当前那份（${input.utrace_path}）`}` +
        '的游戏线程上没有 Frame 计时器 —— 没有帧，两次录制就没法按帧对齐比较' +
        '（时长不同，直接比总耗时没有意义）。这份 trace 可能录的不是编辑器或游戏的主循环，' +
        '或者没带 cpu / frame 通道；用默认通道重新录一份再比。'
    }
  }

  const diffs = Object.fromEntries(
    THREAD_KEYS.map((k) => [
      k,
      diffThread(baseline.tables[k], current.tables[k], before.frames, after.frames, TOP_PER_THREAD)
    ])
  ) as Record<ThreadKey, ThreadDiff>

  const lines: string[] = []
  lines.push(
    `平均帧耗时 ${fmtMs(before.avg_ms)} → ${fmtMs(after.avg_ms)}，` +
      `中位 ${fmtMs(before.median_ms)} → ${fmtMs(after.median_ms)}。`
  )
  for (const k of THREAD_KEYS) {
    const worst = diffs[k].regressions[0]
    const best = diffs[k].improvements[0]
    if (!worst && !best) {
      lines.push(`${THREAD_LABELS[k]}没有超过 0.05 ms/帧的变化。`)
      continue
    }
    const parts: string[] = []
    if (worst) parts.push(`变慢最多的是 ${worst.name}（+${worst.delta_per_frame_ms} ms/帧）`)
    if (best) parts.push(`变快最多的是 ${best.name}（${best.delta_per_frame_ms} ms/帧）`)
    lines.push(`${THREAD_LABELS[k]}${parts.join('，')}。`)
  }

  return {
    success: true,
    action: 'compare',
    baseline_frames: before,
    current_frames: after,
    threads: diffs,
    message: lines.join('')
  }
}

export function createInsightsTraceTool(): V2Tool {
  return defineV2Tool({
    description: `Unreal Insights：录 trace、分析、对比两次录制。
action="capture" 录一段逐帧 CPU/GPU 事件的 trace，交出 .utrace 路径；
action="analyze" 把 .utrace 无头分析，按游戏线程 / 渲染线程 / GPU 分别给出最耗时的计时器；
action="compare" 分析两份 .utrace（baseline_utrace_path 是改之前，utrace_path 是改之后），按每帧耗时列出变慢和变快最多的。

【什么时候用】问题比「哪个子系统慢」更细——「具体是哪个函数、哪个渲染 Pass 花的时间」，
或者「我改了之后到底快没快」。大多数「是不是卡顿」「瓶颈在 CPU 还是 GPU」的问题
ue_capture_perf_trace 就能回答，而且快得多、没有额外依赖；先用它，只在需要事件级细节时才来这里。

【capture】
- duration_seconds：录制时长，默认 10，最长 120。**调用会同步等待这么久**，60 秒以上先跟用户说一句
- channels：默认 cpu,gpu,frame,bookmark。不清楚要不要改就用默认值
- 只录不分析：单独调这一步用户什么数字都看不到，录完接着 analyze
- 要做前后对比：改之前录一份，改之后做同样的操作再录一份，两份的路径都留着

【analyze】
- utrace_path：必填，通常就是 capture 返回的 utrace_path
- start_seconds / end_seconds：可选，只看 trace 里这一段（秒，从 trace 开头算）。整段里混着加载、进 PIE 时用它避开
- 返回：游戏线程的帧统计（平均 / 中位 / 最长一帧）；三条线程各自「自身耗时」最多的计时器；
  游戏线程上单次最长的几件事（卡顿尖刺的嫌疑人）
- 等待类计时器（WaitForTasks 之类）不进排行，单独给合计 —— 那是线程在等别人，不是它自己慢
- 每帧耗时一律按游戏线程的帧数摊，GPU 也是；编辑器里 GPU 帧数和游戏帧数可能对不上，报数时说明「按游戏帧摊」
- 给了 90 秒超时，比录制慢

【compare】
- baseline_utrace_path 和 utrace_path 都必填；两份依次分析，不并行，免得和编辑器抢 CPU
- 按每帧自身耗时对齐比较，录制时长不同也能比；变化小于 0.05 ms/帧的不报
- 两次录的操作不一样（一次停在菜单、一次在跑图），比出来的差别没有意义 —— 报之前先确认是同一段操作

【已知的局限，如实说】
- Insights 的这条 CLI 导出路径社区反馈过偶发空文件，不总能复现；遇到时错误信息里会说明，
  不是这个工具的 bug，提议重录一次而不是凭空编数字
- 只有计时器统计。内存（Memory Insights）和资产加载（Asset Loading Insights）引擎没有提供命令行导出：
  channels 里加 memory / loadtime 能录下来，但要用户自己在 Unreal Insights 里打开看`,

    inputSchema: InsightsTraceSchema,

    execute: async (input) =>
      input.action === 'capture'
        ? runCapture(input)
        : input.action === 'compare'
          ? runCompare(input)
          : runAnalyze(input)
  })
}
