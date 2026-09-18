import { describe, expect, it } from 'vitest'
import { fitMacWindow, mainWindowChrome } from './mainWindowAppearance'

describe('main window platform appearance', () => {
  it('uses native traffic lights only on macOS', () => {
    expect(mainWindowChrome('darwin')).toEqual({
      frame: true,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 12, y: 11 }
    })
    expect(mainWindowChrome('win32')).toEqual({ frame: false })
    expect(mainWindowChrome('linux')).toEqual({ frame: false })
  })

  it('fits a first launch inside a MacBook work area', () => {
    expect(
      fitMacWindow({ width: 1630, height: 1000 }, { x: 0, y: 25, width: 1440, height: 820 })
    ).toEqual({ width: 1440, height: 820, minWidth: 1024, minHeight: 640, x: 0, y: 25 })
  })

  it('preserves valid saved geometry on a secondary screen', () => {
    expect(
      fitMacWindow(
        { width: 1200, height: 700, x: -1400, y: 40 },
        { x: -1920, y: 25, width: 1920, height: 1055 }
      )
    ).toMatchObject({ width: 1200, height: 700, x: -1400, y: 40 })
  })

  it('clamps offscreen positions and minimum sizes to a small display', () => {
    expect(
      fitMacWindow(
        { width: 400, height: 300, x: 9999, y: -9999 },
        { x: 0, y: 25, width: 800, height: 575 }
      )
    ).toEqual({ width: 800, height: 575, minWidth: 800, minHeight: 575, x: 0, y: 25 })
  })
})
