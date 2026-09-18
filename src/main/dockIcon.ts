import { app } from 'electron'

/** 在 app ready 后设置 Dock 图标，开发运行也使用应用图标。 */
export function initializeDockIcon(iconPath: string): void {
  app.dock?.setIcon(iconPath)
}
