/**
 * @vitest-environment node
 *
 * 外部会话里的 `task` 用哪个模型。
 *
 * 真机上查出来的：外部会话没写 `modelRequest`，按默认角色落到了对话模型上，
 * 和盒子助手用的 agent 那一档不是同一个 —— 那家额度一用完，外部派的子任务整路 429。
 */

import { describe, expect, it, vi } from 'vitest'

import { teamModelCandidates } from '../../../../shared/agentTeam'
import { electronMock, servicesMock, targetContextMock } from '../../testSupport/toolMocks'

vi.mock('electron', () => electronMock())
vi.mock('../../../services', () => servicesMock())
vi.mock('../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)
vi.mock('../../../appSettingsManager', () => ({
  appSettingsManager: { getSettings: () => ({ agentDisabledTools: [] }) }
}))
vi.mock('../../../services/project/projectManager', () => ({
  projectManager: { getInteractiveProjects: () => [] }
}))
vi.mock('../../tools/builtin/localShell', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isShellAvailable: async () => true
}))
vi.mock('./index', () => ({
  ensureConnected: async () => ({ getTools: () => [], getStatuses: () => [] })
}))

const runSubAgent = vi.hoisted(() => vi.fn(async () => ({ text: '完成', messageCount: 2 })))
vi.mock('../../core/createAgent', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runSubAgent
}))

const providers = vi.hoisted(() => ({
  list: [] as Parameters<typeof teamModelCandidates>[0]
}))
vi.mock('../../core/team/teamModels', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadTeamModels: async () => ({
    candidates: teamModelCandidates(providers.list),
    isAvailable: async () => true
  })
}))

import { setupMcpSession } from './hostSession'

const chat = (id: string, models: string[]): Parameters<typeof teamModelCandidates>[0][number] => ({
  id,
  kind: 'chat',
  models: models.map((m) => ({ id: m }))
})

async function taskTool(): Promise<{
  parameters: unknown
  execute: (id: string, params: unknown) => Promise<unknown>
}> {
  const { tools } = await setupMcpSession({ sessionId: 'mcp-test' } as never)
  const tool = tools.find((t) => t.name === 'task')
  if (!tool) throw new Error('task 没有装上')
  return tool as never
}

describe('外部会话的 task 用哪个模型', () => {
  it('不点名：子任务照盒子助手用 agent 那一档，不落到对话模型上', async () => {
    providers.list = [chat('a', ['m1']), chat('b', ['m2'])]
    runSubAgent.mockClear()

    await (await taskTool()).execute('c1', { prompt: 'x', context_mode: 'fresh' })

    const [parent, input] = runSubAgent.mock.calls[0] as unknown as [
      { modelRequest?: { role?: string } },
      { model?: unknown }
    ]
    expect(parent.modelRequest?.role).toBe('agent')
    expect(input.model).toBeUndefined()
  })

  it('点名：按名单里的 id 钉到那个模型', async () => {
    providers.list = [chat('a', ['m1']), chat('b', ['m2'])]
    runSubAgent.mockClear()

    const tool = await taskTool()
    expect(JSON.stringify(tool.parameters)).toContain('b/m2')
    await tool.execute('c1', { prompt: 'x', context_mode: 'fresh', model: 'b/m2' })

    const [, input] = runSubAgent.mock.calls[0] as unknown as [unknown, { model?: unknown }]
    expect(input.model).toEqual({ providerId: 'b', modelId: 'm2' })
  })

  it('只配了一个模型：没得挑，不出 model 参数', async () => {
    providers.list = [chat('a', ['m1'])]

    const { parameters } = await taskTool()
    expect(Object.keys((parameters as { properties: object }).properties)).not.toContain('model')
  })
})

describe('外部会话没有盒子的界面', () => {
  it('客户端支持提问也不给 update_plan / wrap_up，说明里也不提', async () => {
    providers.list = [chat('a', ['m1'])]

    const { tools, instructions } = await setupMcpSession({
      sessionId: 'mcp-test',
      elicit: async () => ({ action: 'cancel' })
    } as never)
    const names = tools.map((t) => t.name)

    expect(names).toContain('ask_user')
    expect(names).not.toContain('update_plan')
    expect(names).not.toContain('wrap_up')
    expect(instructions).not.toContain('wrap_up')
    // 外部会话的子任务不继承对话，用户也看不到盒子的改动台账
    expect(instructions).not.toContain('inherits this conversation in full')
    expect(instructions).not.toContain('The UI already lists which assets you touched')
  })
})

describe('混合团队制作人的工具集（X-Unreal-Box-Profile: producer）', () => {
  it('只有团队工具，盒子的读写工具、task 一个都没有；工具说明不超过 Claude Code 的截断长度', async () => {
    // 比赛那一队的四个队员模型，外加一个：招人说明里的候选名单按这个量
    providers.list = [
      chat('deepseek', ['deepseek-v4.1-flash']),
      chat('xai', ['grok-4.7']),
      chat('moonshot', ['kimi-k3.1']),
      chat('qwen', ['qwen3.8-max']),
      chat('openrouter', ['glm-5'])
    ]
    const { tools, instructions } = await setupMcpSession({
      sessionId: 'mcp-producer',
      profile: 'producer'
    } as never)

    expect(tools.map((t) => t.name).sort()).toEqual([
      'project_list',
      'project_manage',
      'team_approve',
      'team_board',
      'team_dismiss',
      'team_gate',
      'team_hire',
      'team_inbox',
      'team_list',
      'team_message',
      'team_open',
      'team_send',
      'team_snapshot',
      'team_status',
      'team_wait',
      'ue_session_health'
    ])
    // Claude Code 把握手说明和每个工具说明截在 4096 字符
    expect(instructions!.length).toBeLessThan(4096)
    for (const tool of tools) expect(tool.description.length).toBeLessThan(4096)
    // 制作人的 project_manage 只认建工程、开工程（同盒子里的 producerTools）
    const manage = tools.find((t) => t.name === 'project_manage')!
    expect(JSON.stringify(manage.parameters)).toContain('open_project')
    expect(JSON.stringify(manage.parameters)).not.toContain('enable_plugins')
    // 候选名单不在招人说明里（模型一多就被截断），随 team_open 的须知给
    const hire = tools.find((t) => t.name === 'team_hire')!
    expect(hire.description).not.toContain('deepseek/deepseek-v4.1-flash')
    expect(JSON.stringify(hire.parameters)).toContain('model_reason')
    // team_open 是混合团队的那份：能选思考档位
    const open = tools.find((t) => t.name === 'team_open')!
    expect(Object.keys((open.parameters as { properties: object }).properties)).toContain(
      'thinking_level'
    )

    // 制作人每轮都要付的那份工具定义有多大（汇报给录制方用）
    const schema = JSON.stringify(
      tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }))
    )
    console.log(
      `[hybrid] producer tools: ${tools.length} tools, ${schema.length} chars, ` +
        `${Buffer.byteLength(schema, 'utf8')} bytes; instructions ${instructions!.length} chars`
    )
    expect(schema.length).toBeLessThan(40_000)
  })

  it('不认识的工具集直接报错，不悄悄换成完整的那一套', async () => {
    await expect(
      setupMcpSession({ sessionId: 'mcp-x', profile: 'produce' } as never)
    ).rejects.toThrow('不认识的工具集')
  })
})
