import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAIConfigStore } from '@/store/modules/aiConfig'
import { useChatSessionsStore } from '@/store/modules/chatSessions'
import {
  ensurePermissionMode,
  resolvePermissionMode,
  setPermissionMode,
  toApprovalMode
} from './sessionPermissionMode'

describe('sessionPermissionMode', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('没设过的会话从推荐档起步', () => {
    expect(resolvePermissionMode('chat-a')).toBe('auto-edit')
  })

  // 用户要的：上次调成完全访问，下次新开的对话也是完全访问
  it('新会话继承上一次选的那一档', () => {
    setPermissionMode('chat-a', 'yolo')

    expect(useAIConfigStore().agentPermissionMode).toBe('yolo')
    expect(ensurePermissionMode('chat-b')).toBe('yolo')
  })

  // 这就是那个 bug 的另一种形状：盖过章之后，别人再怎么调都跟这条无关
  it('盖过章的会话不跟着后来的选择走', () => {
    ensurePermissionMode('chat-a')
    setPermissionMode('chat-b', 'yolo')

    expect(resolvePermissionMode('chat-a')).toBe('auto-edit')
    expect(resolvePermissionMode('chat-b')).toBe('yolo')
  })

  it('盖章只盖一次，不覆盖用户自己选的', () => {
    setPermissionMode('chat-a', 'read-only')
    useAIConfigStore().setAgentPermissionMode('yolo')

    expect(ensurePermissionMode('chat-a')).toBe('read-only')
    expect(useChatSessionsStore().getPermissionMode('chat-a')).toBe('read-only')
  })

  // 只读在内核里没有对应档位（它靠不给写工具实现），退化时只能往严的方向退
  it('只读翻译成内核档位时按最严的一档算', () => {
    expect(toApprovalMode('read-only')).toBe('ask')
    expect(toApprovalMode('yolo')).toBe('yolo')
  })
})
