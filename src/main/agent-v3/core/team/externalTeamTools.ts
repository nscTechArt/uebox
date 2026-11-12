/**
 * 外部团队的工具，以及「这次调用是谁」的那道门。
 *
 * 设计稿：docs/外部大脑跑团队设计-2026-10-17.md 第 4、5 节。
 *
 * ## 角色跟着通行证走
 *
 * 制作人调 `team_open`、队员和验收员调 `team_join`，盒子发一张通行证（team_seat），记进团队记录
 * （`ExternalSeat`）。之后每次调用带上它 —— `_meta.unrealBox.teamSeat`，或者参数里的 `team_seat`
 * （大多数客户端只让模型填参数，所以每个工具的参数表里都多一个可选的 `team_seat`）——
 * 盒子就按它认人。所以：
 *
 * - 一条连接可以同时跑制作人、几个队员和验收员（Kimi Code、Codex、Cursor 的子 Agent 和主会话共用一条连接）；
 * - 盒子重启、连接重连之后角色还在，通行证是落盘的。
 *
 * 不带通行证时退回按连接认：这条连接上只进过一个角色，就当是它（Claude Code 插件里每个子 Agent
 * 各开一条连接，原来就这么用）。一条连接上进过第二个角色，它就成了「共用连接」，之后不带通行证的
 * 调用一律拒绝 —— 猜是谁，猜错了就是验收员拿着队员的写权限。
 *
 * 认出角色之后**每一次**调用都过 `guard`：
 *
 * - 制作人、验收员：只放行只读工具（制作人另有团队工具，验收员另有试玩那几个）。和盒子里
 *   `producerTools()` 同一个口径，规则台账里记过两次「制作人拿着写工具自己把游戏写完」。
 * - 队员：按名册上的只读设置和命名空间白名单收窄；套上自己的锁主（文件锁）和编辑器钥匙，
 *   和盒子里 `runMember` 的执行流一样；写操作记账，交回时据此存快照。
 * - 任何角色都不给 `task`：它跑的是盒子自己的模型，外部团队的前提就是盒子不花模型的钱。
 *
 * **从没进过团队的连接原样透传**：普通的外部会话（Codex、CLI）行为一点不变。
 * 盒子里的团队（`createTeamTools`）不经过这里。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { z } from 'zod'

import { defineTool, effectiveRisk, type UnrealAgentTool } from '../../tools/defineTool'
import { JOB_SEP, releaseAll, runWithLockOwner } from '../assetLock'
import { ACCEPTANCE_JUDGES } from '../goalLoop'
import {
  getTargetProjectPath,
  runWithTargetConnectionId,
  type TargetProjectRef
} from '../projectTargetContext'
import { summarizeDoneWrites, WriteLedger } from '../writeLedger'
import { runWithEditorKey } from './editorKey'
import {
  gateFacts,
  newSeatId,
  type ExternalGateFacts,
  type ExternalSeat,
  type ExternalTeamRecord,
  type ExternalTeamRegistry
} from './externalTeam'
import {
  ACCEPTOR_AGENT,
  buildExternalAcceptancePrompt,
  buildExternalMemberFraming,
  buildExternalProducerBrief,
  MEMBER_AGENT,
  seatNote
} from './externalTeamPrompt'
import { snapshotMessage, type TeamSnapshots } from './snapshots'
import { createStatusTool } from './teamStatus'
import { memberFileBase, PRODUCER, type TeamMember, type TeamStore } from './teamStore'
import { getMetaTeamSeat } from './teamSeatContext'
import { createBoardTool, createSnapshotTool, formatMail, renderBoard } from './teamTools'
import { carryOverTasks, formatBoardCarryOver } from './boardRecap'
import { startTeamRound } from './teamSession'

/** 记给验收员的「用户最近那句话」最长多少字。同盒子里 `ipc/agentV3.ts` 截的那一截 */
const LATEST_REQUEST_MAX = 2000

/** 验收员进门时报的名字。队员不许叫这个（`team_hire` 里拦着） */
export const ACCEPTOR = 'acceptor'

/** 调用方不能发 `_meta` 时，把通行证放进参数用的那个键 */
export const TEAM_SEAT_ARG = 'team_seat'

/** 盒子自己的子任务。外部团队一律不给，见文件头 */
const TASK_TOOL = 'task'

/** 交回时附上这个队员最近几件活的报告，代替盒子里队员自带的记忆 */
const RECENT_REPORTS = 3

/** 每个工具参数表里多出来的那一项。说明写短：外部连接上每个工具都带它 */
const SEAT_PARAM = {
  type: 'string',
  description: 'Unreal Box team pass from team_open/team_join. In a team, send it on every call.'
} as const

type Role = 'producer' | 'member' | 'acceptor'

interface Binding {
  /** 通行证 */
  seat: string
  role: Role
  teamId: string
  /** 队员：名册上的那一项 */
  member?: TeamMember
  /** 队员：锁主。和盒子里 `memberLockOwner` 同一个形状，`team_status` 的锁表按它认人 */
  owner?: string
  jobId?: string
  brief?: string
  ledger?: WriteLedger
  /** 这件活写过工程（落盘的那一份，盒子重启后 ledger 是空的） */
  wrote?: boolean
  /** 验收员记过结论了 */
  closed?: boolean
  /** 团队的工程。第一次用到时从记录里读，之后不再每次调用都读盘；`team_open` 改了就跟着改 */
  projectPath?: string
  /** 调用方亲手带过这张通行证：它自己管身份，连接断了也不收它的活 */
  viaPass?: boolean
  createdAt: number
}

/** 每个角色能用哪些团队工具。没认出角色的调用只能进门、看清单、查交付闸 */
const ROLE_TEAM_TOOLS: Record<Role | 'none', ReadonlySet<string>> = {
  none: new Set(['team_open', 'team_join', 'team_list', 'team_gate']),
  producer: new Set([
    'team_open',
    'team_hire',
    // 混合团队的制作人（`hybridTeamTools.ts`）：队员在盒子里跑，派活、辞人、等结果都走盒子
    'team_send',
    'team_dismiss',
    'team_wait',
    'team_approve',
    'team_board',
    'team_message',
    'team_inbox',
    'team_status',
    'team_snapshot',
    'team_list',
    'team_gate'
  ]),
  member: new Set([
    'team_join',
    'team_report',
    'team_board',
    'team_message',
    'team_inbox',
    'team_status',
    'team_list',
    'team_gate'
  ]),
  acceptor: new Set([
    'team_join',
    'team_verdict',
    'team_board',
    'team_message',
    'team_inbox',
    'team_status',
    'team_list',
    'team_gate'
  ])
}

export const EXTERNAL_TEAM_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(ROLE_TEAM_TOOLS).flatMap((names) => [...names])
)

/** 混合团队开团时能选的思考档位，同盒子输入框里那一档（`ThinkingLevelChoice`） */
const THINKING_CHOICES = [
  'auto',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const

/** 进门的两个工具：不按连接认人，只认这次亲手带的通行证 */
const ENTRY_TOOLS: ReadonlySet<string> = new Set(['team_open', 'team_join'])

// ── 通行证从哪来 ─────────────────────────────────────────────────────────

/** 参数里的通行证拿出来，剩下的参数原样交给工具（有的工具参数表是严格的） */
function splitSeatArg(params: unknown): { params: unknown; seat?: string } {
  if (!params || typeof params !== 'object' || !(TEAM_SEAT_ARG in params)) return { params }
  const { [TEAM_SEAT_ARG]: raw, ...rest } = params as Record<string, unknown>
  return {
    params: rest,
    ...(typeof raw === 'string' && raw.trim() ? { seat: raw.trim() } : {})
  }
}

function withSeatParam(
  schema: UnrealAgentTool<never>['parameters']
): UnrealAgentTool<never>['parameters'] {
  const s = schema as { type?: unknown; properties?: Record<string, unknown> }
  if (s?.type !== 'object' || s.properties?.[TEAM_SEAT_ARG]) return schema
  return {
    ...s,
    properties: { ...s.properties, [TEAM_SEAT_ARG]: SEAT_PARAM }
  } as unknown as UnrealAgentTool<never>['parameters']
}

/**
 * 认出来的角色，进程里只留一份：同一张通行证从几条连接上来，用的是同一本写操作账、同一个锁主。
 * 按名册分开放，测试里每个名册各算各的
 */
const liveSeats = new WeakMap<ExternalTeamRegistry, Map<string, Binding | Promise<Binding>>>()

function seatsOf(registry: ExternalTeamRegistry): Map<string, Binding | Promise<Binding>> {
  let seats = liveSeats.get(registry)
  if (!seats) {
    seats = new Map()
    liveSeats.set(registry, seats)
  }
  return seats
}

function seatRecord(b: Binding): ExternalSeat {
  return {
    role: b.role,
    ...(b.member ? { member: b.member.name } : {}),
    ...(b.jobId ? { jobId: b.jobId } : {}),
    ...(b.jobId && b.brief ? { brief: b.brief } : {}),
    ...(b.jobId && b.wrote ? { wrote: true } : {}),
    ...(b.closed ? { closed: true } : {}),
    createdAt: b.createdAt
  }
}

export interface ExternalTeamDeps {
  registry: ExternalTeamRegistry
  storeFor: (teamId: string) => TeamStore
  snapshots?: TeamSnapshots
  /** 招人时能选的工具命名空间 */
  namespaces: string[]
  /**
   * 工程路径 → 执行流上的目标。编辑器连着就认那条连接；没连着也要给一个
   * 「认不出来」的目标，免得编辑器命令落进旁边另一个连着的工程（见 `projectTargetContext.ts`）
   */
  resolveTarget: (projectPath: string) => TargetProjectRef
  /**
   * 混合团队（队员由盒子托管，`hybridTeam.ts`）。给了它，这条连接是混合制作人的：
   * `team_open` 建的团队记成 `members: 'box'`，回话里的制作人须知由它给（顺带把宿主拉起来）。
   * 不给的连接开不了混合团队，混合团队的队员也不经 `team_join` 进门
   */
  hosted?: {
    /** 制作人须知。团队记录已经落盘 */
    brief: (record: ExternalTeamRecord) => Promise<string>
  }
  /**
   * 混合团队的宿主（`hybridTeam.ts`），交付闸和收工要问它。任何连接都给：Stop hook 走的是
   * 普通的 CLI 连接。宿主没起来时 `facts` 回 undefined
   */
  hybrid?: {
    facts: (
      teamId: string
    ) => Promise<{ pendingJobs: number; unreadForProducer: number } | undefined>
    /** 制作人收工：从「谁在跑」上摘下来 */
    stop: (teamId: string) => Promise<void>
    /** 记录变了（用户新说的话） */
    update: (record: ExternalTeamRecord) => void
  }
  now?: () => number
}

export interface ExternalTeamSession {
  /** 团队工具。由 `guard` 一起包上 */
  tools: UnrealAgentTool<never>[]
  /** 包这条连接上的全部工具（含团队工具） */
  guard: (tools: UnrealAgentTool<never>[]) => UnrealAgentTool<never>[]
  /** 连接断了：放掉这条连接上的锁；按连接认人的活收成「停下」 */
  dispose: () => Promise<void>
  /** 测试用：不带通行证时这条连接被认成谁 */
  binding: () => Readonly<Binding> | undefined
  /**
   * 这次调用是哪个团队的制作人。只在 `guard` 包着的调用里有值：混合团队的制作人工具靠它找到宿主
   */
  producerTeam: () => string | undefined
}

/**
 * 制作人能用的那一个写操作：建工程、打开工程。和盒子里 `producerTools()` 同一个口径 ——
 * 工程要先有，队员才有地方干活；往工程里加东西就是改游戏了，派给队员
 */
const PRODUCER_PROJECT_ACTIONS: ReadonlySet<string> = new Set(['create_project', 'open_project'])

function producerSetupCall(toolName: string, params: unknown): boolean {
  if (toolName !== 'project_manage' || !params || typeof params !== 'object') return false
  const action = (params as { action?: unknown }).action
  return typeof action === 'string' && PRODUCER_PROJECT_ACTIONS.has(action)
}

/**
 * 锁主带上这件活的编号：同一个队员可以同时起两个子 Agent 干两件活，
 * 锁要能把它们分开，一件交回时也不能放掉另一件占着的文件
 */
function memberOwner(teamId: string, name: string, jobId: string): string {
  return `${teamId}:mate-${memberFileBase(name)}${JOB_SEP}${jobId}`
}

function firstSentence(text: string): string {
  return (
    text
      .trim()
      .split(/(?<=[。！？!?])|\n/)
      .find((s) => s.trim())
      ?.trim() ?? ''
  )
}

function roleLabel(binding: Binding | undefined, shared: boolean): string {
  if (!binding) return shared ? `没带 ${TEAM_SEAT_ARG} 的调用` : '还没进团队的连接'
  if (binding.role === 'producer') return '制作人'
  if (binding.role === 'acceptor') return binding.closed ? '记过结论的验收员' : '验收员'
  const name = `队员「${binding.member?.name ?? '?'}」`
  return binding.jobId ? name : `${name}（活已交回）`
}

/** 手上没活的队员、记过结论的验收员：只能重新进门 */
function inactive(b: Binding): boolean {
  return (b.role === 'member' && !b.jobId) || Boolean(b.closed)
}

export function createExternalTeamSession(deps: ExternalTeamDeps): ExternalTeamSession {
  const now = deps.now ?? Date.now
  const seats = seatsOf(deps.registry)
  /** 不带通行证时这条连接被认成哪张。连接上进过第二个角色就清掉，见 `shared` */
  let boundSeat: string | undefined
  /** 这条连接上跑着不止一个角色：不带通行证的调用一律不认 */
  let shared = false
  // 这条连接当过队员：之后不许再不带通行证以验收员进门，自己做的活不能自己验
  let servedAsMember = false
  /** 这条连接上用过的通行证。断开时放掉它们的锁 */
  const usedHere = new Set<string>()
  /** 这次调用是谁。`guard` 认出来之后放进执行流，团队工具从这里读 */
  const current = new AsyncLocalStorage<{ binding?: Binding; explicit: boolean }>()

  const need = (role?: Role): Binding => {
    const binding = current.getStore()?.binding
    if (!binding || inactive(binding)) {
      throw new Error(
        shared
          ? `这条连接上有好几个团队角色：每次调用都要带上自己的 ${TEAM_SEAT_ARG}`
          : '还没进团队：制作人先 team_open，队员和验收员先 team_join'
      )
    }
    if (role && binding.role !== role) {
      throw new Error(
        `只有${role === 'member' ? '队员' : role === 'acceptor' ? '验收员' : '制作人'}能调这个工具`
      )
    }
    return binding
  }

  const mailName = (b: Binding): string =>
    b.role === 'producer' ? PRODUCER : b.role === 'acceptor' ? ACCEPTOR : (b.member?.name ?? '')

  async function openRecord(teamId: string): Promise<ExternalTeamRecord> {
    const record = await deps.registry.get(teamId)
    if (!record) throw new Error(`没有这个外部团队：${teamId}。team_list 看有哪些`)
    if (record.endedAt !== undefined) throw new Error(`团队 ${teamId} 已经结束了`)
    return record
  }

  /** 按通行证认人：进程里有就用，没有就从团队记录里找回来（盒子重启过） */
  function resolveSeat(seat: string): Binding | Promise<Binding> {
    const live = seats.get(seat)
    if (live) return live
    const loading = (async (): Promise<Binding> => {
      const found = await deps.registry.getSeat(seat)
      if (!found) {
        throw new Error(
          `盒子不认得这张通行证（${TEAM_SEAT_ARG}=${seat}）。用 team_open / team_join 返回的那一张，原样带上`
        )
      }
      const { record, seat: saved } = found
      if (record.endedAt !== undefined) throw new Error(`团队 ${record.id} 已经结束了`)
      const b: Binding = {
        seat,
        role: saved.role,
        teamId: record.id,
        createdAt: saved.createdAt,
        ...(record.projectPath ? { projectPath: record.projectPath } : {}),
        ...(saved.closed ? { closed: true } : {})
      }
      if (saved.role === 'member' && saved.member) {
        const store = deps.storeFor(record.id)
        b.member = (await store.findMember(saved.member)) ?? {
          name: saved.member,
          persona: '',
          tier: 'strong',
          readOnly: false,
          hiredAt: saved.createdAt
        }
        if (saved.jobId) {
          b.jobId = saved.jobId
          b.owner = memberOwner(record.id, b.member.name, saved.jobId)
          b.ledger = new WriteLedger()
          if (saved.brief) b.brief = saved.brief
          if (saved.wrote) b.wrote = true
        }
      }
      seats.set(seat, b)
      return b
    })()
    seats.set(seat, loading)
    // 认不出来就别留着：下次带对了的通行证要能重新查
    loading.catch(() => {
      if (seats.get(seat) === loading) seats.delete(seat)
    })
    return loading
  }

  /** 发一张新通行证（或改写一张旧的），记进团队记录 */
  async function saveSeat(b: Binding): Promise<void> {
    seats.set(b.seat, b)
    await deps.registry.putSeat(b.teamId, b.seat, seatRecord(b))
  }

  /**
   * 有人在这条连接上进了门。连接上原来就有一个还在干活的角色、换成另一张通行证：
   * 这条连接从此是共用的，不带通行证的调用不再按连接认
   */
  function enter(b: Binding, explicit: boolean): void {
    usedHere.add(b.seat)
    if (explicit) b.viaPass = true
    if (shared) return
    const prior = boundSeat ? seats.get(boundSeat) : undefined
    const priorLive = prior !== undefined && !(prior instanceof Promise) && !inactive(prior)
    if (boundSeat && boundSeat !== b.seat && priorLive) {
      shared = true
      boundSeat = undefined
      return
    }
    boundSeat = b.seat
  }

  /** 这张通行证的活干完了：不带通行证的调用不再认成它 */
  function leave(b: Binding): void {
    if (boundSeat === b.seat) boundSeat = undefined
  }

  /** 绑定之后的调用：进团队的工程，队员再套上锁主和编辑器钥匙 */
  async function runBound<T>(b: Binding, fn: () => Promise<T>): Promise<T> {
    b.projectPath ??= (await deps.registry.get(b.teamId))?.projectPath
    const projectPath = b.projectPath
    // 调用方自己用 `_meta.unrealBox` 点了工程（CLI）就听它的
    const inProject =
      projectPath && !getTargetProjectPath()
        ? () => runWithTargetConnectionId(deps.resolveTarget(projectPath), fn)
        : fn
    if (b.role === 'member' && b.owner) {
      const owner = b.owner
      return runWithLockOwner(owner, () => runWithEditorKey(inProject))
    }
    return inProject()
  }

  /** 这次调用放不放行。不放行就抛，话里说清下一步 */
  function refuse(b: Binding, tool: UnrealAgentTool<never>, params: unknown): void {
    if (tool.name === TASK_TOOL) {
      throw new Error(
        '外部团队里不用 task：它跑的是盒子自己的模型。要人干活就起一个队员（子 Agent）'
      )
    }
    if (inactive(b)) {
      throw new Error(
        b.role === 'member'
          ? `${roleLabel(b, shared)}：这张通行证手上没有活。再干活先 team_join（带上 ${TEAM_SEAT_ARG}）`
          : `验收员已经记过结论，这张通行证用完了。再验收请制作人另起一个 ${ACCEPTOR_AGENT}`
      )
    }
    const write = effectiveRisk(tool.unrealBox, params) !== 'safe'
    if (b.role === 'producer' && write && !producerSetupCall(tool.name, params)) {
      throw new Error(
        `制作人不直接改工程（${tool.name} 是写操作）。招一个队员（team_hire），起一个 ${MEMBER_AGENT} 子 Agent 去做`
      )
    }
    if (b.role === 'acceptor' && write && !ACCEPTANCE_JUDGES.includes(tool.name)) {
      throw new Error(`验收员只读，${tool.name} 是写操作。验收只判不修，问题写进 team_verdict`)
    }
    if (b.role === 'member' && b.member) {
      if (b.member.readOnly && write) {
        throw new Error(
          `${b.member.name} 是只读岗位，${tool.name} 是写操作。把发现写进 team_report`
        )
      }
      const scope = b.member.namespaces
      const ns = tool.unrealBox.namespace
      if (scope?.length && ns !== 'core' && !scope.includes(ns)) {
        throw new Error(
          `${tool.name}（${ns}）不在 ${b.member.name} 的工具范围里（${scope.join('/')}）。需要的话请制作人改它的设定`
        )
      }
    }
  }

  /** 队员这件活第一次写工程：记进通行证，盒子重启后交回时还知道要存快照 */
  async function noteMemberWrote(b: Binding): Promise<void> {
    if (b.wrote || !b.jobId) return
    b.wrote = true
    await saveSeat(b).catch(() => undefined)
  }

  function guardOne(tool: UnrealAgentTool<never>): UnrealAgentTool<never> {
    const inner = tool.execute.bind(tool)
    const isTeamTool = EXTERNAL_TEAM_TOOL_NAMES.has(tool.name)
    const entry = ENTRY_TOOLS.has(tool.name)
    return {
      ...tool,
      parameters: withSeatParam(tool.parameters),
      execute: async (callId, rawParams, signal, onUpdate) => {
        const split = splitSeatArg(rawParams)
        const params = split.params as typeof rawParams
        const explicit = getMetaTeamSeat() ?? split.seat
        // 进门不按连接认人：同一条连接上制作人刚 team_open，子 Agent 再 team_join 是进新角色
        const seat = explicit ?? (entry || shared ? undefined : boundSeat)
        const b = seat ? await resolveSeat(seat) : undefined
        if (b && explicit) {
          b.viaPass = true
          usedHere.add(b.seat)
        }
        const call = (): ReturnType<typeof inner> =>
          current.run({ ...(b ? { binding: b } : {}), explicit: Boolean(explicit) }, () =>
            inner(callId, params, signal, onUpdate)
          )

        if (isTeamTool) {
          const role = b && !inactive(b) ? b.role : 'none'
          if (!ROLE_TEAM_TOOLS[role].has(tool.name)) {
            throw new Error(
              `${roleLabel(b, shared)}不能调 ${tool.name}` +
                (shared && !b ? `：这条连接上有好几个团队角色，带上自己的 ${TEAM_SEAT_ARG}` : '')
            )
          }
          if (!b || role === 'none') return call()
          const result = await runBound(b, call)
          // 退回快照改写了工程文件：之前的验收不再算数
          if (effectiveRisk(tool.unrealBox, params) === 'destructive') {
            await deps.registry.noteWrite(b.teamId)
          }
          return result
        }

        if (!b) {
          if (shared) {
            throw new Error(
              `这条连接上有好几个团队角色，盒子不猜这次是谁：带上 team_open / team_join 给你的 ${TEAM_SEAT_ARG}`
            )
          }
          // 普通外部会话：一点不变
          return call()
        }

        refuse(b, tool, params)
        // 验收员试玩是去「玩」，不算改工程：记成写操作的话，它自己的 PASS 就被自己作废了
        const write =
          effectiveRisk(tool.unrealBox, params) !== 'safe' &&
          !(b.role === 'acceptor' && ACCEPTANCE_JUDGES.includes(tool.name))
        return runBound(b, async () => {
          if (!write) return call()
          b.ledger?.start(callId, tool.name, params)
          try {
            const result = await call()
            b.ledger?.end(callId, true)
            await deps.registry.noteWrite(b.teamId)
            await noteMemberWrote(b)
            return result
          } catch (error) {
            b.ledger?.end(callId, false)
            throw error
          }
        })
      }
    } as UnrealAgentTool<never>
  }

  // ── 进门 ──────────────────────────────────────────────────────────────

  /** 这次调用亲手带的通行证认出来的角色。不带就是 undefined（进门不按连接认） */
  const presented = (): Binding | undefined => {
    const ctx = current.getStore()
    return ctx?.explicit ? ctx.binding : undefined
  }

  function sameTeam(prior: Binding | undefined, teamId: string | undefined): void {
    if (prior && teamId && teamId !== prior.teamId) {
      throw new Error(
        `这张通行证属于团队 ${prior.teamId}，不是 ${teamId}。进别的团队不带 ${TEAM_SEAT_ARG}`
      )
    }
  }

  const baseOpenInput = z.object({
    objective: z.string().optional().describe('新开团队时必填：用户要的那一句话'),
    team_id: z.string().optional().describe('接着已有的团队干（换天、换会话、补工程路径）'),
    project_path: z
      .string()
      .optional()
      .describe('团队在哪个虚幻工程里干（.uproject 所在目录的绝对路径）。工程建好之后补上')
  })
  const hostedOpenInput = baseOpenInput.extend({
    thinking_level: z
      .enum(THINKING_CHOICES)
      .optional()
      .describe('新开团队时：队员的思考档位，省略 = auto'),
    approval_mode: z
      .enum(['yolo', 'producer', 'ask', 'auto-edit'])
      .optional()
      .describe(
        '新开团队时：队员的审批档位。yolo（默认）= 全放行，队员自己判断；producer = 不可逆的发给你用 team_approve 批；auto-edit / ask = 在盒子窗口弹框问用户'
      )
  })
  // 两种形状给同一个类型：普通连接上 thinking_level 永远是 undefined（同 team_hire 的 model）
  const openInput = (deps.hosted ? hostedOpenInput : baseOpenInput) as typeof hostedOpenInput

  const openTool = defineTool<typeof openInput, unknown>({
    name: 'team_open',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description:
      (deps.hosted
        ? '混合团队（你当制作人，队员是盒子里跑的模型，你招人时给它挑模型）。'
        : '外部团队（你当制作人，队员和验收员是你客户端里的子 Agent，盒子只提供任务板、留言、锁、快照、验收记录）。') +
      `新开一个团队，或者接着已有的团队干。返回团队 id、制作人须知和你的通行证（${TEAM_SEAT_ARG}）：之后每次调用都带上它。` +
      `带着自己的 ${TEAM_SEAT_ARG} 再调一次就是补工程路径。`,
    input: openInput,
    execute: async ({ objective, team_id, project_path, thinking_level, approval_mode }) => {
      const prior = presented()
      if (prior && prior.role !== 'producer') {
        throw new Error(
          `这张通行证是${roleLabel(prior, shared)}的，当不了制作人。开团队时不带 ${TEAM_SEAT_ARG}`
        )
      }
      sameTeam(prior, team_id?.trim())
      const projectPath = project_path?.trim() || undefined
      const existingId = team_id?.trim() || prior?.teamId
      const hosted = deps.hosted
      let record
      if (existingId) {
        record = await openRecord(existingId)
        if (Boolean(hosted) !== (record.members === 'box')) {
          throw new Error(
            record.members === 'box'
              ? `团队 ${record.id} 的队员由盒子托管：用混合制作人的连接（请求头 X-Unreal-Box-Profile: producer）接着开`
              : `团队 ${record.id} 的队员是客户端里的子 Agent，不是混合团队：用普通的盒子连接接着开`
          )
        }
        // 混合团队带着 team_id 再开时给的 objective 是用户新说的话：记下来给验收员，目标原文不动
        const latest = hosted ? objective?.trim() : undefined
        if ((projectPath && projectPath !== record.projectPath) || latest) {
          record = await deps.registry.update(record.id, (r) => ({
            ...r,
            ...(projectPath ? { projectPath } : {}),
            ...(latest ? { latestRequest: latest } : {})
          }))
        }
      } else {
        if (!objective?.trim()) throw new Error('新开团队要给 objective；接着干给 team_id')
        record = await deps.registry.create({
          objective: objective.trim(),
          ...(projectPath ? { projectPath } : {}),
          ...(hosted ? { members: 'box' as const, approvalMode: approval_mode ?? 'yolo' } : {}),
          ...(hosted && thinking_level ? { thinkingLevel: thinking_level } : {})
        })
      }
      const store = deps.storeFor(record.id)
      await store.ensure()

      // 接着用：亲手带来的制作人通行证；或者不带、但这条连接原来就是这个团队的制作人（补工程路径）
      const bound = !shared && boundSeat ? seats.get(boundSeat) : undefined
      const reuse =
        prior ??
        (bound &&
        !(bound instanceof Promise) &&
        bound.role === 'producer' &&
        bound.teamId === record.id
          ? bound
          : undefined)
      const b: Binding = reuse ?? {
        seat: newSeatId(record.id),
        role: 'producer',
        teamId: record.id,
        createdAt: now()
      }
      if (!reuse) await saveSeat(b)
      // 工程路径换了：这个团队里已经认出来的角色跟着换
      if (record.projectPath) {
        for (const live of seats.values()) {
          if (!(live instanceof Promise) && live.teamId === record.id) {
            live.projectPath = record.projectPath
          }
        }
      }
      enter(b, Boolean(prior))

      const { workspaceDir } = deps.registry.dirsFor(record.id)
      const roster = await store.roster()
      return {
        text: [
          seatNote(b.seat),
          '',
          hosted
            ? await hosted.brief(record)
            : buildExternalProducerBrief({
                teamId: record.id,
                objective: record.objective,
                workspaceDir,
                ...(record.projectPath ? { projectPath: record.projectPath } : {})
              }),
          '',
          `团队 ${record.id}：${roster.length ? `现有 ${roster.map((m) => m.name).join('、')}` : '还没有队员'}。`,
          renderBoard(await store.board())
        ].join('\n'),
        details: {
          teamId: record.id,
          seat: b.seat,
          workspaceDir,
          projectPath: record.projectPath ?? null
        }
      }
    }
  })

  const joinInput = z.object({
    team_id: z.string().min(1),
    member: z.string().min(1).describe(`队员名（名册上的），或者 "${ACCEPTOR}" 表示验收员`),
    brief: z.string().optional().describe('队员：这件活是什么。制作人派活时写的原话'),
    report: z.string().optional().describe('验收员：制作人的交付说明'),
    how_to_play: z.string().optional().describe('验收员：怎么玩'),
    package_exe: z.string().optional().describe('验收员：打包出来的 exe（有的话）')
  })

  const joinTool = defineTool<typeof joinInput, unknown>({
    name: 'team_join',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description:
      '外部团队的队员或验收员进门：第一步就调它，不带 team_seat。' +
      `它返回你的通行证（${TEAM_SEAT_ARG}），之后每次调用都带上：写操作记在你名下、带文件锁。` +
      '队员干完调 team_report，验收员判完调 team_verdict。同一个队员接下一件活时带着原来的通行证再进门。',
    input: joinInput,
    execute: async ({ team_id, member, brief, report, how_to_play, package_exe }) => {
      const prior = presented()
      sameTeam(prior, team_id.trim())
      const record = await openRecord(team_id.trim())
      const store = deps.storeFor(record.id)
      const { workspaceDir } = deps.registry.dirsFor(record.id)
      const asAcceptor = member.trim().toLowerCase() === ACCEPTOR

      // 混合团队的队员是盒子里的子 Agent，制作人用 team_send 派活；客户端里再起一个同名的就是两份记忆、两本账
      if (record.members === 'box' && !asAcceptor) {
        throw new Error(
          `团队 ${record.id} 的队员由盒子托管，不用 team_join 进门。制作人用 team_send 给「${member.trim()}」派活`
        )
      }

      if (asAcceptor) {
        if (prior?.role === 'member' || (!prior && !shared && servedAsMember)) {
          throw new Error(
            `${prior ? '这张通行证' : '这条连接'}干过队员的活，不能再当验收员。` +
              `制作人另起一个 ${ACCEPTOR_AGENT} 子 Agent，它进门时不带 ${TEAM_SEAT_ARG}`
          )
        }
        if (prior?.closed) {
          throw new Error(
            `这张通行证已经记过结论。再验收另起一个 ${ACCEPTOR_AGENT}，进门时不带 ${TEAM_SEAT_ARG}`
          )
        }
        if (!report?.trim() || !how_to_play?.trim()) {
          throw new Error('验收员进门要带上制作人的交付说明（report）和怎么玩（how_to_play）')
        }
        await deps.registry.startAcceptance(record.id)
        const b: Binding = prior ?? {
          seat: newSeatId(record.id),
          role: 'acceptor',
          teamId: record.id,
          createdAt: now()
        }
        if (!prior) await saveSeat(b)
        enter(b, Boolean(prior))
        return {
          text: [
            seatNote(b.seat),
            '',
            buildExternalAcceptancePrompt({
              objective: record.objective,
              ...(record.latestRequest ? { latestRequest: record.latestRequest } : {}),
              report,
              howToPlay: how_to_play,
              ...(record.projectPath ? { projectPath: record.projectPath } : {}),
              ...(package_exe ? { packageExe: package_exe } : {})
            })
          ].join('\n'),
          details: { teamId: record.id, role: 'acceptor', seat: b.seat }
        }
      }

      if (prior && prior.role !== 'member') {
        throw new Error(`这张通行证是${roleLabel(prior, shared)}的，当不了队员`)
      }
      if (prior?.jobId) {
        throw new Error(`这张通行证手上还有活（${prior.jobId}），先 team_report`)
      }
      const found = await store.findMember(member)
      if (!found) {
        const roster = await store.roster()
        throw new Error(
          `团队里没有「${member}」。现有：${roster.map((m) => m.name).join('、') || '（无）'}；制作人先 team_hire`
        )
      }
      if (prior?.member && prior.member.name !== found.name) {
        throw new Error(
          `这张通行证是「${prior.member.name}」的。以「${found.name}」进门不带 ${TEAM_SEAT_ARG}`
        )
      }
      if (!brief?.trim()) throw new Error('队员进门要带上这件活的说明（brief）')
      const job = await store.startJob(found.name, brief)
      servedAsMember = true
      const b: Binding = prior ?? {
        seat: newSeatId(record.id),
        role: 'member',
        teamId: record.id,
        createdAt: now()
      }
      b.member = found
      b.owner = memberOwner(record.id, found.name, job.id)
      b.jobId = job.id
      b.brief = brief
      b.ledger = new WriteLedger()
      b.wrote = false
      await saveSeat(b)
      enter(b, Boolean(prior))

      const inbox = await store.takeInbox(found.name)
      const recent = (await store.jobs())
        .filter((j) => j.member === found.name && j.outcome === 'done' && j.report)
        .slice(-RECENT_REPORTS)
      return {
        text: [
          seatNote(b.seat),
          '',
          buildExternalMemberFraming({
            teamId: record.id,
            name: found.name,
            persona: found.persona,
            workspaceDir,
            readOnly: found.readOnly
          }),
          '',
          `<assignment job="${job.id}">`,
          brief,
          '</assignment>',
          ...(recent.length
            ? [
                '',
                '你最近交回的几件活：',
                ...recent.map((j) => `- ${j.id} ${j.brief}：${j.report}`)
              ]
            : []),
          ...(inbox.length ? ['', formatMail('给你的留言：', inbox)] : []),
          '',
          renderBoard(await store.board())
        ].join('\n'),
        details: {
          teamId: record.id,
          role: 'member',
          member: found.name,
          jobId: job.id,
          seat: b.seat
        }
      }
    }
  })

  // ── 交回、验收 ────────────────────────────────────────────────────────

  const reportInput = z.object({
    report: z
      .string()
      .min(1)
      .describe('一段话：做了什么、证据（路径、截图、试玩结论）、还剩什么、制作人要知道什么')
  })

  const reportTool = defineTool<typeof reportInput, unknown>({
    name: 'team_report',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description: '队员交回这件活。改过东西的话盒子存一份工程快照，然后放掉你占着的文件。',
    input: reportInput,
    execute: async ({ report }) => {
      const b = need('member')
      const name = b.member?.name ?? ''
      const store = deps.storeFor(b.teamId)
      const writes = b.ledger?.list().filter((entry) => entry.state === 'done') ?? []
      // 写操作明细只在内存里：盒子中途重启过的话明细是空的，但通行证上记着写过
      const wrote = writes.length > 0 || Boolean(b.wrote)
      const jobId = b.jobId
      if (jobId) await store.finishJob(jobId, { outcome: 'done', report })
      await store
        .recordActivity({
          who: name,
          what: (b.brief ?? '').split('\n').find((line) => line.trim()) ?? '',
          writes: writes.length ? summarizeDoneWrites(writes) : '',
          ...(getTargetProjectPath() ? { project: getTargetProjectPath() } : {})
        })
        .catch(() => undefined)

      let snapshotLine = ''
      if (deps.snapshots && wrote) {
        try {
          const snapshot = await deps.snapshots.save(
            snapshotMessage(name, firstSentence(report) || (b.brief ?? ''))
          )
          snapshotLine = snapshot
            ? `【快照】已存 ${snapshot.id}（${snapshot.message}）`
            : '【快照】这次没存：团队还没有工程路径。请制作人用 team_open 带上 team_id 和 project_path 补上'
        } catch (error) {
          snapshotLine = `【快照】这次没存上：${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (b.owner) releaseAll(b.owner)
      delete b.owner
      delete b.jobId
      delete b.brief
      delete b.ledger
      delete b.wrote
      await saveSeat(b).catch(() => undefined)
      leave(b)
      return {
        text: [
          `已交回 ${jobId ?? ''}。`,
          writes.length
            ? `写操作：${summarizeDoneWrites(writes)}`
            : wrote
              ? '写操作：有（盒子中途重启过，明细没留下）。'
              : '这件活没有写操作。',
          ...(snapshotLine ? [snapshotLine] : []),
          `这张通行证手上没活了；接下一件活时带着它（${TEAM_SEAT_ARG}）重新 team_join。`
        ].join('\n'),
        details: { jobId, writes: writes.length }
      }
    }
  })

  const verdictInput = z.object({
    verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']),
    reason: z
      .string()
      .min(1)
      .describe('PASS：玩了什么、看到了什么；FAIL：哪里不够，具体到能照着修；BLOCKED：为什么没法判')
  })

  const verdictTool = defineTool<typeof verdictInput, unknown>({
    name: 'team_verdict',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description: '验收员记下结论。只有这里记下的才算数；之后工程再有改动，PASS 自动作废。',
    input: verdictInput,
    execute: async ({ verdict, reason }) => {
      const b = need('acceptor')
      const kind = verdict === 'PASS' ? 'pass' : verdict === 'BLOCKED' ? 'blocked' : 'fail'
      // 结论只记在 external.json：虚幻盒子的团队事件账里没有「验收」这一类
      const record = await deps.registry.recordVerdict(b.teamId, { kind, reason })
      // 每次的结论记进团队事件，任务板的往来记录里一条一条看得到（同盒子里的团队）
      await deps
        .storeFor(b.teamId)
        .recordEvent({ kind: 'verdict', verdict: kind })
        .catch(() => undefined)
      b.closed = true
      await saveSeat(b).catch(() => undefined)
      leave(b)
      return {
        text: `已记下：VERDICT: ${verdict} — ${reason}\n（第 ${record.state.deliveries} 次验收）`,
        details: gateFacts(record)
      }
    }
  })

  // ── 名册、留言 ────────────────────────────────────────────────────────

  const hireInput = z.object({
    name: z.string().min(1).max(40).describe('队员名。同名再招一次就是改它的设定'),
    role: z
      .string()
      .min(1)
      .describe(
        '它的人设和职责，由你来写。它只知道这里写的、你派给它的、以及工作区和任务板上的东西'
      ),
    namespaces: z
      .array(z.string())
      .optional()
      .describe(`只给它这些命名空间的工具；省略 = 全套。可选：${deps.namespaces.join(', ')}`),
    read_only: z.boolean().optional().default(false).describe('只读：盒子拒绝它的写操作'),
    role_type: z
      .string()
      .max(20)
      .optional()
      .describe('岗位的粗类型，如 策划、搭建、美术、程序、审核')
  })

  const hireTool = defineTool<typeof hireInput, TeamMember>({
    name: 'team_hire',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description:
      `在名册上登记一个队员，或者改一个已有队员的设定。登记不会让它开工：要它干活就起一个 ${MEMBER_AGENT} 子 Agent，` +
      '告诉它团队 id、它的名字和这件活。',
    input: hireInput,
    execute: async ({ name, role, namespaces, read_only, role_type }) => {
      const b = need('producer')
      const trimmed = name.trim()
      if ([PRODUCER, ACCEPTOR].includes(trimmed.toLowerCase())) {
        throw new Error(`"${trimmed}" 是保留的名字，换一个`)
      }
      if (namespaces?.length) {
        const unknown = namespaces.filter((ns) => !deps.namespaces.includes(ns))
        if (unknown.length) {
          throw new Error(
            `没有这些命名空间：${unknown.join(', ')}。可选：${deps.namespaces.join(', ')}`
          )
        }
      }
      const store = deps.storeFor(b.teamId)
      const existing = await store.findMember(trimmed)
      const roleType = role_type?.trim() || existing?.roleType
      const member: TeamMember = {
        name: existing?.name ?? trimmed,
        persona: role,
        tier: existing?.tier ?? 'strong',
        ...(roleType ? { roleType } : {}),
        ...(namespaces?.length ? { namespaces } : {}),
        readOnly: Boolean(read_only),
        hiredAt: existing?.hiredAt ?? now()
      }
      await store.putMember(member)
      const roster = await store.roster()
      return {
        text:
          `${existing ? '已更新' : '已登记'} ${member.name}${member.readOnly ? '（只读）' : ''}。` +
          `\n团队现在 ${roster.length} 人：${roster.map((m) => m.name).join('、')}` +
          `\n派活：起一个 ${MEMBER_AGENT} 子 Agent，告诉它 team_id=${b.teamId}、member=${member.name} 和这件活。`,
        details: member
      }
    }
  })

  const messageInput = z.object({
    to: z.string().min(1).describe(`收件人：队员名，或者 "${PRODUCER}" 表示制作人`),
    text: z.string().min(1).describe('要说的话。对方看不到你的对话，需要的背景写进来'),
    reply_to: z.string().optional().describe('在回哪一条留言（m 编号）')
  })

  const messageTool = defineTool<typeof messageInput, unknown>({
    name: 'team_message',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '给队友或制作人留言：交接、提问、提醒对方你改了什么。**它不派活** —— 对方下次 team_join 或 team_inbox 时才看到。',
    input: messageInput,
    execute: async ({ to, text, reply_to }) => {
      const b = need()
      const store = deps.storeFor(b.teamId)
      const from = mailName(b)
      let target = PRODUCER
      if (to.trim().toLowerCase() !== PRODUCER) {
        const member = await store.findMember(to)
        if (!member) {
          const roster = await store.roster()
          throw new Error(
            `团队里没有「${to}」。现有：${roster.map((m) => m.name).join('、') || '（无）'}；给制作人用 "${PRODUCER}"`
          )
        }
        target = member.name
      }
      if (target.toLowerCase() === from.toLowerCase()) throw new Error('不用给自己留言')
      const mail = await store.post(from, target, text, reply_to)
      return {
        text: `已留言 ${mail.id} 给 ${target === PRODUCER ? '制作人' : target}。`,
        details: mail
      }
    }
  })

  const inboxTool = defineTool<z.ZodObject<Record<string, never>>, unknown>({
    name: 'team_inbox',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description: '取出给你的新留言（取过的不会再出现）。',
    input: z.object({}),
    execute: async () => {
      const b = need()
      const mails = await deps.storeFor(b.teamId).takeInbox(mailName(b))
      return {
        text: mails.length ? formatMail('给你的留言：', mails) : '没有新留言。',
        details: mails
      }
    }
  })

  // ── 只读的公共视图 ────────────────────────────────────────────────────

  const listTool = defineTool<z.ZodObject<Record<string, never>>, unknown>({
    name: 'team_list',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'parallel',
    description: '列出外部团队：id、目标、工程、验收结论。',
    input: z.object({}),
    execute: async () => {
      const teams = (await deps.registry.list()).map((record) => ({
        ...gateFacts(record),
        projectPath: record.projectPath ?? null,
        createdAt: record.createdAt
      }))
      return {
        text: teams.length
          ? teams
              .map(
                (t) =>
                  `- ${t.teamId}${t.ended ? '（已结束）' : ''} ${t.objective}` +
                  (t.projectPath ? ` @ ${t.projectPath}` : '') +
                  `；验收：${t.passed ? '通过' : (t.verdict ?? '未验')}`
              )
              .join('\n')
          : '还没有外部团队。',
        details: { teams }
      }
    }
  })

  const gateInput = z.object({
    team_id: z.string().optional().describe('不给就是这条连接所在的团队'),
    phase: z
      .enum(['check', 'stop', 'round'])
      .optional()
      .default('check')
      .describe(
        'check = 只看（默认）；stop = 收工检查放行了，混合团队的制作人从「在跑」上摘下来；round = 用户发了新消息'
      ),
    latest_request: z.string().optional().describe('phase=round 时：用户刚说的那句话')
  })

  const gateTool = defineTool<typeof gateInput, ExternalGateFacts>({
    name: 'team_gate',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '交付闸的现状：最近一次验收结论、之后有没有再改过工程、算不算已经过了验收，混合团队还有后台的活和没看的话。给收尾检查（hook）用。',
    input: gateInput,
    execute: async ({ team_id, phase, latest_request }) => {
      const id = team_id?.trim() || current.getStore()?.binding?.teamId
      if (!id) throw new Error('给 team_id')
      let record = await deps.registry.get(id)
      if (!record) throw new Error(`没有这个外部团队：${id}`)
      if (phase === 'stop' && record.members === 'box') await deps.hybrid?.stop(id)
      let carryOver = ''
      if (phase === 'round') {
        // 上一轮留下没动的「进行中 / 卡住」摆给制作人看（同盒子里开局的旧账），再开新一轮
        const since = record.state.roundStartedAt
        const latest = latest_request?.trim().slice(-LATEST_REQUEST_MAX)
        if (since !== undefined) {
          carryOver = formatBoardCarryOver(
            carryOverTasks(await deps.storeFor(id).board(), since),
            now()
          )
        }
        record = await deps.registry.update(id, (r) => ({
          ...r,
          state: startTeamRound(r.state, now()),
          ...(latest && r.members === 'box' ? { latestRequest: latest } : {})
        }))
        deps.hybrid?.update(record)
      }
      const live = record.members === 'box' ? await deps.hybrid?.facts(id) : undefined
      const facts = { ...gateFacts(record), ...live }
      if (phase === 'round') return { text: carryOver || '新一轮已记下。', details: facts }
      return {
        text: facts.passed
          ? '已过验收，之后没有改动。'
          : facts.verdict === 'pass'
            ? '验收过了，但之后又改过工程，要重新验。'
            : facts.verdict
              ? `最近一次验收：${facts.verdict}。`
              : '还没验收过。',
        details: facts
      }
    }
  })

  // 任务板、现状要按团队现造：工具的说明和参数和团队无关，执行时才知道是哪个团队的账
  const unbound = {} as TeamStore
  const board = createBoardTool(unbound) as unknown as UnrealAgentTool<never>
  const boardTool = {
    ...board,
    execute: (callId, params, signal, onUpdate) =>
      (createBoardTool(deps.storeFor(need().teamId)) as unknown as UnrealAgentTool<never>).execute(
        callId,
        params,
        signal,
        onUpdate
      )
  } as UnrealAgentTool<never>

  const status = createStatusTool({
    store: unbound,
    sessionId: ''
  }) as unknown as UnrealAgentTool<never>
  const statusTool = {
    ...status,
    execute: (callId, params, signal, onUpdate) => {
      const b = need()
      return (
        createStatusTool({
          store: deps.storeFor(b.teamId),
          sessionId: b.teamId,
          ...(deps.snapshots ? { snapshots: deps.snapshots } : {})
        }) as unknown as UnrealAgentTool<never>
      ).execute(callId, params, signal, onUpdate)
    }
  } as UnrealAgentTool<never>

  const tools = [
    openTool,
    joinTool,
    reportTool,
    verdictTool,
    hireTool,
    messageTool,
    inboxTool,
    listTool,
    gateTool
  ] as unknown as UnrealAgentTool<never>[]
  tools.push(boardTool, statusTool)
  if (deps.snapshots) {
    tools.push(createSnapshotTool(deps.snapshots) as unknown as UnrealAgentTool<never>)
  }

  return {
    tools,
    guard: (all) => all.map(guardOne),
    binding: () => {
      const b = boundSeat ? seats.get(boundSeat) : undefined
      return b instanceof Promise ? undefined : b
    },
    producerTeam: () => {
      const b = current.getStore()?.binding
      return b && b.role === 'producer' && !inactive(b) ? b.teamId : undefined
    },
    async dispose() {
      const b = !shared && boundSeat ? seats.get(boundSeat) : undefined
      boundSeat = undefined
      // 这条连接上的锁都放掉：连接断了，在它上面干活的子 Agent 多半也没了。还在的话下次写时重新上锁
      for (const seat of usedHere) {
        const live = seats.get(seat)
        if (live && !(live instanceof Promise) && live.owner) releaseAll(live.owner)
      }
      // 按连接认人的那件活收成「停下」。调用方亲手带过通行证的不收：它换条连接还会接着干
      if (!b || b instanceof Promise || b.viaPass || b.role !== 'member' || !b.jobId) return
      await deps
        .storeFor(b.teamId)
        .finishJob(b.jobId, { outcome: 'stopped', reason: '连接断开了，没有 team_report' })
        .catch(() => undefined)
      delete b.owner
      delete b.jobId
      delete b.brief
      delete b.ledger
      delete b.wrote
      await saveSeat(b).catch(() => undefined)
    }
  }
}
