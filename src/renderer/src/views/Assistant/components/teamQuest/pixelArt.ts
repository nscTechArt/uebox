/**
 * 委托板（像素画风的任务板）上的小图标：卷轴、闪电、锁、Z。
 *
 * 和办公室同一套调色板（`artV2.ts` 的 C），每个字符一格，`.` 是透明。
 * 画法见 PixelSprite.vue。
 */

import { C } from '../teamOffice/v2/artV2'

export interface PixelArt {
  rows: string[]
  palette: Record<string, string>
}

/** 交回来的报告：两头是黄铜轴的卷轴 */
export const SCROLL: PixelArt = {
  rows: [
    'rRRRRRRRRRr',
    '.ppppppppp.',
    '.pllllllpp.',
    '.ppppppppp.',
    '.plllllppp.',
    '.ppppppppp.',
    '.pllllpppp.',
    'rRRRRRRRRRr'
  ],
  palette: { R: C.brass, r: C.brassDark, p: C.cream, l: C.creamDark }
}

/** 停下的活：撕开的卷轴 */
export const TORN: PixelArt = {
  rows: [
    'rRRRRRRRRRr',
    '.ppppppppp.',
    '.pllll.pp..',
    '.pppp...p..',
    '.ppp..pp...',
    '..p..ppp...',
    '.....pp....',
    '...........'
  ],
  palette: { R: C.brassDark, r: C.woodDeep, p: C.creamDark, l: C.creamMid }
}

export const BOLT: PixelArt = {
  rows: ['..YY', '.YY.', 'YYYY', '.YY.', 'YY..', 'Y...'],
  palette: { Y: C.sun }
}

export const LOCK: PixelArt = {
  rows: ['.ooo.', 'o...o', 'BBBBB', 'BB.BB', 'BBBBB'],
  palette: { o: C.creamDark, B: C.brass }
}

export const ZZ: PixelArt = {
  // 一大一小两个 Z：睡着了
  rows: ['....zzz', '.....z.', '....zzz', 'zzzz...', '..z....', '.z.....', 'zzzz...'],
  palette: { z: C.cream }
}

/** 日志里的验收：过了是勾，没过是叉 */
export const CHECK: PixelArt = {
  rows: ['....g', '...gg', 'g.gg.', 'ggg..', '.g...'],
  palette: { g: C.leafLight }
}

export const CROSS: PixelArt = {
  rows: ['r...r', '.r.r.', '..r..', '.r.r.', 'r...r'],
  palette: { r: C.roseLight }
}

/** 委托板标题前的小旗子 */
export const FLAG: PixelArt = {
  rows: ['pRRRR.', 'pRRRRR', 'pRRRR.', 'p.....', 'p.....', 'p.....'],
  palette: { p: C.woodLight, R: C.rose }
}

/** 日志标题前的羽毛笔 */
export const QUILL: PixelArt = {
  rows: ['....cc', '...ccc', '..ccc.', '.ccc..', '.c....', 'k.....'],
  palette: { c: C.cream, k: C.line }
}

/** 任务板上便利贴的颜色，和办公室软木板上的便利贴一致 */
export const NOTE_COLORS = {
  todo: C.noteTodo,
  doing: C.noteDoing,
  done: C.noteDone,
  blocked: C.noteBlocked
} as const
