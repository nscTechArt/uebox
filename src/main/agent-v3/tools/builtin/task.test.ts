import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

import { createTaskTool, stripPendingToolCalls, type TaskToolDeps } from './task'

const msg = (role: string, text: string): AgentMessage =>
  ({
    role,
    content: role === 'user' ? text : [{ type: 'text', text }],
    timestamp: 0
  }) as unknown as AgentMessage

const PARENT: AgentMessage[] = [
  msg('user', '把 M_Wood 的粗糙度调到 0.3'),
  msg('assistant', '我先看一下这个材质'),
  msg('user', '对了，材质在 /Game/Env/Materials 下')
]

const makeTool = (
  overrides: Partial<TaskToolDeps> = {}
): { runSubAgent: ReturnType<typeof vi.fn>; tool: ReturnType<typeof createTaskTool> } => {
  const runSubAgent = vi.fn(async () => ({ text: '完成', messageCount: 4 }))
  const deps: TaskToolDeps = {
    runSubAgent,
    getParentMessages: () => PARENT,
    ...overrides
  }
  return { runSubAgent, tool: createTaskTool(deps) }
}

/**
 * 真机复测暴露的那条：子 agent 一睁眼就看到「你的调用方派任务失败了」。
 *
 * 父 agent 那条 assistant 消息在工具开始执行**之前**就进了 transcript，
 * 所以继承过去的最后一条里正是「派出你自己」的那次 task 调用，没有结果；
 * pi-ai 发请求前会给孤儿调用补一条 `No result provided` 的**错误**结果。
 */
describe('stripPendingToolCalls', () => {
  const assistantWithCalls = (text: string, ids: string[]): AgentMessage =>
    ({
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...ids.map((id) => ({ type: 'toolCall', id, name: 'task', arguments: {} }))
      ],
      timestamp: 0
    }) as unknown as AgentMessage

  const toolResult = (toolCallId: string): AgentMessage =>
    ({
      role: 'toolResult',
      toolCallId,
      toolName: 'task',
      content: [{ type: 'text', text: 'done' }],
      timestamp: 0
    }) as unknown as AgentMessage

  it('摘掉没有结果的调用，正文留着', () => {
    const kept = stripPendingToolCalls([
      msg('user', '评审一下场景'),
      assistantWithCalls('我先派三路并行的评审。', ['a', 'b', 'c'])
    ])

    expect(kept).toHaveLength(2)
    expect((kept[1] as { content: unknown[] }).content).toEqual([
      { type: 'text', text: '我先派三路并行的评审。' }
    ])
  })

  it('已经有结果的调用原样保留', () => {
    const source = [
      msg('user', '看一下'),
      assistantWithCalls('查一下', ['done-1']),
      toolResult('done-1')
    ]

    expect(stripPendingToolCalls(source)).toEqual(source)
  })

  it('只剩空壳的那条整条丢掉，不留一条没内容的消息', () => {
    const kept = stripPendingToolCalls([
      msg('user', '评审'),
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'pending', name: 'task', arguments: {} }],
        timestamp: 0
      } as unknown as AgentMessage
    ])

    expect(kept).toHaveLength(1)
  })
})

describe('task 子 agent 工具', () => {
  // 这是 V3 相对 V2 最关键的一处差异。V2 的 route_to_specialist 只能传一个
  // 字符串，工具描述里明写着「专家无法看到对话历史！」，每次委派都丢信息。
  it('默认把父 agent 的完整 transcript 传给子 agent，而不是字符串', async () => {
    const { runSubAgent, tool } = makeTool()

    await tool.execute('c1', { prompt: '调整粗糙度' })

    expect(runSubAgent).toHaveBeenCalledTimes(1)
    expect(runSubAgent.mock.calls[0][0].seedMessages).toEqual(PARENT)
  })

  it('context_mode=fresh 时不带任何历史', async () => {
    const { runSubAgent, tool } = makeTool()

    await tool.execute('c1', { prompt: '与当前对话无关的任务', context_mode: 'fresh' })

    expect(runSubAgent.mock.calls[0][0].seedMessages).toEqual([])
  })

  it('context_mode=summary 时传摘要', async () => {
    const summarize = vi.fn(async () => '用户想改 /Game/Env/Materials/M_Wood 的粗糙度')
    const { runSubAgent, tool } = makeTool({ summarize })

    await tool.execute('c1', { prompt: '继续', context_mode: 'summary' })

    expect(summarize).toHaveBeenCalledWith(PARENT, undefined)
    const seed = runSubAgent.mock.calls[0][0].seedMessages
    expect(seed).toHaveLength(1)
    expect(String((seed[0] as { content: string }).content)).toContain('M_Wood')
  })

  it('摘要不可用时退回完整上下文，而不是静默丢光背景', async () => {
    // 丢光背景会让子 agent 在没有前提的情况下瞎干 —— 正是 V2 的病根
    const { runSubAgent, tool } = makeTool({ summarize: undefined })

    await tool.execute('c1', { prompt: '继续', context_mode: 'summary' })

    expect(runSubAgent.mock.calls[0][0].seedMessages).toEqual(PARENT)
  })

  it('透传命名空间白名单', async () => {
    const { runSubAgent, tool } = makeTool()

    await tool.execute('c1', { prompt: '审查', namespaces: ['ue.material'] })

    expect(runSubAgent.mock.calls[0][0].namespaces).toEqual(['ue.material'])
  })

  it('省略 namespaces 时继承全部工具', async () => {
    const { runSubAgent, tool } = makeTool()

    await tool.execute('c1', { prompt: '随便做点什么' })

    expect(runSubAgent.mock.calls[0][0].namespaces).toBeUndefined()
  })

  it('子 agent 进度实时冒泡给界面', async () => {
    const runSubAgent = vi.fn(async (input: Parameters<TaskToolDeps['runSubAgent']>[0]) => {
      input.onProgress?.('调用 material_get_graph')
      return { text: '完成', messageCount: 2 }
    })
    const tool = createTaskTool({ runSubAgent, getParentMessages: () => PARENT })

    const onUpdate = vi.fn()
    await tool.execute('c1', { prompt: 'x' }, undefined, onUpdate)

    expect(onUpdate).toHaveBeenCalled()
  })

  it('返回子 agent 的结论文本加一行写操作审计，中间过程只进 details', async () => {
    const { tool } = makeTool()

    const result = await tool.execute('c1', { prompt: 'x' })

    // 审计那一行必须在正文里：details 模型看不到，写在那儿等于没给
    expect(result.content).toEqual([
      { type: 'text', text: '完成\n\n【本次子任务的写操作】无，它只调用了只读工具。' }
    ])
    expect(result.details).toEqual({ text: '完成', messageCount: 4 })
  })

  it('read_only 一路传到 runSubAgent，不传就是普通子任务', async () => {
    const { runSubAgent, tool } = makeTool()

    await tool.execute('c1', { prompt: '评审一下这个场景', read_only: true })
    expect(runSubAgent.mock.calls[0][0].readOnly).toBe(true)

    await tool.execute('c2', { prompt: '把材质改了' })
    expect(runSubAgent.mock.calls[1][0].readOnly).toBeUndefined()
  })

  it('标为 safe 且可并发 —— 支持多个子 agent 同时跑不同视角', () => {
    const { tool } = makeTool()

    expect(tool.unrealBox.risk).toBe('safe')
    expect((tool as { executionMode?: string }).executionMode).toBe('parallel')
  })
})

/**
 * 2026-09-24 用户反馈：子任务被停下，父 agent 只拿到「不代表它没执行，先回读现场」，
 * 不知道回读什么 —— 搜了 55 项资产、读了蓝图、AnimGraph 和 CDO 才确认骨架、网格、
 * 三个蒙太奇早就落地了。停下那一刻就要把已经发生和在途的写操作交出去。
 */
describe('task 被停下时交出写操作台账', () => {
  it('已完成和在途的写操作连同对象进中止信息', async () => {
    const controller = new AbortController()
    const { tool } = makeTool({
      runSubAgent: vi.fn(async (input) => {
        input.ledger?.start('c1', 'ue_create_asset', { asset_path: '/Game/Zombie/SK_Male' })
        input.ledger?.end('c1', true)
        input.ledger?.start('c2', 'blueprint_apply_graph', {
          blueprint_path: '/Game/Zombie/ABP_Male'
        })
        input.ledger?.start('c3', 'ue_get_actor', {})
        input.ledger?.end('c3', false)
        setTimeout(() => controller.abort(), 0)
        return new Promise(() => {})
      }) as TaskToolDeps['runSubAgent']
    })

    const error = await tool
      .execute('t', { prompt: '接小怪动画' }, controller.signal)
      .catch((e: Error) => e)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('不代表它没执行')
    expect(message).toContain('已完成（已经生效）：ue_create_asset ×1（/Game/Zombie/SK_Male）')
    expect(message).toContain('在途')
    expect(message).toContain('blueprint_apply_graph ×1（/Game/Zombie/ABP_Male）')
    expect(message).not.toContain('ue_get_actor')
  })

  it('只读子任务停下时说清楚它不可能写过', async () => {
    const controller = new AbortController()
    const { tool } = makeTool({
      runSubAgent: vi.fn(async () => {
        setTimeout(() => controller.abort(), 0)
        return new Promise(() => {})
      }) as TaskToolDeps['runSubAgent']
    })

    const error = await tool
      .execute('t', { prompt: '评审', read_only: true }, controller.signal)
      .catch((e: Error) => e)

    expect((error as Error).message).toContain('只读模式')
  })

  it('正常结束时写操作那一行带上对象', async () => {
    const { tool } = makeTool({
      runSubAgent: vi.fn(async (input) => {
        input.ledger?.start('c1', 'material_apply', { targets: { names: ['BossA'] } })
        input.ledger?.end('c1', true)
        return {
          text: '换好了',
          messageCount: 3,
          writeToolCalls: input.ledger?.counts() ?? {},
          writes: input.ledger?.list() ?? []
        }
      }) as TaskToolDeps['runSubAgent']
    })

    const result = await tool.execute('t', { prompt: '换材质' })
    expect(JSON.stringify(result.content)).toContain('material_apply ×1（BossA）')
  })
})
