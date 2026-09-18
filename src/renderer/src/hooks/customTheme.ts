import { palette, type ThemeRoles } from '@renderer/assets/styles/palette.generated'

export interface CustomThemeColors {
  background: string
  foreground: string
  accent: string
}

export type CustomThemeValidationError =
  | 'invalid-background'
  | 'invalid-foreground'
  | 'invalid-accent'

export type CustomThemeContrastWarning =
  | 'text-contrast'
  | 'accent-contrast'
  | 'accent-text-contrast'

export interface CustomThemeContrastWarningDetail {
  type: CustomThemeContrastWarning
  ratio: number
}

export interface CustomThemeValidation {
  valid: boolean
  error?: CustomThemeValidationError
  normalized?: CustomThemeColors
  warnings: readonly CustomThemeContrastWarningDetail[]
}

type RuntimeThemeRoles = { readonly [K in keyof ThemeRoles]: string }

export interface ResolvedCustomTheme {
  mode: 'light' | 'dark'
  roles: RuntimeThemeRoles
  cssVariables: Record<string, string>
}

const ON_SOLID = palette.dark.selectionText
const DARK_MIX_TARGET = palette.light.textPrimary
const LIGHT_MIX_TARGET = palette.dark.textPrimary

export const DEFAULT_CUSTOM_THEME: CustomThemeColors = {
  background: palette.dark.bgPage.toUpperCase(),
  foreground: palette.dark.textPrimary.toUpperCase(),
  accent: palette.dark.accentSolid.toUpperCase()
}

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const input = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(input)) return input.toUpperCase()
  if (!/^#[0-9a-f]{3}$/i.test(input)) return null
  return `#${[...input.slice(1)].map((channel) => channel.repeat(2)).join('')}`.toUpperCase()
}

function parseHex(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [
    number,
    number,
    number
  ]
}

function toHex(channels: [number, number, number]): string {
  return `#${channels
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase()
}

function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from)
  const b = parseHex(to)
  return toHex(
    a.map((channel, index) => channel + (b[index] - channel) * amount) as [number, number, number]
  )
}

function luminance(hex: string): number {
  const channels = parseHex(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

export function contrastRatio(first: string, second: string): number {
  const a = normalizeHexColor(first)
  const b = normalizeHexColor(second)
  if (!a || !b) return 0
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

function normalizeColors(value: unknown): CustomThemeColors | null {
  if (!value || typeof value !== 'object') return null
  const colors = value as Partial<CustomThemeColors>
  const background = normalizeHexColor(colors.background)
  const foreground = normalizeHexColor(colors.foreground)
  const accent = normalizeHexColor(colors.accent)
  return background && foreground && accent ? { background, foreground, accent } : null
}

export function validateCustomTheme(value: unknown): CustomThemeValidation {
  const colors = value as Partial<CustomThemeColors> | null
  if (!normalizeHexColor(colors?.background)) {
    return { valid: false, error: 'invalid-background', warnings: [] }
  }
  if (!normalizeHexColor(colors?.foreground)) {
    return { valid: false, error: 'invalid-foreground', warnings: [] }
  }
  if (!normalizeHexColor(colors?.accent)) {
    return { valid: false, error: 'invalid-accent', warnings: [] }
  }

  const normalized = normalizeColors(value)!
  const warnings: CustomThemeContrastWarningDetail[] = []
  const surface = mix(normalized.background, normalized.foreground, 0.04)
  const textRatio = Math.min(
    contrastRatio(normalized.foreground, normalized.background),
    contrastRatio(normalized.foreground, surface)
  )
  if (textRatio < 4.5) {
    warnings.push({ type: 'text-contrast', ratio: textRatio })
  }

  const accentRatio = Math.min(
    contrastRatio(normalized.accent, normalized.background),
    contrastRatio(normalized.accent, surface)
  )
  if (accentRatio < 3) {
    warnings.push({ type: 'accent-contrast', ratio: accentRatio })
  }

  const accentTextRatio = contrastRatio(ON_SOLID, normalized.accent)
  if (accentTextRatio < 4.5) {
    warnings.push({ type: 'accent-text-contrast', ratio: accentTextRatio })
  }

  return { valid: true, normalized, warnings }
}

function ensureContrast(
  color: string,
  backgrounds: string[],
  target: number,
  toward: string
): string {
  if (backgrounds.every((background) => contrastRatio(color, background) >= target)) return color
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mix(color, toward, step / 100)
    if (backgrounds.every((background) => contrastRatio(candidate, background) >= target)) {
      return candidate
    }
  }
  return toward
}

function accentHover(accent: string, background: string): string {
  for (const target of [DARK_MIX_TARGET, LIGHT_MIX_TARGET]) {
    const candidate = mix(accent, target, 0.1)
    if (contrastRatio(ON_SOLID, candidate) >= 4.5 && contrastRatio(candidate, background) >= 3) {
      return candidate
    }
  }
  return accent
}

export function resolveCustomTheme(value: CustomThemeColors): ResolvedCustomTheme {
  const validation = validateCustomTheme(value)
  if (!validation.valid || !validation.normalized) {
    throw new Error(`Invalid custom theme: ${validation.error ?? 'unknown'}`)
  }

  const { background, foreground, accent } = validation.normalized
  const mode = luminance(background) < luminance(foreground) ? 'dark' : 'light'
  const base = palette[mode]
  const surface = mix(background, foreground, 0.04)
  const surfaceHover = mix(background, foreground, 0.09)
  const selected = mix(background, foreground, 0.13)
  const selectedHover = mix(background, foreground, 0.18)
  const raised = mix(background, foreground, 0.025)
  const sunken = mix(background, foreground, 0.08)
  const textBackgrounds = [background, surface, raised]
  const secondary = ensureContrast(
    mix(foreground, background, 0.2),
    textBackgrounds,
    4.5,
    foreground
  )
  const muted = ensureContrast(mix(foreground, background, 0.35), textBackgrounds, 4.5, foreground)
  const border = ensureContrast(
    mix(background, foreground, 0.3),
    [background, surface],
    3,
    foreground
  )
  const borderStrong = ensureContrast(
    mix(background, foreground, 0.42),
    [background, surface],
    3,
    foreground
  )
  const accentBg = mix(background, accent, 0.14)
  const accentBgHover = mix(background, accent, 0.22)
  const accentText = ensureContrast(accent, [...textBackgrounds, accentBg], 4.5, foreground)
  const solidHover = accentHover(accent, background)

  const roles: RuntimeThemeRoles = {
    ...base,
    bgPage: background,
    bgSurface: surface,
    bgSurfaceHover: surfaceHover,
    bgOption: surface,
    bgOptionHover: surfaceHover,
    bgOptionSelected: selected,
    bgRaised: raised,
    bgSunken: sunken,
    bgInverse: foreground,
    bgInverseHover: mix(foreground, background, 0.15),
    textPrimary: foreground,
    textSecondary: secondary,
    textMuted: muted,
    textDisabled: mix(foreground, background, 0.55),
    separator: mix(background, foreground, 0.16),
    borderSubtle: mix(background, foreground, 0.16),
    border,
    borderOption: mix(background, foreground, 0.12),
    borderStrong,
    accentText,
    accentBg,
    accentBorder: accent,
    accentSolid: accent,
    accentSolidHover: solidHover,
    switchChecked: accent,
    switchCheckedHover: solidHover,
    selectionBg: accent,
    selectionText: ON_SOLID
  }

  return {
    mode,
    roles,
    cssVariables: {
      '--color-bg-page': roles.bgPage,
      '--color-bg-surface': roles.bgSurface,
      '--color-bg-surface-hover': roles.bgSurfaceHover,
      '--color-bg-option': roles.bgOption,
      '--color-bg-option-hover': roles.bgOptionHover,
      '--color-bg-option-selected': roles.bgOptionSelected,
      '--color-bg-raised': roles.bgRaised,
      '--color-bg-sunken': roles.bgSunken,
      '--color-bg-inverse': roles.bgInverse,
      '--color-bg-inverse-hover': roles.bgInverseHover,
      '--color-text-primary': roles.textPrimary,
      '--color-text-secondary': roles.textSecondary,
      '--color-text-muted': roles.textMuted,
      '--color-text-disabled': roles.textDisabled,
      '--color-text-inverse': background,
      '--color-separator': roles.separator,
      '--color-border-subtle': roles.borderSubtle,
      '--color-border': roles.border,
      '--color-border-option': roles.borderOption,
      '--color-border-strong': roles.borderStrong,
      '--color-border-focus': roles.accentBorder,
      '--color-accent-text': roles.accentText,
      '--color-accent-bg': roles.accentBg,
      '--color-accent-bg-hover': accentBgHover,
      '--color-accent-border': roles.accentBorder,
      '--color-accent-solid': roles.accentSolid,
      '--color-accent-solid-hover': roles.accentSolidHover,
      '--color-switch-checked-solid': roles.switchChecked,
      '--color-switch-checked-solid-hover': roles.switchCheckedHover,
      '--color-selection-bg': roles.selectionBg,
      '--color-selection-text': roles.selectionText,
      '--color-bg-selected': selected,
      '--color-bg-selected-hover': selectedHover,
      '--color-text-selected': roles.textPrimary
    }
  }
}

export const CUSTOM_THEME_VARIABLE_NAMES = Object.freeze(
  Object.keys(resolveCustomTheme(DEFAULT_CUSTOM_THEME).cssVariables)
)
