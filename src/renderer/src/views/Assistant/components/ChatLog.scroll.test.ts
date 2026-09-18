import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import ChatLog from './ChatLog.vue'

function mountLog(): ReturnType<typeof mount> {
  return mount(ChatLog, {
    props: { messages: [] },
    global: {
      stubs: {
        AIBubble: true,
        UserBubble: true,
        SensitiveActionConfirm: true
      }
    }
  })
}

describe('ChatLog scroll behavior', () => {
  it('uses instant scrolling for streaming updates', () => {
    const wrapper = mountLog()
    const scrollTo = vi.fn()
    const scroller = wrapper.find('.chat-log').element as HTMLElement
    Object.defineProperty(scroller, 'scrollTo', { value: scrollTo, configurable: true })
    ;(
      wrapper.vm as unknown as { scrollToBottom: (options: { behavior: 'auto' }) => void }
    ).scrollToBottom({ behavior: 'auto' })

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' })
  })

  it('keeps smooth scrolling for an explicit user action', () => {
    const wrapper = mountLog()
    const scrollTo = vi.fn()
    const scroller = wrapper.find('.chat-log').element as HTMLElement
    Object.defineProperty(scroller, 'scrollTo', { value: scrollTo, configurable: true })
    ;(wrapper.vm as unknown as { scrollToBottom: () => void }).scrollToBottom()

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })
})
