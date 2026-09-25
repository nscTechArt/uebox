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
 * 一条留言。队员之间、队员给制作人都走这里。
 *
 * 是信箱而不是当场对话：两个队员同时问对方，当场对话会互相等死；
 * 留言在收件人**下一次接活**时送到（制作人则是任何一件活交回时）。
 */
export interface TeamMail {
  id: string
  from: string
  to: string
  text: string
  at: number
  /** 送到的时刻。没送到就没有 */
  deliveredAt?: number
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
