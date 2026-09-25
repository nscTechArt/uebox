/**
 * 工作室模式的四个工具：招人、派活、任务板、交付。
 *
 * 制作人拿全部四个；队员只拿任务板（它们不招人、不派活、不交付）。
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
import { formatInterruptedWrites, WriteLedger } from '../writeLedger'
import {
  TASK_STATUSES,
  type BoardTask,
  type MemberTier,
  type TeamMember,
  type TeamStore
} from './teamStore'

export const TEAM_TOOL_NAMES = ['team_hire', 'team_send', 'team_board', 'team_deliver'] as const

/**
 * 同一时间最多几个队员在跑。
 *
 * 真机上撞过：三个队员并行，各自一个六七万 token 的请求同时打到小米 MiMo Token Plan，
 * 网关不回 429，而是把三个请求挂住，5 分钟后一起断开（`ERR_CONNECTION_CLOSED`）。
 * 编程套餐普遍按账号限并发，而且不公布数字（社区实测 3 路就可能被限）。
 * 2 路是「还算并行、又不容易撞墙」的折中；多派的排队，不报错。
 */
export const MAX_PARALLEL_MEMBERS = 2

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
    signal?: AbortSignal
    onProgress: (text: string) => void
  }) => Promise<string>
  /** 验收有了结论。宿主用它记「这一局有没有过验收」 */
  onVerdict?: (verdict: GoalVerdict | null) => void | Promise<void>
  /** 同一时间最多几个队员在跑，默认 `MAX_PARALLEL_MEMBERS` */
  maxParallelMembers?: number
}

/**
 * 计数信号量。排队中途被停下就退出队列，不占名额。
 */
export function createSlots(limit: number): {
  acquire: (signal?: AbortSignal) => Promise<() => void>
  running: () => number
} {
  let running = 0
  const waiting: Array<() => void> = []
  const grant = (): (() => void) => {
    running++
    let released = false
    return () => {
      if (released) return
      released = true
      running--
      waiting.shift()?.()
    }
  }
  return {
    running: () => running,
    acquire: (signal) => {
      signal?.throwIfAborted()
      if (running < limit) return Promise.resolve(grant())
      return new Promise((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve(grant())
        }
        const onAbort = (): void => {
          const index = waiting.indexOf(wake)
          if (index >= 0) waiting.splice(index, 1)
          reject(signal?.reason ?? new Error('Operation aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiting.push(wake)
      })
    }
  }
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

function createSendTool(deps: TeamToolDeps): UnrealAgentTool<SubAgentResult> {
  /**
   * 同一个队员一次只干一件活。它的记忆是一条对话，两件活同时往里写会串台，
   * 所以同一个人的第二件活排在第一件后面；不同的人照常并行。
   */
  const busy = new Map<string, Promise<unknown>>()
  const limit = deps.maxParallelMembers ?? MAX_PARALLEL_MEMBERS
  const slots = createSlots(limit)

  const sendInput = z.object({
    to: z.string().min(1).describe('队员名'),
    message: z
      .string()
      .min(1)
      .describe('给它的活或者话。它看不到你和用户的对话，需要的背景要写进来，或者放进工作区')
  })

  return defineTool<typeof sendInput, SubAgentResult>({
    name: 'team_send',
    namespace: 'core',
    // 队员自己的工具照样过审批门；派活这个动作本身不改任何东西
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '给一个队员派活或者说话，等它干完回话。它记得你之前发给它的所有内容。' +
      `同一轮里发给不同队员的会并行跑，但同一时间最多 ${limit} 个队员在干活（模型套餐限并发），多的自动排队；` +
      '发给同一个人的按顺序排队。' +
      '回话末尾附一行它实际做过的写操作，那是记账记出来的，不是它自己说的。',
    input: sendInput,
    execute: async ({ to, message }, ctx) => {
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

      const key = member.name.toLowerCase()
      const previous = busy.get(key) ?? Promise.resolve()
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          if (slots.running() >= limit) {
            ctx.report({ text: `${member.name} · 排队中：同时最多 ${limit} 个队员在干活` })
          }
          const release = await slots.acquire(ctx.signal)
          const ledger = new WriteLedger()
          ctx.setAbortNote?.(() => formatInterruptedWrites(ledger.list(), member.readOnly))
          // 上次被停在半截工具调用上的话，那条调用没有结果 —— 摘掉，不然它一睁眼
          // 看到的就是一条凭空的失败（同 `task` 的理由，见 stripPendingToolCalls）
          const history = stripPendingToolCalls(await deps.store.history(member.name))
          let latest: AgentMessage[] | undefined
          try {
            return await deps.runMember({
              member,
              message,
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
            release()
            // 被停下也要存：它已经干了一半的活，下次派活时得记得
            if (latest) await deps.store.saveHistory(member.name, latest)
          }
        })
      busy.set(key, run)
      try {
        const result = await run
        return {
          text: `${member.name} 回话：\n${result.text}\n\n${formatWriteAudit(result)}`,
          details: result
        }
      } finally {
        if (busy.get(key) === run) busy.delete(key)
      }
    }
  })
}

// ── 交付 ────────────────────────────────────────────────────────────────

function createDeliverTool(deps: TeamToolDeps): UnrealAgentTool<GoalVerdict | null> {
  const deliverInput = z.object({
    report: z.string().min(1).describe('交付说明：做了什么、玩法是什么、已知缺口'),
    how_to_play: z.string().min(1).describe('怎么玩：打开哪个关卡、操作键位、胜负条件'),
    project_path: z.string().optional().describe('这次新建的工程目录')
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
    execute: async ({ report, how_to_play, project_path }, ctx) => {
      const text = await deps.runAcceptance({
        report,
        howToPlay: how_to_play,
        ...(project_path ? { projectPath: project_path } : {}),
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
    createDeliverTool(deps)
  ] as unknown as UnrealAgentTool<never>[]
}
