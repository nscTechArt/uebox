import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import AgentProcessLog from './AgentProcessLog.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'

function call(callId: string, prompt: string, timestamp: number): AgentProcessItem {
  return {
    type: 'tool-call',
    data: {
      id: callId,
      type: 'function',
      function: { name: 'task', arguments: JSON.stringify({ prompt }) }
    },
    timestamp
  }
}

function progress(callId: string, text: string, timestamp: number): AgentProcessItem {
  return {
    type: 'notify-users',
    data: {
      message: `子任务：${text}`,
      notifyType: 'progress',
      toolCallId: callId,
      toolName: 'task'
    },
    timestamp
  }
}

const parallelItems: AgentProcessItem[] = [
  call('call-a', '盘点能用的模型，按用途列清楚', 1000),
  call('call-b', '检查材质球里的重复贴图', 1100),
  progress('call-a', '调用 ue_get_actor', 2000),
  progress('call-b', '调用 ue_get_actor', 2100)
]

function mountLog(items: AgentProcessItem[], isThinking = true): ReturnType<typeof mount> {
  return mount(AgentProcessLog, {
    props: { items, isThinking },
    global: { stubs: { MarkdownRenderer: true, 'a-tooltip': true } }
  })
}

describe('AgentProcessLog 子任务泳道', () => {
  it('两路并行各占一张卡，标题和进度分得开', async () => {
    const wrapper = mountLog(parallelItems)
    await wrapper.find('.process-header').trigger('click')

    const cards = wrapper.findAll('.subtask-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].find('.subtask-label').text()).toBe('子任务 1')
    expect(cards[0].find('.subtask-title').text()).toBe('盘点能用的模型，按用途列清楚')
    expect(cards[1].find('.subtask-label').text()).toBe('子任务 2')
    expect(cards[1].find('.subtask-title').text()).toBe('检查材质球里的重复贴图')

    // 进度只留在自己那张卡上，且不再单独成行
    expect(cards[0].find('.subtask-detail-text').text()).toBe('调用 ue_get_actor')
    expect(wrapper.findAll('.report-item')).toHaveLength(0)
  })

  it('点开卡片能看到派出去的完整任务书', async () => {
    const prompt =
      '【这是纯只读的评审任务，你的产出是一份文字报告，不是对场景的任何改动】\n' +
      '检查主关卡里所有点光源的衰减半径\n- 超出房间尺寸的列出来'
    const wrapper = mountLog([call('call-a', prompt, 1000)])
    await wrapper.find('.process-header').trigger('click')

    const card = wrapper.find('.subtask-card')
    // 框架说明三路都一样，标题得取到真正区分这一路的那句
    expect(card.find('.subtask-title').text()).toBe('检查主关卡里所有点光源的衰减半径')
    expect(card.find('.subtask-prompt').exists()).toBe(false)

    await card.find('.subtask-head').trigger('click')
    expect(card.find('.subtask-prompt').text()).toContain('超出房间尺寸的列出来')
    expect(card.find('.subtask-head').attributes('aria-expanded')).toBe('true')

    await card.find('.subtask-head').trigger('click')
    expect(card.find('.subtask-prompt').exists()).toBe(false)
  })

  it('收起时表头直说有几路在并行', () => {
    const wrapper = mountLog(parallelItems)

    expect(wrapper.find('.process-header').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.header-title').text()).toBe('2 路子任务并行中')
  })

  it('跑完的那一路收口成结论，失败的单独标出来', async () => {
    const wrapper = mountLog(
      [
        ...parallelItems,
        {
          type: 'tool-result',
          data: {
            toolName: 'task',
            toolCallId: 'call-a',
            result: { text: '共 12 个模型可用', messageCount: 9 }
          },
          timestamp: 5000
        },
        {
          type: 'tool-result',
          data: {
            toolName: 'task',
            toolCallId: 'call-b',
            result: { success: false, error: '引擎没连上' }
          },
          timestamp: 5200
        }
      ],
      false
    )
    await wrapper.find('.process-header').trigger('click')

    const cards = wrapper.findAll('.subtask-card')
    expect(cards[0].classes()).toContain('subtask-success')
    expect(cards[0].find('.subtask-detail-text').text()).toBe('共 12 个模型可用')
    expect(cards[0].find('.subtask-elapsed').text()).toBe('4.0s')
    expect(cards[1].classes()).toContain('subtask-failed')
    expect(cards[1].find('.subtask-detail-text').text()).toBe('引擎没连上')
  })
})
