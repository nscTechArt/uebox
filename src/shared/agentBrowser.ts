export type BrowserToolbarAction = 'back' | 'forward' | 'reload' | 'stop'

export interface BrowserNavigationState {
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface BrowserTabState {
  id: string
  title: string
  url: string
  loading: boolean
}

export type BrowserTabCommand =
  | { action: 'create' }
  | { action: 'select' | 'close'; tabId: string }
  | { action: 'mode'; mode: 'embedded' | 'window' }

export interface BrowserGroupState {
  tabs: BrowserTabState[]
  activeTabId: string | null
}
