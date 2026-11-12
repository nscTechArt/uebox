/**
 * @vitest-environment node
 *
 * 混合团队的一致性：同一个队员，在盒子里 `/team` 的父上下文下和在混合团队的父上下文下，
 * 拿到的工具和系统提示词一模一样（docs/混合团队设计-2026-10-24.md 第 2、7 节）。
 *
 * 模型说什么由脚本决定（fauxProvider）。顺带走一遍真的子 Agent：第二件活记得第一件、
 * 干活途中制作人发的 team_message 当场插进去。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModels, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai/providers/faux'
import { z } from 'zod'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { defineTool } from '../../tools/defineTool'

const resolveModel = vi.hoisted(() => vi.fn())
const buildTools = vi.hoisted(() => vi.fn(() => [] as unknown[]))
vi.mock('../streamFn', () => ({ resolveAgentModel: resolveModel }))
vi.mock('../../tools/registry', () => ({ buildAllTools: buildTools }))
vi.mock('../../tools/builtin/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('../../capabilities/skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capabilities/skills')>()),
  applySkillLearningMode: (skills: unknown[]) => skills,
  discoverEnabledSkills: async () => [],
  buildSkillsSection: () => '',
  buildSkillLearningSection: () => ''
}))
vi.mock('../../../appSettingsManager', () => ({
  appSettingsManager: { getSettings: () => ({ agentToolSearchEnabled: false }) }
}))
const userData = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(`${tmpdir()}/hybrid-parity-userdata-`)
})
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('../../../ai/probe', () => ({
  checkupChatModel: async () => ({ at: 0, reachable: true, tools: 'ok' })
}))
const aiSettings = vi.hoisted(() => ({ providers: [] as unknown[], roles: {} }))
vi.mock('../../../ai/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../ai/store')>()),
  readSettings: async () => aiSettings
}))
vi.mock('../compactionCheckpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../compactionCheckpoint')>()),
  loadCheckpoint: async () => null
}))

import { createTeamRunners, createUnrealAgent, type SessionContext } from '../createAgent'
import type { RuntimeEnvelope } from '../runtimeEnvelope'
import { createExternalTeamRegistry } from './externalTeam'
import {
  createHybridTeamHost,
  hybridParentContext,
  type HybridEnvironment,
  type HybridTeamHost
} from './hybridTeam'
import { createTeamLive } from './teamLive'
import { loadTeamModels } from './teamModels'
import { createTeamStore } from './teamStore'

const root = mkdtempSync(join(tmpdir(), 'hybrid-parity-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

const faux = fauxProvider({ tokensPerSecond: 100000 })
const models = createModels()
models.setProvider(faux.provider)
interface Request {
  system: string
  tools: string
  names: string[]
  messages: string
}
const requests: Request[] = []
/** 慢工具放行的开关：插话那条用例在它卡着的时候发话 */
let releaseSlow: (() => void) | undefined
let slowStarted: (() => void) | undefined

const sender = { send: () => undefined, isDestroyed: () => false } as never
const runtime: RuntimeEnvelope = {
  runtimeScopeId: 'rt-parity',
  observedAt: '2026-10-24 12:00:00 UTC+08:00 (Saturday)',
  engineLink: 'target',
  targetProject: { name: 'TowerDefense', engineVersion: '5.6', pathOnRecord: 'D:/TD' }
}
/** 两边共用的环境事实：同一台机器、同一份用户设置、同一个连着的工程 */
const env: HybridEnvironment = {
  shellAvailable: true,
  userInstructions: '回答简短',
  uiLanguage: 'zh-CN',
  experienceHome: join(root, 'experience'),
  sender,
  editorScreenshotEnabled: true,
  ueConnected: true,
  project: { name: 'TowerDefense', engineVersion: '5.6', path: 'D:/TD' },
  sessionProject: { name: 'TowerDefense', engineVersion: '5.6', path: 'D:/TD', connected: true },
  runtime
}

beforeEach(() => {
  requests.length = 0
  buildTools.mockReturnValue([
    defineTool({
      name: 'read_state',
      namespace: 'ue.material',
      risk: 'safe',
      description: '读取材质',
      input: z.object({}),
      execute: async () => ({ text: 'read' })
    }),
    defineTool({
      name: 'write_state',
      namespace: 'ue.material',
      risk: 'mutating',
      description: '修改材质',
      input: z.object({}),
      execute: async () => ({ text: 'written' })
    }),
    defineTool({
      name: 'slow_read',
      namespace: 'ue.material',
      risk: 'safe',
      description: '读得很慢',
      input: z.object({}),
      execute: async () => {
        slowStarted?.()
        await new Promise<void>((resolve) => (releaseSlow = resolve))
        return { text: 'slow done' }
      }
    })
  ])
  const streamFn: StreamFn = (model, context, options) => {
    const tools = getCurrentTools(context.messages)
    requests.push({
      system: getCurrentSystemPrompt(context.messages),
      tools: JSON.stringify(
        tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
      ),
      names: tools.map((t) => t.name),
      messages: JSON.stringify(context.messages)
    })
    return models.streamSimple(model, context, options)
  }
  aiSettings.providers = [
    {
      id: 'faux',
      displayName: 'Faux',
      kind: 'chat',
      models: [{ id: faux.getModel().id }, { id: 'cheap', displayName: 'Cheap' }]
    }
  ]
  resolveModel.mockResolvedValue({
    selection: {
      providerId: 'faux',
      modelId: faux.getModel().id,
      role: 'agent',
      model: faux.getModel()
    },
    models,
    summaryModel: faux.getModel(),
    streamFn
  })
})

const MEMBER = {
  name: '材质师',
  persona: '负责所有材质',
  tier: 'strong' as const,
  model: { providerId: 'faux', modelId: 'cheap' },
  modelBy: 'producer' as const,
  namespaces: ['ue.material'],
  readOnly: false,
  hiredAt: 0
}

/** 队员那一次请求：系统提示词里带着它的人设 */
const memberRequests = (): Request[] =>
  requests.filter((r) => r.system.includes('<role>负责所有材质</role>'))

describe('混合团队的队员和盒子里的队员一模一样', () => {
  it('工具和系统提示词逐字节相同；第二件活记得第一件；干活途中的 team_message 当场插进去', async () => {
    const registry = createExternalTeamRegistry({
      dirsFor: (id) => ({ stateDir: join(root, `${id}.team`), workspaceDir: join(root, 'ws') }),
      stateRoot: () => root
    })
    const record = await registry.create({ objective: '做一个塔防游戏', members: 'box' })
    // 两边用同一个工作区：队员的提示词里写着工作区路径
    const store = createTeamStore(registry.dirsFor(record.id))
    await store.ensure()
    await store.putMember(MEMBER)

    // ── 盒子里：制作人这一轮的 ctx，照 `ipc/agentV3.ts` 的 executeAgent 摆 ──
    const inbox: SessionContext = {
      sessionId: 'box-team-session',
      ueConnected: env.ueConnected,
      shellAvailable: env.shellAvailable,
      project: env.project!,
      sessionProject: env.sessionProject!,
      refreshEngine: () => undefined,
      sessionProjectControl: { listProjects: () => [], onChange: () => undefined },
      mode: 'agent',
      isReadOnly: () => false,
      approvalMode: () => 'ask',
      alwaysAllowed: new Set(),
      thinkingLevel: 'auto',
      fastMode: false,
      skillLearning: 'ask',
      editorScreenshotEnabled: env.editorScreenshotEnabled,
      userInstructions: env.userInstructions,
      experienceHome: env.experienceHome!,
      uiLanguage: env.uiLanguage,
      modelRequest: { role: 'agent', agentType: 'agent-v3', hasImages: false },
      requestApproval: async () => 'approve',
      requestQuestion: async () => ({ answers: [] }) as never,
      sender,
      runtime,
      onUsage: () => undefined,
      onCompacting: () => undefined,
      pacedRequests: true,
      team: { objective: '做一个塔防游戏', store, live: createTeamLive(store) }
    }
    const { agent } = await createUnrealAgent(inbox)
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('team_send', { to: '材质师', message: '把地面材质做成草地' }, { id: 's' })
      ]),
      fauxAssistantMessage([fauxToolCall('write_state', {}, { id: 'w' })]),
      fauxAssistantMessage('草地材质做好了'),
      fauxAssistantMessage('好')
    ])
    await agent.prompt('派活')
    expect(agent.state.errorMessage).toBeUndefined()
    const [boxMember] = memberRequests()
    expect(boxMember).toBeDefined()

    // ── 混合团队：同一个队员、同一份记忆起点 ──
    await store.saveHistory(MEMBER.name, [])
    requests.length = 0
    const host: HybridTeamHost = await createHybridTeamHost(record, {
      store,
      namespaces: ['ue.material'],
      models: await loadTeamModels(),
      jobScope: async () => ({ parent: hybridParentContext(env), run: (fn) => fn() }),
      runTool: (_record, fn) => fn(),
      runners: createTeamRunners,
      noteWrite: (id) => registry.noteWrite(id)
    })
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('write_state', {}, { id: 'w' })]),
        fauxAssistantMessage('草地材质做好了')
      ])
      expect(
        await host.send({ to: '材质师', message: '把地面材质做成草地', wait: true })
      ).toContain('交回了')
      const result = await host.drain()
      expect(result).toContain('草地材质做好了')
      expect(result).toContain('write_state')
      const [hybridMember] = memberRequests()

      expect(hybridMember!.names.sort()).toEqual(boxMember!.names.sort())
      expect(hybridMember!.tools).toBe(boxMember!.tools)
      expect(hybridMember!.system).toBe(boxMember!.system)
      // 队员写了工程：交付闸记下了
      expect((await registry.get(record.id))?.state.lastWriteAt).toBeDefined()

      // ── 第二件活：它记得第一件 ──
      requests.length = 0
      faux.setResponses([fauxAssistantMessage('记得，上次做的是草地')])
      await host.send({ to: '材质师', message: '上次做了什么？', wait: true })
      expect(memberRequests()[0]!.messages).toContain('把地面材质做成草地')
      expect(await host.drain()).toContain('记得，上次做的是草地')

      // ── 干活途中插话：卡在慢工具上时发 team_message，下一次请求里就有 ──
      requests.length = 0
      const started = new Promise<void>((resolve) => (slowStarted = resolve))
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('slow_read', {}, { id: 'r' })]),
        fauxAssistantMessage('收到，改成雪地')
      ])
      await host.send({ to: '材质师', message: '看看现在的材质' })
      await started
      const sent = await host.call('team_message', { to: '材质师', text: '改成雪地' })
      expect(JSON.stringify(sent.content)).toContain('插进它的下一步')
      releaseSlow!()
      expect(await host.wait(30_000)).toContain('收到，改成雪地')
      const afterSteer = memberRequests().at(-1)!
      expect(afterSteer.messages).toContain('改成雪地')
      expect(afterSteer.messages).toContain('[team mail')

      // 用量和活的账都在团队名下
      expect((await store.jobs()).filter((j) => j.outcome === 'done').length).toBeGreaterThan(2)
    } finally {
      await host.dispose()
    }
  }, 60_000)

  it('一致性测试本身是灵的：父上下文带上 externalClient，队员的提示词就变了', async () => {
    const store = createTeamStore({
      stateDir: join(root, 'sens', 'state'),
      workspaceDir: join(root, 'sens', 'ws')
    })
    await store.ensure()
    await store.putMember(MEMBER)
    const run = async (parent: Omit<SessionContext, 'sessionId'>): Promise<string> => {
      requests.length = 0
      faux.setResponses([fauxAssistantMessage('好')])
      const { runMember } = createTeamRunners(() => ({
        ...parent,
        sessionId: 'sens',
        team: { objective: 'x', store }
      }))
      await runMember({
        member: MEMBER,
        message: '看看',
        history: [],
        onProgress: () => undefined,
        ledger: new (await import('../writeLedger')).WriteLedger(),
        keepMessages: () => undefined
      })
      return memberRequests()[0]!.system
    }
    const plain = await run(hybridParentContext(env))
    const external = await run({ ...hybridParentContext(env), externalClient: true })
    expect(external).not.toBe(plain)
  }, 60_000)
})
