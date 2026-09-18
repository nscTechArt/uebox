import { describe, expect, it } from 'vitest'
import { voiceConversationHistory } from './voiceConversationHistory'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'

const text = (value: string): AgentProcessItem => ({
  type: 'text',
  data: { text: value },
  timestamp: 1
})
const assistant = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'a',
  role: 'assistant',
  status: 'done',
  content,
  ...extra
})

describe('voice conversation projection', () => {
  it('keeps user text and final response, excluding progress and tool/error payloads', () => {
    const final = '修复失败，文件仍未修改。要继续排查吗？'
    const result = voiceConversationHistory([
      { id: 'u', role: 'user', content: '只改这个文件' },
      assistant('先检查。' + final, {
        thinking: 'private reasoning',
        toolResults: [{ toolName: 'read', result: 'raw-error' }],
        agentProcess: [
          text('先检查。'),
          { type: 'tool-call', data: { secret: 'arguments' }, timestamp: 2 },
          { type: 'tool-result', data: { result: 'raw-error' }, timestamp: 3 },
          text(final)
        ]
      })
    ])
    expect(result).toEqual([
      { role: 'user', text: '只改这个文件' },
      { role: 'assistant', text: final }
    ])
  })
  it('keeps legacy final messages whole, including code and middle constraints', () => {
    const final = 'a'.repeat(700) + '只操作备份文件' + 'b'.repeat(700)
    expect(voiceConversationHistory([assistant(final)])).toEqual([
      { role: 'assistant', text: final }
    ])
    const explanation = '错误：之前的方案不适用。需要改用第二种方案。'
    expect(voiceConversationHistory([assistant(explanation)])[0].text).toBe(explanation)
  })
  it('does not turn streaming text or a pre-tool announcement into a final answer', () => {
    expect(
      voiceConversationHistory([
        assistant('还在读取', { status: 'typing' }),
        assistant('开始读取', {
          agentProcess: [text('开始读取'), { type: 'tool-call', data: {}, timestamp: 2 }]
        })
      ])
    ).toEqual([])
  })
  it('preserves user interventions but excludes withdrawn ones and tool details', () => {
    expect(
      voiceConversationHistory([
        assistant('完成', {
          agentProcess: [
            { type: 'user-steer', data: { text: '别删文件', applied: true }, timestamp: 1 },
            { type: 'user-steer', data: { text: '全部删除', cancelled: true }, timestamp: 2 }
          ]
        })
      ])
    ).toEqual([
      { role: 'user', text: '别删文件' },
      { role: 'assistant', text: '完成' }
    ])
  })
  it('replaces runtime error details with failure status, including legacy resumable errors', () => {
    for (const extra of [
      { outcome: 'error' as const },
      { actionButtons: [{ action: 'agent-resume', label: '继续' }] }
    ]) {
      const result = voiceConversationHistory([assistant('provider traceback SECRET', extra)])
      expect(result[0].text).toContain('执行失败')
      expect(JSON.stringify(result)).not.toContain('SECRET')
    }
    expect(
      voiceConversationHistory([assistant('已输出', { outcome: 'stopped' })])[0].text
    ).toContain('已停止')
  })
  it('keeps multimodal text without sending image data or file payloads', () => {
    const message: ChatMessage = {
      id: 'u',
      role: 'user',
      content: [
        { type: 'text', text: '这个附件' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET' } }
      ]
    }
    const result = voiceConversationHistory([message])
    expect(result[0].text).toContain('这个附件')
    expect(result[0].text).toContain('附件内容未传入')
    expect(JSON.stringify(result)).not.toContain('SECRET')
    message.content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET' } }]
    expect(voiceConversationHistory([message])[0].text).toContain('非文本附件')
  })
})
