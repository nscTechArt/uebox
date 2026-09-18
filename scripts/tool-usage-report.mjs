/**
 * 真实会话里的工具使用分布。
 *
 * ## 为什么要有它
 *
 * `tests/manual/tool-selection-metrics.mjs` 量的是**评测集**上的选择质量，
 * 需要用例声明 `scope` / `expectTools`。真实会话没有这两个声明，所以那套
 * 指标里只有「兜底」「原地重复」「失败率」能直接用。
 *
 * 而决定「要不要上工具搜索、核心集该放哪些」的那个数字，那套指标压根没量：
 * **真实调用的频次分布**。没有它，「哪些算核心工具」只能拍脑袋。
 *
 * ## 数据从哪来：已经在磁盘上了
 *
 * 不加任何埋点、不发任何请求。会话记录本来就落在
 * `<userData>/agent-v3-sessions/*.jsonl`（见 `core/transcriptStore.ts`），
 * 这里只是把它读出来做聚合。
 *
 * **社区版不得引入遥测（AGENTS.md §1）**，所以这是个本地只读脚本，
 * 不是运行时采集器。结果只打印到终端，不落盘、不上传。
 *
 * ## 用法
 *
 *   node scripts/tool-usage-report.mjs
 *   node scripts/tool-usage-report.mjs --dir <会话目录> --top 40
 *   node scripts/tool-usage-report.mjs --tools tools.json   # 附带完整工具清单，才能算"从未被调用"
 *
 * ## 读数字之前必须知道的
 *
 * 兜底率高**不等于**模型分不清工具 —— 主工具坏掉时正确的绕路也会被记成兜底。
 * 这条坑的完整说明见 `tool-selection-metrics.mjs` 文件头，那里有一次真实误诊。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'

import { FALLBACK_TOOLS, toolCallExecuted } from '../tests/manual/tool-selection-metrics.mjs'

/** 会话记录的默认位置。跟 `transcriptStore.ts` 的 `sessionsDir()` 保持一致 */
export function defaultSessionsDir() {
  const appData =
    process.env.APPDATA ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : join(homedir(), '.config'))
  return join(appData, 'unreal-box', 'agent-v3-sessions')
}

/**
 * 一份 JSONL 会话 → 扁平的调用列表。
 *
 * 结果按 `toolCallId` 回填：`toolCall` 在 assistant 消息里，成败在随后的
 * `toolResult` 里，两者只能靠 id 对上。对不上的（会话被中断、结果没落盘）
 * 按「没执行」处理而不是丢掉 —— 丢掉会让分母变小，把失败率洗白。
 */
export function parseTranscript(text) {
  const calls = []
  const byId = new Map()

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      // 追加写的最后一行可能是半条，跳过而不是让整份记录作废
      continue
    }

    const message = entry?.message
    if (!message) continue

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== 'toolCall' || typeof block.name !== 'string') continue
        const call = { name: block.name, id: block.id, isError: false, result: '', executed: false }
        calls.push(call)
        if (block.id) byId.set(block.id, call)
      }
    }

    if (message.role === 'toolResult') {
      const call = byId.get(message.toolCallId)
      if (!call) continue
      call.isError = message.isError === true
      call.result = typeof message.content === 'string' ? message.content : ''
      call.executed = toolCallExecuted(call)
    }
  }

  return calls
}

/** 同名同参连续出现两次以上算原地打转。这里没有参数，退化成同名相邻重复 */
export function countAdjacentRepeats(calls) {
  let n = 0
  for (let i = 1; i < calls.length; i++) {
    if (calls[i].name === calls[i - 1].name) n++
  }
  return n
}

/**
 * 覆盖曲线：前 N 个最常用的工具占了全部调用的百分之多少。
 *
 * **这是决定核心集大小的那条曲线。** 如果前 40 个覆盖了 95%，那把剩下的
 * 长尾挪进搜索几乎不影响日常体验；如果前 40 只覆盖 60%，说明使用面很散，
 * 混合制省不下多少，得换思路。
 */
export function coverageCurve(sortedCounts, total, points = [5, 10, 20, 40, 60]) {
  const curve = []
  for (const n of points) {
    if (n > sortedCounts.length) continue
    const sum = sortedCounts.slice(0, n).reduce((a, b) => a + b, 0)
    curve.push({ n, pct: total > 0 ? sum / total : 0 })
  }
  return curve
}

/** 聚合一批会话的调用列表 */
export function aggregate(sessions) {
  const counts = new Map()
  let total = 0
  let failed = 0
  let fallbacks = 0
  let repeats = 0
  let sessionsWithCalls = 0

  for (const calls of sessions) {
    if (calls.length > 0) sessionsWithCalls++
    repeats += countAdjacentRepeats(calls)
    for (const call of calls) {
      total++
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
      if (call.isError) failed++
      if (FALLBACK_TOOLS.includes(call.name)) fallbacks++
    }
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return {
    sessions: sessions.length,
    sessionsWithCalls,
    total,
    failed,
    fallbacks,
    repeats,
    distinct: counts.size,
    ranked,
    coverage: coverageCurve(
      ranked.map(([, c]) => c),
      total
    )
  }
}

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '-')

/**
 * 报告正文。
 *
 * 结论那段是**建议而不是判决**：覆盖曲线只说明「长尾有多长」，
 * 该不该动架构还要看误选率，那个得靠评测集量（见 tool-selection-metrics.mjs）。
 */
export function formatReport(stats, { top = 25, inventory } = {}) {
  const lines = []
  lines.push('真实会话里的工具使用分布')
  lines.push('')
  lines.push(
    `样本：${stats.sessions} 个会话（其中 ${stats.sessionsWithCalls} 个真的调过工具），` +
      `共 ${stats.total} 次调用，用到 ${stats.distinct} 种工具`
  )

  if (stats.total === 0) {
    lines.push('')
    lines.push('没有可分析的调用。先用 Agent 做几件事再回来跑。')
    return lines.join('\n')
  }

  if (inventory?.length) {
    const used = new Set(stats.ranked.map(([name]) => name))
    const never = inventory.filter((name) => !used.has(name))
    lines.push(
      `注册了 ${inventory.length} 个工具，其中 ${never.length} 个从未被调用` +
        `（${pct(never.length, inventory.length)}）`
    )
    if (never.length) {
      lines.push(`  从未用过：${never.slice(0, 30).join('、')}${never.length > 30 ? ' …' : ''}`)
    }
  }

  lines.push('')
  lines.push('覆盖曲线（前 N 个最常用工具占全部调用的比例）：')
  for (const { n, pct: p } of stats.coverage) {
    const bar = '█'.repeat(Math.round(p * 40))
    lines.push(`  前 ${String(n).padStart(2)} 个  ${(p * 100).toFixed(1).padStart(5)}%  ${bar}`)
  }

  lines.push('')
  lines.push(`调用健康度：`)
  lines.push(`  失败 ${stats.failed}/${stats.total}（${pct(stats.failed, stats.total)}）`)
  lines.push(
    `  兜底 ${stats.fallbacks}/${stats.total}（${pct(stats.fallbacks, stats.total)}）` +
      ' —— 有专用工具却改用 Python / shell；高的时候先查主工具是不是坏了'
  )
  lines.push(
    `  相邻重复 ${stats.repeats}/${stats.total}（${pct(stats.repeats, stats.total)}）` +
      ' —— 连着调同一个工具，通常是没看懂上一次的返回'
  )

  lines.push('')
  lines.push(`调用次数 Top ${Math.min(top, stats.ranked.length)}：`)
  for (const [name, count] of stats.ranked.slice(0, top)) {
    lines.push(`  ${String(count).padStart(5)}  ${pct(count, stats.total).padStart(6)}  ${name}`)
  }

  return lines.join('\n')
}

/** 读一个目录下的全部会话。读不动的单个文件跳过，不让一份坏记录毁掉整次统计 */
export async function readSessions(dir) {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  const sessions = []
  for (const file of files) {
    try {
      sessions.push(parseTranscript(await fs.readFile(join(dir, file), 'utf8')))
    } catch (error) {
      console.warn(`跳过 ${file}：${error.message}`)
    }
  }
  return sessions
}

function parseArgs(argv) {
  const args = { dir: defaultSessionsDir(), top: 25, tools: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i]
    else if (argv[i] === '--top') args.top = Number(argv[++i]) || 25
    else if (argv[i] === '--tools') args.tools = argv[++i]
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  let sessions
  try {
    sessions = await readSessions(args.dir)
  } catch (error) {
    console.error(`读不到会话目录：${args.dir}`)
    console.error(error.message)
    console.error('用 --dir 指定别的位置。')
    process.exitCode = 1
    return
  }

  let inventory
  if (args.tools) {
    const raw = JSON.parse(await fs.readFile(args.tools, 'utf8'))
    inventory = Array.isArray(raw)
      ? raw.map((t) => (typeof t === 'string' ? t : t.name))
      : undefined
  }

  console.log(formatReport(aggregate(sessions), { top: args.top, inventory }))
}

// 被 import 时不执行（测试要用上面那些纯函数）。
// 用 pathToFileURL 而不是手拼 `file://` —— Windows 上盘符和反斜杠拼出来的
// 字符串和 import.meta.url 对不上，脚本会静默什么都不做。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
