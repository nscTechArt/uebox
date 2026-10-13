/**
 * 办公室的调色板全部取自主题 token，换主题（深 / 浅 / 自定义）跟着变，不自带一个色值。
 *
 * 画风是「墨线单色 + 点缀色」：墙、地板、家具都用这套界面自己的表面色和文字色画，
 * 换到深色就是一间夜里的办公室。只有人和几样小东西上颜色：衬衫和肤色借用资产类型那组
 * 分类色 —— 它本来就是为「几样东西要一眼分得开、两套主题都看得清」调过的。
 *
 * 人身上的深色（头发、轮廓、裤子、鞋）是从肤色和衬衫色往暗里压出来的，不跟墨色走：
 * 墨色在深色主题下是白的，拿它画头发，一屋子人全成了白头发。
 *
 * 画布要的是具体色值，不认 var()。读法是把 token 写进一个探针元素的 color，再读计算值。
 */

export interface OfficePalette {
  /** 墙 */
  wall: string
  /** 墙上浅一档的面（窗框里、白板、屏幕） */
  paper: string
  floor: string
  /** 地板上的纹 */
  floorLine: string
  /** 主墨色：家具轮廓、键盘、气泡 */
  ink: string
  /** 次墨色：家具、细节、袖子 */
  ink2: string
  /** 最淡的线：踢脚线、影子 */
  faint: string
  accent: string
  accentSoft: string
  success: string
  warning: string
  danger: string
  /** 衬衫 */
  crew: string[]
  /** 脸和手，两种轮着用 */
  skin: string[]
  /** 对应肤色的轮廓 */
  skinLine: string[]
  /** 三种发色 */
  hair: string[]
  pants: string
  /** 鞋和眼睛 */
  shoes: string
  /** 窗外：白天的天、夜里的天、星星和月亮 */
  daySky: string
  nightSky: string
  star: string
  /** 显示器：深色边框、亮着的屏幕（两套主题都是一块深色的编辑器） */
  bezel: string
  screen: string
}

const TOKENS = {
  wall: '--color-bg-surface',
  paper: '--color-bg-raised',
  floor: '--color-bg-sunken',
  floorLine: '--color-border-subtle',
  ink: '--color-text-primary',
  ink2: '--color-text-muted',
  faint: '--color-border',
  accent: '--color-accent-solid',
  accentSoft: '--color-accent-bg',
  accentText: '--color-accent-text',
  success: '--color-success-solid',
  warning: '--color-warning-solid',
  danger: '--color-danger-solid'
} as const

/** 色相互相拉得最开的六个：蓝、品红、绿、琥珀、青、青绿 */
export const CREW_TOKENS = [
  '--color-uetype-blueprint',
  '--color-uetype-sound',
  '--color-uetype-anim-sequence',
  '--color-warning-solid',
  '--color-uetype-niagara',
  '--color-uetype-material'
]

export const CREW_COUNT = CREW_TOKENS.length

/** 分类色里两个偏暖的：一个杏色一个浅粉，当肤色正合适 */
const SKIN_TOKENS = ['--color-uetype-world', '--color-uetype-texture']

function luminance(color: string): number {
  const parts = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  return parts.length < 3 ? 0 : 0.2126 * parts[0]! + 0.7152 * parts[1]! + 0.0722 * parts[2]!
}

const lighter = (a: string, b: string): string => (luminance(a) >= luminance(b) ? a : b)

/** 把一个颜色往暗里压：k=1 原样，k=0 全黑。读不懂的颜色原样返回 */
export function shade(color: string, k: number): string {
  const parts = color.match(/[\d.]+/g)
  if (!parts || parts.length < 3) return color
  const [r, g, b] = parts.slice(0, 3).map((v) => Math.round(Number(v) * k))
  return `rgb(${r} ${g} ${b})`
}

export function buildPalette(read: (token: string) => string): OfficePalette {
  const base = Object.fromEntries(
    Object.entries(TOKENS).map(([role, token]) => [role, read(token)])
  ) as Record<keyof typeof TOKENS, string>
  const skin = SKIN_TOKENS.map(read)
  const crew = CREW_TOKENS.map(read)
  const warm = skin[0]!
  const { accentText, ...rest } = base
  return {
    ...rest,
    // 天是浅蓝的，不管主题深浅：深色主题里浅蓝是强调色的文字色，浅色主题里是它的底色
    daySky: lighter(base.accentSoft, accentText),
    nightSky: shade(base.accent, 0.28),
    star: lighter(base.ink, base.paper),
    bezel: shade(base.ink2, 0.3),
    screen: shade(base.accent, 0.38),
    crew,
    skin,
    skinLine: skin.map((c) => shade(c, 0.55)),
    // 深棕、近黑、栗色
    hair: [shade(warm, 0.32), shade(crew[0]!, 0.22), shade(warm, 0.55)],
    pants: shade(crew[0]!, 0.42),
    shoes: shade(warm, 0.2)
  }
}

export function readPalette(probe: HTMLElement): OfficePalette {
  return buildPalette((token) => {
    probe.style.color = `var(${token})`
    return getComputedStyle(probe).color
  })
}
