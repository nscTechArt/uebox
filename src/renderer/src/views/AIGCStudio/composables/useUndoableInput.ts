/**
 * useUndoableInput - 支持 Ctrl+Z 撤销的输入框操作工具
 *
 * 问题：当使用 v-model 直接设置 textarea 的值时，浏览器的原生撤销历史不会记录这个变化。
 * 解决方案：通过 execCommand('insertText') 或 InputEvent 模拟用户输入，使浏览器认为这是用户输入的内容。
 */

import { Ref } from 'vue'

/**
 * 以可撤销的方式设置输入框的值
 * 该方法会清空现有内容并插入新文本，确保浏览器的撤销历史可以记录此操作
 *
 * @param inputRef - textarea 或 input 元素的引用
 * @param modelValue - 绑定的 v-model 响应式变量
 * @param newValue - 要设置的新值
 */
export function setValueWithUndo(
  inputRef: Ref<HTMLTextAreaElement | HTMLInputElement | null>,
  modelValue: Ref<string>,
  newValue: string
): void {
  const element = inputRef.value
  if (!element) {
    // 如果元素不存在，降级为直接赋值
    modelValue.value = newValue
    return
  }

  // 聚焦元素
  element.focus()

  // 选择全部内容
  element.select()

  // 使用 execCommand 插入文本（这会被记录到撤销历史中）
  const success = document.execCommand('insertText', false, newValue)

  if (!success) {
    // 如果 execCommand 失败（某些浏览器不支持），使用 InputEvent 作为后备
    // 先手动清空并设置值
    element.setSelectionRange(0, element.value.length)

    // 创建并派发 InputEvent
    const inputEvent = new InputEvent('input', {
      inputType: 'insertReplacementText',
      data: newValue,
      bubbles: true,
      cancelable: true
    })

    // 手动更新 DOM 值（InputEvent 不会自动修改值）
    element.value = newValue
    element.dispatchEvent(inputEvent)

    // 同步更新 v-model
    modelValue.value = newValue
  } else {
    // execCommand 成功后，v-model 会通过 input 事件自动更新
    // 但为了确保同步，也手动更新一下
    modelValue.value = newValue
  }
}

/**
 * useUndoableInput composable
 * 提供可撤销的输入操作函数
 */
export function useUndoableInput(): { setValueWithUndo: typeof setValueWithUndo } {
  return {
    setValueWithUndo
  }
}
