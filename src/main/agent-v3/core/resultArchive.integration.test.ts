/**
 * @vitest-environment node
 *
 * 大结果存档走一整轮：模型调一个回大表的工具 → 拿到目录页和编号 → 用 result_query 取回完整的行。
 *
 * 模型说什么由 faux provider 的脚本决定，但 pi 的循环、`afterToolCall` 改写、
 * details 落进消息历史、result_query 从历史里找存档 —— 这几层都是真的。
 * 证明的是管道通，不是模型会不会用（那要真机看）。
 */

import { describe, expect, it } from 'vitest'
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
import { createResultQueryTool } from '../tools/builtin/resultQuery'
import { ARCHIVE_BUDGET_CHARS, createResultArchiver } from './resultArchive'

const ROWS = Array.from({ length: 300 }, (_, i) => ({
  name: `Template_${i}`,
  category: 'Games',
  description: '模板说明'.repeat(20)
}))

const listTool = defineTool({
  name: 'list_templates',
  namespace: 'test',
  risk: 'safe',
  description: '列模板',
  input: z.object({}),
  execute: async () => {
    const result = { success: true, templates: ROWS }
    return { text: JSON.stringify(result), details: result }
  }
}) as unknown as UnrealAgentTool<never>

function textOf(message: AgentMessage): string {
  const content = (message as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return content.map((part) => part.text ?? '').join('')
}

describe('大结果存档走一整轮', () => {
  it('目录页进上下文，完整的行凭编号取回', async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 })
    const models = createModels()
    models.setProvider(faux.provider)

    // eslint-disable-next-line prefer-const -- 闭包要在构造前引用它
    let agent: Agent
    const queryTool = createResultQueryTool({
      getMessages: () => agent.state.messages,
      isMutating: () => false
    }) as unknown as UnrealAgentTool<never>
    const archive = createResultArchiver({
      getMessages: () => agent.state.messages,
      specFor: (name) =>
        name === 'list_templates' ? { lists: { templates: ['name', 'category'] } } : undefined,
      canQuery: () => true,
      loadQueryTool: () => undefined
    })

    agent = new Agent({
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
      sessionId: 'archive-integration',
      initialState: {
        model: faux.getModel(),
        systemPrompt: '测试',
        tools: [listTool, queryTool] as unknown as AgentTool<never>[]
      },
      toolExecution: 'parallel',
      convertToLlm: (messages: AgentMessage[]) => messages as never[],
      afterToolCall: async (hookCtx) => archive(hookCtx)
    })

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('list_templates', {}, { id: 'c1' })]),
      fauxAssistantMessage([
        fauxToolCall('result_query', { ref: 'r1', where: { name: 'Template_250' } }, { id: 'c2' })
      ]),
      fauxAssistantMessage('找到了')
    ])

    await agent.prompt('第 250 个模板是什么')

    const results = agent.state.messages.filter((m) => m.role === 'toolResult')
    const [listed, queried] = results

    // 进上下文的是目录页
    const preview = textOf(listed)
    expect(preview.length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
    expect(preview).toContain('"ref":"r1"')
    expect(preview).not.toContain('模板说明')
    // 完整的那份跟着消息走：这个工具的 details 就是同一张表，存档只记来源、不另存文本
    const details = (
      listed as {
        details?: { archive?: { text?: string; source?: string }; templates?: unknown[] }
      }
    ).details
    expect(details?.templates).toHaveLength(300)
    expect(details?.archive?.source).toBe('details')
    expect(details?.archive?.text).toBeUndefined()

    // 目录页只有名字和分类，查回来的是带说明的完整一行
    const answer = JSON.parse(textOf(queried)) as {
      matched: number
      rows: unknown[]
      snapshot: string
    }
    expect(answer.matched).toBe(1)
    expect(answer.rows[0]).toEqual(ROWS[250])
    expect(answer.snapshot).toContain('list_templates')
  })
})
