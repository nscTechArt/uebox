import { describe, expect, it } from 'vitest'

import {
  contrastRatio,
  DEFAULT_CUSTOM_THEME,
  normalizeHexColor,
  resolveCustomTheme,
  validateCustomTheme
} from './customTheme'

describe('customTheme', () => {
  it('规范化 #RGB / #RRGGBB，并拒绝其它输入', () => {
    expect(normalizeHexColor('#1a2')).toBe('#11AA22')
    expect(normalizeHexColor(' #1a73e2 ')).toBe('#1A73E2')
    expect(normalizeHexColor('blue')).toBeNull()
    expect(normalizeHexColor('#12345')).toBeNull()
  })

  it('默认自定义主题不显示可读性提醒', () => {
    expect(validateCustomTheme(DEFAULT_CUSTOM_THEME)).toMatchObject({ valid: true, warnings: [] })
  })

  it('低对比度主题仍可用，并分别给出可读性提醒', () => {
    expect(
      validateCustomTheme({ background: '#FFFFFF', foreground: '#888888', accent: '#0057B8' })
    ).toMatchObject({ valid: true, warnings: [{ type: 'text-contrast' }] })
    expect(
      validateCustomTheme({ background: '#111111', foreground: '#FCFCFC', accent: '#222222' })
    ).toMatchObject({ valid: true, warnings: [{ type: 'accent-contrast' }] })
    expect(
      validateCustomTheme({ background: '#111111', foreground: '#FCFCFC', accent: '#F7AD30' })
    ).toMatchObject({ valid: true, warnings: [{ type: 'accent-text-contrast' }] })
  })

  it.each([
    { background: '#111111', foreground: '#FCFCFC', accent: '#1A73E2', mode: 'dark' },
    { background: '#FAFAFA', foreground: '#111111', accent: '#0057B8', mode: 'light' }
  ] as const)('为 $mode 自定义主题派生可读的语义色', (colors) => {
    const resolved = resolveCustomTheme(colors)

    expect(resolved.mode).toBe(colors.mode)
    expect(resolved.roles.bgPage).toBe(colors.background)
    expect(resolved.roles.textPrimary).toBe(colors.foreground)
    expect(resolved.roles.accentSolid).toBe(colors.accent)
    expect(
      contrastRatio(resolved.roles.textPrimary, resolved.roles.bgSurface)
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrastRatio(resolved.roles.borderStrong, resolved.roles.bgSurface)
    ).toBeGreaterThanOrEqual(3)
    expect(
      contrastRatio(resolved.roles.accentText, resolved.roles.accentBg)
    ).toBeGreaterThanOrEqual(4.5)
  })
})
