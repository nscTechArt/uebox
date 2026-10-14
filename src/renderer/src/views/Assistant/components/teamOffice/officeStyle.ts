/**
 * 办公室的画风（豪华像素 / 简约墨线），以及每个队员的「身份色」。
 *
 * 身份色就是他在办公室里的衬衫颜色。面板上名册的小圆点用同一个颜色，
 * 看列表就知道办公室里哪个小人是他 —— 所以颜色跟着当前画风走，两处共用这一份映射。
 */

import { ref } from 'vue'

import type { TeamStateView } from '@core/shared/agentTeam'

import { CREW_COUNT, CREW_TOKENS } from './officePalette'
import { PRODUCER_SHIRT, SHIRTS } from './v2/artV2'

export type OfficeStyle = 'v1' | 'v2'

const STYLE_KEY = 'team-office-style'

function loadStyle(): OfficeStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === 'v1' ? 'v1' : 'v2'
  } catch {
    return 'v2'
  }
}

/** 当前画风。界面偏好，记在 localStorage */
export const officeStyle = ref<OfficeStyle>(loadStyle())

export function setOfficeStyle(next: OfficeStyle): void {
  officeStyle.value = next
  try {
    localStorage.setItem(STYLE_KEY, next)
  } catch {
    // 存不下就只在这一次生效
  }
}

/** 按入职顺序给的衬衫序号（办公室和名册必须一致） */
export function crewIndexOf(team: TeamStateView, name: string): number {
  const id = name.trim().toLowerCase()
  const order = [...team.members].sort((a, b) => a.hiredAt - b.hiredAt)
  const index = order.findIndex((m) => m.name.trim().toLowerCase() === id)
  return index < 0 ? 0 : index % CREW_COUNT
}

/** 身份色：CSS 能用的颜色值。crew = -1 是制作人 */
export function crewColor(crew: number, style: OfficeStyle): string {
  if (style === 'v2') return crew < 0 ? PRODUCER_SHIRT[1] : SHIRTS[crew % SHIRTS.length]![1]
  return crew < 0 ? 'var(--color-accent-solid)' : `var(${CREW_TOKENS[crew % CREW_TOKENS.length]})`
}
