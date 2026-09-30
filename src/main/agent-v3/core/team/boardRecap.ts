/**
 * 任务板的「旧账」：上一轮留下、这一轮还没人动过的说法。
 *
 * ## 为什么要有它
 *
 * 2026-09-30 真机：第一轮制作人把 5 件活都标成「卡住」，之后用户又说了好几轮话，
 * 制作人一直自己动手干活，任务板一个字没动 —— 界面上永远是 5 个红色的「卡住」。
 *
 * 任务板只有模型拿 `team_board` 去改才会变，盒子从不替它擦。可制作人每轮开局
 * 根本看不到任务板（提示词里只有目标和规矩），自然想不起来改；干活也不经过任务板，
 * 没人对账。所以这里做三件事：
 *
 * - **开局摆出来**（`formatBoardCarryOver`）：拼进用户这句话前面，和闪存块同一个位置 ——
 *   是这一轮的事实，不进系统提示词，不破坏前缀缓存
 * - **收尾对账**（`buildBoardNudge`）：这一轮改了工程、旧账却一项没动，交付闸补一句
 * - **验收过没过期**（`verdictIsStale`）：验收之后又改过工程，那次结论就不代表现在的游戏
 *
 * 全是纯函数，宿主（`ipc/agentV3.ts`）负责读盘和落盘。
 */

import type { BoardTask } from '../../../../shared/agentTeam'
import type { TeamActivity } from './teamStore'

/** 「进行中」「卡住」是对「现在」的断言，隔了一轮没人碰就可能过期了 */
const LIVE_STATUSES = new Set(['doing', 'blocked'])

/**
 * 这一轮开局时还挂着的旧账：上一轮就在「进行中 / 卡住」、之后没人改过的，
 * 加上用户在界面上点了「重开」、还没人接手的。
 */
export function carryOverTasks(board: BoardTask[], roundStartedAt: number): BoardTask[] {
  return board.filter(
    (task) =>
      task.reopenedAt !== undefined ||
      (LIVE_STATUSES.has(task.status) && task.updatedAt < roundStartedAt)
  )
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 6) / 10
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

function describe(task: BoardTask, now: number): string {
  const state =
    task.reopenedAt !== undefined
      ? `${task.status} · reopened by the user ${ago(now - task.reopenedAt)}`
      : `${task.status} · last updated ${ago(now - task.updatedAt)}`
  return (
    `- [${state}] ${task.id} ${task.title}` +
    (task.owner ? ` @${task.owner}` : '') +
    (task.note ? ` — note: ${task.note.replace(/\s+/g, ' ').slice(0, 200)}` : '')
  )
}

/**
 * 开局摆给制作人看的那一段。没有旧账给空串。
 *
 * 用户说了新话，本身就可能是在回答「卡住」等的那件事 —— 所以明说一句：
 * 拿用户这句话当回答，重新评估。
 */
export function formatBoardCarryOver(tasks: BoardTask[], now: number): string {
  if (tasks.length === 0) return ''
  return [
    '<team_board_carryover>',
    'Unreal Box note, not the user: the team task board still shows these from before the message below. The user watches the board, and it only changes when you or a teammate update it with `team_board`.',
    ...tasks.map((task) => describe(task, now)),
    'Check each against the project as it is now (`team_status`) and update it this turn: done with evidence, back to todo, or blocked with the current reason. If the user\'s message answers what a blocked item was waiting on, it is no longer blocked.',
    '</team_board_carryover>'
  ].join('\n')
}

/**
 * 收尾对账的那句提醒。以 user 身份进上下文，开头说清不是用户在说话（同 `buildTeamNudge`）。
 */
export function buildBoardNudge(tasks: BoardTask[], now: number): string {
  return [
    '[team mode · automatic check] This is not the user speaking.',
    'The project changed this turn, but these task board items still say what they said before it:',
    ...tasks.map((task) => describe(task, now)),
    'Update them with `team_board` so the board matches the project — the user reads the board, not just your reply. Then finish as you intended.'
  ].join('\n')
}

/** 某个时刻之后，工程有没有被改过：制作人自己的写操作，或者队员交回来的、带写操作的活 */
export function changedSince(
  since: number,
  lastWriteAt: number | undefined,
  activity: TeamActivity[]
): boolean {
  if (lastWriteAt !== undefined && lastWriteAt > since) return true
  return activity.some((entry) => entry.writes && entry.at > since)
}

/** 验收之后又改过工程：那次结论只说明当时的游戏 */
export function verdictIsStale(
  verdictAt: number | undefined,
  lastWriteAt: number | undefined,
  activity: TeamActivity[]
): boolean {
  return verdictAt !== undefined && changedSince(verdictAt, lastWriteAt, activity)
}
