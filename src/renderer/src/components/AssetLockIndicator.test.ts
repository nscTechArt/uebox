import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

import AssetLockIndicator from './AssetLockIndicator.vue'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import zhCN from '@renderer/i18n/locales/zh-CN'

/** 主进程报上来的锁主是内核 session id，不是界面上那条对话的 id */
const AGENT_SID = 'agent-b04ba478'

function stubLocks(
  locks: Array<{ path: string; owner: string; connectionId?: string }>,
  projects: Array<{ connectionId: string; projectName: string }> = []
): void {
  Object.assign(window.api as unknown as Record<string, unknown>, {
    websocket: { getProjects: vi.fn().mockResolvedValue(projects) },
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
  it('把锁主的内核 session id 换成用户认得的对话标题', async () => {
    const store = useChatSessionsStore()
    store.createSession('chat-1', 'ToonFace 脸部材质')
    store.setAgentSessionId('chat-1', AGENT_SID)
    stubLocks([{ path: '/Game/ToonFace/M_ToonFace', owner: AGENT_SID }])

    const wrapper = await mountIndicator()

    // 之前这里显示的是「另一条会话」—— 锁主拿去按界面 id 查，永远查不到
    expect(wrapper.get('.lock-owner').text()).toBe('ToonFace 脸部材质')
    expect(wrapper.text()).not.toContain(zhCN.assetLock.unknownChat)

    // 点会话名跳过去
    await wrapper.get('.lock-owner').trigger('click')
    expect(push).toHaveBeenCalledWith({ name: 'AssistantWelcome', query: { sid: 'chat-1' } })
  })

  it('查不到锁主时什么都不写，而不是断言它属于另一条对话', async () => {
    stubLocks([{ path: '/Game/ToonFace/M_ToonFace', owner: 'agent-谁也不认识' }])

    const wrapper = await mountIndicator()

    expect(wrapper.find('.lock-owner').exists()).toBe(false)
    expect(wrapper.text()).not.toContain(zhCN.assetLock.unknownChat)
  })
  it('资产只显示名字，完整路径放在 hover 里', async () => {
    stubLocks([{ path: '/Game/NightCity/Maps/L_PursuitSet', owner: 'x' }])

    const wrapper = await mountIndicator()

    const path = wrapper.get('.lock-path')
    expect(path.text()).toBe('L_PursuitSet')
    expect(path.attributes('title')).toBe('/Game/NightCity/Maps/L_PursuitSet')
  })

  it('按锁所在连接标出工程名，查不到连接时退回会话上记的工程', async () => {
    const store = useChatSessionsStore()
    store.createSession('chat-2', '追车戏')
    store.setAgentSessionId('chat-2', AGENT_SID)
    store.setProject('chat-2', { projectName: 'OldProject' })
    stubLocks(
      [
        { path: '/Game/A', owner: AGENT_SID, connectionId: 'c1' },
        { path: '/Game/B', owner: AGENT_SID, connectionId: 'gone' }
      ],
      [{ connectionId: 'c1', projectName: 'NightCity' }]
    )

    const wrapper = await mountIndicator()
    await flushPromises()

    expect(wrapper.findAll('.lock-project').map((el) => el.text())).toEqual([
      'NightCity',
      'OldProject'
    ])
  })
})
