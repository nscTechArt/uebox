/**
 * 独立对话窗口的渲染层 API（AGENTS.md 硬规则 5：不直接碰 ipcRenderer）。
 *
 * 这里的调用全是「发出去就算」的：打开窗口、发同步补丁、报绑定。拿不到桥
 * （非 Electron 环境跑起来的界面、测试）时安静地什么都不做 —— 同步是锦上添花，
 * 主窗口自己的功能不能因为它缺席而挂掉。
 */

import type { ChatSyncPatch } from '@core/shared/chatWindowSync'

function bridge(): Window['api']['chatWindow'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api?.chatWindow
}

/** 这个界面是不是一个独立对话窗口（主进程用 `#/chat-window?sid=` 打开它） */
export function isChatWindow(): boolean {
  return typeof window !== 'undefined' && window.location.hash.startsWith('#/chat-window')
}

/** 独立窗口打开的是哪条对话（不是独立窗口时是空串） */
export function chatWindowSid(
  hash = typeof window === 'undefined' ? '' : window.location.hash
): string {
  if (!hash.startsWith('#/chat-window')) return ''
  const query = hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('sid')?.trim() ?? ''
}

export const chatWindowAPI = {
  async open(chatSid: string, point?: { screenX: number; screenY: number }): Promise<boolean> {
    const api = bridge()
    if (!api || !chatSid) return false
    const result = await api.open({ chatSid, ...(point ?? {}) })
    return result?.success === true
  },

  async list(): Promise<string[]> {
    const result = await bridge()?.list()
    return Array.isArray(result) ? result : []
  },

  bindAgentSession(chatSid: string, agentSessionId: string): void {
    bridge()?.bindAgentSession({ chatSid, agentSessionId })
  },

  openInMain(path: string): void {
    bridge()?.openInMain(path)
  },

  push(patch: ChatSyncPatch): void {
    bridge()?.push(patch)
  },

  requestSnapshot(chatSid: string): void {
    bridge()?.requestSnapshot(chatSid)
  },

  async resendApprovals(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0
    return (await bridge()?.resendApprovals(sessionIds)) ?? 0
  },

  async runsElsewhere(): Promise<string[]> {
    const result = await bridge()?.runsElsewhere()
    return Array.isArray(result) ? result : []
  },

  onChanged(callback: (chatSids: string[]) => void): () => void {
    return bridge()?.onChanged(callback) ?? (() => {})
  },

  onNavigate(callback: (args: { path: string }) => void): () => void {
    return bridge()?.onNavigate(callback) ?? (() => {})
  },

  onApply(callback: (patch: ChatSyncPatch) => void): () => void {
    return bridge()?.onApply(callback) ?? (() => {})
  },

  onSnapshotRequest(callback: (args: { sid: string }) => void): () => void {
    return bridge()?.onSnapshotRequest(callback) ?? (() => {})
  }
}
