/**
 * 外部团队在盒子界面上的那一半：列出来、读任务板、结束。
 *
 * 外部团队的大脑在 Claude Code 里，盒子只当工作室（docs/外部大脑跑团队设计-2026-10-17.md）。
 * 它们和盒子里的团队落盘格式一样，区别是没有盒子侧的对话：目标、验收结论存在
 * `<团队>.team/external.json`，不在会话的执行记录里。所以这里单独读，`agentV3.ts` 里
 * 只在 id 以 `ext-` 开头时转到这里来，盒子里的团队一条路都不经过这个文件。
 */

import type { ExternalTeamSummary, TeamStateView } from '../../shared/agentTeam'
import { verdictIsStale } from '../agent-v3/core/team/boardRecap'
import {
  gateFacts,
  isExternalTeamId,
  sharedExternalTeamRegistry,
  type ExternalTeamRegistry
} from '../agent-v3/core/team/externalTeam'
import { runningHybridTeam, stopHybridTeam } from '../agent-v3/core/team/hybridTeam'
import { teamDirsFor } from '../agent-v3/core/team/teamSession'
import { createTeamStore, type TeamStore } from '../agent-v3/core/team/teamStore'

export { isExternalTeamId }

/** 面板上最多显示多少条留言、活、事件。和盒子里的团队同一套数（见 `agentV3.ts`） */
const PANEL_MAIL = 30
const PANEL_JOBS = 60
const PANEL_EVENTS = 20
const ACTIVITY_LOOKBACK = 50

export interface ExternalTeamPanelDeps {
  registry: ExternalTeamRegistry
  storeFor: (id: string) => TeamStore
  now?: () => number
}

function defaultDeps(): ExternalTeamPanelDeps {
  return {
    registry: sharedExternalTeamRegistry(),
    storeFor: (id) => createTeamStore(teamDirsFor(id))
  }
}

export async function listExternalTeams(
  deps: ExternalTeamPanelDeps = defaultDeps()
): Promise<ExternalTeamSummary[]> {
  const records = await deps.registry.list()
  return Promise.all(
    records.map(async (record) => {
      const facts = gateFacts(record)
      const members = await deps
        .storeFor(record.id)
        .roster()
        .catch(() => [])
      return {
        id: record.id,
        objective: record.objective,
        ...(record.projectPath ? { projectPath: record.projectPath } : {}),
        createdAt: record.createdAt,
        ended: facts.ended,
        verdict: facts.verdict,
        passed: facts.passed,
        members: members.length
      }
    })
  )
}

/** 任务板面板要的那一份。没有这个团队给 null，和盒子里「这条对话不是团队」一样 */
export async function readExternalTeamState(
  id: string,
  deps: ExternalTeamPanelDeps = defaultDeps()
): Promise<TeamStateView | null> {
  const record = await deps.registry.get(id)
  if (!record) return null
  const store = deps.storeFor(id)
  const hosted = record.members === 'box'
  const [members, board, mail, activity, jobs, events, usage] = await Promise.all([
    store.roster(),
    store.board(),
    store.mail(),
    store.activity(ACTIVITY_LOOKBACK),
    store.jobs(PANEL_JOBS),
    store.events(PANEL_EVENTS),
    hosted ? store.usage() : undefined
  ])
  const { state } = record
  // 混合团队的队员在盒子里跑：用量、谁在跑和盒子里的团队一样看得到
  const live = hosted ? runningHybridTeam(id)?.live.view() : undefined
  return {
    objective: record.objective,
    verdict: state.verdict,
    ...(state.verdictAt !== undefined ? { verdictAt: state.verdictAt } : {}),
    verdictStale: verdictIsStale(state.verdictAt, state.lastWriteAt, activity),
    deliveries: state.deliveries,
    members,
    board,
    mail: mail.slice(-PANEL_MAIL),
    jobs,
    events,
    // 外部团队的用量不给：队员的模型在 Claude Code 那头，盒子一个 token 都看不到
    ...(usage && (usage.total.total > 0 || usage.total.cost > 0) ? { usage } : {}),
    ...(live ? { live } : {}),
    external: true,
    ...(hosted ? { hostedMembers: true } : {}),
    ended: record.endedAt !== undefined
  }
}

/** 用户在面板上结束团队：只是标记。Claude Code 那头还在跑的话要用户自己去停 */
export async function endExternalTeam(
  id: string,
  deps: ExternalTeamPanelDeps = defaultDeps()
): Promise<boolean> {
  const now = deps.now ?? Date.now
  if (!(await deps.registry.get(id))) return false
  await deps.registry.update(id, (record) =>
    record.endedAt !== undefined ? null : { ...record, endedAt: now() }
  )
  // 混合团队的队员在盒子里跑：结束就停掉后台的活
  await stopHybridTeam(id)
  return true
}

/** 这是混合团队吗（队员由盒子托管）。任务板上换模型认它：外部团队的队员模型盒子换不了 */
export async function isHybridTeam(
  id: string,
  deps: ExternalTeamPanelDeps = defaultDeps()
): Promise<boolean> {
  return isExternalTeamId(id) && (await deps.registry.get(id))?.members === 'box'
}

/** 这个外部团队存在吗。任务板上「重开」那两个入口用它代替「这条对话是不是团队」 */
export async function externalTeamExists(
  id: string,
  deps: ExternalTeamPanelDeps = defaultDeps()
): Promise<boolean> {
  return (await deps.registry.get(id)) !== undefined
}
