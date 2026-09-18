import type { BrowserWindowConstructorOptions, Rectangle } from 'electron'

/** Native macOS controls share the 36px renderer tab bar. */
export function mainWindowChrome(platform: string): BrowserWindowConstructorOptions {
  return platform === 'darwin'
    ? { frame: true, titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 11 } }
    : { frame: false }
}

export function fitMacWindow(
  state: { width: number; height: number; x?: number; y?: number },
  area: Rectangle
): BrowserWindowConstructorOptions {
  const minWidth = Math.min(1024, area.width)
  const minHeight = Math.min(640, area.height)
  const width = Math.max(minWidth, Math.min(state.width, area.width))
  const height = Math.max(minHeight, Math.min(state.height, area.height))
  return {
    width,
    height,
    minWidth,
    minHeight,
    x: Math.max(
      area.x,
      Math.min(
        state.x ?? area.x + Math.round((area.width - width) / 2),
        area.x + area.width - width
      )
    ),
    y: Math.max(
      area.y,
      Math.min(
        state.y ?? area.y + Math.round((area.height - height) / 2),
        area.y + area.height - height
      )
    )
  }
}
