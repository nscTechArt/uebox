/**
 * 混合团队制作人的工具集：Claude Code 带着请求头 `X-Unreal-Box-Profile: producer` 连进来时只拿这一套。
 *
 * 设计稿：docs/混合团队设计-2026-10-24.md 第 2 节「制作人的工具集」。
 *
 * 招人、辞人、任务板、留言、现状、快照就是盒子里 `/team` 的那几个工具：说明和参数原样，
 * 执行转给这个团队的宿主（`hybridTeam.ts`）。不同的只有两个：
 *
 * - `team_send` 一律后台派。外部制作人的一次调用撑不住一件活的时长（客户端有超时），
 *   `wait: true` 最多等 280 秒，否则用 `team_wait`。
 * - `team_wait` 是新的：有消息立刻回，没有就等。
 *
 * 队员发给制作人的话（交活、提问、崩溃通知）附在每个工具结果的末尾（`withProducerMailbox`）。
 * 这些工具都要过 `createExternalTeamSession` 的门：它认出这次是哪个团队的制作人。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../../tools/defineTool'
import type { HybridTeamHost } from './hybridTeam'
import { HYBRID_WAIT_MAX_MS } from './hybridTeam'
import type { TeamLive } from './teamLive'
import { canChooseModels, describeCandidates, type TeamModels } from './teamModels'
import type { TeamSnapshots } from './snapshots'
import type { TeamStore } from './teamStore'
import { createTeamTools, HIRE_CANDIDATES_HEADING } from './teamTools'

/** 照搬盒子里那一份的团队工具 */
const BOX_TOOLS = [
  'team_hire',
  'team_dismiss',
  'team_board',
  'team_message',
  'team_status',
  'team_snapshot'
] as const

/**
 * 不给 seconds 时 `team_wait` 等多久。卡在 Claude Code 那 5 分钟「没动静就掐」以内，
 * 理由同 `HYBRID_SEND_WAIT_MS`；客户端把空闲超时调大了，制作人可以给到上限 600
 */
const WAIT_DEFAULT_SECONDS = 280

export interface HybridProducerToolDeps {
  /** 这次调用是哪个团队的制作人（`ExternalTeamSession.producerTeam`） */
  teamOf: () => string | undefined
  /** 这个团队的宿主，没起来就拉起来 */
  hostOf: (teamId: string) => Promise<HybridTeamHost>
  /** 招人时能选的工具命名空间。写进 `team_hire` 的说明 */
  namespaces: string[]
  /** 能挑哪些模型。写进 `team_hire` 的说明；没有就不让挑 */
  models?: TeamModels
  /** 有快照就给 `team_snapshot` */
  snapshots?: boolean
}

function hostFor(deps: HybridProducerToolDeps): Promise<HybridTeamHost> {
  const teamId = deps.teamOf()
  if (!teamId) return Promise.reject(new Error('还没进团队：先 team_open'))
  return deps.hostOf(teamId)
}

export function createHybridProducerTools(deps: HybridProducerToolDeps): UnrealAgentTool<never>[] {
  // 只拿说明和参数：执行时转给团队的宿主，那里才有这个团队的账
  const unbound = {} as TeamStore
  const template = createTeamTools({
    store: unbound,
    objective: '',
    namespaces: deps.namespaces,
    sessionId: 'hybrid-template',
    live: {} as TeamLive,
    ...(deps.snapshots ? { snapshots: {} as TeamSnapshots } : {}),
    ...(deps.models ? { models: deps.models } : {}),
    runMember: () => Promise.reject(new Error('unreachable')),
    runAcceptance: () => Promise.reject(new Error('unreachable'))
  })
  const forwarded = template
    .filter((tool) => (BOX_TOOLS as readonly string[]).includes(tool.name))
    .map(
      (tool) =>
        ({
          ...tool,
          // 候选名单不放在工具说明里：用户配的模型一多就超过 Claude Code 的 4096 字截断，
          // 排在后面的模型制作人根本看不到。名单随 team_open 的须知给（`hybridHireCatalog`）
          ...(tool.name === 'team_hire' && tool.description.includes(HIRE_CANDIDATES_HEADING)
            ? {
                description:
                  tool.description.slice(0, tool.description.indexOf(HIRE_CANDIDATES_HEADING)) +
                  '可用模型的名单在 team_open 的回话里，model 填名单里的 id。'
              }
            : {}),
          execute: async (_callId, params, signal, onUpdate) =>
            (await hostFor(deps)).call(tool.name, params, signal, onUpdate as never)
        }) as UnrealAgentTool<never>
    )

  const sendInput = z.object({
    to: z.string().min(1).describe('队员名'),
    message: z
      .string()
      .min(1)
      .describe('给它的活或者话。它看不到你和用户的对话，需要的背景要写进来，或者放进工作区'),
    wait: z
      .boolean()
      .optional()
      .default(false)
      .describe('true = 最多等 280 秒看它交回；false（默认）= 派完就回来，之后用 team_wait 等')
  })
  const sendTool = defineTool<typeof sendInput, unknown>({
    name: 'team_send',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '给一个队员派活 —— 队员空闲时，这是唯一能让它开工的办法（team_message 只是说话）。它记得你之前发给它的所有内容。' +
      '活一律在后台跑；它交回的结论会附在你下一次调用团队工具的结果后面，或者用 team_wait 等。' +
      '发给不同队员的并行跑；发给同一个人的按顺序排队。结论末尾附一行它实际做过的写操作，那是记账记出来的。',
    input: sendInput,
    execute: async ({ to, message, wait }, ctx) => {
      const host = await hostFor(deps)
      const text = await host.send({ to, message, wait }, ctx.signal, (line) =>
        ctx.report({ text: line })
      )
      return { text }
    }
  })

  const waitInput = z.object({
    seconds: z
      .number()
      .int()
      .min(1)
      .max(HYBRID_WAIT_MAX_MS / 1000)
      .optional()
      .describe(`最多等几秒，默认 ${WAIT_DEFAULT_SECONDS}`)
  })
  const waitTool = defineTool<typeof waitInput, unknown>({
    name: 'team_wait',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '等团队的消息：队员交回的活、给你的提问、出错通知。已经有就立刻回；没有就等到来一条或者到点，' +
      '到点时说清谁还在干。没有在干的活时立刻回。',
    input: waitInput,
    execute: async ({ seconds }, ctx) => {
      const host = await hostFor(deps)
      const text = await host.wait((seconds ?? WAIT_DEFAULT_SECONDS) * 1000, ctx.signal, (line) =>
        ctx.report({ text: line })
      )
      return { text }
    }
  })

  const approveInput = z.object({
    id: z.string().min(1).describe('审批编号，消息开头 [team approval a1 …] 里的 a1'),
    allow: z.boolean().describe('true = 准它做；false = 不准'),
    note: z.string().optional().describe('顺带给这个队员的话：为什么不准、换什么做法')
  })
  const approveTool = defineTool<typeof approveInput, unknown>({
    name: 'team_approve',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '答复队员的审批请求（[team approval …] 消息）：准或不准它那一步。队员一直等到你答复，超时按不准处理。',
    input: approveInput,
    execute: async ({ id, allow, note }) => ({
      text: await (await hostFor(deps)).approve(id, allow, note)
    })
  })

  return [
    ...forwarded,
    sendTool as unknown as UnrealAgentTool<never>,
    waitTool as unknown as UnrealAgentTool<never>,
    approveTool as unknown as UnrealAgentTool<never>
  ]
}

/**
 * `project_manage` 这次建好或打开的工程目录。看参数里的路径和结果里的路径（建工程回 `projectPath`，
 * 开工程回 `openedPath`，都可能是 .uproject）。认不出来给 undefined：只给了 projectKey、又没回路径时
 * 制作人得用 team_open 补
 */
export function openedProjectPath(params: unknown, details: unknown): string | undefined {
  const pick = (value: unknown, keys: string[]): string | undefined => {
    if (!value || typeof value !== 'object') return undefined
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }
  const action = pick(params, ['action'])
  if (action !== 'create_project' && action !== 'open_project') return undefined
  const found =
    pick(details, ['projectPath', 'openedPath', 'uprojectPath']) ??
    (action === 'open_project' ? pick(params, ['projectPath']) : undefined)
  if (!found) return undefined
  return /\.uproject$/i.test(found) ? found.replace(/[\\/][^\\/]+$/, '') : found
}

/** 招人能挑的模型，附在混合团队 `team_open` 的须知后面。只有一个模型可选时不给（招人参数里也没有 model） */
export function hybridHireCatalog(models: TeamModels | undefined): string {
  return canChooseModels(models)
    ? `\n\nModels you can hire (give the id as team_hire's model):\n${describeCandidates(models)}`
    : ''
}

/**
 * 每个工具结果末尾附上制作人信箱里没看的话。`team_wait` 自己就是取信箱，不再附。
 *
 * 要包在门（`guard`）**里面**：认出是哪个团队的制作人是门做的事。宿主没起来就不附 ——
 * 列团队、查交付闸这种调用不该顺手把宿主拉起来
 */
export function withProducerMailbox(
  tools: UnrealAgentTool<never>[],
  deps: {
    teamOf: () => string | undefined
    running: (teamId: string) => HybridTeamHost | undefined
  }
): UnrealAgentTool<never>[] {
  return tools.map((tool) => {
    const inner = tool.execute.bind(tool)
    return {
      ...tool,
      execute: async (...args: Parameters<typeof inner>) => {
        // 制作人又在调工具了：收工时摘下的信箱挂回来，队员的话重新当场送到
        const before = deps.teamOf()
        if (before) deps.running(before)?.resume()
        const result = await inner(...args)
        if (tool.name === 'team_wait') return result
        const teamId = deps.teamOf()
        const host = teamId ? deps.running(teamId) : undefined
        const mail = host ? await host.drain() : ''
        return mail
          ? { ...result, content: [...result.content, { type: 'text' as const, text: mail }] }
          : result
      }
    } as UnrealAgentTool<never>
  })
}
