/**
 * 把 Insights 按线程导出的计时器统计整理成「每条线程上谁在花时间」，以及两次录制的对比。
 *
 * 纯数据处理，不碰进程和文件 —— 测试直接喂 CSV 文本。
 *
 * ## 为什么按线程拆，而不是一张总表排行
 *
 * 一张总表里排第一的是 `WaitForTasks`（实测 47 MB 的 trace 里 91 秒）—— 那是线程
 * 在空等别的线程，不是在干活。游戏线程、渲染线程、GPU 的计时器混在一起排，
 * 回答不了「瓶颈在哪条线」，而这正是用户最先要问的。
 *
 * ## 引擎导出的一个怪癖：GPU 计时器总是混进来
 *
 * `TimingInsights.ExportTimerStatistics -threads=GameThread` 导出的表里照样有
 * ShadowDepths、DistanceFields 这些 GPU 计时器，数值和别的导出一模一样 ——
 * 引擎在导出时把 `IncludeGpu` 写死成 true（5.5 源码 TimingExporter.cpp）。
 * 所以要单独导一份 `-threads="GPU*"`（没有 CPU 线程叫这个名字，剩下的就只有 GPU），
 * 再从 CPU 的两份里把名字、次数、耗时都相同的行减掉。
 *
 * ## 列名
 *
 * `Name,Count,Incl,I.Min,I.Max,I.Avg,I.Med,Excl,E.Min,E.Max,E.Avg,E.Med`，单位秒。
 * 取自界面列的短名（MemTagTreeViewColumnFactory / TimerTreeView），5.1–5.5 源码一致。
 * 缺列就如实报缺了哪几列，不退回去猜。
 */

import type { ParsedInsightsTable } from './insightsCsv'

export const REQUIRED_COLUMNS = ['Name', 'Count', 'Incl', 'Excl', 'E.Max'] as const

export interface TimerRow {
  name: string
  count: number
  /** 以下单位都是秒 */
  incl: number
  excl: number
  exclMax: number
  inclAvg: number | null
  inclMed: number | null
  inclMax: number | null
}

export type ThreadKey = 'game' | 'render' | 'gpu'

export const THREAD_LABELS: Record<ThreadKey, string> = {
  game: '游戏线程',
  render: '渲染线程',
  gpu: 'GPU'
}

function num(v: string | undefined): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function missingColumns(table: ParsedInsightsTable): string[] {
  return REQUIRED_COLUMNS.filter((c) => !table.columns.includes(c))
}

export function toTimerRows(table: ParsedInsightsTable): TimerRow[] {
  return table.rows.map((r) => ({
    name: r['Name'] ?? '',
    count: num(r['Count']) ?? 0,
    incl: num(r['Incl']) ?? 0,
    excl: num(r['Excl']) ?? 0,
    exclMax: num(r['E.Max']) ?? 0,
    inclAvg: num(r['I.Avg']),
    inclMed: num(r['I.Med']),
    inclMax: num(r['I.Max'])
  }))
}

const rowKey = (r: TimerRow): string => `${r.name}\u0000${r.count}\u0000${r.excl}`

/** 从 CPU 线程的导出里减掉引擎硬塞进来的 GPU 行 */
export function subtractGpuRows(cpu: TimerRow[], gpu: TimerRow[]): TimerRow[] {
  const gpuKeys = new Set(gpu.map(rowKey))
  return cpu.filter((r) => !gpuKeys.has(rowKey(r)))
}

/**
 * 不是计时器的行：GPU 的「Unaccounted - Frame: N」、渲染线程的「Frame 72844」。
 * 每帧一行、各自只出现一两次，留着会把排行挤成一串帧号。
 */
export function isNoiseTimer(name: string): boolean {
  return /^Unaccounted\b/i.test(name) || /^Frame \d+$/.test(name)
}

/**
 * 泛泛的任务同步等待：线程在等别的任务跑完，耗时算不到它自己头上。
 * 单独汇总，不进「谁在干活」的排行。
 *
 * 用名单而不是「名字里带 Wait 就算」：`BlockOnShaderMapCompletion`（等着色器编译）、
 * `UWorld::BlockTillLevelStreamingCompleted`（等关卡流送）、`WaitForGatherDynamicMeshElements`
 * 这些也是在等，但它们**说出了在等什么** —— 那正是卡顿的原因，必须留在排行里。
 * 名单取自一份真实 5.5 trace 里所有带 Wait 的计时器。
 */
const TASK_WAIT_TIMERS = new Set([
  'WaitForTasks',
  'WaitUntilTasksComplete',
  'GameThreadWaitForTask',
  'Tasks::Wait',
  'ParallelFor.Wait',
  'ParallelExecute (Await)',
  'SyncPoint_Wait',
  'Submission_Wait'
])

export function isWaitTimer(name: string): boolean {
  return TASK_WAIT_TIMERS.has(name) || /^FTaskBase::Wait/.test(name) || /^FPipe::Wait/.test(name)
}

/** 游戏线程的「一帧」外壳，排行里没有信息量（自身耗时几乎为零） */
const FRAME_SHELLS = new Set(['Frame', 'FEngineLoop::Tick'])

export interface FrameStats {
  frames: number
  avg_ms: number | null
  median_ms: number | null
  max_ms: number | null
}

/** 秒 → 毫秒，保留两位小数。只留一位时会出现「0.3 → 0.3，变化 +0.1」这种自相矛盾的读数 */
const ms = (s: number | null): number | null => (s == null ? null : Math.round(s * 100000) / 100)

/** 游戏线程的 `Frame` 计时器：一帧一次，Incl 就是帧耗时 */
export function frameStats(game: TimerRow[]): FrameStats | null {
  const frame = game.find((r) => r.name === 'Frame')
  if (!frame || frame.count <= 0) return null
  return {
    frames: frame.count,
    avg_ms: ms(frame.inclAvg ?? frame.incl / frame.count),
    median_ms: ms(frame.inclMed),
    max_ms: ms(frame.inclMax)
  }
}

export interface TimerEntry {
  name: string
  count: number
  /** 自身耗时（不含子计时器）合计 */
  excl_total_ms: number
  /** 按游戏线程帧数摊到每帧；没有帧数时为 null */
  excl_per_frame_ms: number | null
  /** 单次最长的一次自身耗时 —— 看卡顿尖刺用 */
  excl_max_ms: number
}

export interface ThreadSummary {
  top: TimerEntry[]
  /** 等待类计时器的自身耗时合计 */
  wait_total_ms: number
  timer_count: number
}

function entry(r: TimerRow, frames: number | null): TimerEntry {
  return {
    name: r.name,
    count: r.count,
    excl_total_ms: ms(r.excl) ?? 0,
    excl_per_frame_ms: frames ? ms(r.excl / frames) : null,
    excl_max_ms: ms(r.exclMax) ?? 0
  }
}

/** 真正在干活的行：去掉噪声、等待和帧外壳 */
function workRows(rows: TimerRow[]): TimerRow[] {
  return rows.filter(
    (r) => !isNoiseTimer(r.name) && !isWaitTimer(r.name) && !FRAME_SHELLS.has(r.name)
  )
}

export function summarizeThread(
  rows: TimerRow[],
  frames: number | null,
  limit: number
): ThreadSummary {
  const waitTotal = rows.filter((r) => isWaitTimer(r.name)).reduce((s, r) => s + r.excl, 0)
  const top = workRows(rows)
    .sort((a, b) => b.excl - a.excl)
    .slice(0, limit)
    .map((r) => entry(r, frames))
  return { top, wait_total_ms: ms(waitTotal) ?? 0, timer_count: rows.length }
}

/** 游戏线程上单次最长的几件事 —— 卡顿尖刺的嫌疑人 */
export function gameThreadSpikes(
  game: TimerRow[],
  frames: number | null,
  limit: number
): TimerEntry[] {
  return workRows(game)
    .sort((a, b) => b.exclMax - a.exclMax)
    .slice(0, limit)
    .map((r) => entry(r, frames))
}

export interface TimerDelta {
  name: string
  baseline_per_frame_ms: number
  current_per_frame_ms: number
  delta_per_frame_ms: number
}

export interface ThreadDiff {
  regressions: TimerDelta[]
  improvements: TimerDelta[]
}

/**
 * 两次录制按「每帧自身耗时」对齐后比较。
 *
 * 录制时长不同，总耗时没法直接比；摊到每帧才是同一把尺子。
 * 只在一边出现的计时器按另一边为 0 算 —— 新冒出来的开销正是要找的东西。
 */
export function diffThread(
  baseline: TimerRow[],
  current: TimerRow[],
  baselineFrames: number,
  currentFrames: number,
  limit: number
): ThreadDiff {
  const perFrame = (rows: TimerRow[], frames: number): Map<string, number> => {
    const m = new Map<string, number>()
    for (const r of workRows(rows)) m.set(r.name, (m.get(r.name) ?? 0) + r.excl / frames)
    return m
  }
  const a = perFrame(baseline, baselineFrames)
  const b = perFrame(current, currentFrames)
  const deltas: TimerDelta[] = []
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(name) ?? 0
    const after = b.get(name) ?? 0
    deltas.push({
      name,
      baseline_per_frame_ms: ms(before) ?? 0,
      current_per_frame_ms: ms(after) ?? 0,
      delta_per_frame_ms: ms(after - before) ?? 0
    })
  }
  // 变化不到 0.05 ms/帧的算噪声
  const significant = deltas.filter((d) => Math.abs(d.delta_per_frame_ms) >= 0.05)
  return {
    regressions: significant
      .filter((d) => d.delta_per_frame_ms > 0)
      .sort((x, y) => y.delta_per_frame_ms - x.delta_per_frame_ms)
      .slice(0, limit),
    improvements: significant
      .filter((d) => d.delta_per_frame_ms < 0)
      .sort((x, y) => x.delta_per_frame_ms - y.delta_per_frame_ms)
      .slice(0, limit)
  }
}
