import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ChatLog from './ChatLog.vue'

/**
 * 事件连线测试：AIBubble.actions.test.ts 只测到气泡发出 branch，这里补中间一段 ——
 * ChatLog 声明了 branch、把气泡的 branch 原样上抛。页面那头由 Welcome.events.test.ts 兜住。
 */

/** 点击即发出 branch 的气泡桩，id 用 ChatLog 传进来的消息 id */
const BranchBubbleStub = {
  props: ['id'],
  template: '<button class="branch-stub" @click="$emit(\'branch\', { id })" />'
}

function mountLog(): ReturnType<typeof mount> {
  return mount(ChatLog, {
    props: {
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '上一条回复'
        }
      ]
    },
    global: {
      stubs: {
        AIBubble: BranchBubbleStub,
        UserBubble: true,
        SensitiveActionConfirm: true
      }
    }
  })
}

describe('ChatLog 分支事件连线', () => {
  it('气泡发出的 branch 原样上抛，载荷不变', async () => {
    const wrapper = mountLog()

    await wrapper.find('button.branch-stub').trigger('click')

    expect(wrapper.emitted('branch')?.[0]?.[0]).toEqual({ id: 'assistant-1' })
  })
})
