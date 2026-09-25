/**
 * 工作室模式的落盘状态：队员名册、任务板、每个队员自己的对话。
 *
 * ## 放两个地方
 *
 * - **盒子自己的账**（名册、任务板、队员对话）放在会话目录旁边的 `<会话>.team/`。
 *   模型只能通过工具动它 —— 任务板是界面要读的数据，队员对话是它们的记忆，
 *   都不该被一次随手的文件编辑写坏。
 * - **团队的共享工作区**放在 `<userData>/team/<会话>/`。立项书、美术圣经、参考图、
 *   决策日志……里面放什么由模型决定，所有队员都能读写。
 *   它在工程之外，因为工程是跑到半路才建的，而立项在建工程之前。
 *   `pathBoundary.ts` 为它单独开了口子。
 *
 * 断点续跑靠这些文件：盒子重启后，名册、任务板和每个队员记得的东西都还在。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { promises as fs } from 'fs'
import { join } from 'path'

import {
  PRODUCER,
  TASK_STATUSES,
  type BoardTask,
  type MemberTier,
  type TaskStatus,
  type TeamMail,
  type TeamMember
} from '../../../../shared/agentTeam'

export { PRODUCER, TASK_STATUSES }
export type { BoardTask, MemberTier, TaskStatus, TeamMail, TeamMember }

export type BoardPatch = Partial<Omit<BoardTask, 'updatedAt'>> & { id: string }

export interface TeamDirs {
  /** 盒子自己的账 */
  stateDir: string
  /** 团队共享工作区 */
  workspaceDir: string
}

/**
 * 队员名 → 文件名。名字是模型起的（「美术总监」「Level Designer」都可能），
 * 只留字母、数字、下划线和横线，其余换成下划线。
 */
export function memberFileBase(name: string): string {
  const safe = name
    .trim()
    .replace(/[^\p{L}\p{N}_-]/gu, '_')
    .slice(0, 40)
  return safe || 'member'
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** 先写临时文件再改名：写到一半进程没了，旧文件还是完整的 */
async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8')
  await fs.rename(tmp, file)
}

export interface TeamStore {
  readonly dirs: TeamDirs
  ensure(): Promise<void>
  roster(): Promise<TeamMember[]>
  findMember(name: string): Promise<TeamMember | undefined>
  /** 同名覆盖：制作人可以改一个队员的人设或工具范围 */
  putMember(member: TeamMember): Promise<void>
  board(): Promise<BoardTask[]>
  /** 按 id 合并；没有的新建（缺 title 时拒绝）。返回合并后的整张板 */
  patchBoard(patches: BoardPatch[]): Promise<BoardTask[]>
  history(name: string): Promise<AgentMessage[]>
  saveHistory(name: string, messages: AgentMessage[]): Promise<void>
  /** 全部留言（含已送到的），界面按时间显示 */
  mail(): Promise<TeamMail[]>
  post(from: string, to: string, text: string, replyTo?: string): Promise<TeamMail>
  /** 取走发给这个人、还没送到的留言，并标成已送到、已读（下一次接活时整段交给它） */
  takeInbox(name: string): Promise<TeamMail[]>
  markDelivered(ids: string[]): Promise<void>
  markRead(ids: string[]): Promise<void>
  /** 塞进去了但对方没来得及读就收工了：退回信箱，下次接活时再交 */
  requeue(ids: string[]): Promise<void>
  /** 记一笔「谁交了一件活、实际改了什么」。`team_status` 的「最近改动」读它 */
  recordActivity(entry: Omit<TeamActivity, 'at'>): Promise<void>
  activity(limit?: number): Promise<TeamActivity[]>
}

/** 一件交回来的活实际改了什么（按写操作台账记，不是队员自己说的） */
export interface TeamActivity {
  who: string
  at: number
  /** 派活内容的第一句 */
  what: string
  /** 写操作台账的摘要，例如「material_create ×3（M_Rock、M_Metal…）」 */
  writes: string
}

export function createTeamStore(
  dirs: TeamDirs,
  now: () => number = Date.now,
  /** 名册、任务板、留言有变化。宿主拿它推给界面 */
  onChange?: () => void
): TeamStore {
  const rosterFile = join(dirs.stateDir, 'roster.json')
  const boardFile = join(dirs.stateDir, 'board.json')
  const mailFile = join(dirs.stateDir, 'mail.json')
  const activityFile = join(dirs.stateDir, 'activity.json')
  const historyFile = (name: string): string =>
    join(dirs.stateDir, 'members', `${memberFileBase(name)}.json`)

  // 并行派活时几个队员会同时改任务板。读-改-写串起来，免得后写的盖掉先写的
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }
  const changed = <T>(value: T): T => {
    onChange?.()
    return value
  }
  const updateMail = (ids: string[], apply: (mail: TeamMail) => void): Promise<void> =>
    ids.length === 0
      ? Promise.resolve()
      : serial(async () => {
          const list = await readJson<TeamMail[]>(mailFile, [])
          for (const mail of list) if (ids.includes(mail.id)) apply(mail)
          await writeJson(mailFile, list)
        }).then(changed)

  const sameName = (a: string, b: string): boolean =>
    a.trim().toLowerCase() === b.trim().toLowerCase()

  return {
    dirs,
    async ensure() {
      await fs.mkdir(join(dirs.stateDir, 'members'), { recursive: true })
      await fs.mkdir(dirs.workspaceDir, { recursive: true })
    },
    roster: () => readJson<TeamMember[]>(rosterFile, []),
    async findMember(name) {
      return (await readJson<TeamMember[]>(rosterFile, [])).find((m) => sameName(m.name, name))
    },
    putMember: (member) =>
      serial(async () => {
        await fs.mkdir(dirs.stateDir, { recursive: true })
        const list = await readJson<TeamMember[]>(rosterFile, [])
        const index = list.findIndex((m) => sameName(m.name, member.name))
        if (index >= 0) list[index] = member
        else list.push(member)
        await writeJson(rosterFile, list)
      }).then(changed),
    board: () => readJson<BoardTask[]>(boardFile, []),
    patchBoard: (patches) =>
      serial(async () => {
        await fs.mkdir(dirs.stateDir, { recursive: true })
        const list = await readJson<BoardTask[]>(boardFile, [])
        for (const patch of patches) {
          const index = list.findIndex((task) => task.id === patch.id)
          const defined = Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined)
          ) as BoardPatch
          if (index >= 0) {
            list[index] = { ...list[index]!, ...defined, updatedAt: now() }
          } else {
            if (!patch.title) throw new Error(`任务 ${patch.id} 是新的，需要给 title`)
            list.push({ status: 'todo', ...defined, title: patch.title, updatedAt: now() })
          }
        }
        await writeJson(boardFile, list)
        return list
      }).then(changed),
    history: (name) => readJson<AgentMessage[]>(historyFile(name), []),
    saveHistory: (name, messages) =>
      serial(async () => {
        await fs.mkdir(join(dirs.stateDir, 'members'), { recursive: true })
        await writeJson(historyFile(name), messages)
      }),
    mail: () => readJson<TeamMail[]>(mailFile, []),
    post: (from, to, text, replyTo) =>
      serial(async () => {
        await fs.mkdir(dirs.stateDir, { recursive: true })
        const list = await readJson<TeamMail[]>(mailFile, [])
        const mail: TeamMail = {
          id: `m${list.length + 1}`,
          from,
          to,
          text,
          at: now(),
          ...(replyTo ? { replyTo } : {})
        }
        list.push(mail)
        await writeJson(mailFile, list)
        return mail
      }).then(changed),
    takeInbox: (name) =>
      serial(async () => {
        const list = await readJson<TeamMail[]>(mailFile, [])
        const taken = list.filter((m) => !m.deliveredAt && sameName(m.to, name))
        if (taken.length === 0) return taken
        const at = now()
        for (const m of taken) {
          m.deliveredAt = at
          m.readAt = at
        }
        await writeJson(mailFile, list)
        return taken
      }).then(changed),
    markDelivered: (ids) => updateMail(ids, (m) => (m.deliveredAt ??= now())),
    markRead: (ids) =>
      updateMail(ids, (m) => {
        m.deliveredAt ??= now()
        m.readAt ??= now()
      }),
    requeue: (ids) =>
      updateMail(ids, (m) => {
        if (!m.readAt) delete m.deliveredAt
      }),
    recordActivity: (entry) =>
      serial(async () => {
        await fs.mkdir(dirs.stateDir, { recursive: true })
        const list = await readJson<TeamActivity[]>(activityFile, [])
        list.push({ ...entry, at: now() })
        // 只留最近这些：它是「最近改动」，不是审计日志
        await writeJson(activityFile, list.slice(-200))
      }),
    activity: async (limit = 20) => (await readJson<TeamActivity[]>(activityFile, [])).slice(-limit)
  }
}
