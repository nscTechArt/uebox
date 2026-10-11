import { describe, expect, it } from 'vitest'
import { Agent, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core'
import { restoreTranscript, withoutSystemMessages, withSystemPrompt } from './systemMessages'

const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: 1 })
/** 只装历史、不发请求；pi 1.0 的 Agent 构造时必须给一个 streamFn */
const streamFn = (() => {
  throw new Error('不该发请求')
}) as unknown as StreamFn
const system = (content: string): AgentMessage =>
  ({ role: 'system', content, timestamp: 0 }) as AgentMessage

describe('restoreTranscript', () => {
  it('装历史时保住这一轮自己的提示词 —— 直接赋值 state.messages 会把它冲掉', () => {
    const agent = new Agent({ streamFn, initialState: { systemPrompt: '这一轮的提示词' } })
    restoreTranscript(agent, [user('上一轮'), user('再上一轮')])
    expect(agent.state.systemPrompt).toBe('这一轮的提示词')
    expect(agent.state.messages.map((message) => message.role)).toEqual(['system', 'user', 'user'])
  })

  it('历史里带着别人的 system 消息（父 agent 的提示词、上一轮的工具增量）一律丢掉', () => {
    const agent = new Agent({ streamFn, initialState: { systemPrompt: '子 agent 的提示词' } })
    restoreTranscript(agent, [system('父 agent 的提示词'), user('活'), system('')])
    expect(agent.state.systemPrompt).toBe('子 agent 的提示词')
    expect(agent.state.messages).toHaveLength(2)
  })

  it('没有提示词的 agent 就只装历史', () => {
    const agent = new Agent({ streamFn })
    restoreTranscript(agent, [system('旧的'), user('活')])
    expect(agent.state.messages).toEqual([user('活')])
  })
})

describe('withSystemPrompt', () => {
  it('只换开头那条的正文，工具声明不动', () => {
    const head = {
      role: 'system',
      content: '没连引擎',
      toolsAdded: [{ name: 't', description: 'd', parameters: {} }],
      timestamp: 0
    } as unknown as AgentMessage
    const next = withSystemPrompt([head, user('活')], '已连引擎')
    expect(next[0]).toEqual({ ...head, content: '已连引擎' })
    expect(next[1]).toEqual(user('活'))
  })

  it('开头没有提示词就补一条', () => {
    expect(withSystemPrompt([user('活')], '提示词')[0]).toMatchObject({
      role: 'system',
      content: '提示词'
    })
  })
})

describe('withoutSystemMessages', () => {
  it('没有 system 消息时原样返回同一个数组', () => {
    const messages = [user('活')]
    expect(withoutSystemMessages(messages)).toBe(messages)
  })
})
