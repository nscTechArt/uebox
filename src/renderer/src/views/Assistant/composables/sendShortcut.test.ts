import { describe, expect, it } from 'vitest'

import { resolveComposerKeyAction, type ComposerKeyEvent } from './sendShortcut'

function press(overrides: Partial<ComposerKeyEvent> = {}): ComposerKeyEvent {
  return { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, ...overrides }
}

describe('回车发送档', () => {
  it('回车就是发送', () => {
    expect(resolveComposerKeyAction(press(), 'enter')).toBe('submit')
  })

  it('Shift+回车换行', () => {
    expect(resolveComposerKeyAction(press({ shiftKey: true }), 'enter')).toBe('newline')
  })

  it('Ctrl+回车对这一条反着来', () => {
    expect(resolveComposerKeyAction(press({ ctrlKey: true }), 'enter')).toBe('submit-opposite')
  })

  it('mac 上 ⌘ 和 Ctrl 等效', () => {
    expect(resolveComposerKeyAction(press({ metaKey: true }), 'enter')).toBe('submit-opposite')
  })
})

describe('Ctrl+回车发送档', () => {
  it('光按回车是换行 —— 这一档存在的全部意义', () => {
    expect(resolveComposerKeyAction(press(), 'ctrl-enter')).toBe('newline')
  })

  it('Shift+回车也是换行', () => {
    expect(resolveComposerKeyAction(press({ shiftKey: true }), 'ctrl-enter')).toBe('newline')
  })

  it('Ctrl+回车才发送', () => {
    expect(resolveComposerKeyAction(press({ ctrlKey: true }), 'ctrl-enter')).toBe('submit')
  })

  it('Ctrl+Shift+回车反着来 —— 这一档下 Ctrl+回车已经被发送占了', () => {
    expect(resolveComposerKeyAction(press({ ctrlKey: true, shiftKey: true }), 'ctrl-enter')).toBe(
      'submit-opposite'
    )
  })
})

describe('别的键不归它管', () => {
  it.each(['a', 'Escape', 'Tab', 'NumpadEnter'])('%s 返回 null，交给输入框自己处理', (key) => {
    expect(resolveComposerKeyAction(press({ key }), 'enter')).toBeNull()
    expect(resolveComposerKeyAction(press({ key }), 'ctrl-enter')).toBeNull()
  })
})

describe('两档都满足的不变量', () => {
  it('Shift+回车在两档下都是换行 —— 这是所有聊天软件的共识', () => {
    expect(resolveComposerKeyAction(press({ shiftKey: true }), 'enter')).toBe('newline')
    expect(resolveComposerKeyAction(press({ shiftKey: true }), 'ctrl-enter')).toBe('newline')
  })

  it('每一档都恰好有一个发送键和一个反着来的键，不会两档都判成同一件事', () => {
    for (const mode of ['enter', 'ctrl-enter'] as const) {
      const results = [
        press(),
        press({ shiftKey: true }),
        press({ ctrlKey: true }),
        press({ ctrlKey: true, shiftKey: true })
      ].map((event) => resolveComposerKeyAction(event, mode))
      expect(results.filter((r) => r === 'submit')).toHaveLength(1)
      expect(results.filter((r) => r === 'submit-opposite')).toHaveLength(1)
    }
  })
})
