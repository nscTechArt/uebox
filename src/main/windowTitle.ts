import type { BrowserWindow } from 'electron'

export const MAIN_WINDOW_TITLE = '虚幻盒子'

export function keepWindowTitleFixed(window: Pick<BrowserWindow, 'on'>): void {
  window.on('page-title-updated', (event) => event.preventDefault())
}
