/**
 * 制作人等团队：后台派出去的活交回来、队员发来的话。
 *
 * 盒子里的制作人在收尾时等（交付闸 `createTeamGate` 的 `awaitTeam`）；混合团队的制作人在
 * Claude Code 里，用 `team_wait` 等（`hybridTeam.ts`）。两边看的是同一份 `TeamLive`。
 */

import type { TeamLive } from './teamLive'
import { PRODUCER, type TeamStore } from './teamStore'
import { formatMail } from './teamTools'

/** 制作人想收尾时，最多等一件后台的活多久。到点就提醒它一声，再接着等 */
export const TEAM_SETTLE_WAIT_MS = 10 * 60_000

/** 「美术 (3 min), 策划 (1 min)」：谁还在干后台的活、干了多久 */
export function describePendingJobs(
  pending: ReadonlyArray<{ member: string; startedAt: number }>,
  now: number = Date.now()
): string {
  return pending
    .map((job) => `${job.member} (${Math.round((now - job.startedAt) / 60_000)} min)`)
    .join(', ')
}

/**
 * 制作人想收尾时，团队这边还有没有事：
 * 后台派出去的活还在跑，就等下一件交回来（结论会插进制作人的下一步）；
 * 等太久就提醒它一声谁还在干、干了多久；信箱里有没看的留言就补给它。
 */
export async function awaitTeamWork(
  team: { live?: TeamLive; store: TeamStore } | undefined,
  signal?: AbortSignal
): Promise<{ continued?: boolean; followUp?: string } | null> {
  if (!team?.live) return null
  const pending = team.live.pendingJobs()
  if (pending.length > 0) {
    const settled = await team.live.nextSettle(TEAM_SETTLE_WAIT_MS, signal)
    if (settled) return { continued: true }
    return {
      followUp: [
        '[team mode · still working] This is not the user speaking.',
        `Teammates are still on background work: ${describePendingJobs(pending)}.`,
        'Their results will come to you as notes. Wait by ending your turn again, or check in with team_message.'
      ].join('\n')
    }
  }
  const inbox = await team.store.takeInbox(PRODUCER)
  if (inbox.length > 0) {
    return {
      followUp: formatMail('[team mode · notes for you] This is not the user speaking.', inbox)
    }
  }
  return null
}
