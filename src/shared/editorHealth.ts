/**
 * 状态监控：插件报来的原始测量 → 一张带预期值、好坏判定的清单。
 *
 * 主进程（AI 工具、界面 IPC）和渲染层（面板）共用这份类型；判定只在这里做一次。
 *
 * ## 预期值从哪来
 *
 * 全部照抄 Epic「编辑器诊断」窗口的默认值（5.5 EditorPerformanceModule.cpp 顶部那一串
 * `*KPILimit`），不自己编。Epic 没给预期的项（插件数、缓存占盘）只显示数值、不判好坏。
 * Epic 的核数 ≥ 32、总内存 ≥ 64 GB 两项没搬：那是在评硬件，16 核的机器会常年亮黄灯，
 * 对「现在编辑器状况怎样」没有信息量。
 *
 * ## 为什么阈值不放插件里
 *
 * 插件只报原始测量。阈值放这边，改了不用重新出 9 个引擎版本的插件包。
 */

export type EditorHealthGroup = 'startup' | 'pie' | 'cache' | 'memory'

export type EditorHealthItemId =
  | 'startup'
  | 'assetRegistry'
  | 'pluginCount'
  | 'editorHitch'
  | 'pieFirstEnter'
  | 'pieEnter'
  | 'pieHitch'
  | 'localCacheHit'
  | 'cacheDisk'
  | 'availableMemory'

export type EditorHealthUnit = 'seconds' | 'percent' | 'count' | 'gb' | 'bytes'

/**
 * - good / bad：有预期值，且数据够下结论
 * - none：没有预期值，只显示数值
 * - pending：还没有数据（没进过 PIE、采样太少）
 * - unsupported：这个引擎版本拿不到
 */
export type EditorHealthStatus = 'good' | 'bad' | 'none' | 'pending' | 'unsupported'

export interface EditorHealthExpect {
  op: '<' | '>' | '>='
  value: number
}

export interface EditorHealthItem {
  id: EditorHealthItemId
  group: EditorHealthGroup
  value: number | null
  unit: EditorHealthUnit
  expect: EditorHealthExpect | null
  status: EditorHealthStatus
}

/** 主进程交给界面和 AI 工具的结果 */
export type EditorHealthResult =
  | { status: 'ok'; report: EditorHealthReport; raw: EditorHealthRaw }
  /** 插件是这条命令加进来之前的版本 —— 界面提示更新插件，不当成出错 */
  | { status: 'plugin_outdated' }
  | { status: 'not_connected' }
  | { status: 'error'; error: string }

export interface EditorHealthReport {
  items: EditorHealthItem[]
  /** status === 'bad' 的个数，按钮上的数字 */
  issueCount: number
}

/** 插件 system.get_editor_health 的响应。字段缺了按 null 处理 */
export interface EditorHealthRaw {
  startup_seconds?: number | null
  asset_registry_seconds?: number | null
  asset_registry_done_before_collector?: boolean
  enabled_plugin_count?: number | null
  editor_hitch_pct?: number | null
  editor_hitch_samples?: number
  pie_hitch_pct?: number | null
  pie_hitch_samples?: number
  pie_first_enter_seconds?: number | null
  pie_last_enter_seconds?: number | null
  pie_enter_count?: number
  ddc_supported?: boolean
  local_ddc_hit_pct?: number | null
  local_ddc_lookups?: number | null
  available_memory_gb?: number | null
  total_memory_gb?: number | null
}

/**
 * 卡顿率至少要多少个有焦点的采样（0.1 秒一个）才算数 —— 10 秒。
 * 刚打开编辑器、一直在别的窗口里干活时，几个采样里碰上一次加载就是 30%。
 */
export const MIN_HITCH_SAMPLES = 100

/** Epic 的默认预期值，单位和 value 一致 */
export const EXPECTS: Partial<Record<EditorHealthItemId, EditorHealthExpect>> = {
  startup: { op: '<', value: 160 },
  assetRegistry: { op: '<', value: 140 },
  editorHitch: { op: '<', value: 25 },
  pieFirstEnter: { op: '<', value: 220 },
  pieEnter: { op: '<', value: 40 },
  pieHitch: { op: '<', value: 25 },
  localCacheHit: { op: '>', value: 85 },
  availableMemory: { op: '>=', value: 16 }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function meets(value: number, expect: EditorHealthExpect): boolean {
  if (expect.op === '<') return value < expect.value
  if (expect.op === '>') return value > expect.value
  return value >= expect.value
}

function item(
  id: EditorHealthItemId,
  group: EditorHealthGroup,
  unit: EditorHealthUnit,
  value: number | null,
  opts: { pending?: boolean; unsupported?: boolean } = {}
): EditorHealthItem {
  const expect = EXPECTS[id] ?? null
  let status: EditorHealthStatus
  if (opts.unsupported) status = 'unsupported'
  else if (value == null || opts.pending) status = 'pending'
  else if (!expect) status = 'none'
  else status = meets(value, expect) ? 'good' : 'bad'
  return { id, group, value, unit, expect, status }
}

export function evaluateEditorHealth(
  raw: EditorHealthRaw,
  extras: { cacheDiskBytes?: number | null } = {}
): EditorHealthReport {
  const editorSamples = num(raw.editor_hitch_samples) ?? 0
  const pieSamples = num(raw.pie_hitch_samples) ?? 0
  const pieCount = num(raw.pie_enter_count) ?? 0

  const items: EditorHealthItem[] = [
    item('startup', 'startup', 'seconds', num(raw.startup_seconds)),
    item('assetRegistry', 'startup', 'seconds', num(raw.asset_registry_seconds)),
    item('pluginCount', 'startup', 'count', num(raw.enabled_plugin_count)),
    item('editorHitch', 'startup', 'percent', num(raw.editor_hitch_pct), {
      pending: editorSamples < MIN_HITCH_SAMPLES
    }),
    item('pieFirstEnter', 'pie', 'seconds', num(raw.pie_first_enter_seconds)),
    // 只进过一次时「最近一次」就是「首次」，重复报一行没有信息
    item('pieEnter', 'pie', 'seconds', pieCount >= 2 ? num(raw.pie_last_enter_seconds) : null),
    item('pieHitch', 'pie', 'percent', num(raw.pie_hitch_pct), {
      pending: pieSamples < MIN_HITCH_SAMPLES
    }),
    item('localCacheHit', 'cache', 'percent', num(raw.local_ddc_hit_pct), {
      unsupported: raw.ddc_supported === false
    }),
    item('cacheDisk', 'cache', 'bytes', num(extras.cacheDiskBytes)),
    item('availableMemory', 'memory', 'gb', num(raw.available_memory_gb))
  ]
  return { items, issueCount: items.filter((i) => i.status === 'bad').length }
}
