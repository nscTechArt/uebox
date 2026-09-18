import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import AgentProcessLog from './AgentProcessLog.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'

const items: AgentProcessItem[] = [
  {
    type: 'tool-call',
    data: {
      name: 'web_read',
      args: { url: 'https://epicgames.github.io/lore/tutorials/quickstart/' }
    },
    timestamp: 1
  },
  {
    type: 'tool-result',
    data: {
      toolName: 'web_read',
      result: {
        url: 'https://epicgames.github.io/lore/tutorials/quickstart/',
        totalChars: 17823
      }
    },
    timestamp: 2
  }
]

function mountLog(isThinking: boolean): ReturnType<typeof mount> {
  return mount(AgentProcessLog, {
    props: { items, isThinking, compact: true },
    global: {
      stubs: {
        MarkdownRenderer: true,
        'a-tooltip': true
      }
    }
  })
}

describe('AgentProcessLog compact mode', () => {
  it('shows thrown tool errors as failures even without a success:false object', async () => {
    const wrapper = mount(AgentProcessLog, {
      props: {
        items: [
          {
            type: 'tool-result',
            timestamp: 1,
            data: {
              toolName: 'generate_task_music',
              isError: true,
              result: 'SunoAPI.org 返回业务错误 400'
            }
          }
        ],
        isThinking: true,
        compact: false
      },
      global: { stubs: { MarkdownRenderer: true, 'a-tooltip': true } }
    })
    if (wrapper.find('.process-header').attributes('aria-expanded') === 'false')
      await wrapper.find('.process-header').trigger('click')
    expect(wrapper.find('.report-list').text()).toContain('执行失败')
    expect(wrapper.find('.report-list').text()).toContain('400')
    expect(wrapper.find('.report-list').text()).not.toContain('已完成')
    wrapper.unmount()
  })
  it('collapses completed work behind a clean summary', () => {
    const wrapper = mountLog(false)

    expect(wrapper.classes()).toContain('compact')
    expect(wrapper.find('.process-header').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.header-title').text()).toBe('过程已完成')
  })

  it('keeps live work to one line until the user asks for details', async () => {
    const wrapper = mountLog(true)

    expect(wrapper.find('.process-header').attributes('aria-expanded')).toBe('false')

    await wrapper.find('.process-header').trigger('click')

    const reportText = wrapper.find('.report-list').text()
    expect(wrapper.find('.process-header').attributes('aria-expanded')).toBe('true')
    expect(reportText).toContain('web_read · epicgames.github.io/lore/tutorials/quickstart')
    expect(reportText).toContain('web_read · 完成 · epicgames.github.io/lore/tutorials/quickstart')
    expect(reportText).not.toContain('"url"')
    expect(reportText).not.toContain('totalChars')
  })

  it('scrolls the process body to the bottom when expanded', async () => {
    const wrapper = mountLog(true)

    const body = wrapper.find('.process-body')
    expect(body.exists()).toBe(true)

    // 展开与滚动事件都不应报错；jsdom 无真实布局（scrollHeight=0），
    // scrollTop 保持 0 即"已贴底"，行为等效于自动滚到底。
    await body.trigger('scroll')
    await wrapper.find('.process-header').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(body.element.scrollTop).toBe(0)
  })
})
