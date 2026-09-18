/**
 * 主进程那几句也得跟着界面语言走。
 *
 * 红灯用例：把界面切成 English，托盘右键还是「显示窗口 / 最小化 / 退出」；
 * 启动失败时弹出来的错误框标题是「虚幻盒子启动失败」；点「导入资产」弹出来的
 * 系统文件对话框标题是「选择文件或文件夹」。这些都是 Electron 直接交给操作系统
 * 画的控件，渲染进程碰不到 —— 只能在主进程翻。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { MAIN_STRINGS, currentMainLanguage, mt, onLanguageChanged, setMainLanguage } from './i18n'

describe('主进程文案表', () => {
  beforeEach(() => setMainLanguage('zh-CN'))

  /*
   * 这个文件**不许有 import**。
   *
   * 之前它读 `appSettingsManager` 拿语言，而那条链一路牵出 `services/config.ts`，
   * 那里在模块加载时就读 `app.isPackaged` —— 于是任何引了 `mt()` 的文件都会把整个
   * electron app 拖进依赖图，十一个跟数据库有关的测试直接加载失败。
   * 改成由 `appSettingsManager` 反过来推。这条用例守着别人把 import 加回来。
   */
  it('没有任何 import —— 一个文案表不该有引力', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(resolve('src/main/i18n.ts'), 'utf8')
    expect(source).not.toMatch(/^\s*import\s/m)
  })

  it('中英两侧的键完全对齐 —— 缺一个就是那句话永远不翻', () => {
    expect(Object.keys(MAIN_STRINGS['en-US']).sort()).toEqual(
      Object.keys(MAIN_STRINGS['zh-CN']).sort()
    )
  })

  it('英文包里不留中文', () => {
    const chinese = Object.entries(MAIN_STRINGS['en-US'])
      .filter(([, value]) => /[一-鿿]/.test(value))
      .map(([key]) => key)
    expect(chinese).toEqual([])
  })

  it('跟着推进来的语言走', () => {
    expect(mt('tray.show')).toBe('显示窗口')
    setMainLanguage('en-US')
    expect(mt('tray.show')).toBe('Show window')
    expect(mt('dialog.save')).toBe('Save file')
  })

  it('没人推过就是中文 —— 启动失败那条路上设置可能根本读不出来', () => {
    expect(currentMainLanguage()).toBe('zh-CN')
    expect(mt('startup.failedTitle')).toBe('虚幻盒子启动失败')
  })

  it('认不出的语言当中文 —— 设置文件是可以被手改坏的', () => {
    setMainLanguage('klingon')
    expect(currentMainLanguage()).toBe('zh-CN')
  })

  it('参数替换', () => {
    // 用 Windows 真实形状的路径：日志目录是反斜杠的，替换不能把它吃掉
    const logDir = String.raw`C:\Users\me\AppData\Roaming\unreal-box\logs`
    const text = mt('startup.failedBody', { reason: 'EBUSY', logDir })
    expect(text).toContain('EBUSY')
    expect(text).toContain(logDir)
    expect(text).not.toContain('{reason}')
  })

  it('查不到的键原样返回，不返回空串', () => {
    // 空串会被当成布局出了问题；露出 key 至少看得出是漏配了
    expect(mt('nope.not.here')).toBe('nope.not.here')
  })

  it('语言真的变了才通知订阅者（托盘据此重建菜单）', () => {
    const seen: string[] = []
    onLanguageChanged(() => seen.push(mt('tray.show')))

    setMainLanguage('en-US')
    // 同一个语言再推一次不该再重建一次
    setMainLanguage('en-US')

    expect(seen).toEqual(['Show window'])
  })

  it('一个订阅者抛错不拖累别的', () => {
    const ok = vi.fn()
    onLanguageChanged(() => {
      throw new Error('boom')
    })
    onLanguageChanged(ok)

    expect(() => setMainLanguage('en-US')).not.toThrow()
    expect(ok).toHaveBeenCalled()
  })
})
