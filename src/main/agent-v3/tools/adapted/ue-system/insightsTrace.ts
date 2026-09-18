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
 * 两条执行路径**原样保留**，只是共用一个入口：
 *
 * - `capture`：让插件在引擎内录 `duration_seconds` 秒，交出 .utrace 路径。
 *   录制前先尝试把编辑器窗口拉到前台（见 foregroundEditorWindow.ts）——窗口被挡在
 *   后面时录出来的渲染线程和 GPU 事件是空的，而且录完还要再分析一遍才知道白录了。
 * - `analyze`：在宿主机上跑随引擎分发的 `UnrealInsights.exe`
 *   （`-NoUI -AutoQuit -ExecOnAnalysisCompleteCmd=...`），导出计时器统计并解析成排行。
 *   .utrace 是逐帧 CPU/GPU 事件的二进制格式，解析它要 TraceAnalysis 那一整套库，
 *   插件里现有的命令没有一个需要它 —— 引擎自带的分析器已经写好了，我们只要会调。
 *
 * ## analyze 已知的脆弱点（如实说，不是没验证过就往下写）
 *
 * 1. Epic 论坛上有用户报告过导出结果是空 CSV——不是每次都能复现，原因不明。
 *    遇到空文件时要如实告诉用户这是 Insights CLI 一个没有稳定复现条件的已知问题。
 * 2. 导出命令有自己的参数解析器，CSV 路径需要单独加引号以保留空格。
 * 3. `TimingInsights.ExportTimerStatistics` 的列名没有官方文档。解析时不假设具体列名，
 *    用启发式找「名字列」和「总计列」，找不到就把原始列名如实回给调用方。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import * as fs from 'fs'
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
import {
  parseGenericCsv,
  pickColumn,
  rankRows,
  TIMER_NAME_PATTERNS,
  TIMER_VALUE_PATTERNS
} from './insightsCsv'

export const INSIGHTS_TRACE_TOOL_NAME = 'ue_insights_trace'

const DEFAULT_DURATION_SECONDS = 10
const DEFAULT_CHANNELS = 'cpu,gpu,frame,bookmark'

const InsightsTraceSchema = z.object({
  action: z
    .enum(['capture', 'analyze'])
    .describe(
      'capture=在引擎里录一段 trace，交出 .utrace；analyze=把已有的 .utrace 跑一次无头分析'
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
        '需要内存分配轨迹时可以加 memory（开销明显更大）'
    ),
  utrace_path: z
    .string()
    .optional()
    .describe('analyze 用（必填）：.utrace 文件路径，通常来自 capture 返回的 utrace_path')
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

function runInsightsExport(
  exePath: string,
  utracePath: string,
  outCsvPath: string,
  timeoutMs: number
): Promise<ExportRunResult> {
  return new Promise((resolve) => {
    const args = [
      `-OpenTraceFile=${utracePath}`,
      '-NoUI',
      '-AutoQuit',
      '-log',
      `-ExecOnAnalysisCompleteCmd=TimingInsights.ExportTimerStatistics "${outCsvPath.replace(/"/g, '\\"')}"`
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
}

async function runAnalyze(input: InsightsTraceInput): Promise<Record<string, unknown>> {
  const utrace_path = input.utrace_path
  console.log('[InsightsTraceTool] analyze:', { utrace_path })

  if (!utrace_path) {
    return {
      success: false,
      error:
        'action="analyze" 必须给 utrace_path —— 通常来自 action="capture" 返回的 utrace_path。' +
        '还没录的话先 capture。'
    }
  }
  if (!utrace_path.toLowerCase().endsWith('.utrace')) {
    return {
      success: false,
      error: `需要一个 .utrace 文件路径，通常来自 ${INSIGHTS_TRACE_TOOL_NAME}(action="capture") 的 utrace_path。`
    }
  }

  try {
    await fs.promises.access(utrace_path, fs.constants.F_OK)
  } catch {
    return { success: false, error: `文件不存在：${utrace_path}` }
  }

  const resolved = await resolveUnrealInsightsExe()
  if ('error' in resolved) {
    return { success: false, error: resolved.error }
  }

  const outCsvPath = utrace_path.replace(/\.utrace$/i, '.timerstats.csv')
  // 导出前先清掉旧文件——UnrealInsights 分析失败时不一定会覆盖，
  // 留着旧文件的话我们会读到上一次的结果却以为是这一次的
  await fs.promises.rm(outCsvPath, { force: true }).catch(() => {})

  const since = Date.now()
  const run = await runInsightsExport(resolved.exePath, utrace_path, outCsvPath, 90000)
  if (run.timedOut) {
    return {
      success: false,
      error: 'UnrealInsights.exe 处理超时（90 秒），已终止进程。trace 文件可能太大或太长。'
    }
  }
  // 先看有没有导出文件，再论退出码：UE 的程序走 RequestEngineExit 关掉时
  // 经常回非零，但 CSV 已经好好写出来了。倒过来判会把能用的结果判成失败。
  let csvText: string
  try {
    csvText = await fs.promises.readFile(outCsvPath, 'utf-8')
  } catch {
    if (run.code !== 0) {
      return {
        success: false,
        error: `Unreal Insights 退出码 ${run.code ?? 'signal'}，也没有产出导出文件。${run.stderr.slice(-1000)}`
      }
    }
    return {
      success: false,
      error:
        'UnrealInsights.exe 跑完了但没有生成导出文件。这是 Insights CLI 导出路径的一个已知问题' +
        '（社区反馈过偶发空结果，原因不明，不是这个工具的 bug）。可以重新采集再试一次，' +
        `或者自己在 Unreal Insights 里打开 ${utrace_path} 查看。` +
        (run.stderr ? `\n\n进程输出：${run.stderr.slice(-500)}` : '')
    }
  }

  try {
    await assertFreshFile(outCsvPath, since)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
  const table = parseGenericCsv(csvText)
  if (!table || table.rows.length === 0) {
    return {
      success: false,
      error: '导出文件是空的（同样是 Insights CLI 的已知问题，见上）。请重新采集再试一次。',
      export_csv_path: outCsvPath
    }
  }

  const nameColumn = pickColumn(table.columns, TIMER_NAME_PATTERNS)
  const valueColumn = pickColumn(table.columns, TIMER_VALUE_PATTERNS)
  const { sortedBy, topEntries } = rankRows(table, valueColumn, 30)

  return {
    success: true,
    action: 'analyze',
    export_csv_path: outCsvPath,
    columns: table.columns,
    row_count: table.rows.length,
    malformed_row_count: table.malformedRowCount,
    name_column: nameColumn,
    sorted_by: sortedBy,
    top_entries: topEntries,
    message: valueColumn
      ? `导出了 ${table.rows.length} 行，按「${valueColumn}」列排序取前 ${topEntries.length} 条。`
      : `导出了 ${table.rows.length} 行，但没能自动识别出"总耗时"列，原样列出前 ${topEntries.length} 行——` +
        `列名是：${table.columns.join('、')}。`
  }
}

export function createInsightsTraceTool(): V2Tool {
  return defineV2Tool({
    description: `Unreal Insights 两步走：action="capture" 录一段逐帧 CPU/GPU 事件的 trace，
交出 .utrace 路径；action="analyze" 把 .utrace 跑一次无头分析，导出计时器统计并排行。

【什么时候用】问题比「哪个子系统慢」更细——「具体是哪个函数、哪个渲染 Pass 花的时间」。
大多数「是不是卡顿」「瓶颈在 CPU 还是 GPU」的问题 ue_capture_perf_trace 就能回答，
而且快得多、没有额外依赖；先用它，只在需要事件级细节时才来这里。

【capture】
- duration_seconds：录制时长，默认 10，最长 120。**调用会同步等待这么久**，60 秒以上先跟用户说一句
- channels：默认 cpu,gpu,frame,bookmark。不清楚要不要改就用默认值
- 只录不分析：单独调这一步用户什么数字都看不到，录完接着 analyze

【analyze】
- utrace_path：必填，通常就是 capture 返回的 utrace_path
- 用已连接项目的引擎版本找到对应的 UnrealInsights.exe（本机装了哪些引擎、在哪个盘，工具自己解析）
- 无头跑一次，导出计时器统计表，按耗时排序回前 30 条
- 要启动 Unreal Insights 处理整个 trace，比录制慢，给了 90 秒超时

【analyze 已知的局限，如实说】
- Insights 的这条 CLI 导出路径社区反馈过偶发空文件，不总能复现；遇到时错误信息里会说明，
  不是这个工具的 bug，提议重录一次而不是凭空编数字
- 导出表的列名没有官方文档，按名字模式启发式找「计时器名」和「总耗时」两列，
  找不到会把原始列名如实列出来
- 只导出计时器统计（谁在花时间），没有线程分布和内存——那两类要用户自己在 Unreal Insights 里打开看`,

    inputSchema: InsightsTraceSchema,

    execute: async (input) => (input.action === 'capture' ? runCapture(input) : runAnalyze(input))
  })
}
