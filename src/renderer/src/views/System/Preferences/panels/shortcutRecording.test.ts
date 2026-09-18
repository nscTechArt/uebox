/**
 * 快捷键录制：哪些按键不该被录进去。
 *
 * 红灯用例来自一次评审：录制原来绑在表格行的 `@focus` 上，用键盘 Tab 遍历这张表时，
 * 下一次 Tab 就被录成「呼出主界面 = Tab」并立刻注册成**全局**热键 —— 此后在任何程序里
 * 按 Tab 都会被盒子截走，而且没有任何退出录制的途径（Esc 同样会被录进去）。
 */
import { describe, expect, it } from 'vitest'

import { interpretRecordingKey } from './shortcutRecording'

describe('interpretRecordingKey', () => {
  it('Mac 录制保留 Control 与 Command 的区别', () => {
    expect(interpretRecordingKey({ key: ' ', ctrlKey: true }, 'global', 'darwin')).toEqual({
      kind: 'accelerator',
      accelerator: 'Control+Space'
    })
    expect(interpretRecordingKey({ key: ' ', metaKey: true }, 'global', 'darwin')).toEqual({
      kind: 'accelerator',
      accelerator: 'CommandOrControl+Space'
    })
    expect(
      interpretRecordingKey({ key: 'k', ctrlKey: true, metaKey: true }, 'global', 'darwin')
    ).toEqual({
      kind: 'accelerator',
      accelerator: 'CommandOrControl+Control+K'
    })
  })
  it('Esc 是取消录制，不是快捷键', () => {
    expect(interpretRecordingKey({ key: 'Escape' }, 'global')).toEqual({ kind: 'cancel' })
    // 带修饰键也一样 —— 用户按 Esc 的意图从来都是「算了」
    expect(interpretRecordingKey({ key: 'Escape', ctrlKey: true }, 'local')).toEqual({
      kind: 'cancel'
    })
  })

  it('裸 Tab 让给焦点导航，不录', () => {
    expect(interpretRecordingKey({ key: 'Tab' }, 'global')).toEqual({ kind: 'cancel' })
  })

  it('带修饰键的 Tab 可以录', () => {
    expect(interpretRecordingKey({ key: 'Tab', ctrlKey: true }, 'global')).toEqual({
      kind: 'accelerator',
      accelerator: 'CommandOrControl+Tab'
    })
  })

  it('全局热键不带修饰键要被拒绝', () => {
    expect(interpretRecordingKey({ key: 'k' }, 'global')).toEqual({
      kind: 'rejected',
      reason: 'needsModifier'
    })
    expect(interpretRecordingKey({ key: 'F5' }, 'global')).toEqual({
      kind: 'rejected',
      reason: 'needsModifier'
    })
  })

  it('应用内快捷键允许单键', () => {
    expect(interpretRecordingKey({ key: 'k' }, 'local')).toEqual({
      kind: 'accelerator',
      accelerator: 'K'
    })
  })

  it('只按住修饰键时继续等，不产生结果', () => {
    for (const key of ['Control', 'Alt', 'Shift', 'Meta']) {
      expect(interpretRecordingKey({ key, ctrlKey: true }, 'global')).toEqual({ kind: 'pending' })
    }
  })

  it('组合键按 Electron 的写法拼', () => {
    expect(interpretRecordingKey({ key: 'k', ctrlKey: true, shiftKey: true }, 'global')).toEqual({
      kind: 'accelerator',
      accelerator: 'CommandOrControl+Shift+K'
    })

    expect(interpretRecordingKey({ key: 'ArrowUp', altKey: true }, 'global')).toEqual({
      kind: 'accelerator',
      accelerator: 'Alt+Up'
    })

    expect(interpretRecordingKey({ key: ' ', ctrlKey: true }, 'global')).toEqual({
      kind: 'accelerator',
      accelerator: 'CommandOrControl+Space'
    })

    expect(interpretRecordingKey({ key: 'F5', ctrlKey: true }, 'global')).toEqual({
      kind: 'accelerator',
      accelerator: 'CommandOrControl+F5'
    })
  })

  it('Cmd 和 Ctrl 归一到 CommandOrControl', () => {
    expect(interpretRecordingKey({ key: 'p', metaKey: true }, 'global')).toEqual({
      kind: 'accelerator',
      accelerator: 'CommandOrControl+P'
    })
  })
})
