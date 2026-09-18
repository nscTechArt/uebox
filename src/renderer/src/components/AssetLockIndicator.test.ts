import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import AssetLockIndicator from './AssetLockIndicator.vue'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

/** 主进程报上来的锁主是**内核**会话 id，不是界面上那条会话的 id */
const AGENT_SID = 'agent-b04ba478'

function stubLocks(locks: Array<{ path: string; owner: string }>): void {
  Object.assign(window.api as unknown as Record<string, unknown>, {
    agentV3: {
      locks: vi.fn().mockResolvedValue({
        success: true,
        locks: locks.map((lock) => ({ ...lock, acquiredAt: Date.now() }))
      }),
      releaseAllLocks: vi.fn().mockResolvedValue({ success: true })
    }
  })
}

async function mountIndicator(): Promise<VueWrapper> {
  const wrapper = mount(AssetLockIndicator) as VueWrapper
  await flushPromises()
  await wrapper.get('.summary-text').trigger('click')
  return wrapper
}

describe('AssetLockIndicator', () => {
  it('把锁主的内核会话 id 换成用户认得的会话标题', async () => {
    const store = useChatSessionsStore()
    store.createSession('chat-1', 'ToonFace 脸部材质')
    store.setAgentSessionId('chat-1', AGENT_SID)
    stubLocks([{ path: '/Game/ToonFace/M_ToonFace', owner: AGENT_SID }])

    const wrapper = await mountIndicator()

    // 之前这里显示的是「另一条会话」—— 锁主拿去按界面 id 查，永远查不到
    expect(wrapper.get('.lock-owner').text()).toBe('ToonFace 脸部材质')
    expect(wrapper.text()).not.toContain('另一条会话')
  })

  it('查不到锁主时什么都不写，而不是断言它属于另一条会话', async () => {
    stubLocks([{ path: '/Game/ToonFace/M_ToonFace', owner: 'agent-谁也不认识' }])

    const wrapper = await mountIndicator()

    expect(wrapper.find('.lock-owner').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('另一条会话')
  })
})
