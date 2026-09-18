/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import type { AgentMessage } from '@earendil-works/pi-agent-core'

import {
  isUserAbort,
  planResume,
  repairPendingQuestions,
  trimDanglingToolCalls,
  trimForResume
} from './resume'

const user = (text: string): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }) as unknown as AgentMessage

const assistant = (text: string, stopReason = 'endTurn'): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    timestamp: 0
  }) as unknown as AgentMessage

/** 模型调不通时 pi 压进 transcript 的那条：内容为空，只有 stopReason */
const failed = (): AgentMessage =>
  ({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: '401 Unauthorized',
    timestamp: 0
  }) as unknown as AgentMessage

const aborted = (): AgentMessage =>
  ({
    role: 'assistant',
    content: [],
    stopReason: 'aborted',
    timestamp: 0
  }) as unknown as AgentMessage

const toolResult = (): AgentMessage =>
  ({
    role: 'toolResult',
    content: [{ type: 'text', text: '找到 3 个资产' }],
    timestamp: 0
  }) as unknown as AgentMessage

describe('trimForResume', () => {
  it('没有失败标记时原样返回同一个引用', () => {
    const messages = [user('造艘船'), toolResult()]
    expect(trimForResume(messages)).toBe(messages)
  })

  it('摘掉尾部的 error 标记', () => {
    expect(trimForResume([user('造艘船'), failed()])).toEqual([user('造艘船')])
  })

  // 用户按停止也是 assistant + stopReason，一样挡住续跑
  it('摘掉尾部的 aborted 标记', () => {
    expect(trimForResume([user('造艘船'), aborted()])).toEqual([user('造艘船')])
  })

  /**
   * 续跑本身也可能再失败，那会再压一条。
   * 只摘一条的话第二次点「接着跑」还是卡在同样的地方。
   */
  it('连续多条失败标记一起摘', () => {
    expect(trimForResume([user('造艘船'), failed(), aborted(), failed()])).toEqual([user('造艘船')])
  })

  // 正常收尾的回复是真实对话内容，摘了就等于删用户的历史
  it('不碰正常收尾的 assistant 回复', () => {
    const messages = [user('你好'), assistant('你好，有什么可以帮你')]
    expect(trimForResume(messages)).toBe(messages)
  })

  it('只摘尾部，中间的失败标记留着', () => {
    // 中间那条失败之后模型自己重试成功了，那段历史是真实发生过的
    const messages = [user('造艘船'), failed(), user('再试一次'), toolResult()]
    expect(trimForResume(messages)).toBe(messages)
  })

  it('空数组不炸', () => {
    expect(trimForResume([])).toEqual([])
  })
})

describe('planResume', () => {
  it('没有历史时说清楚要先发消息', () => {
    const plan = planResume([])
    expect(plan.ok).toBe(false)
    expect(plan.ok === false && plan.reason).toContain('开始对话')
  })

  /**
   * 这是续跑**最主要**的场景：上一轮模型调用失败。
   *
   * 摘掉失败标记之前，最后一条正是它 —— pi 的 continue() 会直接抛
   * "Cannot continue from message role: assistant"，功能对它存在的理由完全失效。
   */
  it('上一轮报错时可以续跑，失败标记被摘掉', () => {
    const plan = planResume([user('造艘船'), failed()])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.messages).toEqual([user('造艘船')])
    expect(plan.trimmed).toBe(1)
  })

  it('用户按停止之后也能续跑', () => {
    const plan = planResume([user('造艘船'), aborted()])
    expect(plan.ok).toBe(true)
    expect(plan.ok === true && plan.trimmed).toBe(1)
  })

  // 工具跑完但应用崩了 —— 最后一条是 toolResult，本来就能续
  it('停在工具结果上时不需要摘任何东西', () => {
    const plan = planResume([user('造艘船'), toolResult()])
    expect(plan.ok).toBe(true)
    expect(plan.ok === true && plan.trimmed).toBe(0)
  })

  it('上一轮正常结束时拒绝，并说明没有断点', () => {
    const plan = planResume([user('你好'), assistant('你好')])
    expect(plan.ok).toBe(false)
    expect(plan.ok === false && plan.reason).toContain('没有可续跑的断点')
  })

  // 第一轮就没调通：摘完什么都不剩，没有"断点"这回事
  it('整个 transcript 只有失败标记时让用户重发', () => {
    const plan = planResume([failed()])
    expect(plan.ok).toBe(false)
    expect(plan.ok === false && plan.reason).toContain('重新发送')
  })
})

/**
 * 真机上删掉一条正在跑的会话，界面弹了两条红字：
 * 「Agent 错误: This operation was aborted」和「This operation was aborted」。
 *
 * 删除和停止都走 `agent.abort()`，中止以 AbortError 抛出来，两条报错分别来自
 * 旧的 `agent:error` 事件和 invoke 的返回值。**用户点了删除，不该被告知出错。**
 */
describe('isUserAbort', () => {
  it('认得出 AbortError 对象', () => {
    const error = new Error('This operation was aborted')
    error.name = 'AbortError'
    expect(isUserAbort(error)).toBe(true)
  })

  // pi 把中止编码成 state.errorMessage 字符串，那一层已经没有 Error 对象可看
  it('认得出只剩文案的中止', () => {
    expect(isUserAbort('This operation was aborted')).toBe(true)
    expect(isUserAbort({ message: 'The operation was aborted.' })).toBe(true)
  })

  // 真故障必须照常报出来，否则失败会被静默吞掉，比多弹一条报错糟得多
  it('真正的失败不算中止', () => {
    expect(isUserAbort(new Error('401 Unauthorized'))).toBe(false)
    expect(isUserAbort('模型调用失败，未返回原因')).toBe(false)
    expect(isUserAbort(undefined)).toBe(false)
    expect(isUserAbort(null)).toBe(false)
  })
})

/** 带工具调用的 assistant 消息 —— 后面必须跟着对应的 toolResult，厂商要求配对 */
const callingTool = (id: string): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'material_add_node', arguments: {} }],
    stopReason: 'toolUse',
    timestamp: 0
  }) as unknown as AgentMessage

const resultFor = (id: string): AgentMessage =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'material_add_node',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: 0
  }) as unknown as AgentMessage

describe('trimDanglingToolCalls', () => {
  it('配平的对话原样返回同一个引用', () => {
    const messages = [user('做个材质'), callingTool('c1'), resultFor('c1'), assistant('做好了')]
    expect(trimDanglingToolCalls(messages)).toBe(messages)
  })

  /**
   * 侧边问一句最常撞上的就是这一刻：模型刚发出工具调用，工具还在跑。
   * 不截掉的话，拿这份消息去发请求会被厂商以「toolCall 没有配对」拒掉。
   */
  it('截掉没有结果的工具调用', () => {
    expect(trimDanglingToolCalls([user('做个材质'), callingTool('c1')])).toEqual([user('做个材质')])
  })

  it('一批工具只回来一半时，整批一起截掉', () => {
    const messages = [
      user('做个材质'),
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'a', arguments: {} },
          { type: 'toolCall', id: 'c2', name: 'b', arguments: {} }
        ],
        stopReason: 'toolUse',
        timestamp: 0
      } as unknown as AgentMessage,
      resultFor('c1')
    ]

    expect(trimDanglingToolCalls(messages)).toEqual([user('做个材质')])
  })

  it('前面配平过的部分留着 —— 只截尾巴，不是整段丢掉', () => {
    const messages = [
      user('做个材质'),
      callingTool('c1'),
      resultFor('c1'),
      assistant('先建好了'),
      callingTool('c2')
    ]

    expect(trimDanglingToolCalls(messages)).toEqual(messages.slice(0, 4))
  })

  it('一条消息都没有时不炸', () => {
    expect(trimDanglingToolCalls([])).toEqual([])
  })
})

/**
 * `ask_user` 的正常状态就是挂着等人 —— 用户去吃个饭、期间应用被关掉，
 * 盘上就留下一个没有结果的 toolCall。厂商要求两者配对，不补的话这条对话
 * 从此再也发不出消息，而「从断点继续」会回一句「上一轮已正常结束」。
 */
describe('repairPendingQuestions', () => {
  const askingUser = (id: string): AgentMessage =>
    ({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'ask_user', arguments: {} }],
      stopReason: 'toolUse',
      timestamp: 0
    }) as unknown as AgentMessage

  const answered = (id: string): AgentMessage =>
    ({
      role: 'toolResult',
      toolCallId: id,
      toolName: 'ask_user',
      content: [{ type: 'text', text: '用户的回答：\n- [用在哪] 补适配层' }],
      isError: false,
      timestamp: 0
    }) as unknown as AgentMessage

  const callingTool = (id: string, name = 'material_create'): AgentMessage =>
    ({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: {} }],
      stopReason: 'toolUse',
      timestamp: 0
    }) as unknown as AgentMessage

  const textOf = (message: AgentMessage): string =>
    (message as unknown as { content: { text?: string }[] }).content[0]?.text ?? ''

  it('给没有结果的 ask_user 补一条「没人回答」', () => {
    const repaired = repairPendingQuestions([user('帮我接个 TTS'), askingUser('q1')])

    expect(repaired).toHaveLength(3)
    const added = repaired[2] as unknown as { role: string; toolCallId: string }
    expect(added.role).toBe('toolResult')
    expect(added.toolCallId).toBe('q1')
    expect(textOf(repaired[2])).toContain('应用中途重启了')
  })

  /** 补出来的话必须写清「不知道」—— 模型不能以为用户默许了第一个选项 */
  it('补出来的结果明说不要假设用户同意了什么', () => {
    const repaired = repairPendingQuestions([askingUser('q1')])
    expect(textOf(repaired[1])).toContain('不要假设他同意了任何一个选项')
  })

  it('已经答过的不重复补，并原样返回同一个引用', () => {
    const messages = [user('x'), askingUser('q1'), answered('q1')]
    expect(repairPendingQuestions(messages)).toBe(messages)
  })

  /**
   * 只补 `ask_user`。别的工具挂在半路是意外不是常态 —— 给一个真跑了一半的
   * 写操作补假结果，模型会以为那一步做完了。
   */
  it('不碰别的工具的半截调用', () => {
    const messages = [user('x'), callingTool('c1')]
    expect(repairPendingQuestions(messages)).toBe(messages)
  })

  /** 厂商要求 toolResult 挨着它的 toolCall，一律追到末尾在多轮场景下会错位 */
  it('补在发起调用的那条 assistant 后面，而不是末尾', () => {
    const repaired = repairPendingQuestions([
      askingUser('q1'),
      user('算了，换个思路'),
      assistant('好的')
    ])

    expect((repaired[1] as unknown as { role: string }).role).toBe('toolResult')
    expect((repaired[2] as unknown as { role: string }).role).toBe('user')
  })

  /**
   * 补完之后「从断点继续」才认得出这是个断点 —— 这是修这个 bug 的全部目的。
   */
  it('补完之后 planResume 能续跑', () => {
    const raw = [user('帮我接个 TTS'), askingUser('q1')]

    expect(planResume(raw)).toEqual({
      ok: false,
      reason: '上一轮已正常结束，没有可续跑的断点'
    })

    const plan = planResume(repairPendingQuestions(raw))
    expect(plan.ok).toBe(true)
  })

  it('一条消息都没有时不炸', () => {
    expect(repairPendingQuestions([])).toEqual([])
  })
})
