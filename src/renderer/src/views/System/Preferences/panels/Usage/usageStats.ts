/**
 * Token 用量统计：从**已经存在的对话记录**里算，不新开一套埋点。
 *
 * ## 为什么只数 token，不算钱
 *
 * 单价随模型和厂商促销一直在变，手上那个 cost 只是每一轮回包时的快照，
 * 加起来既不等于账单也没法核对。给一个对不上的金额，比不给更糟。
 *
 * ## 为什么不记流水
 *
 * 每一轮的真实用量本来就随消息落盘（`responseMetadata.usage`，来自厂商回包），
 * 工具调用和用过的技能也在同一条消息上。再写一份流水表意味着：一套 schema、
 * 一次迁移、以及两份会对不上的数字 —— 而对不上的时候，用户信哪一份？
 *
 * 从对话记录算的代价是诚实的：**删了对话，它的用量也跟着不见**。这符合
 * AGENTS.md 硬规则 10（用户自己的东西，盘上那份是唯一真相源），也符合社区版
 * 的承诺 —— 没有一份你删不掉的影子账本。
 *
 * ## 为什么不上报
 *
 * 全在本地算，一个字节都不出这台机器。社区版不许有遥测（AGENTS.md §1）。
 *
 * ## 为什么要如实报告「算不出来的那部分」
 *
 * 老会话没有用量字段，报错中断的那一轮也没有。把它们悄悄跳过的话，总数会
 * 偏小，而用户拿它去对厂商账单只会更困惑。所以单独数出来摆在旁边。
 *
 * ## 为什么不只有 token
 *
 * 「这台电脑跑掉了多少 token」回答不了用户真正会问的三个问题：**哪个工具在拖后腿、
 * AI 到底动了我多少东西、钱花在哪个工程上**。这三样在对话记录里本来就全有 ——
 * 工具调用带着成败和时间戳，改动台账（`responseMetadata.changes`）带着风险等级和
 * 可撤销性，会话带着它归属的 UE 工程。只数 token 等于把这些一起扔了。
 */

import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import type { AgentProcessItem } from '@renderer/views/Assistant/components/AgentProcessLog.types'

/** 一天的汇总。`date` 是 `YYYY-MM-DD`（本地时区） */
export interface UsageDay {
  date: string
  /** 四项之和，含缓存命中 */
  tokens: number
  /**
   * 其中命中缓存读掉的那部分。
   *
   * 单独留一份，是因为它的单价通常只有新输入的十分之一 —— 混在 `tokens` 里
   * 画柱状图，柱子高低反映的是「今天缓存读了多少」，而不是「今天花了多少」。
   */
  cacheRead: number
  turns: number
  /** 这天真的落地的改动条数 */
  changes: number
}

export interface UsageCount {
  name: string
  count: number
}

/**
 * 「这一天算什么」。
 *
 * 定义在这里而不是界面里：柱状图和热力图问的是同一个问题，只是窗口长短不同。
 * 两边各写一份 switch，迟早会有一边先加了新指标。
 *
 * `uncached` 而不是「全部 token」：缓存命中经常占到总量的九成以上，而它的单价
 * 低一个数量级。按总量画出来的那张图，看着像是「这天特别忙」，实际只是「这天
 * 前缀没被打掉，缓存一直在命中」—— 那恰恰是最省钱的一天。
 */
export type UsageMetric = 'uncached' | 'turns' | 'changes'

export const USAGE_METRICS: readonly UsageMetric[] = ['uncached', 'turns', 'changes']

export function metricValue(day: UsageDay, metric: UsageMetric): number {
  if (metric === 'turns') return day.turns
  if (metric === 'changes') return day.changes
  return uncachedOf(day)
}

/**
 * 不含缓存命中的 token。
 *
 * 写成一个函数而不是在各处减一次：柱状图、热力图、按工程表格都要这个口径，
 * 减错一个地方就会出现两个对不上的「Token」。
 *
 * **写入缓存算在里面**：它按比新输入还高的单价收钱（Anthropic 是 1.25 倍），
 * 只有命中读取才是便宜的那部分。
 */
export function uncachedOf(entry: { tokens: number; cacheRead: number }): number {
  return Math.max(0, entry.tokens - entry.cacheRead)
}

/** 看多久。`today` 只看今天，`all` 覆盖本机现存的全部对话记录 */
export type UsageRange = 'today' | 'week' | 'month' | 'all'

export const USAGE_RANGES: readonly UsageRange[] = ['today', 'week', 'month', 'all']

/**
 * 一个档位往回看几天（含今天）。
 *
 * `all` 没有固定天数，交给报告生成器从最早一条有日期的助手消息算起。
 */
export function rangeDays(range: UsageRange): number | 'all' {
  if (range === 'today') return 1
  if (range === 'week') return 7
  if (range === 'month') return 30
  return 'all'
}

export interface UsageTotals {
  tokens: number
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 工具调用总次数。它不依赖用量字段，老会话也数得出来 */
  toolCalls: number
}

/**
 * 一个工具的表现。
 *
 * 光有「调了多少次」看不出问题在哪：一个调了 300 次的工具，是 300 次都成了，
 * 还是有 80 次报错？后者才是要修的东西。
 */
export interface UsageTool {
  name: string
  calls: number
  /** 返回 `isError` 的次数 */
  failed: number
  /**
   * 从发起到返回的**中位**耗时（毫秒）。一次都没配对上就是 null。
   *
   * 取中位数而不是平均：这段时间里**包含等用户点审批弹窗的时间**（工具调用事件
   * 在审批之前就发出去了），个别几次动辄好几分钟。平均值会被它们拽飞，中位数不会。
   */
  medianMs: number | null
}

export interface UsageSkill {
  name: string
  count: number
  /** 老记录没存来源，那就是 `unknown` —— 不猜 */
  source: 'user' | 'builtin' | 'unknown'
}

/**
 * AI 这段时间替用户干了多少活。
 *
 * 来自每一轮落盘的改动台账（`responseMetadata.changes`），只读操作不在里面。
 *
 * ## 为什么不数「破坏性」和「撤不回」
 *
 * 一度这里还统计 `risk === 'destructive'` 和 `reversible === false` 两项。
 * **那两个数会对用户说假话**：`destructive` 是**审批档位**，判据写在
 * `tools/registry.ts` —— 「撤销栈接不住，所以每次都要问」。`ue_run_python_script`
 * 就在这一档，而它绝大多数时候只是读几个属性、设几个值。把它按次累加成一个
 * 红色的「破坏性 436」，等于对着用户的工程宣布 AI 破坏了 436 个东西，而那
 * 根本没发生。`reversible: false` 同理，说的是「我们没有撤销记录」，不是
 * 「你丢了东西」。
 *
 * 这两件事真正该出现的地方是**动手之前的审批弹窗**，那时候它能改变用户的决定；
 * 事后累计成计分板只剩下吓人。
 *
 * ## 为什么失败数只留一句话
 *
 * 「一共失败了多少次」对用户不可行动 —— 他没法拿这个数做任何事。可行动的版本
 * 是**按工具分**的失败率（见 `UsageTool.failed`），它直接指向该修哪个工具。
 * 所以这里只留一个总数，界面上放在脚注里说明「上面那个总数不含它们」，
 * 不做成卡片。
 */
export interface UsageChanges {
  /** 真的落地的条数 */
  total: number
  /**
   * 落地的改动一共涉及多少个**不同的**对象。
   *
   * 同一个材质被改了十次是一处资产不是十处，「动了多少东西」得看这个数。
   * 认不出目标的那些（命令行、Python 脚本，参数里没有资产路径）不计入 ——
   * 宁可少算，也不要把一次脚本调用当成一个新资产。
   */
  targets: number
  /** 想改但那一步失败了的条数。和 `total` 相加才是台账的全长 */
  failed: number
  /** 按工具排的改动条数，降序；只数落地的 */
  byTool: UsageCount[]
}

/** 一个 UE 工程上花掉的东西。`name` 为空串表示这些会话没绑工程 */
export interface UsageProject {
  name: string
  tokens: number
  /** 其中缓存命中的部分，口径同 `UsageDay.cacheRead` */
  cacheRead: number
  turns: number
  changes: number
}

export interface UsageReport {
  /** 窗口内每一天，**含没有任何活动的那些天** —— 柱状图要看得出空档 */
  days: UsageDay[]
  totals: UsageTotals
  /** 工具表现，按调用次数降序 */
  tools: UsageTool[]
  /** 技能加载次数，降序 */
  skills: UsageSkill[]
  changes: UsageChanges
  /** 按 UE 工程分组，按 token 降序 */
  projects: UsageProject[]
  /**
   * 窗口内有多少轮回复算不出用量（老会话没这个字段、或者那一轮中断了）。
   * 摆出来让用户知道上面的总数不是全部。
   */
  /**
   * 落不进任何一天的轮次。
   *
   * 2026-09-17 起**界面上不再显示**：一句「有 72 轮缺少用量记录」对用户没有任何
   * 可做的事，只是在总览底下吊一条自我怀疑。留着这个字段是因为它是这份报告
   * 对自己口径的自述 —— 排查「数字为什么对不上」时第一个要看的就是它。
   */
  turnsWithoutUsage: number
}

/** 本地时区的 `YYYY-MM-DD`。用 UTC 的话，晚上八点之后的活会记到明天 */
export function toLocalDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 从今天往回数 `days` 天的日期键，升序。含今天 */
function dateWindow(now: number, days: number): string[] {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const keys: string[] = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(start)
    day.setDate(day.getDate() - offset)
    keys.push(toLocalDateKey(day.getTime()))
  }
  return keys
}

/** 全量档从最早一条有效助手消息铺到今天；没有记录时仍保留今天这一格 */
function allTimeDateWindow(messagesBySid: Record<string, ChatMessage[]>, now: number): string[] {
  const todayKey = toLocalDateKey(now)
  let earliestKey = todayKey

  for (const messages of Object.values(messagesBySid ?? {})) {
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      if (message?.role !== 'assistant') continue
      if (typeof message.startTime !== 'number' || !Number.isFinite(message.startTime)) continue
      const dateKey = toLocalDateKey(message.startTime)
      if (dateKey <= todayKey && dateKey < earliestKey) earliestKey = dateKey
    }
  }

  const [year, month, day] = earliestKey.split('-').map(Number)
  const cursor = new Date(year, month - 1, day)
  const keys: string[] = []
  while (toLocalDateKey(cursor.getTime()) <= todayKey) {
    keys.push(toLocalDateKey(cursor.getTime()))
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

function readToolName(item: AgentProcessItem): string {
  // 形状和 `changeSummary.ts` 的 `readToolCall` 一致：历史条目有两种写法，
  // 都要认。只取名字，参数在这里没用
  const data = item.data as { function?: { name?: unknown }; name?: unknown } | undefined
  if (typeof data?.function?.name === 'string') return data.function.name
  if (typeof data?.name === 'string') return data.name
  return ''
}

function bump(counts: Map<string, number>, name: string): void {
  if (!name) return
  counts.set(name, (counts.get(name) ?? 0) + 1)
}

function toSortedCounts(counts: Map<string, number>): UsageCount[] {
  return (
    [...counts]
      .map(([name, count]) => ({ name, count }))
      // 次数降序；同次数按名字排，免得每次打开顺序都不一样
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  )
}

/** 单个工具在整个窗口里的累计。中位数要留住每一次的耗时，所以是数组不是和 */
interface ToolAccumulator {
  calls: number
  failed: number
  durations: number[]
}

function toolBucket(map: Map<string, ToolAccumulator>, name: string): ToolAccumulator {
  let bucket = map.get(name)
  if (!bucket) {
    bucket = { calls: 0, failed: 0, durations: [] }
    map.set(name, bucket)
  }
  return bucket
}

/**
 * 一次调用最多认多久。
 *
 * 超过一小时的间隔不可能是工具在跑 —— 只能是审批弹窗挂了一整晚、或者那一轮
 * 被停掉之后配错了对。留着它会把中位数也带偏。
 */
const MAX_TOOL_DURATION_MS = 60 * 60 * 1000

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * 把一条消息里的工具调用和结果配上对。
 *
 * 和 `changeSummary.summarizeChanges` 同样的做法：过程日志的结果项里没有
 * toolCallId，同名工具的第 n 次调用对应第 n 条结果。并行调用同一个工具时
 * 顺序会错配，但错配的只是「哪一次花了多久」，一组耗时的中位数不受影响。
 */
function collectToolStats(items: AgentProcessItem[], into: Map<string, ToolAccumulator>): number {
  const pendingByTool = new Map<string, number[]>()
  let calls = 0

  for (const item of items) {
    if (item?.type === 'tool-call') {
      const name = readToolName(item)
      if (!name) continue

      calls += 1
      toolBucket(into, name).calls += 1

      const queue = pendingByTool.get(name) ?? []
      queue.push(typeof item.timestamp === 'number' ? item.timestamp : Number.NaN)
      pendingByTool.set(name, queue)
      continue
    }

    if (item?.type !== 'tool-result') continue

    const data = item.data as { toolName?: unknown; isError?: unknown } | undefined
    const name = typeof data?.toolName === 'string' ? data.toolName : ''
    if (!name) continue

    const bucket = toolBucket(into, name)
    if (data?.isError === true) bucket.failed += 1

    const startedAt = pendingByTool.get(name)?.shift()
    const endedAt = item.timestamp
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) continue
    if (typeof endedAt !== 'number' || !Number.isFinite(endedAt)) continue

    const elapsed = endedAt - startedAt
    if (elapsed >= 0 && elapsed <= MAX_TOOL_DURATION_MS) bucket.durations.push(elapsed)
  }

  return calls
}

/** 一个工程（或者「没绑工程」那一格）的累计 */
interface ProjectAccumulator {
  tokens: number
  cacheRead: number
  turns: number
  changes: number
}

function projectBucket(map: Map<string, ProjectAccumulator>, name: string): ProjectAccumulator {
  let bucket = map.get(name)
  if (!bucket) {
    bucket = { tokens: 0, cacheRead: 0, turns: 0, changes: 0 }
    map.set(name, bucket)
  }
  return bucket
}

export interface BuildUsageReportOptions {
  /** 往回看几天，含今天；`all` 表示从最早一条现存记录算起 */
  days: number | 'all'
  /** 现在几点。传进来而不是读 `Date.now()`，这样这个函数可测 */
  now: number
  /**
   * 会话 id → 它归属的 UE 工程名。
   *
   * 传一张表而不是整个会话数组：这一页只需要名字，不该为了一个字符串把会话
   * 的类型（连同草稿、图片、权限档）拖进统计层。查不到的会话归到「没绑工程」。
   */
  projectBySid?: Record<string, string>
}

/**
 * 算一份报告。
 *
 * 只看助手消息：用户那条既没有用量也没有工具调用。没有 `startTime` 的消息
 * 落不进任何一天，计入 `turnsWithoutUsage` —— 与其猜一个日期，不如说不知道。
 */
export function buildUsageReport(
  messagesBySid: Record<string, ChatMessage[]>,
  options: BuildUsageReportOptions
): UsageReport {
  const keys =
    options.days === 'all'
      ? allTimeDateWindow(messagesBySid, options.now)
      : dateWindow(options.now, options.days)
  const inWindow = new Set(keys)
  const byDate = new Map<string, UsageDay>(
    keys.map((date) => [date, { date, tokens: 0, cacheRead: 0, turns: 0, changes: 0 }])
  )

  const totals: UsageTotals = {
    tokens: 0,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCalls: 0
  }
  const toolStats = new Map<string, ToolAccumulator>()
  const skillCounts = new Map<string, number>()
  const skillSources = new Map<string, UsageSkill['source']>()
  const changeCounts = new Map<string, number>()
  const changeTargets = new Set<string>()
  const projectStats = new Map<string, ProjectAccumulator>()
  const changes: UsageChanges = {
    total: 0,
    targets: 0,
    failed: 0,
    byTool: []
  }
  let turnsWithoutUsage = 0

  for (const [sid, messages] of Object.entries(messagesBySid ?? {})) {
    if (!Array.isArray(messages)) continue

    const projectName = options.projectBySid?.[sid] ?? ''

    for (const message of messages) {
      if (message?.role !== 'assistant') continue

      const startTime = typeof message.startTime === 'number' ? message.startTime : null
      if (startTime === null) {
        turnsWithoutUsage += 1
        continue
      }

      const date = toLocalDateKey(startTime)
      if (!inWindow.has(date)) continue

      const bucket = byDate.get(date)!
      const project = projectBucket(projectStats, projectName)

      // 工具、技能、改动都不依赖用量字段 —— 老会话没有 usage，但这些记录还在，
      // 那部分统计照样成立
      totals.toolCalls += collectToolStats(message.agentProcess ?? [], toolStats)

      for (const skill of message.responseMetadata?.usedSkills ?? []) {
        const name = skill?.name ?? ''
        if (!name) continue
        bump(skillCounts, name)
        // 同一个技能在不同轮里来源应当一致；第一次见到什么就记什么
        if (!skillSources.has(name)) {
          const source = skill?.source
          skillSources.set(name, source === 'user' || source === 'builtin' ? source : 'unknown')
        }
      }

      for (const change of message.responseMetadata?.changes ?? []) {
        if (!change) continue
        if (change.failed === true) {
          changes.failed += 1
          continue
        }
        changes.total += 1
        bucket.changes += 1
        project.changes += 1
        // 只按目标去重，不带工具名：同一个 Actor 先挪位置再改属性是**一个**东西
        // 被动了两次，不是两个东西。带上工具名会把它算成两处
        const target = typeof change.target === 'string' ? change.target.trim() : ''
        if (target) changeTargets.add(target)
        bump(changeCounts, change.toolName ?? '')
      }

      const usage = message.responseMetadata?.usage
      if (!usage) {
        turnsWithoutUsage += 1
        continue
      }

      bucket.tokens += usage.total
      bucket.cacheRead += usage.cacheRead
      bucket.turns += 1

      project.tokens += usage.total
      project.cacheRead += usage.cacheRead
      project.turns += 1

      totals.tokens += usage.total
      totals.turns += 1
      totals.input += usage.input
      totals.output += usage.output
      totals.cacheRead += usage.cacheRead
      totals.cacheWrite += usage.cacheWrite
    }
  }

  changes.byTool = toSortedCounts(changeCounts)
  changes.targets = changeTargets.size

  const tools: UsageTool[] = [...toolStats]
    .map(([name, stat]) => ({
      name,
      calls: stat.calls,
      failed: stat.failed,
      medianMs: median(stat.durations)
    }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))

  const skills: UsageSkill[] = toSortedCounts(skillCounts).map((entry) => ({
    name: entry.name,
    count: entry.count,
    source: skillSources.get(entry.name) ?? 'unknown'
  }))

  const projects: UsageProject[] = [...projectStats]
    .map(([name, stat]) => ({ name, ...stat }))
    // 完全没活动的分组不占位置：某个工程这七天一次没跑，列出来只是噪音
    .filter((entry) => entry.tokens > 0 || entry.turns > 0 || entry.changes > 0)
    // 按不含缓存的量排，和界面上那一列显示的是同一个数 —— 按总量排的话会出现
    // 「排在前面的那行数字更小」，看起来像排序坏了
    .sort((a, b) => uncachedOf(b) - uncachedOf(a) || a.name.localeCompare(b.name))

  return {
    days: keys.map((date) => byDate.get(date)!),
    totals,
    tools,
    skills,
    changes,
    projects,
    turnsWithoutUsage
  }
}

/**
 * 热力图看多久。
 *
 * 364 = 52 整周。取整周而不是「一年」，是为了让每一列都对齐星期几 ——
 * 差一天，整张图的行就会错位一格，看起来像是周末在上班。
 */
export const HEATMAP_DAYS = 364

/** 一格。`day` 为空表示这格在窗口开始之前（或今天之后），只是用来把列填满 */
export interface HeatmapCell {
  day: UsageDay | null
  /** 0 = 这天没活动；1–4 越深越忙 */
  level: number
}

export interface UsageHeatmap {
  /** 每一列是一周，从周日到周六（和 GitHub 一致） */
  weeks: HeatmapCell[][]
  /** 月份标：`column` 是第几列，`date` 取那一列第一个真实的日子 */
  months: Array<{ column: number; date: string }>
}

/** `YYYY-MM-DD` → 星期几（0 = 周日）。按本地时区解析，别让 `new Date('...')` 走 UTC */
function weekdayOf(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day).getDay()
}

/**
 * 分四档的门槛，取非零那些天的四分位数。
 *
 * **不按最大值等分**：跑飞过一次的那天能顶平时的几十倍，等分之后剩下的
 * 三百多天会全挤在最浅的一档，整张图变成一片灰加一个亮点。四分位数保证
 * 四种深浅都有人用，看得出「忙」和「更忙」的区别。
 */
function quartiles(sortedNonZero: number[]): number[] {
  const at = (ratio: number): number =>
    sortedNonZero[Math.min(sortedNonZero.length - 1, Math.floor(sortedNonZero.length * ratio))]
  return [at(0.25), at(0.5), at(0.75)]
}

function levelOf(value: number, thresholds: number[]): number {
  if (value <= 0) return 0
  return thresholds.reduce((level, threshold) => (value > threshold ? level + 1 : level), 1)
}

/**
 * 把连续的日汇总排成 GitHub 那种周×星期的方格。
 *
 * 传进来的 `days` 必须是升序连续的（`buildUsageReport` 给的就是）。头部按
 * 第一天的星期几补空格，尾部补到整周 —— 不补的话每一行代表的星期几都会漂。
 */
export function buildHeatmap(days: UsageDay[], metric: UsageMetric): UsageHeatmap {
  if (days.length === 0) return { weeks: [], months: [] }

  const nonZero = days
    .map((day) => metricValue(day, metric))
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
  const thresholds = nonZero.length > 0 ? quartiles(nonZero) : [0, 0, 0]

  const blank: HeatmapCell = { day: null, level: 0 }
  const cells: HeatmapCell[] = []
  for (let index = 0; index < weekdayOf(days[0].date); index += 1) cells.push(blank)
  for (const day of days) {
    cells.push({ day, level: levelOf(metricValue(day, metric), thresholds) })
  }
  while (cells.length % 7 !== 0) cells.push(blank)

  const weeks: HeatmapCell[][] = []
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7))

  const months: UsageHeatmap['months'] = []
  let lastMonth = ''
  weeks.forEach((week, column) => {
    const first = week.find((cell) => cell.day)?.day
    if (!first) return

    const month = first.date.slice(0, 7)
    if (month === lastMonth) return
    lastMonth = month

    // 相邻两个标挨得太近就不要了：窗口开头那半周经常和下个月的标撞在一起
    if (months.length > 0 && column - months[months.length - 1].column < 3) return
    months.push({ column, date: first.date })
  })

  return { weeks, months }
}

/**
 * 缓存命中率：这次发出去的输入里，有多少是按缓存价算的。
 *
 * 分母是**全部输入 token**（新输入 + 命中 + 写入），不是 `totals.tokens` ——
 * 输出 token 从来就不走缓存，把它算进分母会让这个比例无缘无故地变小。
 * 没有任何输入时返回 null，不返回 0：「没数据」和「一次都没命中」不是一回事。
 */
export function cacheHitRate(totals: UsageTotals): number | null {
  const inputTotal = totals.input + totals.cacheRead + totals.cacheWrite
  if (inputTotal <= 0) return null
  return totals.cacheRead / inputTotal
}

/** 平均值。分母为 0 时返回 null —— 除零算出来的 NaN 不该漏到界面上 */
export function average(value: number, count: number): number | null {
  if (count <= 0) return null
  return value / count
}

/** 千分位。token 数动辄七位，不分节读不出量级 */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** 一位小数的百分比。传 null 给一个破折号，不假装是 0% */
export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(1)}%`
}

/**
 * 耗时。毫秒级读不出量级，秒级又会把「11 毫秒」和「490 毫秒」抹成同一个 0 秒，
 * 所以一秒以内保留毫秒，一分钟以内保留一位小数的秒，再往上给「分 秒」。
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}
