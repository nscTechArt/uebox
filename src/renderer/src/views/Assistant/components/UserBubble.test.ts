import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhCopy, PhPencilSimple, PhTarget, PhUsersThree } from '@phosphor-icons/vue'
import type { ChatMessageContent } from '@renderer/store/modules/chatMessages'
import UserBubble from './UserBubble.vue'

vi.mock('@renderer/services/imageViewer', () => ({ openImageViewer: vi.fn() }))

const modes = [
  { command: 'team', label: '团队', icon: PhUsersThree },
  { command: 'goal', label: '目标', icon: PhTarget }
] as const

afterEach(() => {
  vi.useRealTimers()
})

describe('UserBubble command modes', () => {
  it.each(modes)('renders /$command as the composer icon and label', ({ command, label, icon }) => {
    const body = '做一扇门\n  保留缩进和 /team 正文'
    const wrapper = mount(UserBubble, {
      props: { id: 'sent-message', content: `/${command} ${body}` }
    })

    expect(wrapper.get('.command-mode').text()).toBe(label)
    expect(wrapper.findComponent(icon).exists()).toBe(true)
    expect(wrapper.get('.text-content').element.textContent).toBe(body)
    wrapper.unmount()
  })

  it.each(modes)('restores /$command badges with images and attachments', ({ command, label }) => {
    const content: ChatMessageContent = [
      { type: 'text', text: `/${command} 按参考图制作` },
      { type: 'image_url', image_url: { url: 'local-resource://reference.png' } },
      { type: 'text', text: '保留第二段文字' }
    ]
    const wrapper = mount(UserBubble, {
      props: {
        id: 'saved-message',
        content: JSON.parse(JSON.stringify(content)),
        mentionedSources: [{ id: 'source-1', title: '设计说明', type: 'file' }],
        excelFiles: [{ fileName: '需求.xlsx', rowCount: 3 }]
      }
    })

    expect(wrapper.get('.command-mode').text()).toBe(label)
    expect(wrapper.get('.text-content').text()).toBe('按参考图制作\n保留第二段文字')
    expect(wrapper.get('.user-image').attributes('src')).toBe('local-resource://reference.png')
    expect(wrapper.get('.source-title').text()).toBe('设计说明')
    expect(wrapper.get('.attachment-name').text()).toBe('需求.xlsx')
    expect(wrapper.props('content')).toEqual(content)
    wrapper.unmount()
  })

  it.each([
    '普通消息',
    '解释 /team 的用法',
    '/teams 做一扇门',
    '/goals 做一扇门',
    '/team',
    '/goal',
    '/team ',
    '/goal '
  ])('keeps non-mode text unchanged: %s', (content) => {
    const wrapper = mount(UserBubble, { props: { id: 'plain-message', content } })
    expect(wrapper.find('.command-mode').exists()).toBe(false)
    expect(wrapper.get('.text-content').element.textContent).toBe(content)
    wrapper.unmount()
  })

  it.each(modes)('preserves /$command when copying and editing', async ({ command }) => {
    vi.useFakeTimers()
    const content = `/${command} 做一扇门`
    const wrapper = mount(UserBubble, { props: { id: 'editable-message', content } })

    await wrapper.getComponent(PhCopy).trigger('click')
    expect(wrapper.emitted('copy')).toEqual([[{ id: 'editable-message', content }]])
    await wrapper.getComponent(PhPencilSimple).trigger('click')
    expect(wrapper.get('textarea').element.value).toBe(content)
    await wrapper.get('textarea').setValue(`/${command} 做两扇门`)
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('confirm-edit')).toEqual([
      [{ id: 'editable-message', newContent: `/${command} 做两扇门`, originalContent: content }]
    ])
    vi.runOnlyPendingTimers()
    wrapper.unmount()
  })

  it('updates the badge when message content changes', async () => {
    const wrapper = mount(UserBubble, {
      props: { id: 'updated-message', content: '/team 做一扇门' }
    })
    await wrapper.setProps({ content: '/goal 做两扇门' })
    expect(wrapper.get('.command-mode').text()).toBe('目标')
    expect(wrapper.findComponent(PhUsersThree).exists()).toBe(false)
    await wrapper.setProps({ content: '普通消息' })
    expect(wrapper.find('.command-mode').exists()).toBe(false)
    expect(wrapper.get('.text-content').text()).toBe('普通消息')
    wrapper.unmount()
  })
})
