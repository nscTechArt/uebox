/**
 * 工作室模式（`/team`）主进程和界面共用的形状。
 *
 * 主进程的账本在 `main/agent-v3/core/team/teamStore.ts`，这里只放两边都要认的类型，
 * 免得界面那头自己抄一份、字段一改就对不上。
 */

import {
  ROLE_KIND,
  modelAllowsRole,
  type ModelConfig,
  type ProbeFailure,
  type ProviderKind
} from './aiProvider'
import { mergeTurnUsage, toTurnUsage, type AgentTurnUsage, type PiUsageLike } from './agentUsage'

/**
 * 老名册的模型档位。`strong` 跟着制作人，`fast` 走用户绑的对话模型。
 * 现在招人直接钉具体模型（`TeamMember.model`），这两档只为读得懂老名册留着。
 */
export type MemberTier = 'strong' | 'fast'

/** 一个具体模型：哪个来源下的哪个模型。和对话钉的模型同一个形状 */
export interface TeamModel {
  providerId: string
  modelId: string
}

export interface TeamMember {
  name: string
  /** 人设和职责，由制作人现场写。盒子不给模板 */
  persona: string
  tier: MemberTier
  /**
   * 它用哪个模型。招人时由制作人挑，用户可以在任务板上改。
   * 老名册没有这一项，按 `tier` 走。派活那一刻它用不了（来源删了、模型下架了），
   * 这一件活改用制作人的模型，名册不动 —— 用户把来源补回来就又能用
   */
  model?: TeamModel
  /** 制作人为什么给它这个模型，一句话。用户在任务板上悬停看得到 */
  modelReason?: string
  /** 模型是谁定的。用户亲手改过的，制作人除非用户开口不该再动 */
  modelBy?: 'producer' | 'user'
  /**
   * 岗位的粗类型（策划、搭建、审核……），制作人招人时标。履历按它分开看：
   * 难的活干砸了不等于这个模型差，同一类活放在一起比才有意义
   */
  roleType?: string
  /** 工具命名空间白名单。省略 = 和制作人同一套 */
  namespaces?: string[]
  readOnly: boolean
  hiredAt: number
}

/**
 * 辞退的依据。制作人辞人必须挑一条；用户在任务板上辞的记 `user`，由用户自己写理由。
 *
 * - `quality` 交的活不达标（被打回、验收没过），`unfinished` 活老是干不完 ——
 *   这两条是说这个人干得不行，必须引用它自己名下的活或任务当证据，不许空口说
 * - `redundant` 岗位不需要了、和别人重了；`user_request` 用户在对话里要求的 ——
 *   不评价这个人，不要求绩效证据，理由里写清楚
 */
export const DISMISSAL_GROUNDS = [
  'quality',
  'unfinished',
  'redundant',
  'user_request',
  'user'
] as const
export type DismissalGrounds = (typeof DISMISSAL_GROUNDS)[number]

/** 辞退被退回的原因。界面按它选双语文案 */
export type DismissalErrorCode =
  | 'not-found'
  | 'reserved'
  | 'busy'
  | 'no-reason'
  | 'no-evidence'
  | 'bad-evidence'
  | 'bad-handover'

/** 说「这个人干得不行」的依据：要有证据 */
export const PERFORMANCE_GROUNDS: ReadonlySet<DismissalGrounds> = new Set(['quality', 'unfinished'])

/** 辞退档案里引用的一条证据：活（`j…`）或任务板上的一项，带上当时的原文 */
export interface DismissalEvidence {
  kind: 'job' | 'task'
  id: string
  /** 活的派活第一句 + 结局，或任务的标题 + 状态。当场抄下来：活的账会被截掉，档案不会 */
  text: string
}

/** 辞退那一刻盒子从账上数出来的事实，不是谁说的 */
export interface DismissalFacts {
  /** 交回来的活 */
  jobsDone: number
  /** 停下、没干完的活 */
  jobsStopped: number
  /** 名下任务按状态数 */
  tasks: Record<TaskStatus, number>
}

/** 从活的账和任务板上数出一个人的事实。辞退对话框和档案用同一份，用户看到的就是存下的 */
export function countDismissalFacts(
  name: string,
  jobs: readonly TeamJob[],
  board: readonly BoardTask[]
): DismissalFacts {
  const key = name.trim().toLowerCase()
  const mine = jobs.filter((j) => j.member.trim().toLowerCase() === key)
  const tasks = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>
  for (const task of board) {
    if (task.owner && task.owner.trim().toLowerCase() === key) tasks[task.status] += 1
  }
  return {
    jobsDone: mine.filter((j) => j.outcome === 'done').length,
    jobsStopped: mine.filter((j) => j.outcome === 'stopped').length,
    tasks
  }
}

/**
 * 一份辞退档案。存在 `dismissals.json`，不截断：这是人事档案，不是近况。
 * 界面、制作人看到的辞退记录都读它
 */
export interface TeamDismissal {
  name: string
  at: number
  by: 'producer' | 'user'
  grounds: DismissalGrounds
  reason: string
  evidence: DismissalEvidence[]
  facts: DismissalFacts
  /** 辞退那一刻的完整设定（人设、模型、工具范围、招入时间） */
  member: TeamMember
  /** 没做完的任务交给了谁。`to` 没有 = 清掉了负责人，等制作人重新分配 */
  handover: { tasks: string[]; to?: string }
  /** 它的记忆归档到了哪个文件（`members/dismissed/` 下）。从没派过活的没有 */
  memoryArchive?: string
  /** 用户辞的：制作人在哪一轮开局看到了。没有 = 还没告诉它 */
  producerNotifiedAt?: number
}

export function sameTeamModel(a: TeamModel | undefined, b: TeamModel | undefined): boolean {
  return !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId
}

/** 招人时能挑的一个模型，以及它的简历：只写事实，不写评价 */
export interface TeamModelCandidate extends TeamModel {
  /** 给制作人填的 id：`来源/模型`。招人工具的参数就收这个 */
  key: string
  name: string
  providerName: string
  vision: boolean
  contextWindow?: number
  /** 官方标价，美元 / 百万 token。只有直连官方端点、模型目录里查得到时才有 */
  price?: { input: number; output: number }
}

/**
 * 入职体检的结果：这个模型在用户这里能不能正常干活。只查能不能用，不评能力。
 * 设计见 docs/团队选模型与履历设计-2026-10-08.md 5.2 节。
 */
export interface ModelCheckup {
  at: number
  /** 请求有没有通（Key、地址、额度）。不通时下面两项都不算数 */
  reachable: boolean
  /** 让它调一个工具，它调没调 */
  tools: 'ok' | 'fail'
  /** 只在它声称能看图时查：给一张纯色图，它说不说得出颜色 */
  vision?: 'ok' | 'fail'
  /** 请求失败时的原因，渲染层用 `describeProbeFailure` 翻成人话 */
  failure?: ProbeFailure
}

/**
 * 履历的一笔。只记机器能确定的事实（设计稿 5.5 节）：
 * - `task`：一件活交回来了，或者没干完（被停下、出错）
 * - `reopened`：用户在任务板上把这个模型干的一件活打回了
 */
export interface TrackRecordEntry {
  kind: 'task' | 'reopened'
  at: number
  model: TeamModel
  roleType?: string
  /** 哪个工程。按工程记、跨工程汇总（设计稿 9.2 节） */
  project?: string
  /** 只有 `task` 有 */
  outcome?: 'done' | 'unfinished'
  /** 只有 `task` 有：这件活干了多久 */
  ms?: number
}

export interface ModelDossierTally {
  tasks: number
  /** 被用户在任务板上重开的 */
  reopened: number
  unfinished: number
}

/** 档案里按岗位分开的一行。`roleType` 没标的归一类，界面上写「未分类」 */
export interface ModelDossierRole extends ModelDossierTally {
  roleType?: string
  /** 交回来的活平均干了多久。没有带耗时的记录时没有 */
  avgMs?: number
}

/**
 * 设置「团队」页上一个模型的档案：入职体检结论加履历汇总。
 * 和给制作人看的简历是同一份账，只汇总事实，不打分。
 */
export interface ModelDossier extends TeamModel, ModelDossierTally {
  name: string
  providerName?: string
  /** 来源或模型已不在模型设置里：记录保留，不再参与组队 */
  removed: boolean
  checkup?: ModelCheckup
  lastUsedAt?: number
  /** 按任务数从多到少 */
  roles: ModelDossierRole[]
}

/** 给人看的模型名：名单里有就用展示名，没有（来源删了）就用模型 id。制作人的回话和任务板共用 */
export function teamModelLabel(
  candidates: readonly TeamModelCandidate[],
  model: TeamModel
): string {
  return candidates.find((c) => sameTeamModel(c, model))?.name ?? model.modelId
}

/**
 * 队员能用的模型：对话类来源下的模型，去掉明确标了不能调工具的。
 *
 * 和输入框模型下拉框同一个来源、同一个顺序（设置页里的顺序），用户在两处看到的是同一份名单。
 * 不能调工具的去掉，是因为队员干的每件活都靠工具；能力位没填的照留 —— 用户手填的模型
 * 多半没填这一位，按「不知道」处理，不按「不能」处理。
 */
export function teamModelCandidates(
  providers: readonly {
    id: string
    displayName?: string
    kind: ProviderKind
    models: readonly Pick<
      ModelConfig,
      'id' | 'displayName' | 'supportsTools' | 'supportsVision' | 'contextWindow' | 'allowedRoles'
    >[]
  }[]
): TeamModelCandidate[] {
  const list: TeamModelCandidate[] = []
  for (const provider of providers) {
    if (provider.kind !== ROLE_KIND.agent) continue
    const providerName = provider.displayName?.trim() || provider.id
    for (const model of provider.models) {
      if (model.supportsTools === false || !modelAllowsRole(model, 'agent')) continue
      if (list.some((c) => c.providerId === provider.id && c.modelId === model.id)) continue
      // 模型 id 常带斜杠（`anthropic/claude-…`），拼出来可能和别的来源撞上；撞了加序号，不丢模型
      const base = `${provider.id}/${model.id}`
      const key = list.some((c) => c.key === base) ? `${base}#${list.length + 1}` : base
      list.push({
        key,
        providerId: provider.id,
        modelId: model.id,
        name: model.displayName?.trim() || model.id,
        providerName,
        vision: model.supportsVision === true,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
      })
    }
  }
  return list
}

export const TASK_STATUSES = ['todo', 'doing', 'done', 'blocked'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export interface BoardTask {
  id: string
  title: string
  owner?: string
  status: TaskStatus
  deps?: string[]
  /** 做完的证据：截图路径、试玩结论、资产路径…… 没有证据的「做完」看不出真假 */
  evidence?: string
  note?: string
  updatedAt: number
  /**
   * 用户在界面上点了「重开」的时刻。制作人下一轮开局会看到它；
   * 模型再改这一项（任何字段）就清掉 —— 那说明它已经接手了
   */
  reopenedAt?: number
}

/** 留言的收件人是制作人时用的名字。队员叫这个名字会被招人工具拒掉 */
export const PRODUCER = 'producer'

/**
 * 一条留言。制作人和队员之间、队员之间都走这里。
 *
 * 收件人正在干活就插进它的下一步（当场送到），没在干活就进信箱、下次接活时交给它。
 * 「送到」和「读到」分开记，读到就是回执。见 `main/agent-v3/core/team/teamLive.ts`。
 */
export interface TeamMail {
  id: string
  from: string
  to: string
  text: string
  at: number
  /** 回的是哪一条留言 */
  replyTo?: string
  /** 送到的时刻：塞进了对方正在跑的上下文，或者下一次接活时交给了它。没送到就没有 */
  deliveredAt?: number
  /** 对方真的读到的时刻（这条进了它的上下文）。回执就看它 */
  readAt?: number
}

/**
 * 一件派出去的活：从开工到交回（或停下）。盒子自己记的账，不靠制作人写任务板 ——
 * 「谁交回了什么」在界面上就是这本账（见 docs/团队任务板可读性-2026-10-14.md）。
 *
 * 两种派活（等它干完、派到后台）都记；排队等前一件的，轮到它开工才算开始。
 */
export interface TeamJob {
  id: string
  member: string
  /** 派活那段话的第一行（截短）。交回的报告没有标题时拿它当名字 */
  brief: string
  startedAt: number
  /** 没有 = 还在干（或者上次运行被打断，见 `outcome`） */
  endedAt?: number
  outcome?: 'done' | 'stopped'
  /** 交回的结论原文（不含盒子附的写操作记账、快照） */
  report?: string
  /** 停下的原因 */
  reason?: string
  /**
   * 用户在成果架上把这件停下的活「重开」了的时刻：任务板上加了一项交回制作人，
   * 这件就不再算「停着没人管」
   */
  reopenedAt?: number
  /** 这件活花掉的 token（交回、停下都记）。老数据、一个请求都没发出去的没有 */
  usage?: TeamUsage
}

/** 验收员在用量账上的名字。和 `PRODUCER` 一样不许队员用 */
export const ACCEPTOR = 'acceptor'

/**
 * 一个人（或整个团队）花掉的 token。口径同回复下面的「本轮消耗」（`AgentTurnUsage`），
 * 多记一项 `unpriced`：第三方网关、套餐常常没有价目表，那部分算出来的金额是 0。
 * 只有 token 数是可靠的；金额只含有价目的部分，界面据此说明。
 */
export interface TeamUsage extends AgentTurnUsage {
  /** 其中没有价目的 token */
  unpriced: number
}

/**
 * 团队的用量总账。单独一份，不靠逐件活加：活的账只留最近 200 件，会被截掉。
 * 键是队员名；制作人是 `PRODUCER`，验收员是 `ACCEPTOR`。
 */
export interface TeamUsageLedger {
  total: TeamUsage
  byWho: Record<string, TeamUsage>
}

export const EMPTY_TEAM_USAGE: TeamUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
  unpriced: 0
})

/** 一次模型请求报的用量 → 团队账的一笔。没给价（cost 为 0）的整笔算进 `unpriced` */
export function teamUsageOf(usage: PiUsageLike | undefined | null): TeamUsage {
  const turn = toTurnUsage(usage)
  return { ...turn, unpriced: turn.cost > 0 ? 0 : turn.total }
}

export function addTeamUsage(a: TeamUsage, b: TeamUsage): TeamUsage {
  return { ...mergeTurnUsage(a, b), unpriced: (a.unpriced ?? 0) + (b.unpriced ?? 0) }
}

/**
 * 团队这一局里发生的、不属于任何一个人的事。现在只有编辑器的崩溃和恢复：
 * 它影响所有正在干活的人，界面上画成一条贯穿所有人的线，而不是几条一样的留言
 */
export interface TeamEvent {
  /** `verdict` = 跑过一次验收。执行记录里只留最近一次结论，每次的结论记在这里 */
  kind: 'crashed' | 'recovered' | 'recoverFailed' | 'verdict'
  at: number
  /** 崩溃的报错摘要、恢复失败的原因。给人看的，可能没有 */
  detail?: string
  /** 只有 `verdict` 有。读不出结论记 fail，同交付闸 */
  verdict?: TeamVerdict
}

export type TeamVerdict = 'pass' | 'fail' | 'blocked'

/** 界面上任务板面板要的一整份 */
export interface TeamStateView {
  objective: string
  /** 开团之后用户最近说的那句话。`/team` 那一轮、外部团队没有 */
  latestRequest?: string
  /** 最近一次验收的结论。null = 还没交过 */
  verdict: TeamVerdict | null
  /** 那次验收是什么时候。老数据没有 */
  verdictAt?: number
  /** 验收之后工程又改过：结论已经不代表现在的游戏了 */
  verdictStale: boolean
  deliveries: number
  /**
   * 这一轮（最近一条真人消息）是什么时候开始的。在它之前就没再动过的
   * 「进行中 / 卡住」是上一轮留下的说法，界面会把它们标成旧的
   */
  roundStartedAt?: number
  members: TeamMember[]
  /** 辞退档案，旧的在前。没辞过人的没有 */
  dismissals?: TeamDismissal[]
  board: BoardTask[]
  /** 最近的留言，旧的在前 */
  mail: TeamMail[]
  /** 最近派出去的活，旧的在前。老数据没有 */
  jobs?: TeamJob[]
  /** 最近的团队事件（编辑器崩溃、恢复），旧的在前。老数据没有 */
  events?: TeamEvent[]
  /** 团队花掉的 token 总账（制作人、队员、验收员）。老数据没有 */
  usage?: TeamUsageLedger
  /** 此刻谁在跑、谁在等。只有这条对话这次运行里跑过团队才有（内存里的事，不落盘） */
  live?: TeamLiveView
  /**
   * 外部团队：大脑在外部客户端（Claude Code），盒子只当工作室。队员用什么模型盒子不知道
   * （docs/外部大脑跑团队设计-2026-10-17.md）
   */
  external?: boolean
  /** 混合团队：制作人在外部客户端，队员在盒子里跑（模型、用量、谁在跑盒子都看得到） */
  hostedMembers?: boolean
  /** 外部团队已经结束（用户在面板上点了结束） */
  ended?: boolean
}

/** 「外部团队」页上列表里的一项 */
export interface ExternalTeamSummary {
  id: string
  objective: string
  projectPath?: string
  createdAt: number
  ended: boolean
  verdict: TeamVerdict | null
  /** 过了验收，并且之后没再改过工程 */
  passed: boolean
  members: number
}

/**
 * 团队此刻的动静，给任务板上的办公室看。名字一律是小写（同 `teamLive` 的键），
 * 和名册比对时把名册的名字也转小写；制作人是 `PRODUCER`。
 */
export interface TeamLiveView {
  /** 正在跑的（制作人也算） */
  running: string[]
  /** 发了话、正在等对方回的 */
  waiting: string[]
  /** 制作人正卡在「等这个队员交活」上 */
  awaited: string[]
  /** 手上的活：派活那段话的第一行 */
  assignments: { member: string; text: string; since: number }[]
  /** 每人最近几条动态（调了什么工具、说了什么），旧的在前 */
  recent: TeamActivity[]
}

/**
 * 队员的一条动态。后台派出去的活，进度推不到那次已经结束的工具调用上，
 * 只能走这条单独的推送（`agent-v3:team-activity`）
 */
export interface TeamActivity {
  member: string
  /** `调用 <工具> <目标>`，或者它说的一段话 */
  text: string
  at: number
}
