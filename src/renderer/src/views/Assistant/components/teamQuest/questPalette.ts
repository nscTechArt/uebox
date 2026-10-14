/**
 * 委托板的配色。和 artV2 的 C 一个道理：这块是一幅「游戏界面」，颜色是美术数据，
 * 不跟主题反相；文字和底色的对比度按这块深木底手调过（正文 paper/muted 对 panel ≥ 7:1 / 4.5:1）。
 *
 * 以 CSS 变量的形式挂在委托板根上（`--q-*`），样式里只用变量。
 */

export const QUEST_PALETTE = {
  bg: '#241914',
  panel: '#33241c',
  'panel-hi': '#3e2c22',
  edge: '#5a3a28',
  'edge-hi': '#93684a',
  ink: '#1c130f',
  'ink-soft': '#2b1d17',
  paper: '#f0e4c8',
  muted: '#c2ad86',
  dim: '#8f7a5c',
  gold: '#f2cf7a',
  brass: '#d8a648',
  'brass-dark': '#9a6b2c',
  'brass-deep': '#7a4f22',
  red: '#f09090',
  'red-deep': '#6e2f2a',
  'red-edge': '#8a3f36',
  green: '#9ad58a',
  'green-edge': '#4f7a45',
  bubble: '#f6eedb',
  rule: '#4a3628',
  'banner-edge': '#6e4a33',
  banner: '#3a281e',
  'alert-bubble': '#f3c9c0',
  'alert-ink': '#5a1f1a',
  parchment: '#f3e2b5',
  'parch-rule': '#d6c28f',
  'parch-ink': '#3b2f1e',
  'parch-link': '#8a5a1c',
  'parch-meta': '#7a6845',
  'parch-quote': '#c9a35a',
  'parch-quote-ink': '#5a4a30',
  'parch-code': 'rgba(122, 82, 56, 0.14)',
  // 叠在木纹上的暗条、脚下的影子
  stripe: 'rgba(0, 0, 0, 0.08)',
  shade: 'rgba(0, 0, 0, 0.3)'
} as const

/** 绑到委托板根元素的 style 上 */
export const QUEST_VARS: Record<string, string> = Object.fromEntries(
  Object.entries(QUEST_PALETTE).map(([name, value]) => [`--q-${name}`, value])
)
