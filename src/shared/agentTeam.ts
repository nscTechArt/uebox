/**
 * 工作室模式（`/team`）主进程和界面共用的形状。
 *
 * 主进程的账本在 `main/agent-v3/core/team/teamStore.ts`，这里只放两边都要认的类型，
 * 免得界面那头自己抄一份、字段一改就对不上。
 */

export type MemberTier = 'strong' | 'fast'

export interface TeamMember {
  name: string
  /** 人设和职责，由制作人现场写。盒子不给模板 */
  persona: string
  tier: MemberTier
  /** 工具命名空间白名单。省略 = 和制作人同一套 */
  namespaces?: string[]
  readOnly: boolean
  hiredAt: number
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
  deliveries: number
  members: TeamMember[]
  board: BoardTask[]
  /** 最近的留言，旧的在前 */
  mail: TeamMail[]
}
