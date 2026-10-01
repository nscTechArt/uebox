/**
 * 端到端：经验挂在错误结果后面，真的进了模型上下文。
 *
 * 单测证明了 `runtime.after` 会回一段话，但那段话要靠 `afterToolCall` 的
 * `content` 覆盖才进得了上下文 —— 而工具是**抛异常**失败的，覆盖对异常结果
 * 是否生效，只有跑一遍 pi 的循环才知道。挂法照抄 `createAgent.ts`。
 */

import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { createSessionExperience } from './session'
import { ExperienceStore, experienceDir } from './store'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'exp-e2e-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('经验进上下文', () => {
  it('引擎工具报了本工程见过的错，模型下一轮看得到上次怎么过的', async () => {
    const store = new ExperienceStore(experienceDir(root)!)
    await store.updateTool('ue_run_python_script', () => [
      {
        id: 'e-1',
        title: '角色没有 is_hidden',
        tool: 'ue_run_python_script',
        errorPattern: "has no attribute 'is_hidden'",
        advice: '改用 is_hidden_ed() 读隐藏状态',
        expect: { param: 'script' },
        source: 'test',
        status: 'proven'
      }
    ])

    const tool = defineTool({
      name: 'ue_run_python_script',
      namespace: 'ue.system',
      // 和注册表一致：跑任意代码的工具记成 destructive，也得照样学
      risk: 'destructive',
      description: '跑脚本',
      input: z.object({ script: z.string() }),
      execute: async () => {
        throw new Error(
          "Traceback (most recent call last): AttributeError: 'Character' object has no attribute 'is_hidden'"
        )
      }
    }) as unknown as UnrealAgentTool<never>

    const experience = createSessionExperience({
      sessionId: 's1',
      projectRoot: root,
      skillLearning: 'ask',
      tools: [tool],
      // 抽签固定落在出场那一支（对照组的行为在 runtime.test.ts 里测）
      random: () => 0.99
    })!

    const faux = fauxProvider({ tokensPerSecond: 100_000 })
    const models = createModels()
    models.setProvider(faux.provider)
    const agent = new Agent({
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
      sessionId: 's1',
      initialState: {
        model: faux.getModel(),
        systemPrompt: 'test',
        tools: [tool] as unknown as AgentTool<never>[]
      },
      convertToLlm: (messages: AgentMessage[]) => messages as never[],
      afterToolCall: async (hookCtx) => {
        const content = hookCtx.result.content ?? []
        const note = await experience.after({
          tool: hookCtx.toolCall.name,
          args: hookCtx.args,
          isError: hookCtx.isError,
          text: content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
        })
        return note ? { content: [...content, { type: 'text', text: note }] } : undefined
      }
    })

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('ue_run_python_script', { script: 'a.is_hidden' }, { id: 'c1' })
      ]),
      fauxAssistantMessage('好的')
    ])
    await agent.prompt('隐藏角色')
    const text = JSON.stringify(agent.state.messages)
    expect(text).toContain("has no attribute 'is_hidden'")
    expect(text).toContain('Experience from earlier runs')
    expect(text).toContain('is_hidden_ed()')
    await experience.flush()
  })
})
