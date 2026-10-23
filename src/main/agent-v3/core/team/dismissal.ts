/**
 * 辞退队员的规矩。制作人的 `team_dismiss` 和用户在任务板上点辞退走同一条路。
 *
 * ## 三件事
 *
 * - **合规**：制作人、验收员不能辞；手上有活、排着活的不能辞（它的记忆正在写，
 *   辞了这件活就没人收尾）；没做完的任务必须有去向 —— 交给一个在册的队员，或者清掉负责人等重新分配。
 * - **有理有据**：理由必填。说「这个人干得不行」（`PERFORMANCE_GROUNDS`）必须引用它自己名下的
 *   活或任务，引用别人的、不存在的都退回。盒子另外从账上数出事实附在档案里，不靠谁说。
 * - **留痕**：档案落在 `dismissals.json`，不截断；记忆归档到 `members/dismissed/`，不删。
 *
 * 不设「打回几次就该辞」之类的阈值：辞不辞是制作人和用户的判断，盒子只管程序和证据。
 */

import {
  ACCEPTOR,
  PERFORMANCE_GROUNDS,
  PRODUCER,
  countDismissalFacts,
  type BoardTask,
  type DismissalErrorCode,
  type DismissalEvidence,
  type DismissalFacts,
  type DismissalGrounds,
  type TeamDismissal,
  type TeamJob
} from '../../../../shared/agentTeam'
import type { TeamStore } from './teamStore'

/** 界面按 `code` 选双语文案；`message` 是给制作人看的 */
export class DismissalError extends Error {
  constructor(
    readonly code: DismissalErrorCode,
    message: string
  ) {
    super(message)
  }
}

export interface DismissInput {
  name: string
  by: 'producer' | 'user'
  grounds: DismissalGrounds
  reason: string
  /** 引用的活 id（`j…`）或任务 id */
  evidence?: string[]
  /** 没做完的任务交给谁。不给 = 清掉负责人，等制作人重新分配 */
  handoverTo?: string
  /** 它此刻在不在干活、有没有排着的活。宿主各自知道（派活的队列、正在跑的活） */
  isBusy: (name: string) => boolean
  now?: () => number
}

/** 引用证据时看多少件活。和活的账留的条数一样，再早的已经被截掉了 */
const JOBS_LOOKBACK = 200

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

function describeJob(job: TeamJob): string {
  const end =
    job.outcome === 'done'
      ? '交回'
      : job.outcome === 'stopped'
        ? `停下${job.reason ? `：${job.reason}` : ''}`
        : '还在干'
  return `${job.brief || job.id}（${end}）`
}

function describeTask(task: BoardTask): string {
  return `${task.title}（${task.status}${task.evidence ? `；证据：${task.evidence}` : ''}${task.note ? `；备注：${task.note}` : ''}）`
}

export function formatFacts(facts: DismissalFacts): string {
  const t = facts.tasks
  return (
    `交回 ${facts.jobsDone} 件、停下 ${facts.jobsStopped} 件；` +
    `名下任务 完成 ${t.done} · 进行中 ${t.doing} · 待办 ${t.todo} · 卡住 ${t.blocked}`
  )
}

export async function dismissMember(store: TeamStore, input: DismissInput): Promise<TeamDismissal> {
  const name = input.name.trim()
  if (same(name, PRODUCER) || same(name, ACCEPTOR)) {
    throw new DismissalError('reserved', `「${name}」是盒子的角色，不是队员，不能辞退`)
  }
  const member = await store.findMember(name)
  if (!member) {
    const roster = await store.roster()
    throw new DismissalError(
      'not-found',
      `团队里没有「${name}」。现有：${roster.map((m) => m.name).join('、') || '（无）'}`
    )
  }
  if (input.isBusy(member.name)) {
    throw new DismissalError(
      'busy',
      `${member.name} 手上有活（在干或排着）。等它交回、或这一轮停下之后再辞 —— 半截辞掉，这件活没人收尾`
    )
  }
  const reason = input.reason.trim()
  if (!reason) throw new DismissalError('no-reason', '辞退要写理由')

  const [jobs, board, roster] = await Promise.all([
    store.jobs(JOBS_LOOKBACK),
    store.board(),
    store.roster()
  ])

  // 证据：只认它自己名下的活和任务，当场把原文抄进档案
  const evidence: DismissalEvidence[] = []
  for (const raw of new Set((input.evidence ?? []).map((id) => id.trim()).filter(Boolean))) {
    const job = jobs.find((j) => j.id === raw && same(j.member, member.name))
    const task = board.find((t) => t.id === raw && !!t.owner && same(t.owner, member.name))
    if (job) evidence.push({ kind: 'job', id: raw, text: describeJob(job) })
    else if (task) evidence.push({ kind: 'task', id: raw, text: describeTask(task) })
    else {
      throw new DismissalError(
        'bad-evidence',
        `证据「${raw}」不是 ${member.name} 名下的活或任务。` +
          `活的 id 看 team_status 的「最近交回 / 停下」，任务 id 看 team_board`
      )
    }
  }
  if (PERFORMANCE_GROUNDS.has(input.grounds) && evidence.length === 0) {
    throw new DismissalError(
      'no-evidence',
      `以「${input.grounds}」辞退是在说 ${member.name} 干得不行，要引用它名下至少一件活或一项任务当证据`
    )
  }

  // 交接：接手的必须是另一个在册的队员
  let to: string | undefined
  if (input.handoverTo?.trim()) {
    const heir = roster.find((m) => same(m.name, input.handoverTo!))
    if (!heir || same(heir.name, member.name)) {
      throw new DismissalError(
        'bad-handover',
        `接手人「${input.handoverTo}」不是另一个在册的队员。现有：${roster.map((m) => m.name).join('、')}`
      )
    }
    to = heir.name
  }
  const open = board.filter((t) => t.owner && same(t.owner, member.name) && t.status !== 'done')

  return store.recordDismissal({
    name: member.name,
    at: (input.now ?? Date.now)(),
    by: input.by,
    grounds: input.grounds,
    reason,
    evidence,
    facts: countDismissalFacts(member.name, jobs, board),
    member,
    handover: { tasks: open.map((t) => t.id), ...(to ? { to } : {}) }
  })
}

/** 辞退之后给制作人的回执：做了什么、留在哪 */
export function formatDismissal(record: TeamDismissal, remaining: string[]): string {
  const handover = record.handover.tasks.length
    ? record.handover.to
      ? `没做完的 ${record.handover.tasks.length} 项任务（${record.handover.tasks.join('、')}）已转给 ${record.handover.to}`
      : `没做完的 ${record.handover.tasks.length} 项任务（${record.handover.tasks.join('、')}）已清掉负责人，等你重新分配`
    : '名下没有没做完的任务'
  return [
    `已辞退 ${record.name}。${handover}。`,
    `事实：${formatFacts(record.facts)}`,
    ...(record.evidence.length
      ? [`证据：${record.evidence.map((e) => `${e.id} ${e.text}`).join('；')}`]
      : []),
    `档案已记下（理由、证据、当时的设定）${record.memoryArchive ? '，它的记忆已归档' : ''}；用户在任务板上看得到。`,
    `团队现在 ${remaining.length} 人${remaining.length ? `：${remaining.join('、')}` : ''}`
  ].join('\n')
}

/** 用户在任务板上辞的人：下一轮开局告诉制作人一声，免得它接着给这个人派活 */
export function formatUserDismissals(records: TeamDismissal[]): string {
  if (records.length === 0) return ''
  return [
    '<team_dismissals>',
    'Unreal Box note, not the user: the user dismissed these teammates from the task board since your last turn. They are off the roster; do not send them work or re-hire them under the same name unless the user asks.',
    ...records.map(
      (d) =>
        `- ${d.name}: ${d.reason}` +
        (d.handover.tasks.length
          ? ` (unfinished tasks now without an owner: ${d.handover.tasks.join(', ')})`
          : '')
    ),
    '</team_dismissals>'
  ].join('\n')
}
