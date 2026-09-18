import { describe, expect, it } from 'vitest'
import { isSessionOnScreen, shouldMarkTaskDone } from './sessionTaskDone'

describe('sessionTaskDone', () => {
  it('treats only the chat currently open on the assistant route as on screen', () => {
    expect(isSessionOnScreen('/dev-assistant', 'sid-1', 'sid-1')).toBe(true)
    expect(isSessionOnScreen('/dev-assistant/chat', 'sid-1', 'sid-1')).toBe(true)
    expect(isSessionOnScreen('/dev-assistant', 'sid-2', 'sid-1')).toBe(false)
    expect(isSessionOnScreen('/asset-library', 'sid-1', 'sid-1')).toBe(false)
    expect(isSessionOnScreen('/dev-assistant', undefined, 'sid-1')).toBe(false)
  })

  it('marks the task done whenever the user is looking elsewhere', () => {
    // 用户切到了别的会话
    expect(shouldMarkTaskDone('/dev-assistant', 'sid-2', 'sid-1')).toBe(true)
    // 用户切到了别的页面（资产库、知识库……）
    expect(shouldMarkTaskDone('/notebooks', 'sid-1', 'sid-1')).toBe(true)
    // 用户正看着这条会话：结果已经在眼前，不用提示
    expect(shouldMarkTaskDone('/dev-assistant', 'sid-1', 'sid-1')).toBe(false)
    // 没有会话 ID 时不做任何标记
    expect(shouldMarkTaskDone('/notebooks', 'sid-1', '')).toBe(false)
  })
})
