import { ipcMain, Menu, BrowserWindow } from 'electron'

export function registerContextMenuIPC(): void {
  ipcMain.on('app:show-input-context-menu', (event, labels: Record<string, string>) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return

    const menu = Menu.buildFromTemplate([
      { role: 'cut', label: labels?.cut || 'Cut' },
      { role: 'copy', label: labels?.copy || 'Copy' },
      { role: 'paste', label: labels?.paste || 'Paste' },
      { type: 'separator' },
      { role: 'selectAll', label: labels?.selectAll || 'Select All' }
    ])

    menu.popup({ window })
  })
}
