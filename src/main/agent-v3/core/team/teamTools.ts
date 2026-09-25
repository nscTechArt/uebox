/**
 * 工作室模式的工具：招人、派活、任务板、交付、快照，外加队员用的留言。
 *
 * 制作人拿招人、派活、任务板、交付、快照；队员只拿任务板和留言
 * （它们不招人、不派活、不交付，也不能回滚整个工程）。
 *
 * ## 为什么队员是「有记忆的子 Agent」而不是一条条独立会话
 *
 * 队员要的是三件事：自己的人设、自己的工具范围、记得之前干过什么。
 * `runSubAgent` 已经给了前两件（人设走系统提示词，范围走白名单），第三件
 * 就是把它这次跑完的消息存下来、下次作为起始消息喂回去。独立会话还要多出一整套
 * 会话生命周期、界面列表、审批归属，这一版用不上。
 *
 * 队员的锁主是它自己（不是制作人）：两个队员改同一个资产会被资产锁挡下，
 * 而不是像 `task` 子任务那样父子共用一把锁、互相不设防。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../../tools/defineTool'
import {
  formatWriteAudit,
  stripPendingToolCalls,
  type SubAgentResult
} from '../../tools/builtin/task'
import { parseVerdict, type GoalVerdict } from '../goalLoop'
import { formatInterruptedWrites, summarizeDoneWrites, WriteLedger } from '../writeLedger'
import { createStatusTool } from './teamStatus'
import { snapshotMessage, type TeamSnapshots } from './snapshots'
import type { TeamLive } from './teamLive'
import {
  PRODUCER,
  TASK_STATUSES,
  type BoardTask,
  type MemberTier,
  type TeamMail,
  type TeamMember,
  type TeamStore
} from './teamStore'

export const TEAM_TOOL_NAMES = [
  'team_hire',
  'team_send',
  'team_board',
  'team_deliver',
  'team_message',
  'team_snapshot',
  'team_status'
] as const

export interface RunMemberInput {
  member: TeamMember
  message: string
  /** 它之前的全部对话，作为这一次的起始消息 */
  history: AgentMessage[]
  signal?: AbortSignal
  onProgress: (text: string) => void
  ledger: WriteLedger
  /** 跑完（含被停下）时交回它的全部消息，下次派活时接着用 */
  keepMessages: (messages: AgentMessage[]) => void
}

export interface TeamToolDeps {
  store: TeamStore
  objective: string
  /** 制作人这一轮可用的工具命名空间。招人时校验白名单，也写进工具描述让它知道能选什么 */
  namespaces: string[]
  runMember: (input: RunMemberInput) => Promise<SubAgentResult>
  runAcceptance: (input: {
    report: string
    howToPlay: string
    projectPath?: string
    packageExe?: string
    signal?: AbortSignal
    onProgress: (text: string) => void
  }) => Promise<string>
  /** 验收有了结论。宿主用它记「这一局有没有过验收」 */
  onVerdict?: (verdict: GoalVerdict | null) => void | Promise<void>
  /** 工程快照。没有（比如测试里）就不给 `team_snapshot`、也不自动存 */
  snapshots?: TeamSnapshots
  /** 当场对话：插话、回执、后台派活（`teamLive.ts`）。没有就退回纯信箱 */
  live?: TeamLive
  /** 团队的根会话 id。`team_status` 用它从锁表里挑出本团队的锁；没有就不给 `team_status` */
  sessionId?: string
}

// ── 任务板 ──────────────────────────────────────────────────────────────

export function renderBoard(tasks: BoardTask[]): string {
  if (tasks.length === 0) return '任务板是空的。'
  const count = (status: string): number => tasks.filter((t) => t.status === status).length
  const lines = [
    `任务板：${tasks.length} 项（待办 ${count('todo')} · 进行中 ${count('doing')} · 完成 ${count('done')} · 卡住 ${count('blocked')}）`
  ]
  for (const t of tasks) {
    lines.push(
      `- [${t.status}] ${t.id} ${t.title}` +
        (t.owner ? ` @${t.owner}` : '') +
        (t.deps?.length ? ` ←${t.deps.join(',')}` : '') +
        (t.evidence ? `\n    证据：${t.evidence}` : '') +
        (t.note ? `\n    备注：${t.note}` : '')
    )
  }
  return lines.join('\n')
}

const boardInput = z.object({
  action: z.enum(['list', 'update']).describe('list = 看整张板；update = 新建或修改任务'),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).describe('任务 id，自己起，同一个 id 再写就是修改'),
        title: z.string().optional().describe('新建时必填'),
        owner: z.string().optional().describe('负责的队员名'),
        status: z.enum(TASK_STATUSES).optional(),
        deps: z.array(z.string()).optional().describe('依赖哪些任务 id'),
        evidence: z.string().optional().describe('做完的证据：路径、截图、试玩结论'),
        note: z.string().optional()
      })
    )
    .optional()
    .describe('action=update 时给')
})

export function createBoardTool(store: TeamStore): UnrealAgentTool<BoardTask[]> {
  return defineTool<typeof boardInput, BoardTask[]>({
    name: 'team_board',
    namespace: 'core',
    // 只写盒子自己的任务板文件，不碰工程和用户的盘。只读的队员（评审、试玩）也要能报进度
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '团队共享的任务板：制作人和所有队员都能看、都能改，用户在界面上也看得到。' +
      '按 id 合并：写一个已有的 id 就是修改它，新 id 就是新建（要给 title）。' +
      '标 done 时把证据写进 evidence —— 没有证据的「做完」谁也分不出真假。',
    input: boardInput,
    execute: async ({ action, tasks }) => {
      if (action === 'update') {
        if (!tasks?.length) throw new Error('action=update 需要 tasks')
        const board = await store.patchBoard(tasks)
        return { text: renderBoard(board), details: board }
      }
      const board = await store.board()
      return { text: renderBoard(board), details: board }
    }
  })
}

// ── 招人 ────────────────────────────────────────────────────────────────

function createHireTool(deps: TeamToolDeps, now: () => number): UnrealAgentTool<TeamMember> {
  const hireInput = z.object({
    name: z.string().min(1).max(40).describe('队员名，之后派活用它。同名再招一次就是改它的设定'),
    role: z
      .string()
      .min(1)
      .describe(
        '它的人设和职责，由你来写。它只知道这里写的、你派给它的、以及工作区和任务板上的东西'
      ),
    model: z
      .enum(['strong', 'fast'])
      .optional()
      .default('strong')
      .describe('strong = 和你同一档模型；fast = 用户绑的对话模型，便宜快，适合简单重复的活'),
    namespaces: z
      .array(z.string())
      .optional()
      .describe(`只给它这些命名空间的工具；省略 = 和你同一套。可选：${deps.namespaces.join(', ')}`),
    read_only: z
      .boolean()
      .optional()
      .default(false)
      .describe('只读：写工具根本不在它手上。评审、试玩、找问题这类产出是报告的角色用它')
  })

  return defineTool<typeof hireInput, TeamMember>({
    name: 'team_hire',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description:
      '招一个队员，或者改一个已有队员的设定。队员常驻：它记得你之前派给它的所有活。' +
      '岗位、人设、工具范围都由你决定，盒子不预设任何角色。',
    input: hireInput,
    execute: async ({ name, role, model, namespaces, read_only }) => {
      if (name.trim().toLowerCase() === PRODUCER) {
        throw new Error(`"${PRODUCER}" 是留给制作人（你）的名字，换一个`)
      }
      if (namespaces?.length) {
        const unknown = namespaces.filter((ns) => !deps.namespaces.includes(ns))
        if (unknown.length) {
          throw new Error(
            `没有这些命名空间：${unknown.join(', ')}。可选：${deps.namespaces.join(', ')}`
          )
        }
      }
      const existing = await deps.store.findMember(name)
      const member: TeamMember = {
        name: existing?.name ?? name.trim(),
        persona: role,
        tier: model as MemberTier,
        ...(namespaces?.length ? { namespaces } : {}),
        readOnly: Boolean(read_only),
        hiredAt: existing?.hiredAt ?? now()
      }
      await deps.store.putMember(member)
      const roster = await deps.store.roster()
      return {
        text:
          `${existing ? '已更新' : '已招入'} ${member.name}（${member.tier}` +
          `${member.readOnly ? '，只读' : ''}` +
          `${member.namespaces ? `，工具：${member.namespaces.join('/')}` : ''}）。` +
          `\n团队现在 ${roster.length} 人：${roster.map((m) => m.name).join('、')}`,
        details: member
      }
    }
  })
}

// ── 派活 ────────────────────────────────────────────────────────────────

/** 留言拼成一段给模型看的话。以留言人打头，一眼看得出是谁说的 */
export function formatMail(title: string, mails: TeamMail[]): string {
  if (mails.length === 0) return ''
  const who = (name: string): string => (name === PRODUCER ? '制作人' : name)
  return [title, ...mails.map((m) => `- ${who(m.from)}：${m.text}`)].join('\n')
}

function createSendTool(
  deps: TeamToolDeps
): UnrealAgentTool<SubAgentResult | { dispatched: string }> {
  /**
   * 同一个队员一次只干一件活。它的记忆是一条对话，两件活同时往里写会串台，
   * 所以同一个人的第二件活排在第一件后面；不同的人照常并行。
   *
   * 不同队员之间**不设人数上限**：真正扛不住并发的是模型套餐，那一层由
   * `requestGate.ts` 按网关的实际反应自适应调度，队员在编辑器里干活、等工具的时候不占名额。
   */
  const busy = new Map<string, Promise<unknown>>()

  const sendInput = z.object({
    to: z.string().min(1).describe('队员名'),
    message: z
      .string()
      .min(1)
      .describe('给它的活或者话。它看不到你和用户的对话，需要的背景要写进来，或者放进工作区'),
    wait: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'true = 等它干完再回来（默认）；false = 派到后台就回来，你接着干别的、还能用 team_message 跟它当场说话，' +
          '它干完的结论会作为留言送到你这里'
      )
  })

  /** 真正派活：带上记忆和信箱，跑完存记忆、存快照，拼好回话 */
  const assign = async (
    member: TeamMember,
    message: string,
    ctx: {
      signal?: AbortSignal
      report: (partial: { text: string }) => void
      setAbortNote?: (note: () => string | undefined) => void
    }
  ): Promise<{ result: SubAgentResult; text: string }> => {
    const key = member.name.toLowerCase()
    const previous = busy.get(key) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const ledger = new WriteLedger()
        ctx.setAbortNote?.(() => formatInterruptedWrites(ledger.list(), member.readOnly))
        // 上次被停在半截工具调用上的话，那条调用没有结果 —— 摘掉，不然它一睁眼
        // 看到的就是一条凭空的失败（同 `task` 的理由，见 stripPendingToolCalls）
        const history = stripPendingToolCalls(await deps.store.history(member.name))
        // 它不在的时候队友给它的留言，这次接活时一起交给它
        const inbox = formatMail('【队友给你的留言】', await deps.store.takeInbox(member.name))
        let latest: AgentMessage[] | undefined
        deps.live?.setAssignment(member.name, message)
        try {
          return await deps.runMember({
            member,
            message: inbox ? `${inbox}\n\n${message}` : message,
            history,
            ledger,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            // 界面给这类进度统一加「团队：」前缀，这里只标是哪个队员
            onProgress: (text) => ctx.report({ text: `${member.name} · ${text}` }),
            keepMessages: (messages) => {
              latest = messages
            }
          })
        } finally {
          deps.live?.setAssignment(member.name, null)
          // 被停下也要存：它已经干了一半的活，下次派活时得记得
          if (latest) await deps.store.saveHistory(member.name, latest)
        }
      })
    busy.set(key, run)
    try {
      const result = await run
      // 按台账记下它实际改了什么 —— `team_status` 的「最近改动」读它，不靠队员自己说
      await deps.store
        .recordActivity({
          who: member.name,
          what: message.split('\n').find((line) => line.trim()) ?? '',
          writes: result.writes ? summarizeDoneWrites(result.writes) : ''
        })
        .catch(() => undefined)
      const snapshot = await autoSnapshot(deps, member.name, message, result)
      return {
        result,
        text:
          `${member.name} 回话：\n${result.text}\n\n${formatWriteAudit(result)}` +
          (snapshot ? `\n${snapshot}` : '')
      }
    } finally {
      if (busy.get(key) === run) busy.delete(key)
    }
  }

  return defineTool<typeof sendInput, SubAgentResult | { dispatched: string }>({
    name: 'team_send',
    namespace: 'core',
    // 队员自己的工具照样过审批门；派活这个动作本身不改任何东西
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '给一个队员派活 —— 队员空闲时，这是唯一能让它开工的办法（team_message 只是说话）。它记得你之前发给它的所有内容。' +
      '默认等它干完回话；wait=false 派到后台就回来，你可以接着派别人、用 team_message 跟正在干活的队员当场说话，' +
      '它干完的结论作为留言送到你这里（你想收工时，盒子会等所有后台的活交回来）。' +
      '同一轮里发给不同队员的会并行跑；发给同一个人的按顺序排队。' +
      '回话末尾附一行它实际做过的写操作，那是记账记出来的，不是它自己说的。',
    input: sendInput,
    execute: async ({ to, message, wait }, ctx) => {
      const member = await deps.store.findMember(to)
      if (!member) {
        const roster = await deps.store.roster()
        throw new Error(
          `团队里没有「${to}」。` +
            (roster.length
              ? `现有：${roster.map((m) => m.name).join('、')}`
              : '还没招任何人，先用 team_hire')
        )
      }

      if (!wait && deps.live) {
        const live = deps.live
        // 后台跑：进度照样冒到这次调用的泳道上，结论作为留言送回制作人
        const job = assign(member, message, ctx).then(
          ({ text }) => live.send(member.name, PRODUCER, `【交活】${text}`),
          (error: unknown) =>
            live.send(
              member.name,
              PRODUCER,
              `【没干完】${member.name} 这件活停下了：${error instanceof Error ? error.message : String(error)}`
            )
        )
        live.track(member.name, job)
        return {
          text: `已派给 ${member.name}，在后台干。它干完的结论会作为留言送到你这里；想当场跟它说话用 team_message。`,
          details: { dispatched: member.name }
        }
      }

      // 同步等：这段时间制作人没法当场回这个队员的话（它在等队员交活），登记一下，
      // 队员那边要等制作人回复时会被告知「写进结论里交回来」，而不是白等到超时
      const done = deps.live?.awaiting(member.name)
      try {
        const { result, text } = await assign(member, message, ctx)
        // 队员们留给制作人、还没送到的话，跟着这一件活的回话一起带回去
        const toProducer = formatMail('【队员给你的留言】', await deps.store.takeInbox(PRODUCER))
        return { text: text + (toProducer ? `\n\n${toProducer}` : ''), details: result }
      } finally {
        done?.()
      }
    }
  })
}

// ── 留言 ────────────────────────────────────────────────────────────────

/** 等回执、等回复的默认时长和上限 */
const WAIT_READ_MS = 3 * 60_000
const WAIT_REPLY_MS = 10 * 60_000
const WAIT_MAX_MS = 30 * 60_000

/**
 * 留言工具。制作人和每个队员各一份，留言人就是它自己。
 *
 * 对方正在干活，这条就插进它的下一步（和用户插话同一条路）；没在干活就进信箱，
 * 下次接活时交给它。`wait` 决定发完要不要等：等它读到（回执），或者等它回话。
 * 死锁怎么拆见 `teamLive.ts`。
 */
export function createMessageTool(
  store: TeamStore,
  from: string,
  live?: TeamLive
): UnrealAgentTool<unknown> {
  const messageInput = z.object({
    to: z.string().min(1).describe(`收件人：队员名，或者 "${PRODUCER}" 表示制作人`),
    text: z.string().min(1).describe('要说的话。对方看不到你的对话，需要的背景写进来'),
    reply_to: z.string().optional().describe('在回哪一条留言（对方留言开头的 m 编号）'),
    wait: z
      .enum(['none', 'read', 'reply'])
      .optional()
      .default('none')
      .describe(
        'none = 发完就走（默认）；read = 等到对方真的读到（回执）；reply = 等对方回话。' +
          '等的时候如果有人给你发话，会先把那句交给你'
      ),
    wait_seconds: z
      .number()
      .int()
      .min(10)
      .max(WAIT_MAX_MS / 1000)
      .optional()
      .describe('最多等几秒。默认 read 180、reply 600')
  })

  const deliveryNote = (to: string, delivery: string): string =>
    delivery === 'handed'
      ? `${to} 正在等消息，已当场交给它。`
      : delivery === 'live'
        ? `${to} 正在干活，已插进它的下一步。`
        : to === PRODUCER
          ? '制作人这会儿没在跑，已放进它的信箱。'
          : `${to} 这会儿没在干活，已放进它的信箱，下次接活时会看到。`

  return defineTool<typeof messageInput, unknown>({
    name: 'team_message',
    namespace: 'core',
    // 只写盒子自己的信箱，只读的队员（评审、试玩）也要能提意见
    risk: 'safe',
    concurrency: 'parallel',
    description:
      `给队友或制作人（"${PRODUCER}"）说话：交接产出、提问、提醒对方你改了什么。**它不派活** —— ` +
      '对方正在干活的话，这句会插进它的下一步；对方空闲的话只是进信箱，不会让它开工（要它干活用 team_send）。' +
      'wait=read 等回执（对方真的读到），wait=reply 等对方回话。',
    input: messageInput,
    execute: async ({ to, text, reply_to, wait, wait_seconds }, ctx) => {
      const toProducer = to.trim().toLowerCase() === PRODUCER
      let target = PRODUCER
      if (!toProducer) {
        const member = await store.findMember(to)
        if (!member) {
          const roster = await store.roster()
          throw new Error(
            `团队里没有「${to}」。现有：${roster.map((m) => m.name).join('、') || '（无）'}；` +
              `给制作人发话用 "${PRODUCER}"`
          )
        }
        target = member.name
      }
      if (target.toLowerCase() === from.toLowerCase()) throw new Error('不用给自己发话')

      // 制作人正等着这个队员交活时，没法当场回它的话 —— 干等只会等到超时
      if (wait === 'reply' && target === PRODUCER && live?.isAwaiting(from)) {
        throw new Error(
          '制作人正在等你交这件活，没法当场回你。把问题写进你的结论交回去；' +
            '能自己判断的，先按你的判断做并写明理由'
        )
      }

      if (!live) {
        const mail = await store.post(from, target, text, reply_to)
        return { text: deliveryNote(target, 'queued'), details: mail }
      }

      const { mail, delivery } = await live.send(from, target, text, reply_to)
      const lines = [`已发出 ${mail.id}。${deliveryNote(target, delivery)}`]
      // 2026-09-26 真机反馈：制作人给空闲的队员发 team_message 当派活，其实只进了信箱，
      // 白等一整轮才发现得再用 team_send 发一遍
      if (delivery === 'queued' && from === PRODUCER && target !== PRODUCER) {
        lines.push(
          `⚠️ ${target} 现在空闲：这条只是留言，不会让它开工。要它干活用 team_send（可以 wait=false 放到后台）。`
        )
      }
      const ms = Math.min(
        WAIT_MAX_MS,
        wait_seconds ? wait_seconds * 1000 : wait === 'read' ? WAIT_READ_MS : WAIT_REPLY_MS
      )

      if (wait === 'read' && delivery !== 'handed') {
        if (delivery === 'queued') {
          lines.push('对方没在跑，要等它下次接活才读得到，这次不等回执。')
        } else {
          const outcome = await live.waitRead(mail.id, ms, ctx.signal)
          lines.push(
            outcome === 'read'
              ? `回执：${target} 已读到。`
              : `回执：${Math.round(ms / 1000)} 秒内 ${target} 还没读到（它可能卡在一次很长的工具调用里）。`
          )
        }
      }

      if (wait === 'reply') {
        if (delivery === 'queued' && !(toProducer && live.isRunning(PRODUCER))) {
          lines.push('对方没在跑，这次等不到回话；它下次接活时会看到。')
        } else {
          ctx.report({ text: `等 ${who(target)} 回话…` })
          const outcome = await live.waitReply(from, mail.id, ms, ctx.signal)
          if (outcome.kind === 'reply') {
            lines.push(`${who(target)} 回话（${outcome.mail.id}）：\n${outcome.mail.text}`)
          } else if (outcome.kind === 'incoming') {
            lines.push(
              '还没等到回话，先有人给你发了话（可能正是在问你）。先处理它，需要的话再发一次、接着等：',
              formatMail('', outcome.mails).trim()
            )
          } else {
            lines.push(`${Math.round(ms / 1000)} 秒内 ${who(target)} 没回话。`)
          }
        }
      }

      return { text: lines.join('\n'), details: mail }
    }
  })
}

const who = (name: string): string => (name === PRODUCER ? '制作人' : name)

// ── 快照 ────────────────────────────────────────────────────────────────

/**
 * 队员交回一件改了东西的活，就存一份快照。只读的、什么都没写的不存 ——
 * 那样的快照和上一份一模一样，只会把列表撑长。
 *
 * 存失败（没装 git、磁盘满）不影响这件活本身，只在回话里说一句。
 */
async function autoSnapshot(
  deps: TeamToolDeps,
  who: string,
  what: string,
  result: SubAgentResult
): Promise<string> {
  if (!deps.snapshots || Object.keys(result.writeToolCalls ?? {}).length === 0) return ''
  try {
    const snapshot = await deps.snapshots.save(snapshotMessage(who, what))
    return snapshot ? `【快照】已存 ${snapshot.id}（${snapshot.message}）` : ''
  } catch (error) {
    return `【快照】这次没存上：${error instanceof Error ? error.message : String(error)}`
  }
}

function createSnapshotTool(snapshots: TeamSnapshots): UnrealAgentTool<unknown> {
  const snapshotInput = z.object({
    action: z
      .enum(['list', 'save', 'rollback'])
      .describe('list = 看最近的快照；save = 现在存一份；rollback = 把工程退回某一份'),
    id: z.string().optional().describe('rollback 时给：list 里的快照编号'),
    note: z.string().optional().describe('save 时给：这一份是什么状态')
  })

  return defineTool<typeof snapshotInput, unknown>({
    name: 'team_snapshot',
    namespace: 'core',
    // 回滚会关掉编辑器、改写工程文件
    risk: 'destructive',
    concurrency: 'sequential',
    description:
      '工程快照。每个队员交回一件改了东西的活，盒子都会自动存一份（回话里有编号）。' +
      'rollback 把工程的源文件（Content、Config、Source……）整个退回那一份：会先把当前状态也存一份（能反悔），' +
      '然后关掉编辑器、退回文件、重新打开工程。编辑器里没保存的改动会丢，正在动编辑器的队员会失败 —— ' +
      '回滚前先让大家停手。',
    input: snapshotInput,
    execute: async ({ action, id, note }, ctx) => {
      if (action === 'list') {
        const list = await snapshots.list(20)
        return {
          text: list.length
            ? list
                .map(
                  (s) =>
                    `- ${s.id} ${new Date(s.at).toLocaleString('zh-CN', { hour12: false })} ${s.message}`
                )
                .join('\n')
            : '还没有快照。',
          details: list
        }
      }
      if (action === 'save') {
        const snapshot = await snapshots.save(snapshotMessage('制作人', note ?? '手动快照'))
        return {
          text: snapshot ? `已存快照 ${snapshot.id}。` : '和上一份相比没有变化，没有新存。',
          details: snapshot
        }
      }
      if (!id) throw new Error('rollback 要给 id（先用 list 看编号）')
      const text = await snapshots.rollback(id, (line) => ctx.report({ text: line }))
      return { text, details: { id } }
    }
  })
}

// ── 交付 ────────────────────────────────────────────────────────────────

function createDeliverTool(deps: TeamToolDeps): UnrealAgentTool<GoalVerdict | null> {
  const deliverInput = z.object({
    report: z.string().min(1).describe('交付说明：做了什么、玩法是什么、已知缺口'),
    how_to_play: z.string().min(1).describe('怎么玩：打开哪个关卡、操作键位、胜负条件'),
    project_path: z.string().optional().describe('这次新建的工程目录'),
    package_exe: z
      .string()
      .optional()
      .describe('打包出来的 exe（project_package 的结果）。给了的话验收员会拿它冒烟')
  })

  return defineTool<typeof deliverInput, GoalVerdict | null>({
    name: 'team_deliver',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description:
      '交付验收。一个没参与制作的验收员会按交付标准真去玩一遍，回 PASS / FAIL / BLOCKED。' +
      'PASS 之前不算交付；FAIL 就按它说的修完再交；BLOCKED 就停下来告诉用户缺什么。',
    input: deliverInput,
    execute: async ({ report, how_to_play, project_path, package_exe }, ctx) => {
      const text = await deps.runAcceptance({
        report,
        howToPlay: how_to_play,
        ...(project_path ? { projectPath: project_path } : {}),
        ...(package_exe ? { packageExe: package_exe } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (line) => ctx.report({ text: line })
      })
      const verdict = parseVerdict(text)
      await deps.onVerdict?.(verdict)
      const head = !verdict
        ? '验收员没给出明确结论，按未通过处理。'
        : verdict.kind === 'pass'
          ? '验收通过。'
          : verdict.kind === 'blocked'
            ? '验收员没法验：停下来，把缺的东西告诉用户。'
            : '验收未通过：按下面的意见修完，再交一次。'
      return { text: `${head}\n\n${text}`, details: verdict }
    }
  })
}

export function createTeamTools(
  deps: TeamToolDeps,
  now: () => number = Date.now
): UnrealAgentTool<never>[] {
  return [
    createHireTool(deps, now),
    createSendTool(deps),
    createBoardTool(deps.store),
    createDeliverTool(deps),
    // 制作人也能当场跟正在干活的队员说话（配合 team_send 的 wait=false）
    createMessageTool(deps.store, PRODUCER, deps.live),
    ...(deps.snapshots ? [createSnapshotTool(deps.snapshots)] : []),
    ...(deps.sessionId
      ? [
          createStatusTool({
            store: deps.store,
            sessionId: deps.sessionId,
            ...(deps.live ? { live: deps.live } : {}),
            ...(deps.snapshots ? { snapshots: deps.snapshots } : {})
          })
        ]
      : [])
  ] as unknown as UnrealAgentTool<never>[]
}
