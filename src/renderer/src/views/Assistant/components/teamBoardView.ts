/**
 * 「团队任务」面板上那些「把机器写的东西翻成人话」的规则，纯函数，好测。
 *
 *   - 每个队员一行「此刻在干嘛」（取代原来的动态流水账）
 *   - 长报告取标题和一句摘要（不调模型，按 Markdown 结构取）
 *   - 路径缩短、留言分类、同一人的连续几步合并
 *
 * 文案本身不在这里：函数只给出「哪一句、填什么」，由组件按 i18n 渲染。
 */

import {
  PRODUCER,
  type TeamActivity,
  type TeamMail,
  type TeamStateView
} from '@core/shared/agentTeam'

import { parseTeamMail } from './teamBoardText'

const key = (name: string): string => name.trim().toLowerCase()

// ── 路径 ─────────────────────────────────────────────────────────────────

const SHORT_MAX = 40

/**
 * 路径变短：在工程目录下的去掉工程目录；否则只留最后两段。`/Game/...` 同样留两段。
 * 不像路径的原样返回（再长也只在中间省略）。完整的放悬停。
 */
export function shortTarget(target: string, projectDir?: string): string {
  const raw = target.trim()
  if (!raw) return ''
  const looksLikePath = /[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)
  let text = raw
  if (looksLikePath) {
    const path = raw.replace(/\\/g, '/')
    const root = projectDir?.replace(/\\/g, '/').replace(/\/+$/, '')
    // 虚幻工程的顶层目录：认出来就从它开始显示，不用知道工程在哪
    const inProject = path.match(/\/((?:Content|Source|Config|Plugins|Saved)(?:\/.*)?)$/i)
    if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      text = path.slice(root.length + 1)
    } else if (inProject && !path.startsWith('/Game/')) {
      const rest = inProject[1]!.split('/')
      text = rest.length > 3 ? `${rest[0]}/…/${rest.slice(-2).join('/')}` : rest.join('/')
    } else {
      const parts = path.split('/').filter(Boolean)
      text = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
    }
  }
  if (text.length <= SHORT_MAX) return text
  const half = Math.floor((SHORT_MAX - 1) / 2)
  return `${text.slice(0, half)}…${text.slice(-half)}`
}

/** 动态里那一行是不是在调工具：`调用 <工具> <目标>` */
export function parseActivity(text: string): { tool: string; target: string } | null {
  const match = text.match(/^调用 (\S+)\s*([\s\S]*)$/)
  return match ? { tool: match[1]!, target: match[2]!.trim() } : null
}

// ── 报告：标题和摘要 ─────────────────────────────────────────────────────

/** 开头那句客套话：「任务已完成，报告全文如下」之类，说了等于没说 */
const LEAD_IN = /^(任务已?完成|已完成|报告(全文)?如下|以下是|好的|收到)[^\n]*$/
const SUMMARY_MAX = 80

export interface ReportView {
  /** 第一个标题；没有就空 */
  title: string
  /** 一句话摘要 */
  summary: string
  /** 去掉客套话之后的正文（展开、阅读视图用） */
  body: string
  /** 有几节（标题数） */
  sections: number
}

const plain = (line: string): string =>
  line
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .trim()

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export function summarizeReport(text: string): ReportView {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // 去掉开头的客套话和分隔线
  while (lines.length) {
    const first = lines[0]!.trim()
    if (!first || /^-{3,}$|^\*{3,}$/.test(first)) lines.shift()
    else if (first.length <= 60 && LEAD_IN.test(first)) lines.shift()
    else break
  }
  const body = lines.join('\n').trim()
  const sections = lines.filter((line) => /^#{1,6}\s+\S/.test(line)).length

  let title = ''
  let titleAt = -1
  const meaningful = lines.map((line, i) => ({ line: line.trim(), i })).filter((l) => l.line)
  for (const { line, i } of meaningful.slice(0, 5)) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*#*$/)
    if (heading) {
      title = plain(heading[1]!)
      titleAt = i
      break
    }
  }
  if (!title) {
    const first = meaningful[0]
    const bold = first?.line.match(/^\*\*([^*]+)\*\*[:：]?$/)
    if (bold && first) {
      title = bold[1]!.trim()
      titleAt = first.i
    }
  }

  let summary = ''
  for (const { line, i } of meaningful) {
    if (i <= titleAt) continue
    if (/^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|```|\|)/.test(line)) continue
    const text = plain(line)
    if (text.replace(/^[^：:]{1,12}[：:]\s*/, '').length < 8) continue
    summary = clip(text, SUMMARY_MAX)
    break
  }
  if (!summary && !title) summary = clip(plain(meaningful[0]?.line ?? ''), SUMMARY_MAX)
  return { title, summary, body, sections }
}

// ── 留言分类 ─────────────────────────────────────────────────────────────

export type MailRole = 'delivery' | 'stopped' | 'instruction' | 'reply' | 'question' | 'note'

/** 只看我们手上有的：前缀、谁发给谁、是不是回复、是不是问句 */
export function mailRole(mail: TeamMail): MailRole {
  const view = parseTeamMail(mail.text, mail.from)
  if (view.kind === 'delivery') return 'delivery'
  if (view.kind === 'stopped') return 'stopped'
  if (mail.replyTo) return 'reply'
  if (key(mail.from) === PRODUCER) return 'instruction'
  if (/[？?]\s*$/.test(view.body)) return 'question'
  return 'note'
}

// ── 每个队员此刻在干嘛 ───────────────────────────────────────────────────

export type MemberStatus =
  | { kind: 'stopped'; reason: string; at?: number }
  | { kind: 'blocked'; reason: string; at: number }
  | { kind: 'waiting'; at?: number }
  | { kind: 'tool'; tool: string; target: string; at: number }
  | { kind: 'thinking'; at?: number }
  | { kind: 'received'; at: number }
  | { kind: 'delivered'; title: string; at: number }
  | { kind: 'idle' }

/**
 * 一个队员一句话。优先级：停工、受阻（要人处理）> 等回复 > 正在干 > 交付过 > 空闲。
 * 「正在干」只认这件活开工之后的动态，上一件活留下的不算。
 */
export function memberStatus(
  team: TeamStateView,
  name: string,
  activity: readonly TeamActivity[]
): MemberStatus {
  const id = key(name)
  const live = team.live
  const assignment = live?.assignments.find((a) => key(a.member) === id)
  const running = !!live?.running.includes(id) || !!assignment

  const mine = team.mail.filter((m) => key(m.from) === id)
  const last = mine.at(-1)
  if (!running && last) {
    const view = parseTeamMail(last.text, last.from)
    if (view.kind === 'stopped') return { kind: 'stopped', reason: view.body, at: last.at }
  }
  const blocked = team.board
    .filter((task) => task.owner && key(task.owner) === id && task.status === 'blocked')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (blocked)
    return { kind: 'blocked', reason: blocked.note || blocked.title, at: blocked.updatedAt }
  if (live?.waiting.includes(id)) return { kind: 'waiting' }

  if (running) {
    const since = assignment?.since ?? 0
    const latest = [...activity].reverse().find((a) => key(a.member) === id && a.at >= since)
    if (!latest)
      return assignment ? { kind: 'received', at: assignment.since } : { kind: 'thinking' }
    const call = parseActivity(latest.text)
    return call
      ? { kind: 'tool', tool: call.tool, target: call.target, at: latest.at }
      : { kind: 'thinking', at: latest.at }
  }

  const delivered = [...mine]
    .reverse()
    .find((m) => parseTeamMail(m.text, m.from).kind === 'delivery')
  if (delivered) {
    const report = summarizeReport(parseTeamMail(delivered.text, delivered.from).body)
    return { kind: 'delivered', title: report.title || report.summary, at: delivered.at }
  }
  return { kind: 'idle' }
}

/** 名册排序：要人处理的在前，然后在干活的、在等的、闲着的；同档按入职顺序 */
export function statusRank(status: MemberStatus): number {
  switch (status.kind) {
    case 'stopped':
    case 'blocked':
      return 0
    case 'tool':
    case 'thinking':
    case 'received':
      return 1
    case 'waiting':
      return 2
    default:
      return 3
  }
}

// ── 选中某人后展开的「最近几步」 ─────────────────────────────────────────

export interface StepGroup {
  /** 同一个工具连着调了几次就合成一行 */
  tool: string
  targets: string[]
  /** 它说的话（不调工具的那几行） */
  text: string
  at: number
  /** 和上一行隔了一分钟以上才显示时间 */
  showTime: boolean
}

export function recentSteps(
  activity: readonly TeamActivity[],
  member: string,
  limit = 8
): StepGroup[] {
  const id = key(member)
  const groups: StepGroup[] = []
  for (const line of activity) {
    if (key(line.member) !== id) continue
    const call = parseActivity(line.text)
    const prev = groups.at(-1)
    if (call && prev && prev.tool === call.tool && line.at - prev.at < 2 * 60_000) {
      if (call.target) prev.targets.push(call.target)
      prev.at = line.at
      continue
    }
    // 客套话不占一行
    if (!call && LEAD_IN.test(line.text.trim().split('\n')[0] ?? '')) continue
    groups.push({
      tool: call?.tool ?? '',
      targets: call?.target ? [call.target] : [],
      text: call ? '' : line.text,
      at: line.at,
      showTime: true
    })
  }
  const shown = groups.slice(-limit).reverse()
  shown.forEach((group, i) => {
    const newer = shown[i - 1]
    group.showTime = !newer || newer.at - group.at >= 60_000
  })
  return shown
}
