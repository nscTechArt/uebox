import { describe, expect, it } from 'vitest'

import { pointerStillInside } from './dragBounds'

const rect = { left: 100, right: 500, top: 50, bottom: 250 }

describe('pointerStillInside', () => {
  it('指针划过框内的子元素不算离开 —— 否则拖拽高亮会跟着鼠标闪', () => {
    expect(pointerStillInside(rect, 300, 150)).toBe(true)
  })

  it('指针出了框、压在边界上、或者按 Esc 取消（坐标归零）都算离开', () => {
    expect(pointerStillInside(rect, 600, 150)).toBe(false)
    expect(pointerStillInside(rect, 100, 150)).toBe(false)
    expect(pointerStillInside(rect, 0, 0)).toBe(false)
  })
})
