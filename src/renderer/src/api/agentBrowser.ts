import type {
  BrowserCommand,
  BrowserGroupState,
  BrowserTabCommand,
  BrowserNavigationState,
  BrowserToolbarAction
} from '../../../shared/agentBrowser'
import { unwrapResult } from '@renderer/common/utils'

export interface AgentBrowserState extends BrowserGroupState {
  navigation: BrowserNavigationState
  url: string
  open: boolean
  mode: 'window' | 'embedded' | 'hidden'
}

/** 主进程给的失败原因码（`AgentBrowserError.code`），界面按它挑文案 */
export class AgentBrowserActionError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'AgentBrowserActionError'
  }
}

function unwrapAction<T>(res: { success: boolean; data: T; error?: string; code?: string }): T {
  if (res?.success !== true) throw new AgentBrowserActionError(res?.error || '操作失败', res?.code)
  return res.data
}

export const agentBrowserAPI = {
  async tab(sessionId: string, command: BrowserTabCommand): Promise<void> {
    unwrapAction(await window.api.agentBrowser.tab(sessionId, command))
  },
  async toolbar(sessionId: string, action: BrowserToolbarAction): Promise<void> {
    unwrapAction(await window.api.agentBrowser.toolbar(sessionId, action))
  },
  async command(sessionId: string, command: BrowserCommand): Promise<void> {
    unwrapAction(await window.api.agentBrowser.command(sessionId, command))
  },
  async openUrl(sessionId: string, address: string): Promise<{ url: string }> {
    return unwrapAction(await window.api.agentBrowser.openUrl(sessionId, address))
  },
  async getState(sessionId: string, restore: boolean): Promise<AgentBrowserState> {
    return unwrapResult<AgentBrowserState>(
      await window.api.agentBrowser.getState(sessionId, restore)
    )
  }
}
