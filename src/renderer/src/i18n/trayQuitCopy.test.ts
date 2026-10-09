import { describe, expect, it } from 'vitest'
import { MAIN_STRINGS } from '@core/main/i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

/**
 * 托盘「退出确认」的正文有两份活拷贝：窗口活着时由渲染层弹应用内统一确认框
 * （语言包的 `layout.trayQuitContent`），8 秒没被接住主进程退回系统原生框
 * （MAIN_STRINGS 的 `tray.quitConfirm`）。渲染层接不住时主进程还得自己说话，
 * 两份删不掉一份 —— 这里钉住两份逐字一致：改这句文案时四个地方一起改。
 */
const MIRRORED_PAIRS = [
  {
    lang: 'zh-CN',
    main: MAIN_STRINGS['zh-CN']['tray.quitConfirm'],
    renderer: zhCN.layout.trayQuitContent
  },
  {
    lang: 'en-US',
    main: MAIN_STRINGS['en-US']['tray.quitConfirm'],
    renderer: enUS.layout.trayQuitContent
  }
]

describe('托盘退出确认的双份文案', () => {
  it.each(MIRRORED_PAIRS)(
    '$lang：layout.trayQuitContent 与主进程 tray.quitConfirm 一致',
    (pair) => {
      expect(pair.renderer).toBe(pair.main)
    }
  )
})
