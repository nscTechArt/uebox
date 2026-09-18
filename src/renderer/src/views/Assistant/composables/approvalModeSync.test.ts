import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// vi.mock 会被提升到文件顶部，工厂里不能引用普通的顶层变量
const { setApprovalMode } = vi.hoisted(() => ({
  setApprovalMode: vi.fn(async () => ({ success: true }))
}))
vi.mock('@/api/agentV3', () => ({ agentV3API: { setApprovalMode } }))

import { useAIConfigStore } from '@/store/modules/aiConfig'
import { useChatSessionsStore } from '@/store/modules/chatSessions'
import { initApprovalModeSync, resetApprovalModeSyncForTest } from './approvalModeSync'

/** 建一条已经起过内核会话的对话 —— 只有这种才需要往主进程送档位 */
function seedSession(chatSid: string, agentSessionId: string): void {
  const chatStore = useChatSessionsStore()
  chatStore.createSession(chatSid)
  chatStore.setAgentSessionId(chatSid, agentSessionId)
}

describe('approvalModeSync', () => {
  beforeEach(() => {
    setApprovalMode.mockClear()
    setApprovalMode.mockResolvedValue({ success: true })
    resetApprovalModeSyncForTest()
    setActivePinia(createPinia())
  })

  // 主进程的审批门每次工具调用现读档位，但得有人把改动送过去 ——
  // 不送的话「跑到一半改档位」要等下一条消息才算数
  it('改某条会话的档位，立刻送到主进程', async () => {
    seedSession('chat-a', 'kernel-a')
    initApprovalModeSync()

    useChatSessionsStore().setPermissionMode('chat-a', 'yolo')
    await nextTick()

    expect(setApprovalMode).toHaveBeenCalledWith('kernel-a', 'yolo', 'agent')
  })

  // 这就是用户报的那个 bug：B 会话开完全访问，不许把 A 会话也一起放开
  it('只送改动的那条，别的会话不受影响', async () => {
    seedSession('chat-a', 'kernel-a')
    seedSession('chat-b', 'kernel-b')
    useChatSessionsStore().setPermissionMode('chat-a', 'read-only')
    initApprovalModeSync()

    useChatSessionsStore().setPermissionMode('chat-b', 'yolo')
    await nextTick()

    expect(setApprovalMode).toHaveBeenCalledTimes(1)
    expect(setApprovalMode).toHaveBeenCalledWith('kernel-b', 'yolo', 'agent')
  })

  // 即使 ask 和 read-only 的审批档位相同，也必须同步权限变化。
  it('中途切到只读，单独发送禁止写入约束', async () => {
    seedSession('chat-a', 'kernel-a')
    useChatSessionsStore().setPermissionMode('chat-a', 'ask')
    initApprovalModeSync()

    useChatSessionsStore().setPermissionMode('chat-a', 'read-only')
    await nextTick()

    expect(setApprovalMode).toHaveBeenCalledWith('kernel-a', 'ask', 'ask')
    useChatSessionsStore().setPermissionMode('chat-a', 'ask')
    await nextTick()
    expect(setApprovalMode).toHaveBeenLastCalledWith('kernel-a', 'ask', 'agent')
  })

  // 还没盖过章的会话跟着起步档位走。挂在下拉的点击回调上就会漏掉这条路
  it('起步档位变了，还没盖过章的会话跟着变', async () => {
    seedSession('chat-a', 'kernel-a')
    initApprovalModeSync()

    useAIConfigStore().setAgentPermissionMode('yolo')
    await nextTick()

    expect(setApprovalMode).toHaveBeenCalledWith('kernel-a', 'yolo', 'agent')
  })

  it('已经盖过章的会话，不跟着起步档位走', async () => {
    seedSession('chat-a', 'kernel-a')
    useChatSessionsStore().setPermissionMode('chat-a', 'ask')
    initApprovalModeSync()

    useAIConfigStore().setAgentPermissionMode('yolo')
    await nextTick()

    expect(setApprovalMode).not.toHaveBeenCalled()
  })

  it('送不到不影响用户的设置 —— 下一条消息照样会带下去', async () => {
    setApprovalMode.mockRejectedValueOnce(new Error('IPC 挂了'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedSession('chat-a', 'kernel-a')
    initApprovalModeSync()

    useChatSessionsStore().setPermissionMode('chat-a', 'ask')
    await nextTick()
    await Promise.resolve()

    expect(useChatSessionsStore().getPermissionMode('chat-a')).toBe('ask')
    warn.mockRestore()
  })

  it('装两次也只有一个监听，不会重复发', async () => {
    seedSession('chat-a', 'kernel-a')
    initApprovalModeSync()
    initApprovalModeSync()

    useChatSessionsStore().setPermissionMode('chat-a', 'ask')
    await nextTick()

    expect(setApprovalMode).toHaveBeenCalledTimes(1)
  })
})
