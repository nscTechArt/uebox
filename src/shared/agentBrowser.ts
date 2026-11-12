export type BrowserToolbarAction = 'back' | 'forward' | 'reload' | 'stop'

export interface BrowserNavigationState {
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** 当前页的缩放倍数，1 是 100% */
  zoom?: number
}

export interface BrowserTabState {
  id: string
  title: string
  url: string
  loading: boolean
  favicon?: string
}

export type BrowserTabCommand =
  | { action: 'create' }
  | { action: 'select' | 'close'; tabId: string }
  | { action: 'move'; tabId: string; index: number }
  | { action: 'mode'; mode: 'embedded' | 'window' }

export interface BrowserGroupState {
  tabs: BrowserTabState[]
  activeTabId: string | null
}

/** 页内查找的结果。`active` 从 1 开始，没有匹配时两个都是 0 */
export interface BrowserFindState {
  active: number
  matches: number
}

/**
 * 浏览器快捷键对应的动作。
 *
 * 焦点在网页里时由主进程拦（`before-input-event`），焦点在面板上时由渲染层拦，
 * 两边查同一张表，按起来才一致。
 */
export type BrowserCommand =
  | { name: BrowserToolbarAction | 'hardReload' }
  | { name: 'newTab' | 'closeTab' | 'reopenTab' | 'nextTab' | 'previousTab' | 'lastTab' }
  | { name: 'selectTab'; index: number }
  | { name: 'zoomIn' | 'zoomOut' | 'zoomReset' }
  | { name: 'focusAddress' | 'find' }

/** 只认这几个字段，主进程的 `Input` 和渲染层的 `KeyboardEvent` 都能凑出来 */
export interface BrowserKeyInput {
  key: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/** 按 Chrome 的键位。macOS 用 ⌘ 代替 Ctrl */
export function resolveBrowserShortcut(
  input: BrowserKeyInput,
  platform: string
): BrowserCommand | null {
  const mod = platform === 'darwin' ? input.meta : input.control
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key

  if (key === 'F5') return { name: mod || input.shift ? 'hardReload' : 'reload' }
  if (key === 'F6') return { name: 'focusAddress' }
  if (key === 'Escape') return { name: 'stop' }

  if (input.alt && !mod) {
    if (key === 'ArrowLeft') return { name: 'back' }
    if (key === 'ArrowRight') return { name: 'forward' }
    if (key === 'd') return { name: 'focusAddress' }
    return null
  }
  if (!mod) return null

  if (key === 'Tab' || key === 'PageDown' || key === 'PageUp') {
    const previous = key === 'PageUp' || (key === 'Tab' && input.shift)
    return { name: previous ? 'previousTab' : 'nextTab' }
  }
  if (input.shift) {
    if (key === 't') return { name: 'reopenTab' }
    if (key === 'r') return { name: 'hardReload' }
    if (key === '+' || key === '=') return { name: 'zoomIn' }
    return null
  }
  if (/^[1-8]$/.test(key)) return { name: 'selectTab', index: Number(key) - 1 }
  switch (key) {
    case '9':
      return { name: 'lastTab' }
    case 't':
      return { name: 'newTab' }
    case 'w':
      return { name: 'closeTab' }
    case 'r':
      return { name: 'reload' }
    case 'l':
      return { name: 'focusAddress' }
    case 'f':
      return { name: 'find' }
    case '=':
    case '+':
      return { name: 'zoomIn' }
    case '-':
      return { name: 'zoomOut' }
    case '0':
      return { name: 'zoomReset' }
    case '[':
      return platform === 'darwin' ? { name: 'back' } : null
    case ']':
      return platform === 'darwin' ? { name: 'forward' } : null
    default:
      return null
  }
}
