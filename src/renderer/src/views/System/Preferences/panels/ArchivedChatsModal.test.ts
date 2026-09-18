import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import type { Router } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'

import ArchivedChatsModal from './ArchivedChatsModal.vue'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

/**
 * 归档对话。
 *
 * 侧边栏底下那个「已归档」折叠区没了，这里是唯一入口 —— 所以这一屏必须
 * 自己站得住：列出全部已归档会话、能取消归档放回列表、能彻底删掉。
 * 「彻底删掉」尤其要盯：只从列表里划一下的话，消息和内核记忆都还在盘上。
 */

const deleteSession = vi.fn().mockResolvedValue({ success: true })
const dropSession = vi.fn()

vi.mock('@renderer/store/modules/chatMessages', () => ({
  useChatMessagesStore: () => ({ dropSession })
}))

function createTestRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dev-assistant', name: 'AssistantWelcome', component: { template: '<div />' } }
    ]
  })
}

type Wrapper = VueWrapper<InstanceType<typeof ArchivedChatsModal>>

async function mountModal(): Promise<Wrapper> {
  const router = createTestRouter()
  router.push('/dev-assistant')
  await router.isReady()

  const wrapper = mount(ArchivedChatsModal, {
    props: { visible: true },
    global: {
      plugins: [router],
      // AppModal 默认 teleport 到 body，挂载点就找不着了；换成透传的壳子
      stubs: { AppModal: { template: '<div class="modal"><slot /></div>' } }
    }
  })
  await flushPromises()
  return wrapper
}

/** 按钮文案来自 zh-CN（测试环境的 i18n 就是它） */
function buttonByText(wrapper: Wrapper, text: string): DOMWrapper<HTMLElement> | undefined {
  return wrapper.findAll('button').find((button) => button.text().includes(text))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()

  window.api = {
    ...window.api,
    agentV3: { deleteSession }
  } as unknown as typeof window.api

  const chatStore = useChatSessionsStore()
  chatStore.sessions = [
    { id: 'live', title: '还在用的会话', createdAt: 1, updatedAt: 900 },
    {
      id: 'old-archive',
      title: '早就收起来的',
      createdAt: 1,
      updatedAt: 800,
      archived: true,
      archivedAt: 100
    },
    {
      id: 'new-archive',
      title: '刚归档的',
      createdAt: 1,
      updatedAt: 10,
      archived: true,
      archivedAt: 500,
      agentSessionId: 'agent-new'
    }
  ]
})

describe('ArchivedChatsModal', () => {
  it('只列已归档的会话，最近归档的排在前面', async () => {
    const wrapper = await mountModal()

    const titles = wrapper.findAll('.archived-title').map((node) => node.text())
    expect(titles).toEqual(['刚归档的', '早就收起来的'])
    expect(wrapper.text()).not.toContain('还在用的会话')
  })

  /**
   * 排序按 archivedAt 而不是 updatedAt：这一屏回答的是「我什么时候收起它的」。
   * 上面那条 `old-archive` 的 updatedAt 更大，跟着它排就会把顺序倒过来。
   */
  it('取消归档后会话立刻回到主列表', async () => {
    const wrapper = await mountModal()
    const chatStore = useChatSessionsStore()

    await buttonByText(wrapper, '取消归档')!.trigger('click')

    const session = chatStore.sessionById('new-archive')
    expect(session?.archived).toBe(false)
    expect(session?.archivedAt).toBeUndefined()
    expect(chatStore.displayableSessions.map((item) => item.id)).toContain('new-archive')
    expect(wrapper.findAll('.archived-title').map((node) => node.text())).toEqual(['早就收起来的'])
  })

  /**
   * 删除要三处一起清。只 `removeSession` 的话列表干净了，气泡还在 localStorage、
   * 内核记忆还在盘上的 JSONL 里 —— 用户以为删了，其实没有。
   */
  it('删除会话时连消息和内核记忆一起清掉', async () => {
    const wrapper = await mountModal()
    const chatStore = useChatSessionsStore()

    // setup.ts 把 Modal.confirm 桩成直接执行 onOk
    await wrapper.findAll('.archived-item')[0].findAll('button').at(-1)!.trigger('click')
    await flushPromises()

    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'agent-new' })
    expect(dropSession).toHaveBeenCalledWith('new-archive')
    expect(chatStore.sessionById('new-archive')).toBeNull()
  })

  it('一条都没有时给空状态，而不是一片空白', async () => {
    const chatStore = useChatSessionsStore()
    chatStore.sessions = [{ id: 'live', title: '还在用的会话', createdAt: 1, updatedAt: 900 }]

    const wrapper = await mountModal()

    expect(wrapper.findAll('.archived-item')).toHaveLength(0)
    expect(wrapper.text()).toContain('还没有归档的对话')
  })
})
