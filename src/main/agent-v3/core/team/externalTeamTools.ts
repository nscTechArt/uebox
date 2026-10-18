/**
 * 外部团队的工具，以及「这条连接是谁」的那道门。
 *
 * 设计稿：docs/外部大脑跑团队设计-2026-10-17.md 第 4、5 节。
 *
 * ## 一条 MCP 连接 = 一个角色
 *
 * 外部客户端（Claude Code）的制作人、每个队员、验收员各开一条 MCP 连接。连接进门时
 * 什么都不是；制作人调 `team_open`、队员和验收员调 `team_join` 之后，这条连接才绑成那个角色。
 * 之后这条连接上的**每一次**工具调用都过 `guard`：
 *
 * - 制作人、验收员：只放行只读工具（制作人另有团队工具）。和盒子里 `producerTools()` 同一个口径，
 *   规则台账里记过两次「制作人拿着写工具自己把游戏写完」。
 * - 队员：按名册上的只读设置和命名空间白名单收窄；套上自己的锁主（文件锁）和编辑器钥匙，
 *   和盒子里 `runMember` 的执行流一样；写操作记账，交回时据此存快照。
 * - 任何角色都不给 `task`：它跑的是盒子自己的模型，外部团队的前提就是盒子不花模型的钱。
 *
 * **没绑定的连接原样透传**：普通的外部会话（Codex、CLI）行为一点不变。
 * 盒子里的团队（`createTeamTools`）不经过这里。
 */

import { z } from 'zod'

import { defineTool, effectiveRisk, type UnrealAgentTool } from '../../tools/defineTool'
import { releaseAll, runWithLockOwner } from '../assetLock'
import {
  getTargetProjectPath,
  runWithTargetConnectionId,
  type TargetProjectRef
} from '../projectTargetContext'
import { summarizeDoneWrites, WriteLedger } from '../writeLedger'
import { runWithEditorKey } from './editorKey'
import {
  gateFacts,
  type ExternalGateFacts,
  type ExternalTeamRecord,
  type ExternalTeamRegistry
} from './externalTeam'
import {
  buildExternalAcceptancePrompt,
  buildExternalMemberFraming,
  buildExternalProducerBrief,
  MEMBER_AGENT
} from './externalTeamPrompt'
import { snapshotMessage, type TeamSnapshots } from './snapshots'
import { createStatusTool } from './teamStatus'
import { memberFileBase, PRODUCER, type TeamMember, type TeamStore } from './teamStore'
import { createBoardTool, createSnapshotTool, formatMail, renderBoard } from './teamTools'

/** 验收员进门时报的名字。队员不许叫这个（`team_hire` 里拦着） */
export const ACCEPTOR = 'acceptor'

/** 盒子自己的子任务。外部团队一律不给，见文件头 */
const TASK_TOOL = 'task'

/** 交回时附上这个队员最近几件活的报告，代替盒子里队员自带的记忆 */
const RECENT_REPORTS = 3

type Role = 'producer' | 'member' | 'acceptor'

interface Binding {
  role: Role
  teamId: string
  /** 队员：名册上的那一项 */
  member?: TeamMember
  /** 队员：锁主。和盒子里 `memberLockOwner` 同一个形状，`team_status` 的锁表按它认人 */
  owner?: string
  jobId?: string
  brief?: string
  ledger?: WriteLedger
}

/** 每个角色能用哪些团队工具。没绑定的连接只能进门、看清单、查交付闸 */
const ROLE_TEAM_TOOLS: Record<Role | 'none', ReadonlySet<string>> = {
  none: new Set(['team_open', 'team_join', 'team_list', 'team_gate']),
  producer: new Set([
    'team_open',
    'team_hire',
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
  now?: () => number
}

export interface ExternalTeamSession {
  /** 团队工具。由 `guard` 一起包上 */
  tools: UnrealAgentTool<never>[]
  /** 包这条连接上的全部工具（含团队工具） */
  guard: (tools: UnrealAgentTool<never>[]) => UnrealAgentTool<never>[]
  /** 连接断了：没交回的活收成「停下」，放掉锁 */
  dispose: () => Promise<void>
  /** 测试用 */
  binding: () => Readonly<Binding> | undefined
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

function memberOwner(teamId: string, name: string): string {
  return `${teamId}:mate-${memberFileBase(name)}`
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

function roleLabel(binding: Binding | undefined): string {
  if (!binding) return '还没进团队的连接'
  if (binding.role === 'producer') return '制作人'
  if (binding.role === 'acceptor') return '验收员'
  return `队员「${binding.member?.name ?? '?'}」`
}

export function createExternalTeamSession(deps: ExternalTeamDeps): ExternalTeamSession {
  const now = deps.now ?? Date.now
  let binding: Binding | undefined

  const need = (role?: Role): Binding => {
    if (!binding)
      throw new Error('这条连接还没进团队：制作人先 team_open，队员和验收员先 team_join')
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

  /** 绑定之后的调用：进团队的工程，队员再套上锁主和编辑器钥匙 */
  async function runBound<T>(b: Binding, fn: () => Promise<T>): Promise<T> {
    const record = await deps.registry.get(b.teamId)
    const projectPath = record?.projectPath
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
    const write = effectiveRisk(tool.unrealBox, params) !== 'safe'
    if (b.role === 'producer' && write && !producerSetupCall(tool.name, params)) {
      throw new Error(
        `制作人不直接改工程（${tool.name} 是写操作）。招一个队员（team_hire），起一个 ${MEMBER_AGENT} 子 Agent 去做`
      )
    }
    if (b.role === 'acceptor' && write) {
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

  function guardOne(tool: UnrealAgentTool<never>): UnrealAgentTool<never> {
    const inner = tool.execute.bind(tool)
    const isTeamTool = EXTERNAL_TEAM_TOOL_NAMES.has(tool.name)
    return {
      ...tool,
      execute: async (callId, params, signal, onUpdate) => {
        const b = binding
        const call = (): ReturnType<typeof inner> => inner(callId, params, signal, onUpdate)

        if (isTeamTool) {
          if (!ROLE_TEAM_TOOLS[b?.role ?? 'none'].has(tool.name)) {
            throw new Error(`${roleLabel(b)}不能调 ${tool.name}`)
          }
          if (!b) return call()
          const result = await runBound(b, call)
          // 退回快照改写了工程文件：之前的验收不再算数
          if (effectiveRisk(tool.unrealBox, params) === 'destructive') {
            await deps.registry.noteWrite(b.teamId).catch(() => undefined)
          }
          return result
        }

        // 普通外部会话：一点不变
        if (!b) return call()

        refuse(b, tool, params)
        const write = effectiveRisk(tool.unrealBox, params) !== 'safe'
        return runBound(b, async () => {
          if (!write) return call()
          b.ledger?.start(callId, tool.name, params)
          try {
            const result = await call()
            b.ledger?.end(callId, true)
            await deps.registry.noteWrite(b.teamId).catch(() => undefined)
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

  const openInput = z.object({
    objective: z.string().optional().describe('新开团队时必填：用户要的那一句话'),
    team_id: z.string().optional().describe('接着已有的团队干（换天、换会话、补工程路径）'),
    project_path: z
      .string()
      .optional()
      .describe('团队在哪个虚幻工程里干（.uproject 所在目录的绝对路径）。工程建好之后补上')
  })

  const openTool = defineTool<typeof openInput, unknown>({
    name: 'team_open',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'sequential',
    description:
      '外部团队（你当制作人，队员和验收员是你客户端里的子 Agent，盒子只提供任务板、留言、锁、快照、验收记录）。' +
      '新开一个团队，或者接着已有的团队干；这条连接从此是制作人。返回团队 id 和制作人须知。',
    input: openInput,
    execute: async ({ objective, team_id, project_path }) => {
      const projectPath = project_path?.trim() || undefined
      let record
      if (team_id) {
        record = await openRecord(team_id.trim())
        if (projectPath && projectPath !== record.projectPath) {
          record = await deps.registry.update(record.id, (r) => ({ ...r, projectPath }))
        }
      } else {
        if (!objective?.trim()) throw new Error('新开团队要给 objective；接着干给 team_id')
        record = await deps.registry.create({
          objective: objective.trim(),
          ...(projectPath ? { projectPath } : {})
        })
      }
      const store = deps.storeFor(record.id)
      await store.ensure()
      binding = { role: 'producer', teamId: record.id }
      const { workspaceDir } = deps.registry.dirsFor(record.id)
      const roster = await store.roster()
      return {
        text: [
          buildExternalProducerBrief({
            teamId: record.id,
            objective: record.objective,
            workspaceDir,
            ...(record.projectPath ? { projectPath: record.projectPath } : {})
          }),
          '',
          `团队 ${record.id}：${roster.length ? `现有 ${roster.map((m) => m.name).join('、')}` : '还没有队员'}。`,
          renderBoard(await store.board())
        ].join('\n'),
        details: { teamId: record.id, workspaceDir, projectPath: record.projectPath ?? null }
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
      '外部团队的队员或验收员进门：第一步就调它。之后这条连接上的写操作记在你名下、带文件锁，' +
      '队员干完调 team_report，验收员判完调 team_verdict。',
    input: joinInput,
    execute: async ({ team_id, member, brief, report, how_to_play, package_exe }) => {
      if (binding?.jobId) throw new Error(`这条连接手上还有活（${binding.jobId}），先 team_report`)
      const record = await openRecord(team_id.trim())
      const store = deps.storeFor(record.id)
      const { workspaceDir } = deps.registry.dirsFor(record.id)

      if (member.trim().toLowerCase() === ACCEPTOR) {
        if (!report?.trim() || !how_to_play?.trim()) {
          throw new Error('验收员进门要带上制作人的交付说明（report）和怎么玩（how_to_play）')
        }
        binding = { role: 'acceptor', teamId: record.id }
        return {
          text: buildExternalAcceptancePrompt({
            objective: record.objective,
            report,
            howToPlay: how_to_play,
            ...(record.projectPath ? { projectPath: record.projectPath } : {}),
            ...(package_exe ? { packageExe: package_exe } : {})
          }),
          details: { teamId: record.id, role: 'acceptor' }
        }
      }

      const found = await store.findMember(member)
      if (!found) {
        const roster = await store.roster()
        throw new Error(
          `团队里没有「${member}」。现有：${roster.map((m) => m.name).join('、') || '（无）'}；制作人先 team_hire`
        )
      }
      if (!brief?.trim()) throw new Error('队员进门要带上这件活的说明（brief）')
      const job = await store.startJob(found.name, brief)
      binding = {
        role: 'member',
        teamId: record.id,
        member: found,
        owner: memberOwner(record.id, found.name),
        jobId: job.id,
        brief,
        ledger: new WriteLedger()
      }
      const inbox = await store.takeInbox(found.name)
      const recent = (await store.jobs())
        .filter((j) => j.member === found.name && j.outcome === 'done' && j.report)
        .slice(-RECENT_REPORTS)
      return {
        text: [
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
        details: { teamId: record.id, role: 'member', member: found.name, jobId: job.id }
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
      if (b.jobId) await store.finishJob(b.jobId, { outcome: 'done', report })
      await store
        .recordActivity({
          who: name,
          what: (b.brief ?? '').split('\n').find((line) => line.trim()) ?? '',
          writes: writes.length ? summarizeDoneWrites(writes) : '',
          ...(getTargetProjectPath() ? { project: getTargetProjectPath() } : {})
        })
        .catch(() => undefined)

      let snapshotLine = ''
      if (deps.snapshots && writes.length > 0) {
        try {
          const snapshot = await deps.snapshots.save(
            snapshotMessage(name, firstSentence(report) || (b.brief ?? ''))
          )
          snapshotLine = snapshot ? `【快照】已存 ${snapshot.id}（${snapshot.message}）` : ''
        } catch (error) {
          snapshotLine = `【快照】这次没存上：${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (b.owner) releaseAll(b.owner)
      binding = undefined
      return {
        text: [
          `已交回 ${b.jobId ?? ''}。`,
          writes.length ? `写操作：${summarizeDoneWrites(writes)}` : '这件活没有写操作。',
          ...(snapshotLine ? [snapshotLine] : []),
          '这条连接已退出团队；再干活要重新 team_join。'
        ].join('\n'),
        details: { jobId: b.jobId, writes: writes.length }
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
      binding = undefined
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
    team_id: z.string().optional().describe('不给就是这条连接所在的团队')
  })

  const gateTool = defineTool<typeof gateInput, ExternalGateFacts>({
    name: 'team_gate',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '交付闸的现状（只读）：最近一次验收结论、之后有没有再改过工程、算不算已经过了验收。给收尾检查（hook）用。',
    input: gateInput,
    execute: async ({ team_id }) => {
      const id = team_id?.trim() || binding?.teamId
      if (!id) throw new Error('给 team_id')
      const record = await deps.registry.get(id)
      if (!record) throw new Error(`没有这个外部团队：${id}`)
      const facts = gateFacts(record)
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
    binding: () => binding,
    async dispose() {
      const b = binding
      binding = undefined
      if (!b || b.role !== 'member') return
      if (b.jobId) {
        await deps
          .storeFor(b.teamId)
          .finishJob(b.jobId, { outcome: 'stopped', reason: '连接断开了，没有 team_report' })
          .catch(() => undefined)
      }
      if (b.owner) releaseAll(b.owner)
    }
  }
}
