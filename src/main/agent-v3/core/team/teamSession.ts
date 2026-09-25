/**
 * 工作室模式挂到一条会话上要的东西：落盘位置、跨轮状态、交付闸。
 *
 * ## 交付闸
 *
 * 设计稿唯一的一条硬规则（§5）：没过独立验收不算交付。制作人收尾时要是还没过，
 * 这里替它补一句「还没过验收」，最多补两次 —— 真卡住需要用户拍板的时候，
 * 它得有机会停下来把话说完，而不是被无限推着转。
 *
 * 判「收尾」的口径和 `/goal` 一样（见 `goalLoop.ts`）：这一轮没再调工具、
 * 正常结束（`stopReason === 'stop'`）。报错、被停下、超长都不算。
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { app } from 'electron'
import { join } from 'path'

import { safeSessionFileBase, sessionsDir } from '../transcriptStore'
import type { GoalVerdict } from '../goalLoop'
import type { TeamDirs } from './teamStore'

export interface TeamState {
  objective: string
  /** 最近一次验收的结论。null = 还没交过，或者结论读不出来 */
  verdict: GoalVerdict['kind'] | null
  deliveries: number
  /** 这一轮已经被交付闸推了几次。每条真人消息清零 */
  nudges: number
}

export const MAX_TEAM_NUDGES = 2

export function newTeamState(objective: string): TeamState {
  return { objective, verdict: null, deliveries: 0, nudges: 0 }
}

export function teamDirsFor(sessionId: string): TeamDirs {
  const base = safeSessionFileBase(sessionId)
  return {
    stateDir: join(sessionsDir(), `${base}.team`),
    workspaceDir: join(app.getPath('userData'), 'team', base)
  }
}

/** 验收结论落进状态。读不出结论按 fail 算：交付闸不能被一句含糊话放过去 */
export function applyVerdict(state: TeamState, verdict: GoalVerdict | null): TeamState {
  return { ...state, verdict: verdict?.kind ?? 'fail', deliveries: state.deliveries + 1 }
}

/**
 * 交付闸提醒。以 `role: 'user'` 进上下文，所以开头必须说清「这不是用户在说话」，
 * 不然模型会回一句「好的，按你说的继续」。
 */
export function buildTeamNudge(state: TeamState): string {
  const why =
    state.verdict === 'fail'
      ? 'The last acceptance run failed.'
      : 'The game has not been through acceptance yet.'
  return [
    '[team mode · automatic check] This is not the user speaking.',
    `${why} Delivery only counts once \`team_deliver\` returns PASS.`,
    'Keep working toward it. If you genuinely cannot go on without the user, say exactly what you need from them and stop.'
  ].join('\n')
}

export interface TeamGateDeps {
  getState: () => TeamState
  setState: (next: TeamState) => Promise<void>
  followUp: (text: string) => void
  report: (message: string) => void
}

export function createTeamGate(deps: TeamGateDeps): (event: AgentEvent) => Promise<void> {
  return async (event) => {
    if (event.type !== 'turn_end') return
    // 还在调工具 = 没打算收尾
    if (event.toolResults.length > 0) return
    const { stopReason } = event.message as { stopReason?: string }
    if (stopReason !== 'stop') return

    const state = deps.getState()
    // 过了就放行；BLOCKED 是验收员说「这得用户来」，也放行让制作人把话说完
    if (state.verdict === 'pass' || state.verdict === 'blocked') return
    if (state.nudges >= MAX_TEAM_NUDGES) return

    await deps.setState({ ...state, nudges: state.nudges + 1 })
    deps.report(
      state.verdict === 'fail'
        ? '上次验收没过，已提醒制作人接着修。'
        : '还没过独立验收，已提醒制作人继续。'
    )
    deps.followUp(buildTeamNudge(state))
  }
}
