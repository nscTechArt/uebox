import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AIBubble from './AIBubble.vue'
import { AGENT_RESUME_ACTION } from '../composables/agentHandlerShared'

const read = vi.hoisted(() => vi.fn())
const stop = vi.hoisted(() => vi.fn())
vi.mock('../composables/useReadAloud', () => ({
  useReadAloud: () => ({
    active: { value: false },
    loading: { value: false },
    label: { value: '朗读回复' },
    toggle: read,
    stop
  })
}))

function mountBubble(
  action: string,
  data: Record<string, unknown> = { sessionId: 'session-1' }
): ReturnType<typeof mount> {
  return mount(AIBubble, {
    props: {
      id: 'msg-error',
      content: '错误: Connection error.',
      status: 'done' as const,
      actionButtons: [{ label: '接着跑', action, data }]
    },
    global: {
      stubs: {
        MarkdownRenderer: true,
        AgentProcessLog: true,
        ThinkingProcess: true,
        ChatModelViewer: true,
        AssetList: true,
        MessageSources: true,
        NavigationButton: true,
        'a-button': {
          inheritAttrs: false,
          template: '<button v-bind="$attrs"><slot /></button>'
        },
        'a-tooltip': true,
        'a-dropdown': true,
        'a-menu': true,
        'a-menu-item': true,
        'a-menu-divider': true
      }
    }
  })
}

describe('AIBubble 消息动作', () => {
  beforeEach(() => {
    read.mockClear()
    stop.mockClear()
  })

  /*
   * 自动朗读不归气泡管（归应用级的 `autoReadAloud`，用例在它旁边）。
   * 气泡这边只守一条：这一条重跑了，正在念的上一版要掐掉。
   */
  it('这一条重新开跑时掐掉正在念的上一版', async () => {
    const wrapper = mountBubble('open-preview')
    expect(stop).not.toHaveBeenCalled()
    await wrapper.setProps({ status: 'typing', content: '重试中' })
    expect(stop).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ status: 'done', content: '重试后的回复。' })
    expect(stop).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('朗读按钮念的是报错前的最后一段正文，不是过程解说也不是末尾错误', async () => {
    const wrapper = mountBubble(AGENT_RESUME_ACTION)
    await wrapper.setProps({
      agentProcess: [
        { type: 'text', data: { text: '第一段正文。\n\n' }, timestamp: 1 },
        { type: 'tool-result', data: { result: '不能朗读的工具记录' }, timestamp: 2 },
        { type: 'text', data: { text: '第二段正文。' }, timestamp: 3 }
      ]
    })
    await wrapper.get('.read-aloud-tool').trigger('click')
    expect(read).toHaveBeenLastCalledWith('第二段正文。')
    wrapper.unmount()
  })
  it('回复工具栏在复制、重试和分叉会话之后提供朗读', async () => {
    const wrapper = mountBubble('open-preview')
    const tools = wrapper.findAll('.tools .tool')

    expect(tools).toHaveLength(4)
    expect(tools[3].element.tagName).toBe('BUTTON')
    expect(tools[3].attributes('aria-label')).toContain('朗读回复')
    await tools[0].trigger('click')
    await tools[1].trigger('click')
    await tools[2].trigger('click')

    expect(wrapper.emitted('copy')?.[0]?.[0]).toEqual({
      id: 'msg-error',
      content: '错误: Connection error.'
    })
    expect(wrapper.emitted('retry')?.[0]?.[0]).toEqual({
      id: 'msg-error',
      content: '错误: Connection error.'
    })
    expect(wrapper.emitted('fork')?.[0]?.[0]).toEqual({ id: 'msg-error' })
    expect(wrapper.emitted('edit')).toBeUndefined()
  })

  it('把断点续跑显示为带说明的恢复入口，并由 CTA 按钮派发原动作', async () => {
    const wrapper = mountBubble(AGENT_RESUME_ACTION, {
      sessionId: 'session-1',
      recoveryTitle: '网络连接失败',
      recoveryReason: '请检查网络、VPN、代理或服务商的 API 地址。'
    })
    const resume = wrapper.get('.resume-action')
    const resumeCta = wrapper.get('.resume-action-cta')

    expect(resume.text()).toContain('继续尝试')
    expect(resume.text()).toContain('网络连接失败')
    expect(resume.text()).toContain('请检查网络、VPN、代理或服务商的 API 地址')
    expect(resume.text()).not.toContain('处理后')
    expect(resume.element.tagName).toBe('DIV')
    expect(resumeCta.element.tagName).toBe('BUTTON')
    expect(resumeCta.find('svg').exists()).toBe(false)

    await resumeCta.trigger('click')
    expect(wrapper.emitted('action')?.[0]?.[0]).toEqual({
      id: 'msg-error',
      action: AGENT_RESUME_ACTION,
      data: {
        sessionId: 'session-1',
        recoveryTitle: '网络连接失败',
        recoveryReason: '请检查网络、VPN、代理或服务商的 API 地址。'
      }
    })
  })

  it('老消息没有错误分类时仍显示原因提示', () => {
    const wrapper = mountBubble(AGENT_RESUME_ACTION)

    expect(wrapper.get('.resume-action').text()).toContain('暂时无法确定具体原因')
  })

  it('其它消息动作仍使用普通按钮', () => {
    const wrapper = mountBubble('open-preview')

    expect(wrapper.find('.resume-action').exists()).toBe(false)
    expect(wrapper.get('.action-buttons button').text()).toBe('接着跑')
  })
})
