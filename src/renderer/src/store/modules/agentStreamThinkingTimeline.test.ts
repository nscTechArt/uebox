import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAgentStreamStore } from './agentStream'
import { splitAgentTimeline } from '@renderer/views/Assistant/composables/agentTimeline'

/**
 * 一次回答里模型会想好几轮。每一轮的推理要落在它发生的那一步，
 * 而不是全挤进顶部一个框。
 */
describe('agentStream 推理记进时间线', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('想 → 调工具 → 再想：两段推理各成一块，夹着那段过程', () => {
    const store = useAgentStreamStore()
    store.initStream('chat-1', 'agent-1', 'typing-1')

    store.appendThinking('agent-1', '先看')
    store.appendThinking('agent-1', '场景')
    store.addAgentProcess('agent-1', { type: 'tool-call', data: {}, timestamp: 1 })
    store.appendThinking('agent-1', '再改材质')

    const blocks = splitAgentTimeline(
      store.getAgentProcess('chat-1'),
      store.getCurrentThinking('chat-1')
    )
    expect(blocks.map((block) => block.kind)).toEqual(['thinking', 'process', 'thinking'])
    expect(blocks.map((block) => ('text' in block ? block.text : ''))).toEqual([
      '先看场景',
      '',
      '再改材质'
    ])
  })

  it('推理全文仍是完整的一根字符串', () => {
    const store = useAgentStreamStore()
    store.initStream('chat-1', 'agent-1', 'typing-1')

    store.appendThinking('agent-1', '先看')
    store.addAgentProcess('agent-1', { type: 'tool-call', data: {}, timestamp: 1 })
    store.appendThinking('agent-1', '再改')

    expect(store.getCurrentThinking('chat-1')).toBe('先看再改')
  })
})
