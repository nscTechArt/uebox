import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@earendil-works/pi-agent-core'

import { createProjectionState, projectEvent, type AgentV3Event } from './eventBridge'

const SID = 'session-1'
const project = (event: unknown): AgentV3Event[] => projectEvent(event as AgentEvent, SID)

/** 增量事件的壳子，测试里只关心里面那条 assistantMessageEvent */
const update = (assistantMessageEvent: unknown): unknown => ({
  type: 'message_update',
  message: { role: 'assistant' },
  assistantMessageEvent
})

describe('projectEvent', () => {
  it('agent_start → agent-v3:start', () => {
    expect(project({ type: 'agent_start' })).toEqual([
      { channel: 'agent-v3:start', payload: { sessionId: SID } }
    ])
  })

  it('message_end 抽出文本块，忽略其他内容类型', () => {
    const events = project({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先看看图表' },
          { type: 'text', text: '已创建' },
          { type: 'toolCall', id: 'c1', name: 'material_create' },
          { type: 'text', text: '材质。' }
        ]
      }
    })

    expect(events).toEqual([
      { channel: 'agent-v3:text', payload: { sessionId: SID, text: '已创建材质。' } }
    ])
  })

  // 真实模型第一轮就暴露的 bug：pi 对用户消息也发 message_end，
  // 不判角色的话用户刚发的那句会被当成助手回复回显。
  it('用户消息不进正文通道 —— 否则会把用户自己的话当成 AI 回复', () => {
    const events = project({
      type: 'message_end',
      message: { role: 'user', content: '帮我做件事' }
    })

    expect(events.some((event) => event.channel === 'agent-v3:text')).toBe(false)
  })

  /**
   * 插话回执。pi 把排队的插话注入对话时为它发一条用户 message_end ——
   * 那是「模型真的看见了」的唯一确凿信号，steer 那个 IPC 的 success
   * 只代表入队成功。渲染层拿它把界面上那句话标成已生效。
   */
  it('用户消息投到单独的通道，给插话打回执', () => {
    expect(
      project({
        type: 'message_end',
        message: { role: 'user', content: '别用 legacy 映射，走增强输入' }
      })
    ).toEqual([
      {
        channel: 'agent-v3:user-message',
        payload: { sessionId: SID, text: '别用 legacy 映射，走增强输入' }
      }
    ])
  })

  /**
   * 回执是按**文本相等**匹配的（`agentStream.markSteerApplied`）：界面上存着用户
   * 打的原话，而模型收到的是「闪存块 + 原话」。不剥的话两边永远对不上，那条插话
   * 会一直显示「未生效」—— 而它其实早就进上下文了。
   */
  it('用户消息投出去之前剥掉闪存块，只留用户真正说的那句', () => {
    const withBlock = [
      '<editor-snapshot captured_at="2026-09-07T14:21:33.000Z" project="MyGame">',
      'last_active_asset_editor: blueprint BP_Player (/Game/BP_Player)',
      'selected_nodes: none',
      'selected_actors: none',
      'content_browser: none',
      '</editor-snapshot>',
      '',
      '把这个改成 Lerp'
    ].join('\n')

    expect(project({ type: 'message_end', message: { role: 'user', content: withBlock } })).toEqual(
      [{ channel: 'agent-v3:user-message', payload: { sessionId: SID, text: '把这个改成 Lerp' } }]
    )
  })

  /**
   * 带图的插话前面还多一个附件块（图落盘之后的路径）。同一个理由：不剥的话
   * 那条插话会一直显示「未生效」，而它早就进上下文了。
   */
  it('闪存块和附件块一起剥，图片块不当正文', () => {
    const content = [
      {
        type: 'text',
        text: [
          '<editor-snapshot captured_at="2026-09-07T14:21:33.000Z" project="MyGame">',
          'selected_actors: none',
          '</editor-snapshot>',
          '',
          '<attachments>',
          'The user attached 1 image(s) to this message. You can see them directly above.',
          '1. C:/tmp/a.png',
          '</attachments>',
          '',
          '照着这张改'
        ].join('\n')
      },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    ]

    expect(project({ type: 'message_end', message: { role: 'user', content } })).toEqual([
      { channel: 'agent-v3:user-message', payload: { sessionId: SID, text: '照着这张改' } }
    ])
  })

  it('toolResult 消息也不投影', () => {
    expect(
      project({
        type: 'message_end',
        message: { role: 'toolResult', content: [{ type: 'text', text: '工具输出' }] }
      })
    ).toEqual([])
  })

  /**
   * pi 的 StreamFn 契约：**不得抛异常，失败编码进事件流** ——
   * 表现为一条 stopReason=error 的助手消息。
   *
   * 不看这两个字段的话，模型调不通时 agent.prompt() 正常返回、IPC 报 success、
   * 界面一片空白。真实模型第一次跑就撞上了（四条验证全是 0 次调用却"成功"）。
   */
  it('模型报错时投影成 error，而不是被当作空回复丢掉', () => {
    expect(
      project({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Model Not Exist'
        }
      })
    ).toEqual([
      { channel: 'agent-v3:error', payload: { sessionId: SID, message: 'Model Not Exist' } }
    ])
  })

  it('报错但没给原因时也要发事件，附带兜底文案', () => {
    const events = project({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error' }
    })
    expect(events[0].channel).toBe('agent-v3:error')
    expect((events[0].payload as { message: string }).message).toContain('失败')
  })

  // 用户按下停止 → agent.abort() → stopReason=aborted。
  // 那是意图达成不是故障，投到 error 会让用户点了停止反被告知出错。
  it('用户主动停止投影成 stopped，不是 error', () => {
    expect(
      project({
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason: 'aborted' }
      })
    ).toEqual([{ channel: 'agent-v3:stopped', payload: { sessionId: SID } }])
  })

  it('message_end 没有文本时不发事件（避免界面出现空气泡）', () => {
    expect(
      project({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'x' }] }
      })
    ).toEqual([])
  })

  it('tool_execution_start 带上参数供界面展示', () => {
    expect(
      project({
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'material_create',
        args: { material_name: 'M_Test' }
      })
    ).toEqual([
      {
        channel: 'agent-v3:tool-call',
        payload: {
          sessionId: SID,
          toolCallId: 'c1',
          toolName: 'material_create',
          args: { material_name: 'M_Test' }
        }
      }
    ])
  })

  it('tool_execution_update → tool-progress（V2 没有的能力）', () => {
    const events = project({
      type: 'tool_execution_update',
      toolCallId: 'c1',
      toolName: 'asset_import',
      args: {},
      partialResult: { content: [{ type: 'text', text: '12/50' }] }
    })

    expect(events[0].channel).toBe('agent-v3:tool-progress')
  })

  it('tool_execution_end 拆出文本与结构化 details', () => {
    expect(
      project({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'material_create',
        isError: false,
        result: {
          content: [{ type: 'text', text: '已创建 M_Test' }],
          details: { material_path: '/Game/Materials/M_Test' }
        }
      })
    ).toEqual([
      {
        channel: 'agent-v3:tool-result',
        payload: {
          sessionId: SID,
          toolCallId: 'c1',
          toolName: 'material_create',
          isError: false,
          text: '已创建 M_Test',
          details: { material_path: '/Game/Materials/M_Test' }
        }
      }
    ])
  })

  it('工具失败时保留 isError 供界面标红', () => {
    const events = project({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'material_compile',
      isError: true,
      result: { content: [{ type: 'text', text: '编译失败' }] }
    })

    expect(events[0].payload).toMatchObject({ isError: true, text: '编译失败' })
  })

  it('turn_end 没有用量时只发 step', () => {
    expect(project({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] })).toEqual([
      { channel: 'agent-v3:step', payload: { sessionId: SID } }
    ])
  })

  it('turn_end 带用量时补发 turn-usage，total 是四项之和', () => {
    expect(
      project({
        type: 'turn_end',
        message: {
          role: 'assistant',
          usage: {
            input: 12_000,
            output: 480,
            cacheRead: 1024,
            cacheWrite: 96,
            totalTokens: 99_999,
            cost: { total: 0.0031 }
          }
        },
        toolResults: []
      })
    ).toEqual([
      { channel: 'agent-v3:step', payload: { sessionId: SID } },
      {
        channel: 'agent-v3:turn-usage',
        payload: {
          sessionId: SID,
          input: 12_000,
          output: 480,
          cacheRead: 1024,
          cacheWrite: 96,
          total: 13_600,
          cost: 0.0031
        }
      }
    ])
  })

  /**
   * `task` 是子 agent 工具，它烧掉的 token 记在**工具结果**上而不是助手消息里。
   * 只看助手消息的话，一个「派子任务改十个材质」的回合会显示成几百 token，
   * 而账单上是几万。
   */
  it('子 agent 挂在工具结果上的用量也要算进这一轮', () => {
    const events = project({
      type: 'turn_end',
      message: { role: 'assistant', usage: { input: 100, output: 20, cost: { total: 0.25 } } },
      toolResults: [
        { role: 'toolResult', usage: { input: 5000, output: 300, cost: { total: 0.5 } } },
        { role: 'toolResult' }
      ]
    })

    expect(events[1].payload).toMatchObject({
      input: 5100,
      output: 320,
      total: 5420,
      cost: 0.75
    })
  })

  it('agent_end → done', () => {
    expect(project({ type: 'agent_end', messages: [] })).toEqual([
      { channel: 'agent-v3:done', payload: { sessionId: SID } }
    ])
  })

  it('未投影的事件返回空数组而不是抛错', () => {
    // pi 升级新增事件类型时，这里必须静默忽略 —— 抛错会把整个 agent 带崩。
    expect(project({ type: 'some_future_event' })).toEqual([])
    expect(project({ type: 'turn_start' })).toEqual([])
  })
})

/**
 * 流式投影。
 *
 * 没有它的时候，界面从发出消息到第一条工具调用之间是**盲区**：只有「思考中」
 * 三个字，模型想两分钟就空转两分钟。正文和推理都要边生成边发出去。
 *
 * 记账（哪条消息流出去多少）是这一段的核心：增量和终稿说的是同一条消息，
 * 两边都发一遍的话，用户会看到每句话出现两次。
 */
describe('projectEvent 流式增量', () => {
  it('正文增量按条发出去，界面才有东西可显示', () => {
    const state = createProjectionState()

    expect(
      projectEvent(update({ type: 'text_delta', delta: '已创建' }) as AgentEvent, SID, state)
    ).toEqual([{ channel: 'agent-v3:text', payload: { sessionId: SID, text: '已创建' } }])
    expect(
      projectEvent(update({ type: 'text_delta', delta: '材质。' }) as AgentEvent, SID, state)
    ).toEqual([{ channel: 'agent-v3:text', payload: { sessionId: SID, text: '材质。' } }])
  })

  /**
   * 推理内容以前**一条都发不出来** —— `agent-v3:thinking` 这个通道存在，
   * 但没有任何东西往里发。界面上那个「思考过程」折叠块因此永远是空的。
   */
  it('推理增量走 thinking 通道，不混进正文', () => {
    const state = createProjectionState()

    expect(
      projectEvent(
        update({ type: 'thinking_delta', delta: '先看看工程' }) as AgentEvent,
        SID,
        state
      )
    ).toEqual([{ channel: 'agent-v3:thinking', payload: { sessionId: SID, text: '先看看工程' } }])
  })

  it('空增量不发事件', () => {
    const state = createProjectionState()
    expect(
      projectEvent(update({ type: 'text_delta', delta: '' }) as AgentEvent, SID, state)
    ).toEqual([])
  })

  it('toolcall / start / end 这些增量不投影', () => {
    const state = createProjectionState()
    expect(
      projectEvent(update({ type: 'toolcall_delta', delta: '{' }) as AgentEvent, SID, state)
    ).toEqual([])
    expect(projectEvent(update({ type: 'text_start' }) as AgentEvent, SID, state)).toEqual([])
    expect(
      projectEvent(update({ type: 'text_end', content: '已创建材质。' }) as AgentEvent, SID, state)
    ).toEqual([])
  })

  /** 流过一遍的正文不能在终稿里再发一遍，否则界面上每句话都是两遍 */
  it('终稿只补增量没发过的那一截', () => {
    const state = createProjectionState()
    projectEvent(update({ type: 'text_delta', delta: '已创建' }) as AgentEvent, SID, state)

    expect(
      projectEvent(
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '已创建材质。' }] }
        } as unknown as AgentEvent,
        SID,
        state
      )
    ).toEqual([{ channel: 'agent-v3:text', payload: { sessionId: SID, text: '材质。' } }])
  })

  it('增量已经把话说完时，终稿什么都不发', () => {
    const state = createProjectionState()
    projectEvent(update({ type: 'text_delta', delta: '已创建材质。' }) as AgentEvent, SID, state)

    expect(
      projectEvent(
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '已创建材质。' }] }
        } as unknown as AgentEvent,
        SID,
        state
      )
    ).toEqual([])
  })

  /** provider 不支持流式（一个增量都没来过）时，行为和以前完全一样 */
  it('没有增量的 provider 仍然在终稿一次性拿到全文', () => {
    const state = createProjectionState()

    expect(
      projectEvent(
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '已创建材质。' }] }
        } as unknown as AgentEvent,
        SID,
        state
      )
    ).toEqual([{ channel: 'agent-v3:text', payload: { sessionId: SID, text: '已创建材质。' } }])
  })

  it('一条消息说完之后记账清零，下一条重新从头流', () => {
    const state = createProjectionState()
    projectEvent(update({ type: 'text_delta', delta: '第一条' }) as AgentEvent, SID, state)
    projectEvent(
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '第一条' }] }
      } as unknown as AgentEvent,
      SID,
      state
    )

    expect(
      projectEvent(
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '第二条' }] }
        } as unknown as AgentEvent,
        SID,
        state
      )
    ).toEqual([{ channel: 'agent-v3:text', payload: { sessionId: SID, text: '第二条' } }])
  })

  it('message_start 清零记账，且自己不投影', () => {
    const state = createProjectionState()
    projectEvent(update({ type: 'text_delta', delta: '半截' }) as AgentEvent, SID, state)

    expect(
      projectEvent(
        { type: 'message_start', message: { role: 'assistant' } } as unknown as AgentEvent,
        SID,
        state
      )
    ).toEqual([])
    expect(state.streamedText).toBe('')
  })

  /**
   * 用户按停止时终稿和流过的内容对不上是常态（话说到一半被截断）。
   * 这时该发的是 stopped，不是把半截正文再补一遍。
   */
  it('中止时不补正文，只发 stopped', () => {
    const state = createProjectionState()
    projectEvent(update({ type: 'text_delta', delta: '正在建' }) as AgentEvent, SID, state)

    expect(
      projectEvent(
        {
          type: 'message_end',
          message: { role: 'assistant', content: [], stopReason: 'aborted' }
        } as unknown as AgentEvent,
        SID,
        state
      )
    ).toEqual([{ channel: 'agent-v3:stopped', payload: { sessionId: SID } }])
    expect(state.streamedText).toBe('')
  })

  /** 终稿和流过的内容对不上（理论上不该发生）：宁可少一截也不重复一遍 */
  it('终稿对不上流过的内容时什么都不发', () => {
    const state = createProjectionState()
    projectEvent(update({ type: 'text_delta', delta: '完全不同的开头' }) as AgentEvent, SID, state)

    expect(
      projectEvent(
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '已创建材质。' }] }
        } as unknown as AgentEvent,
        SID,
        state
      )
    ).toEqual([])
  })
})
