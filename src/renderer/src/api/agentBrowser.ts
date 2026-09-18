import type {
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

export const agentBrowserAPI = {
  async tab(sessionId: string, command: BrowserTabCommand): Promise<void> {
    unwrapResult(await window.api.agentBrowser.tab(sessionId, command))
  },
  async toolbar(sessionId: string, action: BrowserToolbarAction): Promise<void> {
    unwrapResult(await window.api.agentBrowser.toolbar(sessionId, action))
  },
  async openUrl(sessionId: string, address: string): Promise<{ url: string }> {
    return unwrapResult(await window.api.agentBrowser.openUrl(sessionId, address))
  },
  async getState(sessionId: string, restore: boolean): Promise<AgentBrowserState> {
    return unwrapResult<AgentBrowserState>(
      await window.api.agentBrowser.getState(sessionId, restore)
    )
  }
}
