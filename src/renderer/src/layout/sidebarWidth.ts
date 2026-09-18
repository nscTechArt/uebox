export const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar-width'
export const SIDEBAR_WIDTH_DEFAULT = 240
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 420

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
}

export function parseSidebarWidth(value: string | null): number {
  if (value === null || value.trim() === '') return SIDEBAR_WIDTH_DEFAULT
  return clampSidebarWidth(Number(value))
}
