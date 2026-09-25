/**
 * AI 游戏工作室题库：评分表的纯函数部分。
 *
 * 读写文件、调引擎都在 bench.mjs；这里只做「文本进、数字出」，好让判据能钉测试。
 * 评分标准的出处：docs/AI游戏工作室-题库与评分表.md。
 */

import { FALLBACK_TOOLS } from '../tool-selection-metrics.mjs'

/** 人工评分项，每项 0 / 1 / 2。bug 那一项不在这里 —— 它由两个计数推出来 */
export const HUMAN_ITEMS = [
  { key: 'loop', label: '完整游戏循环' },
  { key: 'mechanics', label: '核心机制' },
  { key: 'scene', label: '基础场景' },
  { key: 'art', label: '基础美术' },
  { key: 'numbers', label: '基础数值' }
]

/** 验收最后的结论：/team 的独立验收员、或 /goal 的复核员。none = 没有验收这一步 */
export const VERDICTS = ['pass', 'fail', 'blocked', 'maxed', 'none']

/** 六项满分 12；达标 = 没有 0 分项且总分 ≥ 9（约 75%，对应「做到七八成」） */
export const MAX_TOTAL = 12
export const PASS_TOTAL = 9

/**
 * `/goal` 复核员打回时注入的那条消息的开头。
 * 出处 `src/main/agent-v3/core/goalLoop.ts` 的 `buildContinuationPrompt`，
 * 两边对不上时 score.test.ts 会红。
 */
export const GOAL_FOLLOW_UP_PREFIX = '[automatic goal review'

const AUTO_START = '<!-- auto:start -->'
const AUTO_END = '<!-- auto:end -->'

// ── 评分表 ──────────────────────────────────────────────────────────────

export function renderScoreSheet({ caseDef, runId, arm, model, startedAt }) {
  return [
    `# ${caseDef.genre} · ${runId}`,
    '',
    `- 题目：\`${caseDef.id}\`（${caseDef.form}） · 模式 \`/${arm}\``,
    `- 题面：${caseDef.prompt}`,
    `- 模型：${model || '（没填，collect 时从会话记录里补）'}`,
    `- 开跑：${new Date(startedAt).toLocaleString('zh-CN', { hour12: false })}`,
    `- 评分参考（不是标准答案，按它自己立项的玩法评）：${caseDef.hint}`,
    '',
    '## 人工评分',
    '',
    '亲自玩一遍再填。标准见 `docs/AI游戏工作室-题库与评分表.md` §3。',
    '',
    '```score',
    '# 每项 0 / 1 / 2',
    ...HUMAN_ITEMS.map((item) => `${item.key}:      # ${item.label}`),
    '# bug 个数。严重 = 崩溃 / 卡死 / 软锁 / 没法继续玩；一般 = 不挡路的表现问题',
    'bugs_severe:',
    'bugs_minor:',
    '# 盲玩感受 1~5，不计入达标',
    'fun:',
    '# 验收最后的结论：pass / fail / blocked / maxed（到轮数上限） / none（没有验收）',
    'verdict:',
    '```',
    '',
    '## 自动核验',
    '',
    AUTO_START,
    '（还没跑 `bench.mjs collect`）',
    AUTO_END,
    '',
    '## 观察',
    '',
    '### 它怎么拆的（立项、玩法、范围、先后顺序）',
    '',
    '### 卡在哪 / 绕了哪些路',
    '',
    '### 缺什么（工具、素材、能力）',
    '',
    '### 它说做完了，实际差在哪',
    ''
  ].join('\n')
}

/**
 * 读 score 代码块。空着的项是 null（还没评），不是 0 —— 两者混了会把
 * 「没评完」算成「全挂」。
 */
export function parseScoreBlock(markdown) {
  const match = /```score\s*\n([\s\S]*?)```/.exec(markdown)
  const values = {}
  const errors = []
  if (!match) return { values, errors: ['找不到 ```score 代码块'] }

  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const raw = line.slice(at + 1).trim()
    values[key] = raw === '' ? null : raw
  }

  const out = {}
  for (const { key, label } of HUMAN_ITEMS) {
    out[key] = intIn(values[key], 0, 2, label, errors)
  }
  out.bugs_severe = intIn(values.bugs_severe, 0, Infinity, '严重 bug 数', errors)
  out.bugs_minor = intIn(values.bugs_minor, 0, Infinity, '一般 bug 数', errors)
  out.fun = intIn(values.fun, 1, 5, '盲玩感受', errors)
  const verdict = values.verdict ?? null
  if (verdict !== null && !VERDICTS.includes(verdict)) {
    errors.push(`verdict 只能是 ${VERDICTS.join(' / ')}，填的是「${verdict}」`)
  }
  out.verdict = VERDICTS.includes(verdict) ? verdict : null
  return { values: out, errors }
}

function intIn(raw, min, max, label, errors) {
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${label} 填的是「${raw}」，应为 ${min}～${max === Infinity ? '' : max} 的整数`)
    return null
  }
  return n
}

/** 有严重 bug 就是 0；一般 bug 超过 2 个是 1；否则 2 */
export function bugScore(severe, minor) {
  if (severe === null || minor === null) return null
  if (severe > 0) return 0
  return minor > 2 ? 1 : 2
}

/** 六项齐了才出总分和达标；缺一项就是「没评完」，不猜 */
export function scoreRun(values) {
  const items = [
    ...HUMAN_ITEMS.map(({ key, label }) => ({ key, label, score: values[key] ?? null })),
    { key: 'bugs', label: '无明显 bug', score: bugScore(values.bugs_severe, values.bugs_minor) }
  ]
  const complete = items.every((item) => item.score !== null)
  const total = complete ? items.reduce((sum, item) => sum + item.score, 0) : null
  const pass = complete ? items.every((item) => item.score > 0) && total >= PASS_TOTAL : null
  return { items, complete, total, pass }
}

// ── 会话记录 ────────────────────────────────────────────────────────────

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

export function isGoalFollowUp(message) {
  return message?.role === 'user' && textOf(message.content).startsWith(GOAL_FOLLOW_UP_PREFIX)
}

/** 用户按停止的那条工具结果。那不是失败，算进去会把失败数放大好几倍 */
const USER_INTERRUPT = /Operation aborted|用户停止了这一轮|用户取消|This operation was aborted/i

/** JSONL → header + 消息列表。半行（追加写到一半）跳过，不让整份作废 */
export function readTranscript(text) {
  let header = null
  const messages = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.kind === 'header') header = entry
    else if (entry?.message) messages.push(entry.message)
  }
  return { header, messages }
}

/** 第一条真人消息的正文。用来认「这条会话是不是这次跑的那道题」 */
export function firstUserText(messages) {
  const first = messages.find((m) => m.role === 'user' && !isGoalFollowUp(m))
  return first ? textOf(first.content) : ''
}

/**
 * 会话最后绑定的工程，从每轮注入的 `<runtime-status>` 里读。
 *
 * `execution.json` 只在显式绑定过工程时才记 `project`；模型自己新建、打开的
 * 工程要从这里补。取最后一次出现的 —— 工程是跑到半路才建的。
 * 格式出处：`core/runtimeStatus.ts`（`session_project: 名字 (版本), path_on_record 路径`）。
 */
export function projectFromTranscript(messages) {
  const re = /^(session_project|target_project): (.+?) \(.*\), path_on_record (.+)$/gm
  let found = null
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const hit of textOf(m.content).matchAll(re)) {
      if (hit[1] === 'session_project' || !found || found.from === 'target_project') {
        found = { from: hit[1], projectName: hit[2], projectPath: hit[3].trim() }
      }
    }
  }
  return found ? { projectName: found.projectName, projectPath: found.projectPath } : null
}

/**
 * 过程指标。
 *
 * 子任务（`task`）的内部调用不在这份记录里 —— 子 Agent 不落 transcript，
 * 这里只看得到它被派了几次。token 同理只算主会话的。
 */
export function transcriptMetrics(text) {
  const { header, messages } = readTranscript(text)
  const stamps = messages.map((m) => m.timestamp).filter((t) => Number.isFinite(t) && t > 0)
  // 不用 Math.min(...stamps)：跑几小时的会话有几万条消息，展开会爆参数上限
  const first = stamps.length ? stamps.reduce((a, b) => Math.min(a, b)) : null
  const last = stamps.length ? stamps.reduce((a, b) => Math.max(a, b)) : null

  const calls = []
  const byId = new Map()
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let cost = 0
  let modelErrors = 0
  const models = new Set()
  let userTurns = 0
  let goalFollowUps = 0
  let assistantResponses = 0

  for (const m of messages) {
    if (m.role === 'user') {
      if (isGoalFollowUp(m)) goalFollowUps++
      else userTurns++
    } else if (m.role === 'assistant') {
      assistantResponses++
      if (m.provider && m.model) models.add(`${m.provider}/${m.model}`)
      if (m.stopReason === 'error') modelErrors++
      if (m.usage) {
        for (const k of Object.keys(usage)) usage[k] += Number(m.usage[k]) || 0
        cost += Number(m.usage.cost?.total) || 0
      }
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block?.type !== 'toolCall') continue
        const call = { name: block.name, isError: false }
        calls.push(call)
        if (block.id) byId.set(block.id, call)
      }
    } else if (m.role === 'toolResult') {
      const call = byId.get(m.toolCallId)
      // 用户按停止也落成 isError。口径同 failure-census.mjs 的 isUserInterrupt
      if (call) call.isError = m.isError === true && !USER_INTERRUPT.test(textOf(m.content))
    }
  }

  const freq = {}
  for (const c of calls) freq[c.name] = (freq[c.name] ?? 0) + 1
  const fallback = calls.filter((c) => FALLBACK_TOOLS.includes(c.name)).length

  return {
    sessionId: header?.sessionId ?? null,
    project: projectFromTranscript(messages),
    startedAt: first,
    endedAt: last,
    minutes: stamps.length ? Math.round((last - first) / 60_000) : 0,
    userTurns,
    goalFollowUps,
    assistantResponses,
    modelErrors,
    models: [...models],
    toolCalls: calls.length,
    toolErrors: calls.filter((c) => c.isError).length,
    fallbackCalls: fallback,
    subtasks: freq.task ?? 0,
    topTools: Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12),
    usage,
    // 厂商没报价时 cost 全是 0，那是「不知道」而不是「免费」
    cost: cost > 0 ? Number(cost.toFixed(4)) : null
  }
}

// ── 引擎核验的判定 ──────────────────────────────────────────────────────

/** ok: true / false / null（没验到）。「没验到」不等于「通过」 */
const unknown = (note) => ({ ok: null, note })

export function judgeBlueprints(r) {
  if (!r || typeof r !== 'object') return unknown('没验到（引擎没连上或工具报错）')
  if (!r.compiled_count) return { ok: true, note: r.note || '工程里没有蓝图' }
  const bad = (r.failures ?? []).slice(0, 5).map((f) => f.path)
  return {
    ok: r.error_count === 0,
    note:
      `编译 ${r.compiled_count} 个：${r.error_count} 错误 / ${r.warning_count} 警告` +
      (bad.length ? `；出错的：${bad.join('、')}` : '') +
      (r.truncated ? '（到上限，没编完）' : '')
  }
}

export function judgeSmoke(r) {
  if (!r || typeof r !== 'object') return unknown('没验到（引擎没连上、PIE 起不来或工具报错）')
  const errors = (r.errors ?? []).slice(0, 3).map((e) => String(e).slice(0, 160))
  return {
    ok: r.ran === true && r.ended_by === 'duration' && r.error_count === 0,
    note:
      `跑了 ${r.elapsed_seconds ?? '?'} 秒，结束原因 ${r.ended_by ?? '?'}，` +
      `运行时错误 ${r.error_count ?? '?'} 条` +
      (errors.length ? `：${errors.join(' | ')}` : '')
  }
}

export function judgeNewProject(birthMs, startedAt) {
  if (!Number.isFinite(birthMs)) return unknown('找不到 .uproject')
  return {
    ok: birthMs >= startedAt,
    note:
      birthMs >= startedAt
        ? '开跑之后新建的工程'
        : '工程早于开跑时间 —— 它在已有工程里干的，这一条样本作废'
  }
}

export function judgeCrashes(count) {
  if (!Number.isFinite(count)) return unknown('没找到崩溃目录')
  return { ok: count === 0, note: count === 0 ? '开跑后没有崩溃记录' : `开跑后崩溃 ${count} 次` }
}

// ── 自动核验段 ──────────────────────────────────────────────────────────

const mark = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '—')

export function renderAutoSection(auto) {
  const m = auto.metrics
  const lines = []
  if (m) {
    lines.push(
      `- 会话：\`${m.sessionId}\` · 模型 ${m.models.join('、') || '?'}`,
      `- 用时 ${m.minutes} 分钟 · 真人消息 ${m.userTurns} 条 · 复核打回 ${m.goalFollowUps} 次 · 模型响应 ${m.assistantResponses} 次`,
      `- 工具调用 ${m.toolCalls} 次（失败 ${m.toolErrors}，Python/命令行 ${m.fallbackCalls}，派子任务 ${m.subtasks}）`,
      `- token：输入 ${m.usage.input} · 输出 ${m.usage.output} · 缓存读 ${m.usage.cacheRead} · 缓存写 ${m.usage.cacheWrite}` +
        ` · 费用 ${m.cost === null ? '—（厂商没报价）' : `$${m.cost}`}`,
      `- 常用工具：${m.topTools.map(([n, c]) => `${n}×${c}`).join('  ')}`
    )
  }
  if (auto.goal) {
    lines.push(
      `- /goal：复核 ${auto.goal.rounds} 轮 · ${auto.goal.settled ? '已收尾' : '未收尾'}` +
        (auto.goal.lastFailReason
          ? ` · 最后一次打回：${auto.goal.lastFailReason.slice(0, 200)}`
          : '')
    )
  }
  if (auto.project) lines.push(`- 工程：${auto.project.projectName} · ${auto.project.projectPath}`)
  lines.push('')
  for (const c of auto.checks ?? []) lines.push(`- ${mark(c.ok)} ${c.label}：${c.note}`)
  if (auto.images?.length) {
    lines.push('', '冒烟试玩的时间轴拼图：', '')
    for (const img of auto.images) lines.push(`![](${img})`)
  }
  lines.push(
    '',
    `（${new Date(auto.collectedAt).toLocaleString('zh-CN', { hour12: false })} 采集）`
  )
  return lines.join('\n')
}

export function replaceAutoSection(markdown, body) {
  const start = markdown.indexOf(AUTO_START)
  const end = markdown.indexOf(AUTO_END)
  if (start < 0 || end < start)
    return `${markdown}\n\n## 自动核验\n\n${AUTO_START}\n${body}\n${AUTO_END}\n`
  return markdown.slice(0, start + AUTO_START.length) + '\n' + body + '\n' + markdown.slice(end)
}

// ── 汇总 ────────────────────────────────────────────────────────────────

/**
 * runs: [{ runId, caseId, arm, model, auto, score: { values, errors } }]
 *
 * 除了达标率，单独数一个「验收放行但没达标」：验收员说过了、人玩下来不达标。
 * 这是独立验收员那条硬规则（设计稿 §5）要不要做、做多严的直接证据。
 */
export function summarize(runs) {
  const rows = runs.map((run) => {
    const scored = scoreRun(run.score.values)
    const m = run.auto?.metrics
    const checks = run.auto?.checks ?? []
    return {
      ...run,
      scored,
      minutes: m?.minutes ?? null,
      toolCalls: m?.toolCalls ?? null,
      cost: m?.cost ?? null,
      model: run.model || m?.models?.[0] || '?',
      autoPassed: checks.filter((c) => c.ok === true).length,
      autoKnown: checks.filter((c) => c.ok !== null).length
    }
  })

  const lines = [
    '| 运行 | 题目 | 模式 | 模型 | 分钟 | 工具 | 费用 | 自动 | 循环 | 机制 | 场景 | 美术 | 数值 | bug | 总分 | 达标 | 盲玩 | 验收 |',
    '|---|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|:-:|--:|---|'
  ]
  const cell = (v) => (v === null || v === undefined ? '—' : String(v))
  for (const r of rows) {
    const s = Object.fromEntries(r.scored.items.map((i) => [i.key, i.score]))
    lines.push(
      `| ${r.runId} | ${r.caseId} | /${r.arm ?? '?'} | ${r.model} | ${cell(r.minutes)} | ${cell(r.toolCalls)} | ` +
        `${r.cost === null ? '—' : `$${r.cost}`} | ${r.autoPassed}/${r.autoKnown} | ` +
        `${cell(s.loop)} | ${cell(s.mechanics)} | ${cell(s.scene)} | ${cell(s.art)} | ${cell(s.numbers)} | ${cell(s.bugs)} | ` +
        `${r.scored.total === null ? '未评完' : `${r.scored.total}/${MAX_TOTAL}`} | ` +
        `${r.scored.pass === null ? '—' : r.scored.pass ? '✅' : '❌'} | ${cell(r.score.values.fun)} | ${cell(r.score.values.verdict)} |`
    )
  }

  const graded = rows.filter((r) => r.scored.complete)
  const passed = graded.filter((r) => r.scored.pass)
  const overclaimed = graded.filter((r) => r.score.values.verdict === 'pass' && !r.scored.pass)
  lines.push(
    '',
    `评完 ${graded.length}/${rows.length} 次 · 达标 ${passed.length}/${graded.length}` +
      ` · 验收放行但没达标 ${overclaimed.length} 次` +
      (overclaimed.length ? `（${overclaimed.map((r) => r.runId).join('、')}）` : '')
  )

  const problems = rows.filter((r) => r.score.errors.length)
  if (problems.length) {
    lines.push('', '评分表有填错的：')
    for (const r of problems) lines.push(`- ${r.runId}：${r.score.errors.join('；')}`)
  }
  return lines.join('\n')
}
