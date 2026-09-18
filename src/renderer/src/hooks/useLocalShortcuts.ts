import { useShortcutStore } from '@renderer/store/modules/shortcut'
import { acceleratorModifiers } from '@renderer/utils/accelerator'

export const useLocalShortcuts = () => {
  const shortcutStore = useShortcutStore()

  const handleKeyDown = (e: KeyboardEvent): void => {
    // 忽略在输入框中的按键，除非是特定的功能键（如 Ctrl+S 保存）
    // 这里简单起见，如果是在输入框中，且不是组合键，则忽略
    // 但通常快捷键（如 Ctrl+K）应该在任何地方生效，或者有特定规则
    const target = e.target as HTMLElement
    const isInput =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

    // 如果是输入状态，且没有按下修饰键，则不处理（允许打字）
    if (isInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
      return
    }

    // 构造快捷键字符串
    const modifiers = acceleratorModifiers(e, window.api.platform)

    // 忽略仅按下修饰键
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return

    let key = e.key.toUpperCase()

    // 键名映射
    const keyMap: Record<string, string> = {
      ' ': 'Space',
      ARROWUP: 'Up',
      ARROWDOWN: 'Down',
      ARROWLEFT: 'Left',
      ARROWRIGHT: 'Right',
      ESCAPE: 'Esc',
      ENTER: 'Enter',
      BACKSPACE: 'Backspace',
      DELETE: 'Delete',
      TAB: 'Tab'
    }

    if (keyMap[key]) {
      key = keyMap[key]
    } else if (key.length === 1) {
      // 字母和数字保持原样
    } else {
      // 其他功能键 F1-F12 等，首字母大写
      key = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()
    }

    const pressedAccelerator = [...modifiers, key].join('+')

    // 查找匹配的快捷键
    const matched = shortcutStore.shortcuts.find((s) => {
      if (!s.enabled || s.type !== 'local') return false
      return s.accelerator === pressedAccelerator
    })

    if (matched) {
      console.log('Triggered local shortcut:', matched.action_key)

      // 刷新只在开发环境生效。
      //
      // 用户看到的是一个应用而不是网页，「刷新页面」这个概念在他那边不存在，而误按一次
      // 会把正在跑的对话和导入连同渲染进程一起扔掉（主进程那侧的工具调用还在跑，
      // 事件却已经没人收了）。View 菜单和偏好设置里那两处入口都已经只在开发环境出现，
      // 这里是**真正会触发的那个**，之前漏了 —— 结果正式包里键还管用，用户却找不到
      // 地方解绑它。
      if (matched.action_key === 'app.reload' || matched.action_key === 'app.force_reload') {
        if (!import.meta.env.DEV) return
        e.preventDefault()
        window.location.reload()
      }
    }
  }

  const init = (): void => {
    window.addEventListener('keydown', handleKeyDown)
    // 确保 store 已加载
    if (shortcutStore.shortcuts.length === 0) {
      shortcutStore.fetchShortcuts()
    }
  }

  const destroy = (): void => {
    window.removeEventListener('keydown', handleKeyDown)
  }

  return { init, destroy }
}
