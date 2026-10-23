/**
 * 任务板头上的团队用量：默认只露一个总数，点开按人看。
 *
 * 顺序：制作人、名册里的人（按名册顺序）、名册里已经没有的人、验收员。
 * 名字不分大小写，同主进程的总账（`teamStore.ts`）。
 */

import {
  ACCEPTOR,
  PRODUCER,
  type TeamMember,
  type TeamUsage,
  type TeamUsageLedger
} from '@core/shared/agentTeam'

export interface TeamUsageRow {
  /** 总账里的名字：队员名，或 `PRODUCER` / `ACCEPTOR` */
  who: string
  usage: TeamUsage
}

const key = (name: string): string => name.trim().toLowerCase()

export function teamUsageRows(
  ledger: TeamUsageLedger | undefined,
  members: readonly Pick<TeamMember, 'name'>[]
): TeamUsageRow[] {
  if (!ledger) return []
  const entries = Object.entries(ledger.byWho).filter(([, u]) => u.total > 0 || u.cost > 0)
  const rank = (who: string): number => {
    const k = key(who)
    if (k === PRODUCER) return -1
    if (k === ACCEPTOR) return Number.MAX_SAFE_INTEGER
    const index = members.findIndex((m) => key(m.name) === k)
    return index >= 0 ? index : members.length
  }
  return entries.map(([who, usage]) => ({ who, usage })).sort((a, b) => rank(a.who) - rank(b.who))
}

/** 金额只含有价目的部分：既有金额、又有没价目的 token 时，界面要说明 */
export function usageCostIsPartial(usage: TeamUsage | undefined): boolean {
  return !!usage && usage.cost > 0 && (usage.unpriced ?? 0) > 0
}
