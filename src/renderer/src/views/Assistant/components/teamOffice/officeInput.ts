/**
 * 任务板的数据 → 办公室里每个人「此刻该干嘛」，以及两次数据之间发生了什么（谁给谁写了信、
 * 谁标了完成、验收过没过）。
 *
 * 判断全按主进程给的实时状态（`team.live`）和留言本身，不猜：
 *   - 正在等回话 → 坐在工位上冒省略号
 *   - 在跑 / 手上有活 → 回工位干活，动作看最近一次调用的工具
 *   - 最后一条留言是「没干完」、之后没再跑 → 趴桌上睡（多半是额度用完）
 *   - 其余 → 闲着，自己找事做
 */

import type { TaskStatus, TeamActivity, TeamStateView } from '@core/shared/agentTeam'

import { parseTeamMail } from '../teamBoardText'
import { toolKind } from './officeActivity'
import { modelLook } from './modelLook'
import { CREW_COUNT } from './officePalette'
import { PRODUCER_ID, type MemberInput, type Mode } from './officeSim'

/** 某人最近一次调用的工具。空字符串 = 在组织语言（没调工具） */
export interface RecentTool {
  tool: string
  at: number
}

export const actorId = (name: string): string => name.trim().toLowerCase()

/** 发型按名字定，换了顺序也不变；6 号（耳麦）留给制作人 */
export function hairStyle(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return [0, 1, 2, 3, 4, 5, 7][h % 7]!
}

/** 停工的那条原因：最后一条是这个人发的「没干完」 */
export function stoppedReason(team: TeamStateView, name: string): string | null {
  const id = actorId(name)
  for (let i = team.mail.length - 1; i >= 0; i--) {
    const mail = team.mail[i]!
    if (actorId(mail.from) !== id) continue
    const view = parseTeamMail(mail.text, mail.from)
    return view.kind === 'stopped' ? view.body : null
  }
  return null
}

export function memberMode(
  team: TeamStateView,
  name: string,
  tools: ReadonlyMap<string, RecentTool>
): Mode {
  const id = actorId(name)
  const live = team.live
  if (live?.waiting.includes(id)) return { kind: 'wait' }
  const assignment = live?.assignments.find((a) => actorId(a.member) === id)
  if (live?.running.includes(id) || assignment) {
    // 上一件活留下的那条不算：这件活开工之后还没调过工具，就是在想
    const recent = tools.get(id)
    const fresh = recent && (!assignment || recent.at >= assignment.since)
    return { kind: 'work', tool: fresh && recent.tool ? toolKind(recent.tool) : 'think' }
  }
  if (stoppedReason(team, name) !== null) return { kind: 'out' }
  return { kind: 'idle' }
}

export function officeMembers(
  team: TeamStateView,
  tools: ReadonlyMap<string, RecentTool>
): MemberInput[] {
  return [...team.members]
    .sort((a, b) => a.hiredAt - b.hiredAt)
    .map((member, index) => ({
      id: actorId(member.name),
      name: member.name,
      style: hairStyle(member.name),
      crew: index % CREW_COUNT,
      look: modelLook(member.model),
      mode: memberMode(team, member.name, tools)
    }))
}

/**
 * 制作人：卡在等某个队员交活 → 站到那人身后；在跑 → 白板前写写画画；否则闲着。
 * `running` 是界面自己知道的「这条对话正在跑」，主进程的 live 还没推过来时兜一下
 */
export function producerMode(team: TeamStateView, running: boolean): Mode {
  const live = team.live
  const awaited = live?.awaited[0]
  if (awaited) return { kind: 'awaiting', on: actorId(awaited) }
  if (live?.running.includes(PRODUCER_ID) || running) return { kind: 'board' }
  return { kind: 'idle' }
}

export type OfficeEvent =
  | { kind: 'mail'; from: string; to: string }
  | { kind: 'done'; id: string }
  | { kind: 'blocked'; id: string }
  | { kind: 'verdict'; result: 'pass' | 'fail' }

/** 两次数据之间新发生的事。第一次（prev 为 null）不算，免得一打开满屏纸飞机 */
export function teamEvents(prev: TeamStateView | null, next: TeamStateView): OfficeEvent[] {
  if (!prev) return []
  const events: OfficeEvent[] = []
  const seen = new Set(prev.mail.map((m) => m.id))
  for (const mail of next.mail) {
    if (!seen.has(mail.id))
      events.push({ kind: 'mail', from: actorId(mail.from), to: actorId(mail.to) })
  }
  const before = new Map<string, TaskStatus>(prev.board.map((t) => [t.id, t.status]))
  for (const task of next.board) {
    const was = before.get(task.id)
    if (!task.owner || was === task.status) continue
    if (task.status === 'done') events.push({ kind: 'done', id: actorId(task.owner) })
    if (task.status === 'blocked') events.push({ kind: 'blocked', id: actorId(task.owner) })
  }
  if (next.verdictAt !== undefined && next.verdictAt !== prev.verdictAt && next.verdict) {
    events.push({ kind: 'verdict', result: next.verdict === 'pass' ? 'pass' : 'fail' })
  }
  return events
}

/** 一条动态是不是在调工具：`调用 <工具> <目标>`（`teamTools.ts` / `runSubAgent` 拼的）。不是就返回空串（它在说话） */
export function activityTool(text: string): string {
  return text.match(/^调用 ([\w.:-]+)/)?.[1] ?? ''
}

/** 每人最近一条动态 → 此刻在调什么 */
export function recentTools(activity: readonly TeamActivity[]): Map<string, RecentTool> {
  const tools = new Map<string, RecentTool>()
  for (const line of activity)
    tools.set(actorId(line.member), { tool: activityTool(line.text), at: line.at })
  return tools
}
