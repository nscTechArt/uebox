/**
 * 把一次按键翻译成 Electron 的 accelerator 字符串。
 *
 * ## 为什么这段逻辑值得单独拿出来
 *
 * 快捷键面板录到的东西会被直接注册成**全局**热键 —— 注册成功之后，用户在任何程序里
 * 按下它都会被盒子截走。所以「哪些按键不该被录进去」不是界面细节，是这个功能的正确性本身：
 *
 * - **Esc 是取消，不是快捷键。** 用户按 Esc 的意图是「算了别改了」，把它录成热键之后，
 *   他在别的程序里按 Esc 都会触发盒子的动作。
 * - **裸 Tab 是移动焦点，不是快捷键。** 面板里的行本来就要能用 Tab 遍历。
 * - **全局热键必须带修饰键。** 一个裸字母/裸 Tab 的全局热键会让整台电脑没法正常打字。
 *   本地快捷键只在盒子窗口内生效，这条不适用。
 */

import { acceleratorModifiers } from '@renderer/utils/accelerator'

/** 录制结果：要么得到一个 accelerator，要么说明为什么不收 */
export type RecordingOutcome =
  | { kind: 'accelerator'; accelerator: string }
  /** 用户想退出录制（Esc），或按了不该被吃掉的导航键（裸 Tab） */
  | { kind: 'cancel' }
  /** 按键本身合法，但不满足这条快捷键的要求 */
  | { kind: 'rejected'; reason: 'needsModifier' }
  /** 还没按到实质内容（只按住了修饰键），继续等 */
  | { kind: 'pending' }

const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta']

/** 浏览器 KeyboardEvent.key → Electron accelerator 里的写法 */
const KEY_MAP: Record<string, string> = {
  ' ': 'Space',
  ARROWUP: 'Up',
  ARROWDOWN: 'Down',
  ARROWLEFT: 'Left',
  ARROWRIGHT: 'Right',
  ENTER: 'Enter',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',
  TAB: 'Tab'
}

export interface RecordingInput {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/**
 * @param event 按键
 * @param type 这条快捷键的作用域。`global` 会注册到操作系统，要求至少一个修饰键
 */
export function interpretRecordingKey(
  event: RecordingInput,
  type: 'global' | 'local',
  platform = 'win32'
): RecordingOutcome {
  // Esc 永远是「退出录制」。它自己不能成为快捷键 —— 那会让用户在任何地方按 Esc 都触发盒子
  if (event.key === 'Escape') return { kind: 'cancel' }

  // 只按住修饰键，还没按到正主
  if (MODIFIER_KEYS.includes(event.key)) return { kind: 'pending' }

  const modifiers = acceleratorModifiers(event, platform)

  // 裸 Tab 让给焦点导航。带修饰键的 Tab（Ctrl+Tab 之类）仍然可以录
  if (event.key === 'Tab' && modifiers.length === 0) return { kind: 'cancel' }

  if (type === 'global' && modifiers.length === 0)
    return { kind: 'rejected', reason: 'needsModifier' }

  let key = event.key.toUpperCase()
  if (KEY_MAP[key]) {
    key = KEY_MAP[key]
  } else if (key.length === 1) {
    // 字母和数字保持原样（已经是大写）
  } else {
    // F1–F12 这类功能键，首字母大写
    key = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()
  }

  return { kind: 'accelerator', accelerator: [...modifiers, key].join('+') }
}
