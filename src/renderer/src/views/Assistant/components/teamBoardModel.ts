/**
 * 「团队任务」面板的数据模型：把主进程那几本账（名册、活、留言、事件、任务板、验收）
 * 拼成界面要回答的三件事 —— 干完没有、交回了什么、谁在忙。
 *
 * 两种画风（像素的委托板、简约的泳道）读的是同一份模型，只是画法不同。
 * 纯函数，不碰 i18n：只给「哪种情况、填什么」，文案由组件定。
 * 设计见 docs/团队任务板可读性-2026-10-14.md。
 */

import {
  PRODUCER,
  type BoardTask,
  type TeamActivity,
  type TeamEvent,
  type TeamJob,
  type TeamMail,
  type TeamMember,
  type TeamStateView,
  type TeamVerdict
} from '@core/shared/agentTeam'

import { parseTeamMail } from './teamBoardText'
import { memberStatus, summarizeReport, type MemberStatus } from './teamBoardView'
import { hairStyle } from './teamOffice/officeInput'
import { modelLook, type ModelLook } from './teamOffice/modelLook'
import { CREW_COUNT } from './teamOffice/officePalette'

const key = (name: string): string => name.trim().toLowerCase()

// ── 活 ───────────────────────────────────────────────────────────────────

/**
 * - writing：在干
 * - done：交回来了
 * - stopped：停下了（出错、被停）
 * - lost：账上还挂着「在干」，可这次运行里没人在跑它 —— 上次运行被打断了，等下一轮开跑时主进程会收成停下
 */
export type JobState = 'writing' | 'done' | 'stopped' | 'lost'

export interface JobView {
  id: string
  member: string
  memberId: string
  /** 报告的标题；没有标题就用派活那句 */
  title: string
  brief: string
  startedAt: number
  endedAt?: number
  state: JobState
  /** 报告正文（Markdown，去掉了开头的客套话） */
  body: string
  /** 报告有几节 */
  sections: number
  reason?: string
  /** 停下之后用户点过「重开」，已经交回制作人 */
  reopened: boolean
  /** 属于这一轮（最近一条真人消息之后还在干或干完的） */
  current: boolean
}

/** 正文开头那个标题就是卡片上的名字：展开时不再重复一遍 */
function withoutTitle(body: string, title: string): string {
  if (!title) return body
  const lines = body.split('\n')
  const first = lines.findIndex((line) => line.trim())
  const heading = first >= 0 ? lines[first]!.match(/^#{1,3}\s+(.+?)\s*#*$/) : null
  if (!heading || heading[1]!.replace(/[*`]/g, '').trim() !== title) return body
  return lines
    .slice(first + 1)
    .join('\n')
    .trim()
}

function jobView(job: TeamJob, live: boolean, roundStart: number): JobView {
  const report = job.report ? summarizeReport(job.report) : null
  const state: JobState =
    job.outcome === 'done'
      ? 'done'
      : job.outcome === 'stopped'
        ? 'stopped'
        : live
          ? 'writing'
          : 'lost'
  return {
    id: job.id,
    member: job.member,
    memberId: key(job.member),
    title: report?.title || job.brief,
    brief: job.brief,
    startedAt: job.startedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    state,
    body: report ? withoutTitle(report.body, report.title) : '',
    sections: report?.sections ?? 0,
    ...(job.reason ? { reason: job.reason } : {}),
    reopened: job.reopenedAt !== undefined,
    current: (job.endedAt ?? Number.POSITIVE_INFINITY) >= roundStart
  }
}

/**
 * 有「活的账」之前的老数据：交活只留在后台派活的【交活】留言里。
 * 拿这些留言补成交回的活，免得老团队打开面板一份成果都没有。
 * 只补账上第一件活开工之前的那些 —— 之后的同一份交付账上已经有了
 */
function legacyJobs(team: TeamStateView, roundStart: number): JobView[] {
  const first = team.jobs?.[0]?.startedAt ?? Number.POSITIVE_INFINITY
  const list: JobView[] = []
  for (const mail of team.mail) {
    if (mail.at >= first || key(mail.to) !== PRODUCER) continue
    const view = parseTeamMail(mail.text, mail.from)
    if (view.kind !== 'delivery' && view.kind !== 'stopped') continue
    const report = view.kind === 'delivery' ? summarizeReport(view.body) : null
    list.push({
      id: `mail:${mail.id}`,
      member: mail.from,
      memberId: key(mail.from),
      title: report?.title || report?.summary || view.body.slice(0, 40),
      brief: '',
      startedAt: mail.at,
      endedAt: mail.at,
      state: view.kind === 'delivery' ? 'done' : 'stopped',
      body: report?.body ?? '',
      sections: report?.sections ?? 0,
      ...(view.kind === 'stopped' ? { reason: view.body } : {}),
      reopened: false,
      current: mail.at >= roundStart
    })
  }
  return list
}

// ── 往来和事件 ───────────────────────────────────────────────────────────

export type LogKind =
  | 'mail'
  | 'delivered'
  | 'stopped'
  | 'crashed'
  | 'recovered'
  | 'recoverFailed'
  | 'verdict'

export interface LogEntry {
  key: string
  at: number
  kind: LogKind
  /** 谁说的 / 谁交的。事件没有 */
  from?: string
  /** 发给谁。同一段话连着发给几个人的，合成一条 */
  to: string[]
  /** 留言正文、活的名字、事件的说明 */
  text: string
  jobId?: string
  /** 制作人发出去、还有人没读到 */
  unread?: boolean
  verdict?: TeamVerdict
}

/** 后台派活交回的【交活】【没干完】留言：活的账里已经有了，往来里不再重复 */
function isJobMail(mail: TeamMail): boolean {
  const kind = parseTeamMail(mail.text, mail.from).kind
  return key(mail.to) === PRODUCER && (kind === 'delivery' || kind === 'stopped')
}

/** 旧的在前。连着两条同一个人发的一字不差的话，合成一条发给几个人的 */
function mailEntries(mail: readonly TeamMail[], skipJobMail: boolean): LogEntry[] {
  const out: LogEntry[] = []
  let last: { from: string; text: string; entry: LogEntry } | null = null
  for (const m of mail) {
    if (skipJobMail && isJobMail(m)) continue
    const body = parseTeamMail(m.text, m.from).body
    if (last && last.from === key(m.from) && last.text === m.text) {
      last.entry.to.push(m.to)
      if (key(m.from) === PRODUCER && !m.readAt) last.entry.unread = true
      continue
    }
    const entry: LogEntry = {
      key: `mail:${m.id}`,
      at: m.at,
      kind: 'mail',
      from: m.from,
      to: [m.to],
      text: body,
      ...(key(m.from) === PRODUCER && !m.readAt ? { unread: true } : {})
    }
    out.push(entry)
    last = { from: key(m.from), text: m.text, entry }
  }
  return out
}

function eventEntry(event: TeamEvent, index: number): LogEntry {
  return {
    key: `event:${index}:${event.at}`,
    at: event.at,
    kind: event.kind,
    to: [],
    text: event.detail ?? '',
    ...(event.verdict ? { verdict: event.verdict } : {})
  }
}

// ── 队员 ─────────────────────────────────────────────────────────────────

/** 干活中 / 等回复 / 闲着 / 要人看一眼 */
export type CrewMood = 'work' | 'wait' | 'idle' | 'alert'

export interface CrewView {
  id: string
  name: string
  member: TeamMember
  /** 办公室里的衬衫序号、发型：卡片上的小人和办公室里那个是同一个人 */
  crew: number
  style: number
  look?: ModelLook
  status: MemberStatus
  mood: CrewMood
  /** 这个人的活，新的在前 */
  jobs: JobView[]
  open?: JobView
  /** 这一轮交回了几份 */
  delivered: number
  /** 和他有关的往来、他交的活、全队的事件，新的在前 */
  thread: LogEntry[]
  /** 他手上有活的时候编辑器崩过（这一轮里） */
  shaken: boolean
  /** 任务板上记在他名下的 */
  tasks: BoardTask[]
  assignment: string
}

function moodOf(status: MemberStatus): CrewMood {
  switch (status.kind) {
    case 'stopped':
    case 'blocked':
      return 'alert'
    case 'tool':
    case 'thinking':
    case 'received':
      return 'work'
    case 'waiting':
      return 'wait'
    default:
      return 'idle'
  }
}

/**
 * 闲下来的人说什么：`memberStatus` 只认得后台派活留下的【交活】【没干完】留言，
 * 等它干完那种派活不留留言。活的账上有的，以账为准：最近一件交回了就说交了什么，停下了就说停在哪
 */
function settledStatus(status: MemberStatus, mine: readonly JobView[]): MemberStatus {
  if (status.kind !== 'idle' && status.kind !== 'delivered') return status
  const latest = mine.find((job) => job.state !== 'writing')
  if (!latest || (status.kind === 'delivered' && status.at >= (latest.endedAt ?? 0))) return status
  if (latest.state === 'done') {
    return { kind: 'delivered', title: latest.title, at: latest.endedAt ?? latest.startedAt }
  }
  return {
    kind: 'stopped',
    reason: latest.reason ?? latest.brief,
    ...(latest.endedAt !== undefined ? { at: latest.endedAt } : {})
  }
}

// ── 整块 ─────────────────────────────────────────────────────────────────

/**
 * - planning：在跑，但还没有活派出去（制作人在想、在招人）
 * - working：有活在干
 * - alert：有活停下了，或任务板上有这一轮的受阻项
 * - done：这一轮跑完了
 * - idle：没在跑，这一轮也没派过活
 */
export type BoardPhase = 'planning' | 'working' | 'alert' | 'done' | 'idle'

export interface BoardModel {
  phase: BoardPhase
  /** 此刻在干活的队员数 */
  working: number
  /** 停着没人管的活有几件（就是 `stops` 的长度） */
  stopped: number
  /**
   * 这一轮停下、还没人管的活，新的在前。「没人管」= 用户没重开、同一个人之后也没再接活 ——
   * 之后又派了一件的，说明制作人已经接手了，这件只留在日志里
   */
  stops: JobView[]
  /** 任务板上这一轮的受阻项 */
  blocked: number
  /** 只在没人在跑、且是这一轮的验收时给 */
  verdict: { kind: TeamVerdict; stale: boolean; at?: number; count: number } | null
  /** 这一轮的活，旧的在前（进度格、成果架） */
  round: JobView[]
  /** 之前几轮交回的，新的在前 */
  earlier: JobView[]
  crew: CrewView[]
  /** 全部往来、交付、事件，新的在前 */
  log: LogEntry[]
  /** 全队事件，旧的在前（泳道上那几条竖线） */
  events: TeamEvent[]
}

/** 崩溃之后多久之内，在受影响的人身上挂个小闪电 */
const SHAKEN_MS = 15 * 60_000

export function buildBoardModel(
  team: TeamStateView,
  activity: readonly TeamActivity[],
  options: { running: boolean; now: number }
): BoardModel {
  const roundStart = team.roundStartedAt ?? 0
  const live = team.live
  const liveRun = !!live
  const jobs = [
    ...legacyJobs(team, roundStart),
    ...(team.jobs ?? []).map((job) => jobView(job, liveRun, roundStart))
  ].sort((a, b) => a.startedAt - b.startedAt)
  const events = team.events ?? []

  const mails = mailEntries(team.mail, true)
  const jobEntries: LogEntry[] = jobs
    .filter((job) => job.state === 'done' || job.state === 'stopped' || job.state === 'lost')
    .map((job) => ({
      key: `job:${job.id}`,
      at: job.endedAt ?? job.startedAt,
      kind: job.state === 'done' ? 'delivered' : 'stopped',
      from: job.member,
      to: [],
      text: job.state === 'done' ? job.title : (job.reason ?? job.brief),
      jobId: job.id
    }))
  const eventEntries = events.map(eventEntry)
  // 每次验收都记成了事件；老数据没有，只能拿执行记录里最近那一次补一条
  const verdictEntry: LogEntry[] =
    team.verdict && team.verdictAt !== undefined && !events.some((e) => e.kind === 'verdict')
      ? [
          {
            key: `verdict:${team.verdictAt}`,
            at: team.verdictAt,
            kind: 'verdict',
            to: [],
            text: '',
            verdict: team.verdict
          }
        ]
      : []
  const log = [...mails, ...jobEntries, ...eventEntries, ...verdictEntry].sort(
    (a, b) => b.at - a.at
  )

  const crashes = events.filter((e) => e.kind === 'crashed' && e.at >= roundStart)
  const crew: CrewView[] = [...team.members]
    .sort((a, b) => a.hiredAt - b.hiredAt)
    .map((member, index) => {
      const id = key(member.name)
      const mine = jobs.filter((job) => job.memberId === id).reverse()
      const status = settledStatus(memberStatus(team, member.name, activity), mine)
      const open = mine.find((job) => job.state === 'writing')
      const shaken = crashes.some(
        (crash) =>
          options.now - crash.at < SHAKEN_MS &&
          mine.some((job) => job.startedAt <= crash.at && (job.endedAt ?? options.now) >= crash.at)
      )
      const thread = log.filter(
        (entry) =>
          (entry.from !== undefined && key(entry.from) === id) ||
          entry.to.some((to) => key(to) === id) ||
          (entry.kind === 'crashed' &&
            mine.some(
              (job) => job.startedAt <= entry.at && (job.endedAt ?? options.now) >= entry.at
            ))
      )
      return {
        id,
        name: member.name,
        member,
        crew: index % CREW_COUNT,
        style: hairStyle(member.name),
        look: modelLook(member.model),
        status,
        mood: moodOf(status),
        jobs: mine,
        ...(open ? { open } : {}),
        delivered: mine.filter((job) => job.current && job.state === 'done').length,
        thread,
        shaken,
        tasks: team.board.filter((task) => task.owner && key(task.owner) === id),
        assignment: live?.assignments.find((a) => key(a.member) === id)?.text ?? ''
      }
    })

  const round = jobs.filter((job) => job.current)
  const earlier = jobs.filter((job) => !job.current && job.state === 'done').reverse()

  const stops = pendingStops(jobs)
  const stopped = stops.length
  const blocked = team.board.filter(
    (task) => task.status === 'blocked' && (task.reopenedAt ?? task.updatedAt) >= roundStart
  ).length
  const working = crew.filter((c) => c.mood === 'work' || c.open).length
  const running = options.running || (live?.running.length ?? 0) > 0

  const phase: BoardPhase =
    stopped + blocked > 0
      ? 'alert'
      : running
        ? round.some((job) => job.state === 'writing')
          ? 'working'
          : 'planning'
        : round.length > 0
          ? 'done'
          : 'idle'

  const verdict =
    team.verdict && !running && (team.verdictAt ?? 0) >= roundStart
      ? {
          kind: team.verdict,
          stale: team.verdictStale,
          ...(team.verdictAt !== undefined ? { at: team.verdictAt } : {}),
          count: team.deliveries
        }
      : null

  return { phase, working, stopped, stops, blocked, verdict, round, earlier, crew, log, events }
}

/** 这一轮停下、没重开、同一个人之后也没再接活的。`jobs` 旧的在前，返回新的在前 */
export function pendingStops(jobs: readonly JobView[]): JobView[] {
  return jobs
    .filter(
      (job, index) =>
        job.current &&
        (job.state === 'stopped' || job.state === 'lost') &&
        !job.reopened &&
        !jobs.slice(index + 1).some((later) => later.memberId === job.memberId)
    )
    .reverse()
}

/** 任务板上「最新要求」那一行最多显示多少字。完整的一段放在悬停提示里 */
const LATEST_REQUEST_LINE_CHARS = 120

/**
 * 「最新要求」那一行的文字。主进程存的是整段消息的末尾（渲染层拼在前面的知识库命中、
 * 附件正文都可能在里面），用户自己的话在最后 —— 所以截末尾，不靠 CSS 从头省略
 */
export function latestRequestLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= LATEST_REQUEST_LINE_CHARS
    ? flat
    : `…${flat.slice(flat.length - LATEST_REQUEST_LINE_CHARS)}`
}
