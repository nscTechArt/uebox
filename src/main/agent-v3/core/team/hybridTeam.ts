/**
 * 混合团队的宿主：制作人在外部客户端（Claude Code），队员是盒子里的子 Agent。
 *
 * 设计稿：docs/混合团队设计-2026-10-24.md 第 2 节。
 *
 * ## 为什么队员和盒子里的 `/team` 一模一样
 *
 * 队员只要一个父 `SessionContext`（`runSubAgent(parent, {member})`），不需要盒子侧有制作人的回合。
 * 宿主就造这么一个父上下文：`sessionId` 是团队 id，带 `team`、`pacedRequests`、工程和运行信息，
 * **不带 `externalClient`**（它会改队员的提示词和工具）。派活、记忆、插话、编辑器排队、锁、快照、
 * 用量、履历、体检全用盒子里那套 `createTeamTools`，一行不改。
 *
 * ## 为什么是进程级、每队一个
 *
 * MCP 会话闲 5 分钟就被回收（`McpServerHost.ts`），Claude Code 再连上来是一条新会话。
 * 队员手上的活、排队的顺序（`createTeamTools` 里的 BusyMap）、谁在跑（`TeamLive`）都不能跟着
 * 会话走，所以挂在进程上，按团队 id 找。后台的活用宿主自己的中止控制器：Claude Code 取消一次
 * 调用，跑到一半的队员不跟着死。团队结束（界面上点结束）才停。
 *
 * ## 制作人的信箱
 *
 * 盒子里的制作人正在跑时，队员交活、提问、崩溃通知会插进它的下一步（`steer`）。外部制作人没法
 * 插，就由宿主以制作人的名义登记在 `TeamLive` 上，插进来的话先进缓冲，附在制作人下一次调用
 * 团队工具的结果后面，或者由 `team_wait` 取走。
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'

import type { UnrealAgentTool } from '../../tools/defineTool'
import type { ApprovalDeps, ApprovalVerdict } from '../approval'
import type { SessionContext } from '../createAgent'
import { projectPathKey } from '../projectPathKey'
import type { RuntimeEnvelope } from '../runtimeEnvelope'
import { buildCrashNotice, type EditorWatchEvent } from './editorWatch'
import type { TeamToolDeps } from './teamTools'
import type { ExternalTeamRecord } from './externalTeam'
import type { TeamSnapshots } from './snapshots'
import { createTeamLive, type TeamLive } from './teamLive'
import type { TeamModels } from './teamModels'
import { PRODUCER, type TeamStore } from './teamStore'
import { createTeamTools, formatMail } from './teamTools'
import { describePendingJobs } from './teamWait'

/**
 * `team_send` 带 `wait: true` 时最多等多久。超过就回来，叫制作人用 `team_wait`。
 *
 * 卡在 5 分钟以内：Claude Code 对 HTTP 的 MCP 调用有个 5 分钟的「没动静就掐」（进度通知能续，
 * 但它发不发 progressToken 文档没写），单次请求默认又只等 60 秒（要把服务器的 `timeout` 调大）
 */
export const HYBRID_SEND_WAIT_MS = 280_000

/**
 * 队员的审批交给制作人时（`approval_mode: 'producer'`），等制作人答复最多多久。到点按拒绝处理：
 * 队员不能无限期挂着，制作人可能正在一次很长的思考里
 */
export const PRODUCER_APPROVAL_WAIT_MS = 10 * 60_000

/** 审批请求里参数原文最多给制作人看多少字 */
const APPROVAL_ARGS_SHOWN = 1500

/** `team_wait` 最多等多久 */
export const HYBRID_WAIT_MAX_MS = 600_000

/** 等的时候隔多久报一次进度。客户端靠进度判断这次调用还活着（Claude Code 闲 5 分钟就掐） */
const HEARTBEAT_MS = 30_000

/** 「谁在跑」的变化合并成一次通知，同 `ipc/agentV3.ts` 的 `TEAM_LIVE_COALESCE_MS` */
const LIVE_COALESCE_MS = 120

/**
 * 父上下文里由环境决定的那些事实：机器、用户设置、此刻的引擎。宿主在外面再补团队那几项。
 *
 * 一项一项对着盒子里那一轮的 ctx（`ipc/agentV3.ts` 的 `executeAgent`）写：队员的工具和提示词
 * 只认这些。那边有、这里没有的（审批通道、提问、换归属、轮内体检、用量回调）都只给主会话，
 * 子 Agent 拿不到，所以不影响队员。一致性测试守着这一条（`hybridTeam.test.ts`）
 */
export interface HybridEnvironment {
  shellAvailable: boolean
  userInstructions: string
  uiLanguage: 'zh-CN' | 'en-US'
  experienceHome?: string
  mcp?: SessionContext['mcp']
  sender?: SessionContext['sender']
  editorScreenshotEnabled: boolean
  /** 这件活开工时引擎连没连着团队的工程 */
  ueConnected: boolean
  project?: SessionContext['project']
  /** 团队记着的工程：盒子里的团队在哪个工程下开，队员看到的就是哪个 */
  sessionProject?: SessionContext['sessionProject']
  outOfScopeProjects?: string[]
  runtime: RuntimeEnvelope
}

export function hybridParentContext(env: HybridEnvironment): Omit<SessionContext, 'sessionId'> {
  return {
    ueConnected: env.ueConnected,
    shellAvailable: env.shellAvailable,
    ...(env.project ? { project: env.project } : {}),
    ...(env.sessionProject ? { sessionProject: env.sessionProject } : {}),
    ...(env.outOfScopeProjects?.length ? { outOfScopeProjects: env.outOfScopeProjects } : {}),
    mode: 'agent',
    fastMode: false,
    skillLearning: 'ask',
    editorScreenshotEnabled: env.editorScreenshotEnabled,
    userInstructions: env.userInstructions,
    ...(env.experienceHome ? { experienceHome: env.experienceHome } : {}),
    uiLanguage: env.uiLanguage,
    modelRequest: { role: 'agent', agentType: 'agent-v3' },
    ...(env.sender ? { sender: env.sender } : {}),
    ...(env.mcp ? { mcp: env.mcp } : {}),
    runtime: env.runtime
  }
}

/** 一件活要的那份父上下文，和它该跑在哪些执行流上下文里 */
export interface HybridJobScope {
  parent: Omit<SessionContext, 'sessionId'>
  /** 在这件活自己的执行流上下文里跑（运行时作用域、目标工程） */
  run: <T>(fn: () => Promise<T>) => Promise<T>
}

export interface HybridTeamDeps {
  store: TeamStore
  snapshots?: TeamSnapshots
  models?: TeamModels
  /** 招人时能选的工具命名空间 */
  namespaces: string[]
  /**
   * 每件活现算一份父上下文。宿主在上面补团队那几项（`sessionId`、`team`、`pacedRequests`、
   * 思考档位、审批档位），其余（工程、引擎、运行信息、技能、MCP……）由它给
   */
  jobScope: (record: ExternalTeamRecord) => Promise<HybridJobScope>
  /** 团队工具的调用跑在哪些执行流上下文里（编辑器钥匙、截图档、目标工程） */
  runTool: <T>(record: ExternalTeamRecord, fn: () => Promise<T>) => Promise<T>
  /** 造跑队员、跑验收的那两件。默认 `createTeamRunners`；测试换成假的 */
  runners: (parentOf: () => SessionContext) => Pick<TeamToolDeps, 'runMember' | 'runAcceptance'>
  /** 有队员写了工程：之前的验收作废（`ExternalTeamRegistry.noteWrite`） */
  noteWrite: (teamId: string) => Promise<void>
  /** 名册、任务板、谁在跑变了：界面重读 */
  onChange?: () => void
  /** 队员的一条动态：界面当场显示 */
  onActivity?: Parameters<typeof createTeamLive>[2]
  /**
   * 队员的审批找谁批。混合团队没有盒子侧的对话，确认框弹在盒子主窗口上（应用级的那张卡）。
   * 不给 = 没人能批：除了 yolo，要问的一律按拒绝（审批门的规矩）
   */
  requestApproval?: ApprovalDeps['request']
  /** 交给制作人的审批等多久按拒绝处理。默认 `PRODUCER_APPROVAL_WAIT_MS`，测试改短 */
  approvalTimeoutMs?: number
  /**
   * 看护编辑器：团队的工程崩了自动重开（`ipc/teamEditorWatch.ts`）。宿主活着就一直看着，
   * 经过记进团队的账、告诉制作人。返回停掉看护的函数
   */
  watchEditor?: (
    isOurs: (projectDir: string) => boolean,
    onEvent: (event: EditorWatchEvent) => void
  ) => () => void
  now?: () => number
}

export interface HybridTeamHost {
  readonly teamId: string
  readonly store: TeamStore
  readonly live: TeamLive
  /** 记录变了（补工程路径、用户新说的话）：之后的活按新的来 */
  update(record: ExternalTeamRecord): void
  /** 调盒子里的一个团队工具（`team_hire`、`team_board`……），在团队的执行流上下文里 */
  call(
    name: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partial: AgentToolResult<unknown>) => void
  ): Promise<AgentToolResult<unknown>>
  /** 派活。一律放到后台；`wait` 时最多等 `HYBRID_SEND_WAIT_MS` 看它交回 */
  send(
    input: { to: string; message: string; wait?: boolean },
    signal?: AbortSignal,
    report?: (text: string) => void
  ): Promise<string>
  /** 等下一个消息：有就立刻回，没有就最多等 `ms` */
  wait(ms: number, signal?: AbortSignal, report?: (text: string) => void): Promise<string>
  /** 取走制作人信箱里还没看的。没有给空串 */
  drain(): Promise<string>
  /**
   * 制作人收工了（Claude Code 的 Stop hook 放行）：从「谁在跑」上摘下来，之后给它的话进信箱，
   * 等它的队员会被告知「它没在跑」。制作人下一次调团队工具时自动挂回来（`resume`）
   */
  pause(): Promise<void>
  resume(): void
  /**
   * 制作人答复一条审批（`team_approve`）。`note` 当场插给那个队员。
   * 没有这条（答过、超时、编号错）就抛
   */
  approve(id: string, allow: boolean, note?: string): Promise<string>
  /** 交付闸要的两件事：还有几件后台的活、制作人还有几条没看的话 */
  gateFacts(): Promise<{ pendingJobs: number; unreadForProducer: number }>
  /** 团队结束：停掉后台的活，从「谁在跑」上摘掉制作人 */
  dispose(): Promise<void>
}

export async function createHybridTeamHost(
  initial: ExternalTeamRecord,
  deps: HybridTeamDeps
): Promise<HybridTeamHost> {
  // 结束的团队不再拉起宿主：制作人那条连接上还认得这张通行证，再调一次工具不能把队员救活
  if (initial.endedAt !== undefined) throw new Error(`团队 ${initial.id} 已经结束了`)
  const now = deps.now ?? Date.now
  let record = initial
  const { store } = deps
  await store.ensure()
  // 上次没交回的活（盒子关了、崩了）不会再交回来了；不收掉，界面上会一直挂着「正在写」
  await store.closeOpenJobs('上次运行中断，这件活没有交回').catch(() => undefined)

  let liveTimer: ReturnType<typeof setTimeout> | null = null
  const live = createTeamLive(
    store,
    () => {
      if (liveTimer || !deps.onChange) return
      liveTimer = setTimeout(() => {
        liveTimer = null
        deps.onChange?.()
      }, LIVE_COALESCE_MS)
    },
    deps.onActivity
  )

  // 制作人信箱：插给制作人的话先进这里
  const mailbox: string[] = []
  let wakers: Array<() => void> = []
  const wake = (): void => {
    const list = wakers
    wakers = []
    for (const w of list) w()
  }
  const attachProducer = (): (() => Promise<void>) =>
    live.attach(PRODUCER, {
      steer: (text) => {
        mailbox.push(text)
        wake()
      }
    })
  let detach: (() => Promise<void>) | undefined = attachProducer()

  const controller = new AbortController()
  /** 「本对话内都允许」记在团队上：几个队员、几件活共用，同盒子里一个对话一份 */
  const alwaysAllowed = new Set<string>()

  // 编辑器看护：只认团队此刻的工程，补了工程路径之后自然跟过去
  const stopWatch = deps.watchEditor?.(
    (projectDir) =>
      Boolean(record.projectPath) &&
      projectPathKey(record.projectPath) === projectPathKey(projectDir),
    (event) => {
      void store
        .recordEvent(
          event.kind === 'crashed'
            ? { kind: 'crashed', ...(event.reason ? { detail: event.reason.slice(0, 200) } : {}) }
            : event.kind === 'recovered'
              ? { kind: 'recovered' }
              : { kind: 'recoverFailed', detail: event.why.slice(0, 200) }
        )
        .catch(() => undefined)
      mailbox.push(buildCrashNotice(event))
      wake()
    }
  )

  // ── 制作人审批 ──
  // 档位是 producer（默认）时，队员要问的那几步（不可逆的删、覆盖、回滚这类）不弹盒子的确认框，
  // 进制作人信箱，由制作人用 team_approve 答。可撤销的改动照 auto-edit 直接做，不打扰制作人
  const approvals = new Map<string, { member: string; finish: (v: ApprovalVerdict) => void }>()
  let approvalSeq = 0
  const approvalWaitMs = deps.approvalTimeoutMs ?? PRODUCER_APPROVAL_WAIT_MS
  /** 队员子 Agent 的会话 id 是 `<团队>:mate-<名字>`（`runSubAgent`） */
  const memberOf = (sessionId: string): string => {
    const at = sessionId.indexOf(':mate-')
    return at >= 0 ? sessionId.slice(at + ':mate-'.length) : sessionId
  }
  const askProducer: ApprovalDeps['request'] = (req, signal) =>
    new Promise<ApprovalVerdict>((resolve) => {
      const id = `a${++approvalSeq}`
      const member = memberOf(req.sessionId)
      let settled = false
      const finish = (verdict: ApprovalVerdict): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        approvals.delete(id)
        resolve(verdict)
      }
      const onAbort = (): void => finish('reject')
      const timer = setTimeout(() => {
        finish('reject')
        const minutes = Math.round(approvalWaitMs / 60_000)
        mailbox.push(
          `[team approval ${id} · expired] ${member} 的 ${req.toolName} 等了 ${minutes} 分钟没等到答复，已按拒绝处理。`
        )
        wake()
        void live
          .send(
            PRODUCER,
            member,
            `你刚才的 ${req.toolName} 制作人 ${minutes} 分钟内没答复，按拒绝处理了。换个不需要批准的做法，或者在结论里写明要制作人批什么`
          )
          .catch(() => undefined)
      }, approvalWaitMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      approvals.set(id, { member, finish })
      let args = ''
      try {
        args = JSON.stringify(req.args) ?? ''
      } catch {
        args = String(req.args)
      }
      mailbox.push(
        [
          `[team approval ${id} · from ${member}] This is not the user speaking.`,
          `${member} wants to run \`${req.toolName}\` (${req.risk}) and is waiting for your decision:`,
          args.length > APPROVAL_ARGS_SHOWN ? `${args.slice(0, APPROVAL_ARGS_SHOWN)}…` : args,
          `Answer with team_approve {"id": "${id}", "allow": true|false, "note": optional}. ` +
            `No answer within ${Math.round(approvalWaitMs / 60_000)} minutes counts as denied.`
        ].join('\n')
      )
      wake()
    })

  // 默认全放行（yolo）：团队模式里由模型自己判断，不拿每一步去打扰人或制作人
  const producerDecides = (): boolean => record.approvalMode === 'producer'

  const parentOf = (scope: HybridJobScope): SessionContext => ({
    ...scope.parent,
    sessionId: record.id,
    approvalMode: producerDecides()
      ? 'auto-edit'
      : ((record.approvalMode ?? 'yolo') as Exclude<
          NonNullable<typeof record.approvalMode>,
          'producer'
        >),
    alwaysAllowed,
    ...(producerDecides()
      ? { requestApproval: askProducer }
      : deps.requestApproval
        ? { requestApproval: deps.requestApproval }
        : {}),
    thinkingLevel: record.thinkingLevel ?? 'auto',
    pacedRequests: true,
    team: {
      objective: record.objective,
      ...(record.latestRequest ? { latestRequest: record.latestRequest } : {}),
      store,
      live,
      ...(deps.snapshots ? { snapshots: deps.snapshots } : {})
    }
  })

  /** 写过工程的活交回（含停下）：之前的验收不算数了 */
  const noteWrites = async (ledger: { list: () => Array<{ state: string }> }): Promise<void> => {
    if (ledger.list().some((entry) => entry.state === 'done')) {
      await deps.noteWrite(record.id).catch(() => undefined)
    }
  }

  const tools = new Map<string, UnrealAgentTool<unknown>>(
    createTeamTools(
      {
        store,
        objective: record.objective,
        namespaces: deps.namespaces,
        sessionId: record.id,
        live,
        ...(deps.snapshots ? { snapshots: deps.snapshots } : {}),
        ...(deps.models ? { models: deps.models } : {}),
        runMember: async (input) => {
          try {
            const scope = await deps.jobScope(record)
            const parent = parentOf(scope)
            return await scope.run(() => deps.runners(() => parent).runMember(input))
          } finally {
            await noteWrites(input.ledger)
          }
        },
        runAcceptance: async (input) => {
          const scope = await deps.jobScope(record)
          const parent = parentOf(scope)
          return scope.run(() => deps.runners(() => parent).runAcceptance(input))
        }
      },
      now
    ).map((tool): [string, UnrealAgentTool<unknown>] => [
      tool.name,
      tool as unknown as UnrealAgentTool<unknown>
    ])
  )

  let callSeq = 0
  const call: HybridTeamHost['call'] = (name, params, signal, onUpdate) => {
    const tool = tools.get(name)
    if (!tool) return Promise.reject(new Error(`团队工具里没有 ${name}`))
    return deps.runTool(record, () =>
      tool.execute(`hybrid-${record.id}-${++callSeq}`, params as never, signal, onUpdate)
    )
  }

  const drain: HybridTeamHost['drain'] = async () => {
    const steered = mailbox.splice(0)
    // 交到制作人手上了才算读到：回执、等回复的队员靠它
    if (steered.length) await live.consumed(PRODUCER, steered.join('\n'))
    const queued = await store.takeInbox(PRODUCER).catch(() => [])
    return [...steered, formatMail('【给你的留言】', queued)].filter(Boolean).join('\n\n')
  }

  /** 等到信箱里有东西（或 `ready` 说可以了）、到点或被取消。到点不是错 */
  const nextMail = (
    ms: number,
    signal?: AbortSignal,
    ready: () => boolean = () => mailbox.length > 0
  ): Promise<void> =>
    new Promise<void>((resolve) => {
      if (ready() || signal?.aborted) return resolve()
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        wakers = wakers.filter((w) => w !== done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener('abort', done, { once: true })
      wakers.push(done)
    })

  /** 等的时候按时报一声「还在等谁」，客户端不至于当它卡死 */
  const heartbeat = (report?: (text: string) => void): (() => void) => {
    if (!report) return () => undefined
    const timer = setInterval(() => {
      const pending = live.pendingJobs()
      report(pending.length ? `还在等：${describePendingJobs(pending, now())}` : '还在等…')
    }, HEARTBEAT_MS)
    return () => clearInterval(timer)
  }

  return {
    teamId: record.id,
    store,
    live,

    update(next) {
      record = next
    },

    call,

    async send({ to, message, wait }, signal, report) {
      // 后台跑，用宿主自己的中止信号：客户端取消这次调用不该杀掉跑到一半的队员。
      // 进度不往这次调用上推（调用早就结束了），动态走 `TeamLive.note` 进任务板
      const dispatched = await call('team_send', { to, message, wait: false }, controller.signal)
      const name = (dispatched.details as { dispatched?: string } | undefined)?.dispatched ?? to
      if (!wait) return `已派给 ${name}，在后台干。用 team_wait 等它交回。`

      const deadline = now() + HYBRID_SEND_WAIT_MS
      const busy = (): boolean =>
        live.pendingJobs().some((job) => job.member.toLowerCase() === name.toLowerCase())
      const stop = heartbeat(report)
      // 有审批在等就先回来：队员正等着制作人批一步，制作人卡在这里等它交活就成了互等
      const gotMail = (): boolean => approvals.size > 0
      try {
        while (busy() && !gotMail() && !signal?.aborted && now() < deadline) {
          const local = new AbortController()
          const stopLocal = (): void => local.abort()
          signal?.addEventListener('abort', stopLocal, { once: true })
          try {
            await Promise.race([
              live.nextSettle(deadline - now(), local.signal).catch(() => undefined),
              nextMail(deadline - now(), local.signal, gotMail)
            ])
          } finally {
            local.abort()
            signal?.removeEventListener('abort', stopLocal)
          }
        }
      } finally {
        stop()
      }
      if (!busy()) return `${name} 交回了，结论在下面。`
      return gotMail()
        ? `${name} 还在干，有审批在等你答复（在下面），答完用 team_wait 接着等。`
        : `已派给 ${name}。${Math.round(HYBRID_SEND_WAIT_MS / 1000)} 秒内还没交回，它接着在后台干；用 team_wait 等。`
    },

    async wait(ms, signal, report) {
      const waitMs = Math.min(Math.max(ms, 0), HYBRID_WAIT_MAX_MS)
      const first = await drain()
      if (first) return first
      if (live.pendingJobs().length === 0) return '没有在干的活，也没有新消息。'
      const stop = heartbeat(report)
      try {
        await nextMail(waitMs, signal)
      } finally {
        stop()
      }
      const got = await drain()
      if (got) return got
      const pending = live.pendingJobs()
      return pending.length
        ? `${Math.round(waitMs / 1000)} 秒内没有新消息。还在干：${describePendingJobs(pending, now())}。`
        : '没有在干的活，也没有新消息。'
    },

    drain,

    async pause() {
      const off = detach
      detach = undefined
      await off?.()
    },

    resume() {
      detach ??= attachProducer()
    },

    async approve(id, allow, note) {
      const pending = approvals.get(id.trim())
      if (!pending) {
        throw new Error(
          `没有在等答复的审批「${id}」：可能已经答过或超时了。` +
            (approvals.size
              ? `还在等的：${[...approvals.keys()].join('、')}`
              : '现在没有在等的审批')
        )
      }
      // 审批门拒绝时那句话说的是「用户拒绝」；这里是制作人拒的，跟队员说清楚，免得它去等用户
      const say = note?.trim() || (allow ? '' : '这一步是制作人没准，换个不需要它的做法。')
      if (say) await live.send(PRODUCER, pending.member, say).catch(() => undefined)
      pending.finish(allow ? 'approve' : 'reject')
      return allow ? `已批准 ${pending.member} 的这一步。` : `已拒绝 ${pending.member} 的这一步。`
    },

    async gateFacts() {
      const queued = (await store.mail().catch(() => [])).filter(
        (m) => m.to === PRODUCER && !m.deliveredAt
      ).length
      return { pendingJobs: live.pendingJobs().length, unreadForProducer: mailbox.length + queued }
    },

    async dispose() {
      controller.abort(new Error('团队已结束'))
      for (const pending of [...approvals.values()]) pending.finish('reject')
      if (liveTimer) clearTimeout(liveTimer)
      stopWatch?.()
      wake()
      await detach?.()
      detach = undefined
    }
  }
}

// ── 进程里的宿主表 ──────────────────────────────────────────────────────

const hosts = new Map<string, Promise<HybridTeamHost>>()
const ready = new Map<string, HybridTeamHost>()

/**
 * 这个团队的宿主，没有就用 `create` 造一个。同一个团队并发要宿主时只造一次；
 * 造失败不留着，下次再试
 */
export function hybridTeamHost(
  teamId: string,
  create: () => Promise<HybridTeamHost>
): Promise<HybridTeamHost> {
  const existing = hosts.get(teamId)
  if (existing) return existing
  const pending = create().then((host) => {
    ready.set(teamId, host)
    return host
  })
  hosts.set(teamId, pending)
  pending.catch(() => {
    if (hosts.get(teamId) === pending) hosts.delete(teamId)
  })
  return pending
}

/** 已经起来的宿主。任务板读「谁在跑」用，不会因为读一下就把宿主拉起来 */
export function runningHybridTeam(teamId: string): HybridTeamHost | undefined {
  return ready.get(teamId)
}

/** 团队结束：停掉它的宿主。没有宿主什么都不做 */
export async function stopHybridTeam(teamId: string): Promise<void> {
  const host = hosts.get(teamId)
  hosts.delete(teamId)
  ready.delete(teamId)
  if (host) await (await host.catch(() => undefined))?.dispose()
}
