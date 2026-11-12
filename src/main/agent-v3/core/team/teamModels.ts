/**
 * 队员用哪个模型。
 *
 * 谁招人谁配模型：用户不知道制作人会招哪些人，没法事先按人指定，所以由制作人招人时
 * 从用户配好的模型里挑，并写一句理由；用户在任务板上看得到、改得动。
 * 设计见 docs/团队选模型与履历设计-2026-10-08.md。
 *
 * 这里只放和工具无关的那几样：候选名单（简历）怎么写给制作人、入职体检、履历、
 * 派活那一刻实际用哪个模型。
 */

import { join } from 'path'

import {
  sameTeamModel,
  teamModelCandidates,
  teamModelLabel,
  type ModelCheckup,
  type TeamMember,
  type TeamModel,
  type TeamModelCandidate,
  type TrackRecordEntry
} from '../../../../shared/agentTeam'
import type { AiProviderSettings } from '../../../ai/types'
import { getTargetProjectPath } from '../projectTargetContext'
import { checkupPassed, loadModelCheckups } from './modelCheckups'
import type { TeamStore } from './teamStore'
import { createTrackRecord, summarizeTrackRecord } from './trackRecord'

export interface TeamModels {
  /** 招人能挑的模型，按设置页里的顺序 */
  candidates: TeamModelCandidate[]
  /** 制作人这一轮用的模型 */
  producer?: TeamModel
  /** 派活那一刻这个模型还能不能用（来源删了、模型下架了就不能） */
  isAvailable: (model: TeamModel) => Promise<boolean>
  /** 入职体检：要用它了，有新鲜结论就用、没有就测一次（`modelCheckups.ts`）。没有就不体检 */
  checkup?: (model: TeamModel) => Promise<ModelCheckup>
  /** 测过的结论（不管新旧），写进简历 */
  knownCheckup?: (model: TeamModel) => ModelCheckup | undefined
  /** 每个候选的履历一行话，按候选 key。没记录的没有这一项 */
  records?: Record<string, string>
  /** 记一笔履历（`trackRecord.ts`）。工程路径由它自己补 */
  record?: (entry: Omit<TrackRecordEntry, 'at' | 'project'>) => Promise<void>
}

/** 只有一个能用的模型时没得挑：招人工具里不出现这一项，派活回话里也不提模型 */
export function canChooseModels(models: TeamModels | undefined): models is TeamModels {
  return (models?.candidates.length ?? 0) > 1
}

/** 给人看的模型名：名单里有就用展示名，没有（来源删了）就用模型 id */
export function modelLabel(models: TeamModels | undefined, model: TeamModel): string {
  return teamModelLabel(models?.candidates ?? [], model)
}

/** 上下文长度写成 128k 这样，制作人一眼比得出大小 */
function formatContext(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : `${Math.round(tokens / 1000)}k`
}

/**
 * 体检查出来的问题，写给制作人看。只说查到了什么，不猜为什么
 * （「多半是网关吞了工具调用」这种话没有依据就不说）。没问题给空串。
 */
export function describeCheckup(checkup: ModelCheckup): string {
  if (!checkup.reachable) {
    const failure = checkup.failure
    return `请求不通（${failure?.code ?? 'unknown'}${failure?.raw ? `：${failure.raw}` : ''}）`
  }
  if (checkup.tools === 'fail') return '让它调一个工具，两次都没调'
  if (checkup.vision === 'fail') return '说能看图，但认不出测试图的颜色'
  return ''
}

/**
 * 写进招人工具说明里的候选名单，也就是每个模型的简历。只写事实：哪一家、能不能看图、
 * 上下文多长、官方标价、体检查出的问题、在用户项目里的履历。
 * 不写「审核该用另一家」这类规则 —— 怎么搭由制作人判断（见设计稿 5.1 节）。
 */
export function describeCandidates(models: TeamModels): string {
  return models.candidates
    .map((c) => {
      const facts = [
        c.providerName,
        c.vision ? '能看图' : '看不了图',
        ...(c.contextWindow ? [`上下文 ${formatContext(c.contextWindow)}`] : []),
        ...(c.price
          ? [`官方标价 $${c.price.input}/$${c.price.output} 每百万 token（输入/输出）`]
          : [])
      ]
      const mine = sameTeamModel(c, models.producer) ? ' ← 你自己用的' : ''
      const checkup = models.knownCheckup?.(c)
      const problem = checkup ? describeCheckup(checkup) : ''
      const record = models.records?.[c.key]
      return [
        `- ${c.key}：${c.name}（${facts.join('，')}）${mine}`,
        ...(record ? [`    在用户项目里：${record}`] : []),
        ...(problem
          ? [`    ${checkup && checkupPassed(checkup) ? '体检提示' : '体检没过'}：${problem}`]
          : [])
      ].join('\n')
    })
    .join('\n')
}

export interface MemberRoute {
  /** 钉给这个队员的模型。不给 = 沿用老规矩（制作人的模型，或 `fast` 档的对话模型） */
  pin?: TeamModel
  /** 这件活实际用的模型，记账和回话用。说不准（老 `fast` 档）时不给 */
  used?: TeamModel
  /** 它的模型这会儿用不了，这件活改用制作人的；没有制作人的模型（混合团队）就是盒子的默认模型 */
  fellBack: boolean
}

/**
 * 派活那一刻这个队员用哪个模型。
 *
 * 它的模型用不了时不报错、不停活：这一件改用制作人的模型，回话里说一声，名册不动 ——
 * 用户把来源补回来，下一件就又用回去了。
 */
export async function routeMember(
  models: TeamModels | undefined,
  member: TeamMember
): Promise<MemberRoute> {
  if (member.model) {
    if (!models || (await models.isAvailable(member.model))) {
      return { pin: member.model, used: member.model, fellBack: false }
    }
    return { ...(models.producer ? { used: models.producer } : {}), fellBack: true }
  }
  // 老名册：strong 跟着制作人；fast 走对话模型，具体是哪个这里说不准
  if (member.tier === 'fast') return { fellBack: false }
  return { ...(models?.producer ? { used: models.producer } : {}), fellBack: false }
}

/**
 * 按名单里的 id 认出模型。外部 MCP 调用方给 `task` 点名用（`hostSession.ts`）。
 *
 * 和队员不同，点了名就照办或者报错，不悄悄换成别的：调用方是冲着这个模型来的，
 * 换了它也不知道，拿回来的结论就不是它要比的那个。
 */
export async function pickModel(models: TeamModels, key: string): Promise<TeamModel> {
  const picked = models.candidates.find((c) => c.key === key.trim())
  if (!picked) {
    throw new Error(
      `没有「${key}」这个模型。可选：${models.candidates.map((c) => c.key).join('、')}`
    )
  }
  const model: TeamModel = { providerId: picked.providerId, modelId: picked.modelId }
  if (!(await models.isAvailable(model))) {
    throw new Error(
      `${picked.name} 现在用不了（来源删了或模型下架了）。换一个，或省略 model 用默认模型`
    )
  }
  return model
}

interface CatalogLookup {
  baseUrl: string
  models: readonly { id: string; cost?: { input: number; output: number } }[]
}

/**
 * 官方标价。只认直连官方端点的：同一个模型经第三方网关、订阅套餐卖，价钱完全是另一回事，
 * 拿官方价给制作人看只会误导。所以来源 id 和地址都得和内置目录对得上。
 */
export function attachPrices(
  candidates: TeamModelCandidate[],
  providers: AiProviderSettings['providers'],
  findEntry: (id: string) => CatalogLookup | undefined
): TeamModelCandidate[] {
  return candidates.map((c) => {
    const provider = providers.find((p) => p.id === c.providerId)
    const entry = findEntry(c.providerId)
    if (!provider || !entry || entry.baseUrl !== provider.baseUrl) return c
    const cost = entry.models.find((m) => m.id === c.modelId)?.cost
    return cost ? { ...c, price: { input: cost.input, output: cost.output } } : c
  })
}

/**
 * 从模型设置读出这一轮的候选名单，带上体检结论和履历。读不到设置就不给 —— 招人照常，只是不让挑模型。
 *
 * 懒加载 `ai/*` 和 `teamSession`：它们顶上静态引了 electron，团队工具的单测不该为此加载它。
 */
export async function loadTeamModels(producer?: TeamModel): Promise<TeamModels | undefined> {
  try {
    const [{ readSettings }, { findCatalogEntry }, { checkupChatModel }, session] =
      await Promise.all([
        import('../../../ai/store'),
        import('../../../ai/catalog'),
        import('../../../ai/probe'),
        import('./teamSession')
      ])
    const settings = await readSettings()
    const candidates = attachPrices(
      teamModelCandidates(settings.providers),
      settings.providers,
      findCatalogEntry
    )
    const checkups = await loadModelCheckups(join(session.teamModelsDir(), 'model-checkups.json'))
    const trackRecord = createTrackRecord(session.trackRecordFile())
    const entries = await trackRecord.all()
    const project = getTargetProjectPath()
    const records: Record<string, string> = {}
    for (const c of candidates) {
      const line = summarizeTrackRecord(entries, c, project)
      if (line) records[c.key] = line
    }
    return {
      candidates,
      ...(producer ? { producer } : {}),
      // 和任务板、换模型 IPC 同一条规矩：在候选名单里才算能用。名单本身已经要求是对话类来源、
      // 模型还在清单里，另外去掉了标明不能调工具的 —— 两边各判一次的话，界面标黄而派活照用
      isAvailable: async (model) =>
        teamModelCandidates((await readSettings()).providers).some((c) => sameTeamModel(c, model)),
      checkup: async (model) => {
        const provider = (await readSettings()).providers.find((p) => p.id === model.providerId)
        if (!provider) return { at: Date.now(), reachable: false, tools: 'fail' }
        return checkups.ensure({
          model,
          baseUrl: provider.baseUrl,
          run: () => checkupChatModel(provider, model.modelId)
        })
      },
      knownCheckup: checkups.known,
      records,
      record: (entry) => {
        const where = getTargetProjectPath()
        return trackRecord.add({ ...entry, at: Date.now(), ...(where ? { project: where } : {}) })
      }
    }
  } catch (error) {
    console.warn('[team] 读模型设置失败，这一轮招人不给挑模型:', error)
    return undefined
  }
}

/**
 * 用户在任务板上给队员换模型（IPC `agent-v3:team-member-model`）。
 *
 * 只收候选名单里的模型，先过入职体检；记成「用户定的」；
 * 制作人当初的理由说的是原来那个模型，换了就清掉。
 */
export async function assignMemberModel(
  store: TeamStore,
  candidates: readonly TeamModelCandidate[],
  name: string,
  model: TeamModel,
  /** 入职体检。没过就不换，把结论带回去让界面说清卡在哪 */
  checkup?: (model: TeamModel) => Promise<ModelCheckup>
): Promise<{ success: true } | { success: false; error: string; checkup?: ModelCheckup }> {
  const member = await store.findMember(name)
  if (!member) return { success: false, error: `团队里没有 ${name}` }
  if (!candidates.some((c) => sameTeamModel(c, model))) {
    return { success: false, error: `${model.providerId}/${model.modelId} 不在能用的模型里` }
  }
  if (checkup && !(member.model && sameTeamModel(member.model, model))) {
    const result = await checkup(model)
    if (!checkupPassed(result)) {
      return { success: false, error: `体检没过：${describeCheckup(result)}`, checkup: result }
    }
  }
  const next: TeamMember = {
    ...member,
    model: { providerId: model.providerId, modelId: model.modelId },
    modelBy: 'user'
  }
  delete next.modelReason
  await store.putMember(next)
  return { success: true }
}

/**
 * 用户在任务板上打回了一件活：记到干这件活的那个模型头上（设计稿 5.5 节，最重的一条信号）。
 *
 * 认的是这个队员**最近一次交活时实际用的模型**（派活记录里有），不是它现在名册上的模型 ——
 * 用户可能已经给它换过了，打回的是换之前那个干的活。没负责人、查不到记录的不记。
 */
export async function recordReopen(
  store: TeamStore,
  taskId: string,
  add: (entry: TrackRecordEntry) => Promise<void>,
  now: () => number = Date.now
): Promise<void> {
  const task = (await store.board()).find((item) => item.id === taskId)
  if (!task?.owner) return
  const member = await store.findMember(task.owner)
  const name = member?.name ?? task.owner
  const last = (await store.activity(200))
    .reverse()
    .find((entry) => entry.who === name && entry.model)
  if (!last?.model) return
  await add({
    kind: 'reopened',
    at: now(),
    model: last.model,
    ...(member?.roleType ? { roleType: member.roleType } : {}),
    ...(last.project ? { project: last.project } : {})
  })
}
