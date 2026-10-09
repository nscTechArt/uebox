/**
 * 工作室模式（`/team`）主进程和界面共用的形状。
 *
 * 主进程的账本在 `main/agent-v3/core/team/teamStore.ts`，这里只放两边都要认的类型，
 * 免得界面那头自己抄一份、字段一改就对不上。
 */

import { ROLE_KIND, type ModelConfig, type ProbeFailure, type ProviderKind } from './aiProvider'

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
      'id' | 'displayName' | 'supportsTools' | 'supportsVision' | 'contextWindow'
    >[]
  }[]
): TeamModelCandidate[] {
  const list: TeamModelCandidate[] = []
  for (const provider of providers) {
    if (provider.kind !== ROLE_KIND.agent) continue
    const providerName = provider.displayName?.trim() || provider.id
    for (const model of provider.models) {
      if (model.supportsTools === false) continue
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

export type TeamVerdict = 'pass' | 'fail' | 'blocked'

/** 界面上任务板面板要的一整份 */
export interface TeamStateView {
  objective: string
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
  board: BoardTask[]
  /** 最近的留言，旧的在前 */
  mail: TeamMail[]
}
