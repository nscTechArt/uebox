import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  parseSidebarWidth
} from './sidebarWidth'

describe('sidebarWidth', () => {
  it('restores a saved width', () => {
    expect(parseSidebarWidth('320')).toBe(320)
  })

  it('keeps the width within the supported range', () => {
    expect(SIDEBAR_WIDTH_MIN).toBe(200)
    expect(SIDEBAR_WIDTH_MAX).toBe(420)
    expect(clampSidebarWidth(120)).toBe(SIDEBAR_WIDTH_MIN)
    expect(clampSidebarWidth(500)).toBe(SIDEBAR_WIDTH_MAX)
  })

  it('falls back to the default for missing or invalid values', () => {
    expect(parseSidebarWidth(null)).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(parseSidebarWidth('')).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(parseSidebarWidth('not-a-width')).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
})
