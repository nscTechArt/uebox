/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai/providers/faux'
import { z } from 'zod'
import { defineTool } from '../tools/defineTool'

const resolveModel = vi.hoisted(() => vi.fn())
const buildTools = vi.hoisted(() => vi.fn(() => [] as unknown[]))
vi.mock('./streamFn', () => ({ resolveAgentModel: resolveModel }))
vi.mock('../tools/registry', () => ({ buildAllTools: buildTools }))
vi.mock('../tools/builtin/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('../capabilities/skills', () => ({
  applySkillLearningMode: (skills: unknown[]) => skills,
  discoverEnabledSkills: async () => [],
  createSkillTools: () => [],
  buildSkillsSection: () => '',
  buildSkillLearningSection: () => ''
}))
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('../../appSettingsManager', () => ({
  appSettingsManager: { getSettings: () => ({ agentToolSearchEnabled: false }) }
}))

import { runSubAgent } from './createAgent'
import { createTaskTool } from '../tools/builtin/task'

const faux = fauxProvider({ tokensPerSecond: 100000 })
const models = createModels()
models.setProvider(faux.provider)
const runtime = {
  selection: {
    providerId: 'faux',
    modelId: faux.getModel().id,
    role: 'agent',
    model: faux.getModel()
  },
  models,
  summaryModel: faux.getModel(),
  streamFn: models.streamSimple.bind(models)
}
const parent = { sessionId: 'parent', ueConnected: false, skills: [] }

beforeEach(() => {
  resolveModel.mockReset().mockResolvedValue(runtime)
  buildTools.mockReset().mockReturnValue([])
})

describe('真实子任务运行边界', () => {
  it.each([false, true])(
    '父会话运行中收紧只读，子任务后续不能写入（免审批=%s）',
    async (withoutApproval) => {
      let readOnly = false
      const write = vi.fn(async () => ({ text: 'written' }))
      buildTools.mockReturnValue([
        defineTool({
          name: 'read_state',
          namespace: 'asset',
          description: 'read',
          input: z.object({}),
          risk: 'safe',
          execute: async () => {
            readOnly = true
            return { text: 'read' }
          }
        }),
        defineTool({
          name: 'write_state',
          namespace: 'asset',
          description: 'write',
          input: z.object({}),
          risk: 'mutating',
          execute: write
        })
      ])
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read_state', {}, { id: 'read' })]),
        fauxAssistantMessage([fauxToolCall('write_state', {}, { id: 'write' })]),
        fauxAssistantMessage('read-only respected')
      ])
      const result = await runSubAgent(
        { ...parent, isReadOnly: () => readOnly, requestApproval: async () => 'approve' as const },
        { prompt: 'read then write', seedMessages: [], withoutApproval }
      )
      expect(readOnly).toBe(true)
      expect(write).not.toHaveBeenCalled()
      expect(result.text).toBe('read-only respected')
    }
  )
  it('模型失败必须让 task 报错，即使 prompt 正常返回', async () => {
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'provider failed' })
    ])
    const task = createTaskTool({
      getParentMessages: () => [],
      runSubAgent: (input) => runSubAgent(parent, input)
    })
    await expect(task.execute('t', { prompt: 'work', context_mode: 'fresh' })).rejects.toThrow(
      'provider failed'
    )
  })

  it('初始化期间取消，不能继续发模型请求', async () => {
    let ready: (value: typeof runtime) => void = () => {}
    resolveModel.mockReturnValueOnce(
      new Promise((resolve) => {
        ready = resolve
      })
    )
    faux.setResponses([fauxAssistantMessage('should not run')])
    const controller = new AbortController()
    const running = runSubAgent(parent, {
      prompt: 'work',
      seedMessages: [],
      signal: controller.signal
    })
    controller.abort()
    ready(runtime)
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(faux.getPendingResponseCount()).toBe(1)
  })

  it('已取消的任务不能开始初始化', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runSubAgent(parent, { prompt: 'work', seedMessages: [], signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(resolveModel).not.toHaveBeenCalled()
  })

  it('正常子任务返回最终结论', async () => {
    faux.setResponses([fauxAssistantMessage('done')])
    expect(await runSubAgent(parent, { prompt: 'work', seedMessages: [] })).toMatchObject({
      text: 'done'
    })
  })

  /**
   * 真机上出过的事：prompt 开头写着「纯只读评审，严禁调用任何写工具」并列全了
   * 工具名，子 agent 照样改了 6 个 Actor 的位置并存盘。文字拦不住工具，
   * 只有工具清单里没有才拦得住。
   */
  it('read_only 的子任务手里根本没有写工具', async () => {
    const write = vi.fn(async () => ({ text: 'written' }))
    buildTools.mockReturnValue([
      defineTool({
        name: 'read_state',
        namespace: 'asset',
        description: 'read',
        input: z.object({}),
        risk: 'safe',
        execute: async () => ({ text: 'read' })
      }),
      defineTool({
        name: 'write_state',
        namespace: 'asset',
        description: 'write',
        input: z.object({}),
        risk: 'mutating',
        execute: write
      })
    ])
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_state', {}, { id: 'write' })]),
      fauxAssistantMessage('reviewed without touching anything')
    ])

    const result = await runSubAgent(parent, {
      prompt: 'review the scene',
      seedMessages: [],
      readOnly: true
    })

    expect(write).not.toHaveBeenCalled()
    expect(result.readOnly).toBe(true)
    expect(result.writeToolCalls).toEqual({})
  })

  it('写操作按工具名记账，只读工具不进账', async () => {
    const write = vi.fn(async () => ({ text: 'written' }))
    buildTools.mockReturnValue([
      defineTool({
        name: 'read_state',
        namespace: 'asset',
        description: 'read',
        input: z.object({}),
        risk: 'safe',
        execute: async () => ({ text: 'read' })
      }),
      defineTool({
        name: 'write_state',
        namespace: 'asset',
        description: 'write',
        input: z.object({}),
        risk: 'mutating',
        execute: write
      })
    ])
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('read_state', {}, { id: 'r1' }),
        fauxToolCall('write_state', {}, { id: 'w1' })
      ]),
      fauxAssistantMessage([fauxToolCall('write_state', {}, { id: 'w2' })]),
      fauxAssistantMessage('done')
    ])

    const result = await runSubAgent(parent, { prompt: 'work', seedMessages: [] })

    expect(result.writeToolCalls).toEqual({ write_state: 2 })
  })

  /**
   * 子任务的结论是它自己写的，可能与事实不符（真机上三份报告互相矛盾）。
   * 审计那一行不是它写的，必须跟着结论一起进父 agent 的上下文。
   */
  it('task 把写操作审计拼进返回正文', async () => {
    buildTools.mockReturnValue([
      defineTool({
        name: 'write_state',
        namespace: 'asset',
        description: 'write',
        input: z.object({}),
        risk: 'mutating',
        execute: async () => ({ text: 'written' })
      })
    ])
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_state', {}, { id: 'w1' })]),
      fauxAssistantMessage('已修复：挪开了 14 个物件')
    ])
    const task = createTaskTool({
      getParentMessages: () => [],
      runSubAgent: (input) => runSubAgent(parent, input)
    })

    const outcome = await task.execute('t', { prompt: 'fix it', context_mode: 'fresh' })
    const text = outcome.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')

    expect(text).toContain('已修复：挪开了 14 个物件')
    expect(text).toContain('write_state ×1')
  })
})
