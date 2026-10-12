/**
 * 入职体检的结果缓存。
 *
 * 体检在**要用到这个模型时**才做：制作人招人挑中它、用户在任务板上换成它。
 * 不在配模型时把整张清单都测一遍 —— 一个来源动辄几十个模型，大多数永远不会被派去当队员。
 *
 * 结果存在 `<userData>/team-models/model-checkups.json`，跨团队、跨会话共用。
 * 测过的地址变了（用户换了网关）就作废重测。没过的只记一会儿：用户多半会去修，
 * 修完再挑它时应该重测，而不是拿着旧结论一直拒。
 */

import { promises as fs } from 'fs'
import { dirname } from 'path'

import { sameTeamModel, type ModelCheckup, type TeamModel } from '../../../../shared/agentTeam'

/** 过了的结论管多久。模型、网关很少在一个月里悄悄变坏，变坏了派活时也会报出来 */
export const CHECKUP_PASS_TTL_MS = 30 * 24 * 60 * 60_000
/** 没过的结论管多久。够挡住同一轮里反复挑同一个坏模型，又不至于用户修好了还被拒 */
export const CHECKUP_FAIL_TTL_MS = 10 * 60_000

interface StoredCheckup extends ModelCheckup, TeamModel {
  /** 测的时候这个来源的地址。地址变了结论就不算数 */
  baseUrl: string
}

export interface ModelCheckupTarget {
  model: TeamModel
  /** 现在这个来源的地址 */
  baseUrl: string
  /** 真去测一次 */
  run: () => Promise<ModelCheckup>
  /** 不管结论新不新都重测：用户在设置「团队」页点了「重新检测」 */
  force?: boolean
}

export interface ModelCheckups {
  /** 已知的结论（不管新旧），给制作人看的简历用。没测过给 undefined */
  known: (model: TeamModel) => ModelCheckup | undefined
  /** 测过的全部结论（不管新旧），设置「团队」页列档案用 */
  all: () => (TeamModel & ModelCheckup)[]
  /** 要用它了：有新鲜结论就用，没有就测一次 */
  ensure: (target: ModelCheckupTarget) => Promise<ModelCheckup>
}

/** 没过：请求不通，或者不会调工具。看不了图不算没过 —— 不是每个岗位都要看图 */
export function checkupPassed(checkup: ModelCheckup): boolean {
  return checkup.reachable && checkup.tools === 'ok'
}

export async function loadModelCheckups(
  file: string,
  now: () => number = Date.now
): Promise<ModelCheckups> {
  let list: StoredCheckup[] = []
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (Array.isArray(parsed)) list = parsed as StoredCheckup[]
  } catch {
    // 没有文件、文件坏了：当作谁都没测过
  }
  const inflight = new Map<string, Promise<ModelCheckup>>()
  const find = (model: TeamModel): StoredCheckup | undefined =>
    list.find((item) => sameTeamModel(item, model))

  const fresh = (stored: StoredCheckup, baseUrl: string): boolean =>
    stored.baseUrl === baseUrl &&
    now() - stored.at < (checkupPassed(stored) ? CHECKUP_PASS_TTL_MS : CHECKUP_FAIL_TTL_MS)

  const save = async (): Promise<void> => {
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(list), 'utf8')
    await fs.rename(tmp, file)
  }

  return {
    known: (model) => find(model),
    all: () => list,
    ensure: ({ model, baseUrl, run, force }) => {
      const stored = find(model)
      if (!force && stored && fresh(stored, baseUrl)) return Promise.resolve(stored)
      // 同一个模型同时被要两次（并行招人）只测一次
      const key = JSON.stringify([model.providerId, model.modelId])
      const pending = inflight.get(key)
      if (pending) return pending
      const job = run()
        .then(async (checkup) => {
          list = [
            ...list.filter((item) => !sameTeamModel(item, model)),
            { ...checkup, providerId: model.providerId, modelId: model.modelId, baseUrl }
          ]
          await save().catch((error: unknown) =>
            console.warn('[team] 体检结果没存下来，下次会重测:', error)
          )
          return checkup
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, job)
      return job
    }
  }
}
