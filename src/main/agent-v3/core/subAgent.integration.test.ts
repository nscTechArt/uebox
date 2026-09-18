/**
 * @vitest-environment node
 *
 * `task` 子 agent 与 skill 加载的端到端验证。
 *
 * 这两条是 V3 相对 V2 最核心的改动，但此前只有纯函数级的单测：
 *
 *   - `task.test.ts` 打桩了 `runSubAgent`，只验了参数传递
 *   - `skills.test.ts` 直接调工具的 execute，没经过 agent 循环
 *
 * 这里让真实的 agent 循环去调它们，验证「模型决定用 → 工具真的跑 → 结果回到
 * 模型上下文」这条完整链路。模型说什么仍由脚本决定（fauxProvider）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai/providers/faux'

import { defineTool, type UnrealAgentTool } from '../tools/defineTool'
import { createTaskTool } from '../tools/builtin/task'

const root = mkdtempSync(join(tmpdir(), 'agent-v3-subagent-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function makeAgent(tools: UnrealAgentTool<never>[]): {
  agent: Agent
  faux: ReturnType<typeof fauxProvider>
} {
  const faux = fauxProvider({ tokensPerSecond: 100_000 })
  const models = createModels()
  models.setProvider(faux.provider)

  const agent = new Agent({
    streamFn: (model, context, options) => models.streamSimple(model, context, options),
    sessionId: 'sub-integration',
    initialState: {
      model: faux.getModel(),
      systemPrompt: '测试助手',
      tools: tools as unknown as AgentTool<never>[]
    },
    convertToLlm: (messages: AgentMessage[]) => messages as never[]
  })
  return { agent, faux }
}

describe('task 子 agent 端到端', () => {
  it('模型调 task → 子 agent 拿到父对话 → 结论回到父上下文', async () => {
    // 子 agent 收到的 seedMessages —— V3 与 V2 的本质区别就在这里
    let seedSeen: AgentMessage[] = []

    const taskTool = createTaskTool({
      getParentMessages: () => agent.state.messages,
      runSubAgent: async (input) => {
        seedSeen = input.seedMessages
        return { text: '子 agent 查到：材质在 /Game/Env/M_Wood', messageCount: 3 }
      }
    }) as unknown as UnrealAgentTool<never>

    const { agent, faux } = makeAgent([taskTool])

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task', { prompt: '找到那个材质' }, { id: 'c1' })]),
      fauxAssistantMessage('材质在 /Game/Env/M_Wood，我接着改')
    ])

    await agent.prompt('帮我找一下木头材质在哪')

    // 子 agent 拿到的是**完整 transcript**，不是一个字符串
    expect(seedSeen.length).toBeGreaterThan(0)
    expect(JSON.stringify(seedSeen)).toContain('木头材质')

    // 子 agent 的结论回到了父 agent 的上下文
    expect(JSON.stringify(agent.state.messages)).toContain('/Game/Env/M_Wood')
  })

  it('context_mode=fresh 时子 agent 不带父对话', async () => {
    let seedSeen: AgentMessage[] = []
    const taskTool = createTaskTool({
      getParentMessages: () => agent.state.messages,
      runSubAgent: async (input) => {
        seedSeen = input.seedMessages
        return { text: '独立任务完成', messageCount: 1 }
      }
    }) as unknown as UnrealAgentTool<never>

    const { agent, faux } = makeAgent([taskTool])
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('task', { prompt: '做件无关的事', context_mode: 'fresh' }, { id: 'c1' })
      ]),
      fauxAssistantMessage('好了')
    ])

    await agent.prompt('做件跟当前无关的事')

    expect(seedSeen).toEqual([])
  })

  it('并发起多个 task —— 支持多视角审查', async () => {
    const started: string[] = []
    const taskTool = createTaskTool({
      getParentMessages: () => agent.state.messages,
      runSubAgent: async (input) => {
        started.push(input.prompt)
        return { text: `${input.prompt} 的结论`, messageCount: 1 }
      }
    }) as unknown as UnrealAgentTool<never>

    const { agent, faux } = makeAgent([taskTool])
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('task', { prompt: '从正确性审查' }, { id: 'c1' }),
        fauxToolCall('task', { prompt: '从性能审查' }, { id: 'c2' })
      ]),
      fauxAssistantMessage('两个视角都看过了')
    ])

    await agent.prompt('多角度审查这份蓝图')

    expect(started.sort()).toEqual(['从性能审查', '从正确性审查'])
  })

  it('子 agent 失败时错误回给父 agent，父 agent 能换路子', async () => {
    const fallback = defineTool({
      name: 'do_it_myself',
      namespace: 'test',
      risk: 'safe',
      description: '自己动手',
      input: z.object({}),
      execute: async () => ({ text: '自己做完了' })
    }) as unknown as UnrealAgentTool<never>

    const taskTool = createTaskTool({
      getParentMessages: () => agent.state.messages,
      runSubAgent: async () => {
        throw new Error('子 agent 里的模型没配好')
      }
    }) as unknown as UnrealAgentTool<never>

    const { agent, faux } = makeAgent([taskTool, fallback])
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task', { prompt: '派给子 agent' }, { id: 'c1' })]),
      fauxAssistantMessage([fauxToolCall('do_it_myself', {}, { id: 'c2' })]),
      fauxAssistantMessage('子 agent 不行，我自己做完了')
    ])

    await agent.prompt('做件事')

    const transcript = JSON.stringify(agent.state.messages)
    expect(transcript).toContain('子 agent 里的模型没配好')
    expect(transcript).toContain('自己做完了')
  })
})

describe('skill 加载端到端', () => {
  const SKILL_DIR = join(root, 'skills')

  function writeSkill(name: string, description: string, body: string): void {
    const dir = join(SKILL_DIR, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
      'utf8'
    )
  }

  writeSkill(
    'ue-blueprint-graph-wiring',
    '连蓝图执行流时读它',
    '# 流程\n\n1. 先 blueprint.get_graph 拿真实 node_id\n2. 再 blueprint.connect_pins'
  )

  it('模型调 load_skill → 正文回到上下文，且工具名已重写', async () => {
    const { discoverSkills } = await import('../capabilities/skillsService/SkillsService')
    const { createSkillTools } = await import('../capabilities/skills')

    const skills = await discoverSkills([SKILL_DIR])
    const skillTools = createSkillTools(skills) as unknown as UnrealAgentTool<never>[]

    const { agent, faux } = makeAgent(skillTools)
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('load_skill', { name: 'ue-blueprint-graph-wiring' }, { id: 'c1' })
      ]),
      fauxAssistantMessage('按技能里的流程来')
    ])

    await agent.prompt('帮我连蓝图')

    const transcript = JSON.stringify(agent.state.messages)
    // 正文进了上下文
    expect(transcript).toContain('拿真实 node_id')
    // 点号工具名被重写 —— 否则模型会照着技能去调一个不存在的工具
    expect(transcript).toContain('blueprint_get_graph')
    expect(transcript).not.toContain('blueprint.get_graph')
  })

  it('技能不存在时报错并列出可选项，模型能自我纠正', async () => {
    const { discoverSkills } = await import('../capabilities/skillsService/SkillsService')
    const { createSkillTools } = await import('../capabilities/skills')

    const skills = await discoverSkills([SKILL_DIR])
    const skillTools = createSkillTools(skills) as unknown as UnrealAgentTool<never>[]

    const { agent, faux } = makeAgent(skillTools)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('load_skill', { name: '瞎猜的技能' }, { id: 'c1' })]),
      // 模型看到可选项后改调对的
      fauxAssistantMessage([
        fauxToolCall('load_skill', { name: 'ue-blueprint-graph-wiring' }, { id: 'c2' })
      ]),
      fauxAssistantMessage('这次对了')
    ])

    await agent.prompt('加载技能')

    const transcript = JSON.stringify(agent.state.messages)
    expect(transcript).toContain('ue-blueprint-graph-wiring')
    expect(transcript).toContain('拿真实 node_id')
  })
})

void vi
