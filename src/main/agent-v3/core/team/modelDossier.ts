/**
 * 设置「团队」页的模型档案：入职体检结论（`modelCheckups.ts`）加履历（`trackRecord.ts`）。
 *
 * 和给制作人看的简历读的是同一份账，这里只换一种给人看的汇总：按模型一行、按岗位展开。
 * 不打综合分（理由见 `trackRecord.ts` 顶部）。
 */

import { join } from 'path'

import {
  sameTeamModel,
  teamModelCandidates,
  type ModelCheckup,
  type ModelDossier,
  type ModelDossierRole,
  type ModelDossierTally,
  type TeamModel,
  type TeamModelCandidate,
  type TrackRecordEntry
} from '../../../../shared/agentTeam'
import { loadModelCheckups } from './modelCheckups'
import { createTrackRecord } from './trackRecord'

function tally(entries: readonly TrackRecordEntry[]): ModelDossierTally {
  return {
    tasks: entries.filter((e) => e.kind === 'task').length,
    reopened: entries.filter((e) => e.kind === 'reopened').length,
    unfinished: entries.filter((e) => e.kind === 'task' && e.outcome === 'unfinished').length
  }
}

function role(
  roleType: string | undefined,
  entries: readonly TrackRecordEntry[]
): ModelDossierRole {
  const timed = entries.filter((e) => e.kind === 'task' && e.outcome === 'done' && e.ms != null)
  const total = timed.reduce((sum, e) => sum + (e.ms ?? 0), 0)
  return {
    ...(roleType ? { roleType } : {}),
    ...tally(entries),
    ...(timed.length ? { avgMs: Math.round(total / timed.length) } : {})
  }
}

/**
 * 只列检测过或干过活的模型：配了几十个、从没派过活的不占地方。
 * 名单里已经没有的（来源删了、模型下架了）照列，标成 `removed`，名字退回模型 id。
 */
export function buildModelDossiers(
  candidates: readonly TeamModelCandidate[],
  checkups: readonly (TeamModel & ModelCheckup)[],
  entries: readonly TrackRecordEntry[]
): ModelDossier[] {
  const models: TeamModel[] = []
  for (const model of [...checkups, ...entries.map((e) => e.model)]) {
    if (!models.some((m) => sameTeamModel(m, model))) {
      models.push({ providerId: model.providerId, modelId: model.modelId })
    }
  }

  return models
    .map((model): ModelDossier => {
      const candidate = candidates.find((c) => sameTeamModel(c, model))
      const mine = entries.filter((e) => sameTeamModel(e.model, model))
      const byRole = new Map<string, TrackRecordEntry[]>()
      for (const entry of mine) {
        const key = entry.roleType?.trim() ?? ''
        byRole.set(key, [...(byRole.get(key) ?? []), entry])
      }
      const used = mine.filter((e) => e.kind === 'task').map((e) => e.at)
      const stored = checkups.find((c) => sameTeamModel(c, model))
      const checkup: ModelCheckup | undefined = stored && {
        at: stored.at,
        reachable: stored.reachable,
        tools: stored.tools,
        ...(stored.vision ? { vision: stored.vision } : {}),
        ...(stored.failure ? { failure: stored.failure } : {})
      }
      return {
        ...model,
        name: candidate?.name ?? model.modelId,
        ...(candidate ? { providerName: candidate.providerName } : {}),
        removed: !candidate,
        ...(checkup ? { checkup } : {}),
        ...(used.length ? { lastUsedAt: Math.max(...used) } : {}),
        ...tally(mine),
        roles: [...byRole.entries()]
          .map(([key, list]) => role(key || undefined, list))
          .sort((a, b) => b.tasks - a.tasks)
      }
    })
    .sort(
      (a, b) =>
        Number(a.removed) - Number(b.removed) ||
        b.tasks - a.tasks ||
        (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
    )
}

/**
 * 懒加载 `ai/*` 和 `teamSession`：它们顶上静态引了 electron，`buildModelDossiers` 的单测不该为此加载它。
 */
export async function loadModelDossiers(): Promise<ModelDossier[]> {
  const [{ readSettings }, session] = await Promise.all([
    import('../../../ai/store'),
    import('./teamSession')
  ])
  const [settings, checkups, entries] = await Promise.all([
    readSettings(),
    loadModelCheckups(join(session.teamModelsDir(), 'model-checkups.json')),
    createTrackRecord(session.trackRecordFile()).all()
  ])
  return buildModelDossiers(teamModelCandidates(settings.providers), checkups.all(), entries)
}

/** 「重新检测」：不管上次的结论新不新都测一次，结果照常落进体检缓存，制作人下次招人也看得到 */
export async function recheckModel(
  model: TeamModel
): Promise<{ success: true; checkup: ModelCheckup } | { success: false; error: string }> {
  const [{ readSettings }, { checkupChatModel }, session] = await Promise.all([
    import('../../../ai/store'),
    import('../../../ai/probe'),
    import('./teamSession')
  ])
  const settings = await readSettings()
  if (!teamModelCandidates(settings.providers).some((c) => sameTeamModel(c, model))) {
    return { success: false, error: '模型设置里没有这个模型' }
  }
  const provider = settings.providers.find((p) => p.id === model.providerId)
  if (!provider) return { success: false, error: '模型设置里没有这个来源' }
  const checkups = await loadModelCheckups(join(session.teamModelsDir(), 'model-checkups.json'))
  const checkup = await checkups.ensure({
    model,
    baseUrl: provider.baseUrl,
    force: true,
    run: () => checkupChatModel(provider, model.modelId)
  })
  return { success: true, checkup }
}
