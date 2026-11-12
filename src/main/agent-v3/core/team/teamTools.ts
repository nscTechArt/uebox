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

import { defineTool, type ToolRisk, type UnrealAgentTool } from '../../tools/defineTool'
import { SET_SESSION_PROJECT_TOOL_NAME } from '../../tools/toolNames'
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
  MEMORY_KEPT_NOTE,
  PRODUCER,
  TASK_STATUSES,
  type BoardTask,
  type TeamMail,
  type TeamMember,
  type TeamModel,
  type TeamStore
} from './teamStore'
import {
  ACCEPTOR,
  DISMISSAL_GROUNDS,
  sameTeamModel,
  type TeamDismissal,
  type TeamUsage
} from '../../../../shared/agentTeam'
import { dismissMember, formatDismissal } from './dismissal'
import { getTargetProjectPath } from '../projectTargetContext'
import { withoutSystemMessages } from '../systemMessages'
import { checkupPassed } from './modelCheckups'
import {
  canChooseModels,
  describeCandidates,
  describeCheckup,
  modelLabel,
  routeMember,
  type MemberRoute,
  type TeamModels
} from './teamModels'

export const TEAM_TOOL_NAMES = [
  'team_hire',
  'team_dismiss',
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
  /**
   * 交回它的全部消息，下次派活时接着用。每说完一轮交一次，跑完（含被停下）再交一次最终版
   * （见 `runSubAgent` 的同名参数）
   */
  keepMessages: (messages: AgentMessage[]) => void
  /** 钉给它的模型。不给 = 老规矩（制作人的模型，或老 `fast` 档的对话模型），见 `routeMember` */
  pin?: TeamModel
  /** 跑完（含被停下）时交回这件活花掉的 token，记进这件活和团队的总账 */
  keepUsage?: (usage: TeamUsage) => void
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
    /** 跑完（含被停下）时交回验收花掉的 token，记进团队的总账 */
    keepUsage: (usage: TeamUsage) => void
  }) => Promise<string>
  /** 验收有了结论。宿主用它记「这一局有没有过验收」 */
  onVerdict?: (verdict: GoalVerdict | null) => void | Promise<void>
  /** 工程快照。没有（比如测试里）就不给 `team_snapshot`、也不自动存 */
  snapshots?: TeamSnapshots
  /** 当场对话：插话、回执、后台派活（`teamLive.ts`）。没有就退回纯信箱 */
  live?: TeamLive
  /** 团队的根会话 id。`team_status` 用它从锁表里挑出本团队的锁；没有就不给 `team_status` */
  sessionId?: string
  /** 队员能用哪些模型（`teamModels.ts`）。没有（老测试）就不让挑，队员跟着制作人 */
  models?: TeamModels
}

// ── 任务板 ──────────────────────────────────────────────────────────────

/** 计数那一行。整张板、只看几项、改完回执都以它开头，模型随时知道全局 */
function boardSummary(tasks: BoardTask[]): string {
  const count = (status: string): number => tasks.filter((t) => t.status === status).length
  return `任务板：${tasks.length} 项（待办 ${count('todo')} · 进行中 ${count('doing')} · 完成 ${count('done')} · 卡住 ${count('blocked')}）`
}

/** 一项任务。`full` 时带上证据和备注全文，否则只标「有」 */
function boardLine(t: BoardTask, full: boolean): string {
  const head =
    `- [${t.status}] ${t.id} ${t.title}` +
    (t.owner ? ` @${t.owner}` : '') +
    (t.deps?.length ? ` ←${t.deps.join(',')}` : '')
  if (full) {
    return (
      head +
      (t.evidence ? `\n    证据：${t.evidence}` : '') +
      (t.note ? `\n    备注：${t.note}` : '')
    )
  }
  return head + (t.evidence ? ' · 有证据' : '') + (t.note ? ' · 有备注' : '')
}

/**
 * 任务板给模型看的样子。
 *
 * **已完成的项默认只列一行，证据和备注折叠成「有证据 / 有备注」。** 以前每次都是整张板
 * 带全文：真机上一个团队 138 项、每项带完整证据，一次 list 约 14 万字符，一个队员的
 * 历史里攒了 13 份 —— 工具结果进了上下文就不出来，这是把队员顶到厂商上下文上限的
 * 放大器之一。完成项的证据是「交回时」要看的东西，之后大多只用知道它做完了；
 * 要验收某几项，`team_board` list 带 `ids` 看全文（`expand`）。
 *
 * 没做完的项照旧带全文：那是正在干的活，备注里往往就是下一步。
 */
export function renderBoard(
  tasks: BoardTask[],
  options: { expand?: readonly string[] } = {}
): string {
  if (tasks.length === 0) return '任务板是空的。'
  const expand = new Set(options.expand ?? [])
  const lines = [boardSummary(tasks)]
  let folded = false
  for (const t of tasks) {
    const full = t.status !== 'done' || expand.has(t.id)
    if (!full && (t.evidence || t.note)) folded = true
    lines.push(boardLine(t, full))
  }
  if (folded) {
    lines.push('（已完成项的证据和备注折叠了：team_board list 带 ids，如 ["t1"]，看全文）')
  }
  return lines.join('\n')
}

/** 只看这几项：计数行 + 这几项的全文。没有的 id 说出来，免得模型以为它们存在 */
export function renderBoardTasks(tasks: BoardTask[], ids: readonly string[]): string {
  const wanted = new Set(ids)
  const found = tasks.filter((t) => wanted.has(t.id))
  const missing = ids.filter((id) => !tasks.some((t) => t.id === id))
  return [
    boardSummary(tasks),
    ...found.map((t) => boardLine(t, true)),
    ...(missing.length ? [`（任务板上没有：${missing.join('、')}）`] : [])
  ].join('\n')
}

/**
 * 改完的回执：计数行 + 改到的那几项。
 *
 * 不再回整张板：改一项就回 138 项全文，正是上面说的那个放大器里占大头的一份 ——
 * 改任务板是队员最常做的事。要看整张板用 list
 */
export function renderBoardUpdate(tasks: BoardTask[], changedIds: readonly string[]): string {
  const changed = new Set(changedIds)
  return [
    `已更新 ${changed.size} 项。${boardSummary(tasks)}`,
    ...tasks.filter((t) => changed.has(t.id)).map((t) => boardLine(t, true))
  ].join('\n')
}

const boardInput = z.object({
  action: z.enum(['list', 'update']).describe('list = 看整张板；update = 新建或修改任务'),
  ids: z
    .array(z.string())
    .optional()
    .describe('action=list 时只看这几项，带证据和备注全文（整张板里已完成项的证据是折叠的）'),
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
    execute: async ({ action, ids, tasks }) => {
      if (action === 'update') {
        if (!tasks?.length) throw new Error('action=update 需要 tasks')
        const board = await store.patchBoard(tasks)
        return {
          text: renderBoardUpdate(
            board,
            tasks.map((t) => t.id)
          ),
          details: board
        }
      }
      const board = await store.board()
      return {
        text: ids?.length ? renderBoardTasks(board, ids) : renderBoard(board),
        details: board
      }
    }
  })
}

// ── 辞退 ────────────────────────────────────────────────────────────────

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/** 制作人能挑的依据：`user` 留给用户在任务板上辞的，制作人不能冒用 */
const PRODUCER_GROUNDS = DISMISSAL_GROUNDS.filter((g) => g !== 'user') as [
  Exclude<(typeof DISMISSAL_GROUNDS)[number], 'user'>,
  ...Exclude<(typeof DISMISSAL_GROUNDS)[number], 'user'>[]
]

function createDismissTool(
  deps: TeamToolDeps,
  busy: BusyMap,
  now: () => number
): UnrealAgentTool<TeamDismissal> {
  const dismissInput = z.object({
    name: z.string().min(1).describe('要辞退的队员名'),
    grounds: z
      .enum(PRODUCER_GROUNDS)
      .describe(
        'quality = 交的活不达标；unfinished = 活老是干不完；redundant = 岗位不需要了或和别人重了；' +
          'user_request = 用户在对话里要求的'
      ),
    reason: z.string().min(1).max(500).describe('理由，写给用户看的：具体到哪件活、哪里不行'),
    evidence: z
      .array(z.string())
      .optional()
      .describe(
        '它名下的活 id（j…，team_status 的【最近的活】）或任务 id。grounds 是 quality / unfinished 时至少一条'
      ),
    handover_to: z
      .string()
      .optional()
      .describe('它没做完的任务交给谁（在册队员）。省略 = 清掉负责人，之后你再分配')
  })
  return defineTool<typeof dismissInput, TeamDismissal>({
    name: 'team_dismiss',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description:
      '辞退一个队员：移出名册，没做完的任务交接出去，它的记忆归档。' +
      '手上有活的不能辞。说它干得不行要引用它名下的活或任务当证据；' +
      '盒子另从账上记下它交回、停下了几件，连同理由一起存档，用户在任务板上看得到。' +
      '只是想换模型或改人设，用 team_hire 同名再招，不用辞。',
    input: dismissInput,
    execute: async ({ name, grounds, reason, evidence, handover_to }) => {
      const record = await dismissMember(deps.store, {
        name,
        by: 'producer',
        grounds,
        reason,
        ...(evidence ? { evidence } : {}),
        ...(handover_to ? { handoverTo: handover_to } : {}),
        isBusy: (who) => busy.has(who.toLowerCase()) || !!deps.live?.isRunning(who),
        now
      })
      const roster = await deps.store.roster()
      return {
        text: formatDismissal(
          record,
          roster.map((m) => m.name)
        ),
        details: record
      }
    }
  })
}

// ── 招人 ────────────────────────────────────────────────────────────────

/** `team_hire` 说明里候选名单的开头。混合团队把名单挪进 `team_open` 的回话，按它切（`hybridTeamTools.ts`） */
export const HIRE_CANDIDATES_HEADING = '可用模型：\n'

function createHireTool(deps: TeamToolDeps, now: () => number): UnrealAgentTool<TeamMember> {
  const models = deps.models
  const choosable = canChooseModels(models)
  const baseInput = z.object({
    name: z.string().min(1).max(40).describe('队员名，之后派活用它。同名再招一次就是改它的设定'),
    role: z
      .string()
      .min(1)
      .describe(
        '它的人设和职责，由你来写。它只知道这里写的、你派给它的、以及工作区和任务板上的东西'
      ),
    namespaces: z
      .array(z.string())
      .optional()
      .describe(
        `只给它这些命名空间的工具；省略 = 全套（含你手上没有的写工具）。可选：${deps.namespaces.join(', ')}`
      ),
    read_only: z
      .boolean()
      .optional()
      .default(false)
      .describe('只读：写工具根本不在它手上。评审、试玩、找问题这类产出是报告的角色用它'),
    role_type: z
      .string()
      .max(20)
      .optional()
      .describe(
        '岗位的粗类型，一两个字的词，如 策划、搭建、美术、程序、审核、试玩。同一类岗位用同一个词：' +
          '盒子按它把每个模型干过的活分开记，以后招人时你看得到谁干哪类活靠谱'
      )
  })
  const fullInput = baseInput.extend({
    model: z
      .string()
      .optional()
      .describe('它用哪个模型，填工具说明里列的 id。新招的省略 = 和你同一个；改设定时省略 = 不变'),
    model_reason: z
      .string()
      .max(120)
      .optional()
      .describe('为什么给它这个模型，一句话。用户在任务板上看得到；挑了和你不同的模型时必填')
  })
  /*
   * 只有一个能用的模型时，参数里干脆不出现 model —— 没得选就不让制作人想。
   * 两种形状给同一个类型：少的那种只是 model / model_reason 永远是 undefined
   */
  const hireInput = (choosable ? fullInput : baseInput) as unknown as typeof fullInput

  return defineTool<typeof hireInput, TeamMember>({
    name: 'team_hire',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description:
      '招一个队员，或者改一个已有队员的设定。队员常驻：它记得你之前派给它的所有活。' +
      '岗位、人设、工具范围都由你决定，盒子不预设任何角色。' +
      (choosable
        ? '\n\n每个队员可以用不同的模型。看这个岗位的活要多强、量多大、要不要换一家的眼光来查，自己判断；' +
          '用户在任务板上亲手改过的模型（回话里标着「用户定的」），除非用户开口别再改。' +
          '某个岗位的活老被用户打回，可以同名再招一次换个模型，回话里跟用户说清依据。' +
          '挑了你以外的模型，盒子会先给它做一次入职体检（通不通、会不会调工具），没过会告诉你。' +
          HIRE_CANDIDATES_HEADING +
          describeCandidates(models)
        : ''),
    input: hireInput,
    execute: async ({ name, role, model, model_reason, namespaces, read_only, role_type }) => {
      if (name.trim().toLowerCase() === PRODUCER) {
        throw new Error(`"${PRODUCER}" 是留给制作人（你）的名字，换一个`)
      }
      if (name.trim().toLowerCase() === ACCEPTOR) {
        throw new Error(`"${ACCEPTOR}" 是留给验收员的名字，换一个`)
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
      const choice = await pickMemberModel(
        models,
        existing,
        choosable ? model : undefined,
        model_reason
      )
      const roleType = role_type?.trim() || existing?.roleType
      const member: TeamMember = {
        name: existing?.name ?? name.trim(),
        persona: role,
        tier: existing?.tier ?? 'strong',
        ...choice,
        ...(roleType ? { roleType } : {}),
        ...(namespaces?.length ? { namespaces } : {}),
        readOnly: Boolean(read_only),
        hiredAt: existing?.hiredAt ?? now()
      }
      await deps.store.putMember(member)
      const roster = await deps.store.roster()
      // 同名的人辞退过：新招的是新人，记忆从空白开始；用户辞的要让制作人看见理由
      const dismissed = existing
        ? undefined
        : (await deps.store.dismissals()).filter((d) => sameName(d.name, member.name)).at(-1)
      const flags = [
        ...(choosable && member.model
          ? [
              `${modelLabel(models, member.model)}` +
                (member.modelBy === 'user'
                  ? '，用户定的'
                  : member.modelReason
                    ? `：${member.modelReason}`
                    : '')
            ]
          : []),
        ...(!member.model && member.tier === 'fast' ? ['fast'] : []),
        ...(member.readOnly ? ['只读'] : []),
        ...(member.namespaces ? [`工具：${member.namespaces.join('/')}`] : [])
      ]
      return {
        text:
          `${existing ? '已更新' : '已招入'} ${member.name}` +
          (flags.length ? `（${flags.join('；')}）` : '') +
          `。\n团队现在 ${roster.length} 人：${roster.map((m) => m.name).join('、')}` +
          (dismissed
            ? `\n注意：${dismissed.by === 'user' ? '用户' : '你'}辞退过同名队员，理由：${dismissed.reason}。` +
              '这次是新人，不记得之前的活' +
              (dismissed.by === 'user'
                ? '；用户没开口要它回来的话，换个名字、换掉让用户不满的地方'
                : '')
            : ''),
        details: member
      }
    }
  })
}

/**
 * 招人或改设定时，这个队员的模型怎么定。
 *
 * - 指定了：必须在候选名单里；和制作人不同的要写理由（用户在任务板上看理由），
 *   还要过入职体检（`modelCheckups.ts`）—— 不会调工具的模型招进来也干不了活。
 * - 没指定、是新人：钉成制作人此刻的模型。不钉的话用户之后在输入框换模型，
 *   整个团队会悄悄跟着换 —— 招人时定下的就该一直是它。
 * - 没指定、是老队员：不变。老名册里没钉模型的队员照旧按 `tier` 走。
 */
async function pickMemberModel(
  models: TeamModels | undefined,
  existing: TeamMember | undefined,
  requested: string | undefined,
  reason: string | undefined
): Promise<Pick<TeamMember, 'model' | 'modelReason' | 'modelBy'>> {
  const keep = {
    ...(existing?.model ? { model: existing.model } : {}),
    ...(existing?.modelReason ? { modelReason: existing.modelReason } : {}),
    ...(existing?.modelBy ? { modelBy: existing.modelBy } : {})
  }
  const why = reason?.trim()
  if (!requested?.trim()) {
    if (existing) return keep
    return models?.producer ? { model: models.producer, modelBy: 'producer' } : {}
  }
  const picked = models?.candidates.find((c) => c.key === requested.trim())
  if (!models || !picked) {
    throw new Error(
      `没有「${requested}」这个模型。可选：${models?.candidates.map((c) => c.key).join('、') ?? '（无）'}`
    )
  }
  const model: TeamModel = { providerId: picked.providerId, modelId: picked.modelId }
  if (sameTeamModel(model, existing?.model)) {
    return why ? { ...keep, modelReason: why } : keep
  }
  if (!why && !sameTeamModel(model, models.producer)) {
    throw new Error(
      `给 ${picked.name} 写一句理由（model_reason）：为什么这个岗位用它。用户在任务板上看得到`
    )
  }
  // 制作人自己用的那个正在跑，用不着体检
  if (models.checkup && !sameTeamModel(model, models.producer)) {
    const checkup = await models.checkup(model)
    if (!checkupPassed(checkup)) {
      throw new Error(`${picked.name} 入职体检没过：${describeCheckup(checkup)}。换一个模型`)
    }
  }
  return { model, ...(why ? { modelReason: why } : {}), modelBy: 'producer' }
}

// ── 派活 ────────────────────────────────────────────────────────────────

/** 留言拼成一段给模型看的话。以留言人打头，一眼看得出是谁说的 */
export function formatMail(title: string, mails: TeamMail[]): string {
  if (mails.length === 0) return ''
  const who = (name: string): string => (name === PRODUCER ? '制作人' : name)
  return [title, ...mails.map((m) => `- ${who(m.from)}：${m.text}`)].join('\n')
}

/**
 * 干活途中按轮存盘，从第一次交来的那一轮起最多隔这么久落一次。
 *
 * 只是合并写盘：一件活里工具一轮接一轮，记忆是整份 JSON，每轮都整份重写太浪费；
 * 隔一会儿只写最新那份。崩了最多丢这一小段，和模型怎么干活无关
 */
export const MEMORY_SAVE_INTERVAL_MS = 2_000

/**
 * 一件活的记忆存盘：`keep` 记下最新一份、合并着落盘，`flush` 取消待写的、把最终版写上去。
 *
 * 所有写都排在同一条链上，先交的先写 —— `flush` 那次排在最后，在途的旧快照盖不掉它。
 * 提示词和工具增量每轮现算，不进队员的记忆（见 systemMessages.ts）
 */
export function createMemorySaver(
  save: (messages: AgentMessage[]) => Promise<void>,
  intervalMs = MEMORY_SAVE_INTERVAL_MS
): {
  keep: (messages: AgentMessage[]) => void
  flush: () => Promise<void>
  /** 交过至少一份（落没落盘另说） */
  readonly kept: boolean
} {
  let latest: AgentMessage[] | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()
  const write = (): void => {
    const snapshot = latest
    if (!snapshot) return
    // 中途那几次写失败不要紧，下一次写的是更全的一份
    chain = chain.then(() => save(snapshot)).catch(() => undefined)
  }
  return {
    keep(messages) {
      // 交来的是活的数组，下一轮还会往里推 —— 拷一份
      latest = withoutSystemMessages(messages).slice()
      timer ??= setTimeout(() => {
        timer = undefined
        write()
      }, intervalMs)
    },
    async flush() {
      if (timer) clearTimeout(timer)
      timer = undefined
      const snapshot = latest
      if (!snapshot) return chain
      // 最终版写失败要让调用方知道，和改之前一样
      const final = chain.then(() => save(snapshot))
      chain = final.catch(() => undefined)
      return final
    },
    get kept() {
      return latest !== undefined
    }
  }
}

/**
 * 每个队员手上（在干 + 排着）的活，键是小写名字。
 *
 * 同一个队员一次只干一件活。它的记忆是一条对话，两件活同时往里写会串台，
 * 所以同一个人的第二件活排在第一件后面；不同的人照常并行。
 *
 * 不同队员之间**不设人数上限**：真正扛不住并发的是模型套餐，那一层由
 * `requestGate.ts` 按网关的实际反应自适应调度，队员在编辑器里干活、等工具的时候不占名额。
 *
 * 辞退也看它：手上有活的不能辞
 */
type BusyMap = Map<string, Promise<unknown>>

function createSendTool(
  deps: TeamToolDeps,
  busy: BusyMap
): UnrealAgentTool<SubAgentResult | { dispatched: string }> {
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
    // 轮到它开工那一刻再定用哪个模型：排队期间用户可能在任务板上换了。
    // 回话和记账要说的是这一件实际用的
    let current = member
    let route: MemberRoute = { fellBack: false }
    let startedAt = Date.now()
    /** 活的账（`store.startJob`）：界面上「谁交回了什么」就是它。记不上不影响干活 */
    let jobId: string | undefined
    /** 这件活花掉的 token。跑完（含停下）才有，记进这件活和总账 */
    let spent: TeamUsage | undefined
    // 记一笔履历：哪个模型、干哪类活、交没交回来。说不准是哪个模型（老 fast 档）就不记
    const remember = (outcome: 'done' | 'unfinished'): void => {
      if (!route.used || !deps.models?.record) return
      void deps.models
        .record({
          kind: 'task',
          model: route.used,
          ...(current.roleType ? { roleType: current.roleType } : {}),
          outcome,
          ms: Date.now() - startedAt
        })
        .catch(() => undefined)
    }
    const settleJob = async (
      end: { outcome: 'done'; report: string } | { outcome: 'stopped'; reason: string }
    ): Promise<void> => {
      const usage = spent ? { usage: spent } : {}
      await (
        jobId
          ? deps.store.finishJob(jobId, { ...end, ...usage })
          : // 活的账没记上（startJob 失败）：用量照样进总账
            spent
            ? deps.store.addUsage(member.name, spent)
            : Promise.resolve()
      ).catch(() => undefined)
    }

    // 被停下也要存：它已经干了一半的活，下次派活时得记得
    const memory = createMemorySaver((messages) => deps.store.saveHistory(member.name, messages))
    const previous = busy.get(key) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const latest = await deps.store.findMember(member.name)
        // 排队期间被用户在任务板上辞了：这件不开工
        if (!latest) throw new Error(`${member.name} 在排队期间被辞退了，这件活没开工`)
        current = latest
        route = await routeMember(deps.models, current)
        startedAt = Date.now()
        jobId = (await deps.store.startJob(member.name, message).catch(() => undefined))?.id
        const ledger = new WriteLedger()
        ctx.setAbortNote?.(() => formatInterruptedWrites(ledger.list(), member.readOnly))
        // 上次被停在半截工具调用上的话，那条调用没有结果 —— 摘掉，不然它一睁眼
        // 看到的就是一条凭空的失败（同 `task` 的理由，见 stripPendingToolCalls）
        const history = stripPendingToolCalls(await deps.store.history(member.name))
        // 它不在的时候队友给它的留言，这次接活时一起交给它
        const inbox = formatMail('【队友给你的留言】', await deps.store.takeInbox(member.name))
        deps.live?.setAssignment(member.name, message)
        try {
          return await deps.runMember({
            member: current,
            message: inbox ? `${inbox}\n\n${message}` : message,
            history,
            ledger,
            keepUsage: (usage) => (spent = usage),
            ...(route.pin ? { pin: route.pin } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            // 界面给这类进度统一加「团队：」前缀，这里只标是哪个队员
            // 后台派的活这次调用早就结束了，report 推不出去；动态另走一条推送
            onProgress: (text) => {
              ctx.report({ text: `${member.name} · ${text}` })
              deps.live?.note(member.name, text)
            },
            keepMessages: memory.keep
          })
        } finally {
          deps.live?.setAssignment(member.name, null)
          await memory.flush()
        }
      })
    busy.set(key, run)
    try {
      let result: SubAgentResult
      try {
        result = await run
      } catch (error) {
        remember('unfinished')
        const why = error instanceof Error ? error.message : String(error)
        // 制作人决定重派时要知道：它记得干到哪了，可以让它接着上次的往下干
        const reason = memory.kept ? `${why}；${MEMORY_KEPT_NOTE}` : why
        // 停下的活也记已经花掉的：钱是真花了
        await settleJob({ outcome: 'stopped', reason })
        throw error
      }
      remember('done')
      await settleJob({ outcome: 'done', report: result.text })
      // 按台账记下它实际改了什么 —— `team_status` 的「最近改动」读它，不靠队员自己说
      await deps.store
        .recordActivity({
          who: member.name,
          what: message.split('\n').find((line) => line.trim()) ?? '',
          writes: result.writes ? summarizeDoneWrites(result.writes) : '',
          ...(route.used ? { model: route.used } : {}),
          // 用户以后在任务板上打回这件活时，履历要记到同一个工程上
          ...(getTargetProjectPath() ? { project: getTargetProjectPath() } : {})
        })
        .catch(() => undefined)
      const snapshot = await autoSnapshot(deps, member.name, message, result)
      return {
        result,
        text:
          `${member.name}${describeRoute(deps.models, current, route)} 回话：\n` +
          `${result.text}\n\n${formatWriteAudit(result)}` +
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
        const gone = (await deps.store.dismissals()).filter((d) => sameName(d.name, to)).at(-1)
        throw new Error(
          `团队里没有「${to}」。` +
            (gone ? `它已被${gone.by === 'user' ? '用户' : '你'}辞退（${gone.reason}）。` : '') +
            (roster.length
              ? `现有：${roster.map((m) => m.name).join('、')}`
              : '还没招任何人，先用 team_hire')
        )
      }

      if (!wait && deps.live) {
        const live = deps.live
        // 后台跑：进度照样冒到这次调用的泳道上，结论作为留言送回制作人
        const job = assign(member, message, ctx).then(
          ({ text }) =>
            live.send(member.name, PRODUCER, `【交活】${text}`, undefined, { interrupt: true }),
          (error: unknown) =>
            live.send(
              member.name,
              PRODUCER,
              `【没干完】${member.name} 这件活停下了：${error instanceof Error ? error.message : String(error)}`,
              undefined,
              { interrupt: true }
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

/**
 * 回话抬头里带上这件活是哪个模型干的：用户可能在任务板上改过，制作人得知道现在是谁在干。
 * 只有一个模型可用时不提 —— 说了也没得选。
 */
function describeRoute(
  models: TeamModels | undefined,
  member: TeamMember,
  route: MemberRoute
): string {
  if (route.fellBack && member.model) {
    // 没有「制作人的模型」（混合团队的制作人在盒子外）时退回的是盒子的默认模型，不能说成你的
    return `（它的模型 ${modelLabel(models, member.model)} 现在用不了，这件活改用${models?.producer ? '你的模型' : '盒子的默认模型'}）`
  }
  if (!canChooseModels(models) || !route.used) return ''
  return `（${modelLabel(models, route.used)}${member.modelBy === 'user' ? '，用户定的' : ''}）`
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
          ? '已放进制作人的信箱，它下次看信箱时会读到。'
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
      '发给制作人的话不带 wait 只进它的信箱，不打断它。' +
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

      // 给制作人的话只有对方要等的才当场插进去，见 `teamLive.ts` 文件头
      const { mail, delivery } = await live.send(from, target, text, reply_to, {
        interrupt: wait !== 'none'
      })
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
    // 标签说「它干了什么」：交回报告的第一句比派活原文贴切 —— 派活常以工程路径这类背景开头，
    // 一串快照全叫「地编：工程：I:\…」就分不出来了
    const did = result.text
      .trim()
      .split(/(?<=[。！？!?])|\n/)
      .find((s) => s.trim())
    const snapshot = await deps.snapshots.save(snapshotMessage(who, did || what))
    return snapshot ? `【快照】已存 ${snapshot.id}（${snapshot.message}）` : ''
  } catch (error) {
    return `【快照】这次没存上：${error instanceof Error ? error.message : String(error)}`
  }
}

export function createSnapshotTool(snapshots: TeamSnapshots): UnrealAgentTool<unknown> {
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
    // 回滚会关掉编辑器、改写工程文件，编辑器里没保存的改动会丢
    risk: 'destructive',
    // list 只读；save 只多存一份。回滚虽然先存了当前状态，但未保存的改动救不回，仍要问
    riskFor: ({ action }) =>
      action === 'list' ? 'safe' : action === 'save' ? 'mutating' : 'destructive',
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
    project_path: z
      .string()
      .optional()
      .describe('这次新建的工程目录；交付的是模型、贴图这类文件而不是游戏时，给交付目录'),
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
      'PASS 之前不算交付；FAIL 就修它指出的问题，再按交付标准整体过一遍才交；BLOCKED 就停下来告诉用户缺什么。',
    input: deliverInput,
    execute: async ({ report, how_to_play, project_path, package_exe }, ctx) => {
      // 验收员不进活的账（它不是队员、不交成果），用量只记进总账；被停下也记
      let spent: TeamUsage | undefined
      let text: string
      try {
        text = await deps.runAcceptance({
          report,
          howToPlay: how_to_play,
          ...(project_path ? { projectPath: project_path } : {}),
          ...(package_exe ? { packageExe: package_exe } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onProgress: (line) => ctx.report({ text: line }),
          keepUsage: (usage) => (spent = usage)
        })
      } finally {
        if (spent) await deps.store.addUsage(ACCEPTOR, spent).catch(() => undefined)
      }
      const verdict = parseVerdict(text)
      await deps.onVerdict?.(verdict)
      const head = !verdict
        ? '验收员没给出明确结论，按未通过处理。'
        : verdict.kind === 'pass'
          ? '验收通过。'
          : verdict.kind === 'blocked'
            ? '验收员没法验：停下来，把缺的东西告诉用户。'
            : '验收未通过：下面是验收员找到的问题，不是交付标准的全部。修完后按交付标准整体过一遍再交；别靠砍内容、关功能换通过。'
      return { text: `${head}\n\n${text}`, details: verdict }
    }
  })
}

export function createTeamTools(
  deps: TeamToolDeps,
  now: () => number = Date.now
): UnrealAgentTool<never>[] {
  const busy: BusyMap = new Map()
  return [
    createHireTool(deps, now),
    createDismissTool(deps, busy, now),
    createSendTool(deps, busy),
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
            ...(deps.snapshots ? { snapshots: deps.snapshots } : {}),
            ...(deps.models ? { models: deps.models } : {})
          })
        ]
      : [])
  ] as unknown as UnrealAgentTool<never>[]
}

/**
 * 制作人手上留哪些工具：只读的，加上建工程、绑工程。其余（写文件、改编辑器、跑命令、
 * `task` 子任务）一律收走，活只能招人派出去。团队工具在这之后追加，不经这道过滤。
 *
 * 2026-10-16 加，规则台账有记：制作人拿着全套写工具，两次都一个人没招、自己把游戏写完。
 * 团队模式就是为了多个模型分工协作，想单干用普通对话就行。参照 Claude Code Agent Teams 的 delegate mode。
 *
 * - `task` 虽然是 safe，但它派出去的子 agent 带全套写工具，留着等于没收。
 * - 建工程、绑工程留给制作人：队员开了工程，它这一轮的工具清单不会跟着刷新
 *   （见 `runSubAgent` 的 `refreshEngine`），而快照、`team_status` 认的是这条会话绑的工程。
 */
const PRODUCER_SETUP_TOOLS = new Set(['project_manage', SET_SESSION_PROJECT_TOOL_NAME])

/** `project_manage` 里制作人能用的动作。导资产、往关卡放东西、建定序器、开插件都是改游戏，派给队员 */
const PRODUCER_PROJECT_ACTIONS = ['create_project', 'open_project'] as const
const PRODUCER_PROJECT_ACTION_SET: ReadonlySet<string> = new Set(PRODUCER_PROJECT_ACTIONS)

/** 这两个动作用得到的参数。导入、插件、定序器那十几个字段制作人一个都用不上 */
const PRODUCER_PROJECT_FIELDS: ReadonlySet<string> = new Set([
  'action',
  'templateName',
  'projectName',
  'targetDir',
  'engineVersion',
  'projectKey',
  'projectPath',
  'waitSeconds'
])

/**
 * 底层这两个字段的说明里写着 import / enable_plugins 也认 —— 留着就等于在提示词里
 * 再告诉一遍制作人「这个工具还能导资产」，所以连说明一起换掉。
 */
const PRODUCER_FIELD_DESCRIPTIONS: Record<string, string> = {
  projectKey:
    'open_project 用：项目唯一标识（project_list 的 list_projects 里查），优先于 projectPath',
  projectPath: 'open_project 用：项目目录或 .uproject 路径（没有 projectKey 时给它）'
}

const PRODUCER_PROJECT_DESCRIPTION = `建新工程、打开已有工程。工作室模式里你只用它做这两件事。

【action 取值】
- create_project：按模板建新工程（需要 templateName、projectName、targetDir）
- open_project：打开一个已有工程（给 projectKey，或直接给 projectPath）

导资产、往关卡里放东西、建定序器、给工程开插件都是改游戏内容，写进任务派给队员。
列模板、列工程用 project_list。

【打开不用先挑引擎】open_project 把 .uproject 交给系统打开，用哪个引擎由工程里的
EngineAssociation 定，这里没有引擎参数；UnrealAgentLink 插件由盒子在打开前装好。
【打开默认立即返回】waitSeconds 默认 0，connected=false 是还在加载，不是失败，不要重复启动。
用 ue_session_health 确认目标工程连上后，再对同一工程调一次 open_project、waitSeconds: 5
做就绪校验；connected=true 且 switched_target=true 就直接接着干，不用请用户去界面上切工程。
open_project 不改这条对话挂在哪个工程下，要改归属用 set_session_project。`

/**
 * 只认 create / open 的 JSON Schema：action 枚举收窄，用不上的字段去掉。
 *
 * 和 `splitByRisk.ts` 的 `withWriteActionsOnly` 是同一件事（2026-09-11「声明在骗人」：
 * 枚举里露着调不通的动作），只是做在适配之后的 JSON Schema 上 —— 这里拿到的是已经
 * 适配、包过资产锁的工具，Zod schema 早就转掉了；而为了拿 Zod 去 import `splitByRisk`，
 * 会把底下 `projectTool` 那一整串（数据库、服务、electron）拖进团队模块。
 *
 * 枚举收窄不只是给模型看的：pi 在 `beforeToolCall` **之前**按这份 schema 校验参数，
 * 枚举外的动作在那一步就被退回，根本走不到审批门。
 */
function producerProjectSchema(parameters: unknown): unknown {
  const schema = parameters as
    | { properties?: Record<string, unknown>; required?: unknown }
    | undefined
  // 不是对象 schema（测试替身、将来换写法）就原样返回，execute 那道拦截照样在
  if (!schema?.properties) return parameters
  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema.properties)) {
    if (!PRODUCER_PROJECT_FIELDS.has(key)) continue
    properties[key] = PRODUCER_FIELD_DESCRIPTIONS[key]
      ? { ...(value as object), description: PRODUCER_FIELD_DESCRIPTIONS[key] }
      : value
  }
  properties.action = {
    type: 'string',
    enum: [...PRODUCER_PROJECT_ACTIONS],
    description: '【必填】create_project 建工程 / open_project 开工程'
  }
  return {
    ...schema,
    properties,
    ...(Array.isArray(schema.required)
      ? { required: schema.required.filter((key) => PRODUCER_PROJECT_FIELDS.has(String(key))) }
      : {})
  }
}

/**
 * 制作人版的 `project_manage`：说明、schema、风险、执行入口四处一起收窄。
 *
 * 原来只在 execute 里拒，可审批门跑在 execute 前面：ask 档下制作人调一次
 * `enable_plugins`，先弹一张审批卡、用户点了允许才换回一句「不让做」；
 * 卡上还有「以后都允许」，点了就把**整个** `project_manage` 记进永久名单，
 * 普通对话里的开插件从此再也不问。
 *
 * - **schema 收窄**：模型看不见别的动作；看见了硬调，pi 的参数校验先退回。
 * - **riskFor 封顶 mutating**：声明风险仍是 destructive，于是实际风险永远低于声明，
 *   审批门不会给「以后都允许」（只在两者相等时给），工具名不会进永久名单。
 *   名单外的动作算 safe：反正下面 execute 会拒，不该为一次注定被拒的调用弹框。
 * - **execute 拦截保留**：schema 只是建议，绕过校验漏进来的照样挡掉。
 */
function producerProjectManage(tool: UnrealAgentTool<never>): UnrealAgentTool<never> {
  const allowed = (args: unknown): boolean => {
    const action = (args as { action?: unknown } | undefined)?.action
    return typeof action === 'string' && PRODUCER_PROJECT_ACTION_SET.has(action)
  }
  return {
    ...tool,
    description: PRODUCER_PROJECT_DESCRIPTION,
    parameters: producerProjectSchema(tool.parameters) as UnrealAgentTool<never>['parameters'],
    unrealBox: {
      ...tool.unrealBox,
      // 建工程、开工程只往外加东西（见 splitByRisk 的 ADDITIVE_ACTIONS），按 mutating 问
      riskFor: (args): ToolRisk => (allowed(args) ? 'mutating' : 'safe')
    },
    execute: (async (...args: Parameters<UnrealAgentTool<never>['execute']>) => {
      if (!allowed(args[1])) {
        const action = String((args[1] as { action?: unknown } | undefined)?.action)
        const hint =
          action === 'list_projects' || action === 'list_templates'
            ? '列模板、列工程用 project_list'
            : '这是改游戏内容的活，写进任务派给队员去做'
        throw new Error(
          `制作人的 project_manage 只能 create_project、open_project，不支持 action="${action}"；${hint}`
        )
      }
      return tool.execute(...args)
    }) as UnrealAgentTool<never>['execute']
  }
}

export function producerTools(pool: UnrealAgentTool<never>[]): UnrealAgentTool<never>[] {
  return pool
    .filter(
      (tool) =>
        PRODUCER_SETUP_TOOLS.has(tool.name) ||
        (tool.name !== 'task' && tool.unrealBox.risk === 'safe')
    )
    .map((tool) => (tool.name === 'project_manage' ? producerProjectManage(tool) : tool))
}
