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

import { createHash } from 'crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { promises as fs } from 'fs'
import { join } from 'path'

import {
  EMPTY_TEAM_USAGE,
  PRODUCER,
  TASK_STATUSES,
  addTeamUsage,
  type BoardTask,
  type MemberTier,
  type TaskStatus,
  type TeamDismissal,
  type TeamEvent,
  type TeamJob,
  type TeamMail,
  type TeamMember,
  type TeamModel,
  type TeamUsage,
  type TeamUsageLedger
} from '../../../../shared/agentTeam'

export { PRODUCER, TASK_STATUSES }
export type {
  BoardTask,
  MemberTier,
  TaskStatus,
  TeamDismissal,
  TeamEvent,
  TeamJob,
  TeamMail,
  TeamMember,
  TeamModel,
  TeamUsage,
  TeamUsageLedger
}

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
  const trimmed = name.trim()
  const safe = trimmed.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 40)
  // 换过字符或截过的名字带上原名的短指纹：「Art Lead」和「Art.Lead」不能共用一份记忆和一把锁
  if (safe && safe === trimmed) return safe
  const tag = createHash('sha1').update(trimmed).digest('hex').slice(0, 8)
  return `${safe || 'member'}-${tag}`
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
  /**
   * 这个队员记忆的压缩检查点（见 `compactionCheckpoint.ts`），原样读回，格式由那边校验。
   *
   * 和记忆放在一起：队员每次派活都重建 agent，检查点不落盘的话，闭包一清就得拿
   * 完整原始历史去发 —— 真机上就这样撞过厂商的上下文上限。记忆被改过、换了人，
   * 检查点里的指纹对不上，自然作废
   */
  memberCheckpoint(name: string): Promise<unknown>
  saveMemberCheckpoint(name: string, checkpoint: unknown): Promise<void>
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
  /** 一件活开工了：记下来，返回它（交回、停下时按 id 收尾） */
  startJob(member: string, brief: string): Promise<TeamJob>
  /** 一件活交回来了或停下了。带了用量就记在这件活上，同时记进总账 */
  finishJob(
    id: string,
    end: ({ outcome: 'done'; report: string } | { outcome: 'stopped'; reason: string }) & {
      usage?: TeamUsage
    }
  ): Promise<void>
  /**
   * 还挂着「在干」的活一律收成停下。新一次运行开始时调：上次运行被打断（盒子关了、崩了）的活
   * 不会再交回来，不收掉的话界面上会永远显示「正在写」。
   *
   * 这件活开工后队员的记忆存过盘的，原因后面带上 `MEMORY_KEPT_NOTE`
   */
  closeOpenJobs(reason: string): Promise<void>
  /** 用户把一件停下的活交回制作人：记下时刻，返回这件活（没有这件、或它不是停下的，回 undefined） */
  reopenJob(id: string): Promise<TeamJob | undefined>
  jobs(limit?: number): Promise<TeamJob[]>
  /**
   * 记一笔用量进总账（不挂在哪件活上的：制作人、验收员）。
   * 不推界面：制作人每次请求都记一笔，那么推会让面板跟着每条回复重读
   */
  addUsage(who: string, usage: TeamUsage): Promise<void>
  usage(): Promise<TeamUsageLedger>
  recordEvent(event: Omit<TeamEvent, 'at'>): Promise<void>
  events(limit?: number): Promise<TeamEvent[]>
  /**
   * 辞退一个队员，一次落完：移出名册、交接它没做完的任务、记忆归档（不删）、写进人事档案。
   * 规矩（能不能辞、理由和证据够不够）在 `dismissal.ts` 里查过才调到这里。名册里没有它就抛错
   */
  recordDismissal(record: Omit<TeamDismissal, 'memoryArchive'>): Promise<TeamDismissal>
  /** 人事档案，旧的在前。不截断 */
  dismissals(): Promise<TeamDismissal[]>
  /** 用户辞的、还没告诉制作人的：取出来并标成已告诉。制作人每轮开局调一次 */
  takeUnnotifiedDismissals(): Promise<TeamDismissal[]>
}

/** 活的账、事件的账各留多少条：它们是近况，不是档案 */
const JOBS_KEPT = 200
const EVENTS_KEPT = 100
/** 派活那段话截多长当名字 */
const BRIEF_MAX = 80

/**
 * 停下的活，队员记忆里存着干到哪了（队员每说完一轮存一次，见 `createMemorySaver`）：
 * 跟在停下的原因后面。制作人看到它，重派时可以让队员接着上次的往下干，而不是从头来
 */
export const MEMORY_KEPT_NOTE = '它的记忆里存着这件活干到哪了，再派给它可以接着上次的往下干'

/** 一件交回来的活实际改了什么（按写操作台账记，不是队员自己说的） */
export interface TeamActivity {
  who: string
  at: number
  /** 派活内容的第一句 */
  what: string
  /** 写操作台账的摘要，例如「material_create ×3（M_Rock、M_Metal…）」 */
  writes: string
  /**
   * 这件活实际是哪个模型干的。以后按结果看哪个模型干什么靠谱，要从这里起账
   * （见 docs/团队选模型与履历设计-2026-10-08.md）。老记录和没钉模型的老队员没有
   */
  model?: TeamModel
  /** 在哪个工程里干的。用户打回这件活时，履历记到同一个工程上 */
  project?: string
}

/** 每个团队目录一条写入链，所有 store 实例共用（见 `createTeamStore` 里的 `serial`） */
const writeChains = new Map<string, Promise<unknown>>()

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
  const jobsFile = join(dirs.stateDir, 'jobs.json')
  const eventsFile = join(dirs.stateDir, 'events.json')
  const usageFile = join(dirs.stateDir, 'usage.json')
  const dismissalsFile = join(dirs.stateDir, 'dismissals.json')
  const historyFile = (name: string): string =>
    join(dirs.stateDir, 'members', `${memberFileBase(name)}.json`)
  const checkpointFile = (name: string): string =>
    join(dirs.stateDir, 'members', `${memberFileBase(name)}.compaction.json`)

  // 并行派活时几个队员会同时改任务板。读-改-写串起来，免得后写的盖掉先写的。
  // 链按目录共用而不是按实例：界面那头（重开、换模型）每次另造一个 store，
  // 它和正在跑的制作人写的是同一批文件、同一个 .tmp
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = (writeChains.get(dirs.stateDir) ?? Promise.resolve()).then(fn, fn)
    writeChains.set(
      dirs.stateDir,
      next.catch(() => undefined)
    )
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
  /** 这个队员的记忆在这个时刻之后落过盘。同一个人的活排着队，开工后写的只会是这一件的 */
  const memorySavedSince = async (name: string, since: number): Promise<boolean> => {
    try {
      return (await fs.stat(historyFile(name))).mtimeMs >= since
    } catch {
      return false
    }
  }

  const readUsage = (): Promise<TeamUsageLedger> =>
    readJson<TeamUsageLedger>(usageFile, { total: { ...EMPTY_TEAM_USAGE }, byWho: {} })
  /** 只在 `serial` 里调 */
  const chargeUsage = async (who: string, usage: TeamUsage): Promise<void> => {
    if (usage.total <= 0 && usage.cost <= 0) return
    await fs.mkdir(dirs.stateDir, { recursive: true })
    const ledger = await readUsage()
    // 名字不分大小写，同 roster：「Art」和「art」是一个人，不记成两行
    const key = Object.keys(ledger.byWho).find((k) => sameName(k, who)) ?? who
    ledger.total = addTeamUsage(ledger.total, usage)
    ledger.byWho[key] = addTeamUsage(ledger.byWho[key] ?? EMPTY_TEAM_USAGE, usage)
    await writeJson(usageFile, ledger)
  }

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
            const next: BoardTask = { ...list[index]!, ...defined, updatedAt: now() }
            // 用户点过「重开」、这次又有人改了它：已经有人接手，重开标记就不用再提了
            if (patch.reopenedAt === undefined) delete next.reopenedAt
            list[index] = next
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
    memberCheckpoint: (name) => readJson<unknown>(checkpointFile(name), undefined),
    saveMemberCheckpoint: (name, checkpoint) =>
      serial(async () => {
        await fs.mkdir(join(dirs.stateDir, 'members'), { recursive: true })
        await writeJson(checkpointFile(name), checkpoint)
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
    activity: async (limit = 20) =>
      (await readJson<TeamActivity[]>(activityFile, [])).slice(-limit),
    startJob: (member, brief) =>
      serial(async () => {
        await fs.mkdir(dirs.stateDir, { recursive: true })
        const list = await readJson<TeamJob[]>(jobsFile, [])
        const line =
          brief
            .split(/\r?\n/)
            .find((l) => l.trim())
            ?.trim() ?? ''
        // id 不用下标：旧的会被截掉，下标会撞
        const last = Number(list.at(-1)?.id.slice(1)) || 0
        const job: TeamJob = {
          id: `j${last + 1}`,
          member,
          brief: line.length > BRIEF_MAX ? `${line.slice(0, BRIEF_MAX - 1)}…` : line,
          startedAt: now()
        }
        list.push(job)
        await writeJson(jobsFile, list.slice(-JOBS_KEPT))
        return job
      }).then(changed),
    finishJob: (id, end) =>
      serial(async () => {
        const list = await readJson<TeamJob[]>(jobsFile, [])
        const job = list.find((j) => j.id === id)
        if (!job || job.endedAt !== undefined) return
        job.endedAt = now()
        job.outcome = end.outcome
        if (end.outcome === 'done') job.report = end.report
        else job.reason = end.reason
        if (end.usage && end.usage.total > 0) job.usage = end.usage
        await writeJson(jobsFile, list)
        // 同一段串行里记进总账：活上的数和总账不会一边记上、一边没记上
        if (end.usage) await chargeUsage(job.member, end.usage)
      }).then(changed),
    closeOpenJobs: (reason) =>
      serial(async () => {
        const list = await readJson<TeamJob[]>(jobsFile, [])
        const open = list.filter((j) => j.endedAt === undefined)
        if (open.length === 0) return false
        const at = now()
        for (const job of open) {
          job.endedAt = at
          job.outcome = 'stopped'
          job.reason = (await memorySavedSince(job.member, job.startedAt))
            ? `${reason}；${MEMORY_KEPT_NOTE}`
            : reason
        }
        await writeJson(jobsFile, list)
        return true
      }).then((closed) => {
        if (closed) onChange?.()
      }),
    reopenJob: (id) =>
      serial(async () => {
        const list = await readJson<TeamJob[]>(jobsFile, [])
        const job = list.find((j) => j.id === id)
        if (!job || job.outcome !== 'stopped') return undefined
        job.reopenedAt = now()
        await writeJson(jobsFile, list)
        return job
      }).then((job) => {
        if (job) onChange?.()
        return job
      }),
    jobs: async (limit = 60) => (await readJson<TeamJob[]>(jobsFile, [])).slice(-limit),
    addUsage: (who, usage) => serial(() => chargeUsage(who, usage)),
    usage: readUsage,
    recordEvent: (event) =>
      serial(async () => {
        await fs.mkdir(dirs.stateDir, { recursive: true })
        const list = await readJson<TeamEvent[]>(eventsFile, [])
        list.push({ ...event, at: now() })
        await writeJson(eventsFile, list.slice(-EVENTS_KEPT))
      }).then(changed),
    events: async (limit = 20) => (await readJson<TeamEvent[]>(eventsFile, [])).slice(-limit),
    recordDismissal: (record) =>
      serial(async () => {
        const roster = await readJson<TeamMember[]>(rosterFile, [])
        const index = roster.findIndex((m) => sameName(m.name, record.name))
        if (index < 0) throw new Error(`团队里没有「${record.name}」`)
        roster.splice(index, 1)

        // 没做完的任务：有接手人就改到它名下，没有就清掉负责人。备注里写明原负责人和去向
        const board = await readJson<BoardTask[]>(boardFile, [])
        const handed = new Set(record.handover.tasks)
        for (const task of board) {
          if (!handed.has(task.id)) continue
          const line = record.handover.to
            ? `原负责人 ${record.name} 已辞退，转给 ${record.handover.to}`
            : `原负责人 ${record.name} 已辞退，待重新分配`
          task.note = task.note ? `${task.note}\n${line}` : line
          if (record.handover.to) task.owner = record.handover.to
          else delete task.owner
          task.updatedAt = now()
        }

        // 记忆归档不删：档案要能回头查它当时干了什么；同名再招的是新人，从空白开始
        let memoryArchive: string | undefined
        const archiveDir = join(dirs.stateDir, 'members', 'dismissed')
        const archived = `${memberFileBase(record.name)}-${record.at}.json`
        try {
          await fs.mkdir(archiveDir, { recursive: true })
          await fs.rename(historyFile(record.name), join(archiveDir, archived))
          memoryArchive = `members/dismissed/${archived}`
        } catch (error) {
          // 从没派过活的没有记忆文件，不算错
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        // 压缩检查点只是这份记忆的缓存，记忆归档了它就没用了，直接删。
        // 留着也不会被同名新人误用（指纹对不上），但会在 members/ 里留一个没人认的文件
        await fs.rm(checkpointFile(record.name), { force: true })

        const full: TeamDismissal = { ...record, ...(memoryArchive ? { memoryArchive } : {}) }
        const archive = await readJson<TeamDismissal[]>(dismissalsFile, [])
        archive.push(full)
        // 档案先落：名册、任务板后写。中途断了，最坏是人还在名册上、档案里多一条，不会人没了却没留痕
        await writeJson(dismissalsFile, archive)
        await writeJson(boardFile, board)
        await writeJson(rosterFile, roster)
        return full
      }).then(changed),
    dismissals: () => readJson<TeamDismissal[]>(dismissalsFile, []),
    takeUnnotifiedDismissals: () =>
      serial(async () => {
        const archive = await readJson<TeamDismissal[]>(dismissalsFile, [])
        const fresh = archive.filter((d) => d.by === 'user' && d.producerNotifiedAt === undefined)
        if (fresh.length === 0) return fresh
        const at = now()
        for (const d of fresh) d.producerNotifiedAt = at
        await writeJson(dismissalsFile, archive)
        return fresh
      })
  }
}
