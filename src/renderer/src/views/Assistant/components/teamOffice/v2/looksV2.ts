/**
 * 认得出模型的队员：照那家的看板娘画成 Q 版美少女 —— 大眼睛带睫毛、刘海和鬓发包着脸、
 * 各自的裙子和配件（耳朵、角、尾巴、帽子）。不画各家 logo。
 *
 * 坐标和 drawV2 里的人一致：朝右，x 0..12；头 y -1..9，身子 y 10..14，
 * 站着脚底 y 25，坐下 y 21。身后的东西（尾巴、翅膀、后头发）在小 x 那边。
 * 手臂还是 drawV2 的 arms() 画，袖子颜色取 `sleeve`。
 */

import type { ModelLook } from '../modelLook'
import { C } from './artV2'
import type { Body } from './drawV2'

type Paint = Body['P']
type Tone = [string, string, string]

interface Girl {
  /** 发色：[主色, 高光, 暗部] */
  hair: Tone
  cut: 'long' | 'twin' | 'braid' | 'short' | 'bob'
  /** 发梢颜色（渐变发） */
  tips?: string
  /** 瞳色：[远眼, 近眼]（异色瞳就两个不一样） */
  eyes: [string, string]
  /** 上衣 [亮, 中, 暗] */
  top: Tone
  /** 袖子 [亮, 中, 暗]，arms() 用 */
  sleeve: Tone
  /** 裙子 [主色, 暗部, 裙边] */
  skirt: Tone
  skirtLen: 'mini' | 'knee' | 'long' | 'pencil'
  /** 腿：[袜子 / 腿, 暗部] */
  legs: [string, string]
  /** 脚踝那几行另一种颜色（短袜、袜套） */
  socks?: string
  shoe: string
  /** 露腰：上衣只到 y 12 */
  crop?: boolean
  /** 身后：尾巴、翅膀 */
  back?: (P: Paint, g: Pose) => void
  /** 上衣、裙子上的装饰 */
  dress?: (P: Paint, g: Pose, skirtTop: number, skirtEnd: number) => void
  /** 头上的：耳朵、角、帽子、发卡 */
  head?: (H: Paint) => void
}

export interface Pose {
  seated: boolean
  /** 走路相位 0..3，不在走为 -1 */
  walk: number
  closed: boolean
  talking: boolean
  /** 头的偏移（探身、打瞌睡） */
  dx: number
  dy: number
}

const INK = '#2b1d1a'
const WHITE = '#ffffff'
const GOLD = '#f2d06a'
const BLUSH = '#f29a9a'

/** 尾巴、翅膀：坐着时落到地面以下的不画 */
function parts(P: Paint, g: Pose, list: [number, number, number, number, string][]): void {
  const floor = g.seated ? 22 : 26
  for (const [x, y, w, h, color] of list) {
    const clipped = Math.min(h, floor - y)
    if (clipped > 0) P(x, y, w, clipped, color)
  }
}

/** 尖耳朵（猫 / 狐）。tall 多一格 */
function ears(H: Paint, c: string, inner: string, tall: boolean): void {
  const up = tall ? 1 : 0
  H(1, -2, 4, 1, c)
  H(1, -3 - up, 3, 1 + up, c)
  H(1, -4 - up, 2, 1, c)
  H(1, -5 - up, 1, 1, c)
  H(2, -3 - up, 1, 1 + up, inner)
  H(8, -2, 4, 1, c)
  H(9, -3 - up, 3, 1 + up, c)
  H(10, -4 - up, 2, 1, c)
  H(11, -5 - up, 1, 1, c)
  H(10, -3 - up, 1, 1 + up, inner)
}

export const LOOKS: Record<ModelLook, Girl> = {
  // 橙色长直发、奶白长裙配橙黑拼片、黑领结、手里抱书的学者气
  claude: {
    hair: ['#e0742a', '#f7a35c', '#b4561a'],
    cut: 'long',
    eyes: ['#c26a1e', '#c26a1e'],
    top: ['#fffaf0', '#f3e8d4', '#d8c6a6'],
    sleeve: ['#fffaf0', '#f3e8d4', '#d8c6a6'],
    skirt: ['#f3e8d4', '#d8c6a6', INK],
    skirtLen: 'long',
    legs: ['#f3ece0', '#d8ccb6'],
    shoe: '#c8b89c',
    dress: (P, g, top, end) => {
      P(5, 10, 3, 1, INK)
      P(6, 11, 1, 2, INK)
      P(4, 14, 5, 1, INK)
      if (!g.seated) {
        P(7, top + 1, 2, end - top - 1, '#e07a2e')
        P(9, top + 3, 1, end - top - 3, INK)
      }
    },
    head: (H) => {
      H(9, -2, 2, 2, '#f2a24e')
      H(9, -2, 1, 1, GOLD)
      H(2, -1, 2, 1, INK)
    }
  },
  // 白色长卷发、龙角龙翼龙尾、白色长裙开衩
  gpt: {
    hair: ['#e8e6f2', '#ffffff', '#b6b0cc'],
    cut: 'long',
    eyes: ['#8478c8', '#8478c8'],
    top: ['#ffffff', '#f2f0f8', '#cdc8e0'],
    sleeve: ['#ffffff', '#f2f0f8', '#cdc8e0'],
    skirt: ['#f2f0f8', '#cdc8e0', '#a9a2c8'],
    skirtLen: 'long',
    legs: [C.skinA, C.skinAShade],
    shoe: '#d6d2e8',
    back: (P, g) => {
      const w = '#e6e3f2'
      const r = '#a9a2c8'
      // 龙翼：从肩后张开，两根翼骨
      parts(P, g, [
        [0, 8, 3, 2, w],
        [-2, 7, 3, 2, w],
        [-3, 9, 4, 4, w],
        [-2, 13, 3, 2, w],
        [-3, 8, 1, 1, r],
        [-2, 10, 3, 1, r],
        [-2, 13, 1, 2, r]
      ])
      const t = '#d6d2e8'
      const top = g.seated ? 12 : 16
      parts(P, g, [
        [2, top, 2, 3, t],
        [0, top + 2, 3, 3, t],
        [-1, top + 5, 2, 3, t],
        [-2, top + 7, 2, 2, t],
        [1, top + 3, 1, 1, WHITE],
        [0, top + 5, 1, 2, WHITE]
      ])
    },
    dress: (P, g, top, end) => {
      P(6, 10, 2, 1, '#a9a2c8')
      P(4, 14, 5, 1, '#cdc8e0')
      // 开衩露一截腿
      if (!g.seated && g.walk < 0) P(8, top + 4, 1, end - top - 4, C.skinA)
    },
    head: (H) => {
      // 一对往后卷的龙角
      const hc = '#f6f4fc'
      const hs = '#9a94b8'
      H(2, -1, 2, 1, hc)
      H(1, -2, 2, 1, hc)
      H(1, -3, 1, 1, hc)
      H(2, -4, 1, 1, hs)
      H(9, -1, 2, 1, hc)
      H(10, -2, 2, 1, hc)
      H(11, -3, 1, 1, hc)
      H(10, -4, 1, 1, hs)
    }
  },
  // 蓝紫渐变长发、猫耳猫尾、异色瞳、露腰短裙、白袜套
  gemini: {
    hair: ['#6a66e0', '#a68cf2', '#4644b0'],
    cut: 'long',
    tips: '#d48ae6',
    eyes: ['#d8506e', '#e8b830'],
    top: ['#5a50b0', '#36307a', '#241f58'],
    sleeve: ['#ffffff', '#ecebf8', '#c8c4e4'],
    skirt: ['#36307a', '#241f58', WHITE],
    skirtLen: 'mini',
    crop: true,
    legs: [C.skinA, C.skinAShade],
    socks: '#f6f4fc',
    shoe: '#2a2458',
    back: (P, g) => {
      const top = g.seated ? 12 : 15
      parts(P, g, [
        [2, top + 1, 1, 2, '#6a66e0'],
        [0, top + 2, 2, 1, '#6a66e0'],
        [-1, top - 2, 2, 4, '#7a6ee6'],
        [-2, top - 5, 2, 3, '#a68cf2'],
        [-2, top - 6, 2, 1, '#d48ae6']
      ])
    },
    dress: (P) => {
      P(6, 11, 1, 1, GOLD)
      P(4, 15, 1, 1, GOLD)
    },
    head: (H) => {
      ears(H, '#6a66e0', '#f2a6c8', false)
      H(10, 0, 1, 1, GOLD)
      H(11, 1, 1, 1, '#9fe0f0')
    }
  },
  // 金色双马尾、小皇冠、黑色哥特长裙红里子、小虎牙
  grok: {
    hair: ['#f0c650', '#fbe6a0', '#c8942a'],
    cut: 'twin',
    eyes: ['#3a7ad8', '#3a7ad8'],
    top: ['#4a3a40', '#241c20', '#140e12'],
    sleeve: ['#4a3a40', '#241c20', '#140e12'],
    skirt: ['#241c20', '#140e12', '#c8a050'],
    skirtLen: 'long',
    legs: ['#3a2c32', '#241c20'],
    shoe: '#140e12',
    dress: (P, g, top, end) => {
      P(4, 10, 5, 1, '#c02a3c')
      P(6, 11, 1, 1, GOLD)
      P(4, 14, 5, 1, '#c8a050')
      if (!g.seated) P(10, top + 3, 2, end - top - 3, '#b8263a')
    },
    head: (H) => {
      // 小皇冠 + 黑蝴蝶结
      H(4, -3, 4, 1, GOLD)
      H(4, -4, 1, 1, GOLD)
      H(6, -4, 1, 1, GOLD)
      H(5, -3, 1, 1, '#c02a3c')
      H(-1, -1, 2, 2, INK)
      H(11, -1, 2, 2, INK)
    }
  },
  // 蓝色长发、鲸鳍耳、女仆装白围裙、鲸尾
  deepseek: {
    hair: ['#2f5aa8', '#5a86d6', '#1e3c78'],
    cut: 'long',
    eyes: ['#3a8ad8', '#3a8ad8'],
    top: ['#4a5a9a', '#2a3466', '#1c2448'],
    sleeve: ['#4a5a9a', '#2a3466', '#1c2448'],
    skirt: ['#2a3466', '#1c2448', WHITE],
    skirtLen: 'knee',
    legs: ['#f6f6fa', '#d8d8e4'],
    shoe: '#1c2448',
    back: (P, g) => {
      const t = '#2a3a6a'
      const top = g.seated ? 12 : 16
      parts(P, g, [
        [2, top, 2, 3, t],
        [0, top + 2, 3, 2, t],
        [-1, top + 4, 2, 2, t],
        [-3, top + 5, 2, 2, t],
        [0, top + 6, 2, 1, t],
        [-3, top + 7, 1, 1, t],
        [1, top + 7, 1, 1, t]
      ])
    },
    dress: (P, g, top, end) => {
      // 白领子 + 黑领结 + 白围裙
      P(4, 10, 5, 1, WHITE)
      P(6, 11, 1, 1, INK)
      P(6, 12, 3, 3, '#f8f6f0')
      if (!g.seated) P(5, top, 5, end - top, '#f8f6f0')
      else P(5, top, 6, 1, '#f8f6f0')
    },
    head: (H) => {
      // 女仆头饰 + 鲸鳍耳
      H(3, -2, 7, 1, WHITE)
      for (const x of [3, 5, 7, 9]) H(x, -3, 1, 1, WHITE)
      H(8, -2, 2, 1, '#5a9ae0')
      H(-1, 4, 2, 1, '#2a3a6a')
      H(-2, 3, 2, 1, '#2a3a6a')
    }
  },
  // 蓝紫长发加一条麻花辫、小圆帽、白旗袍配藏青披肩、蓝色长裙
  qwen: {
    hair: ['#5a6ee0', '#8ea0f4', '#3a4cb0'],
    cut: 'braid',
    eyes: ['#5a6ad8', '#5a6ad8'],
    top: ['#ffffff', '#eef0fa', '#c8cce8'],
    sleeve: ['#3a4690', '#26306a', '#1a2250'],
    skirt: ['#5a70d0', '#3a4cb0', '#e8ecff'],
    skirtLen: 'long',
    legs: ['#f4f4fa', '#d8dae8'],
    shoe: '#3a4cb0',
    dress: (P) => {
      // 披肩搭在后背，盘扣
      P(2, 10, 2, 7, '#26306a')
      P(3, 10, 2, 1, '#26306a')
      P(7, 11, 1, 1, '#3a4690')
      P(7, 13, 1, 1, '#3a4690')
      P(4, 14, 5, 1, '#3a4cb0')
    },
    head: (H) => {
      H(4, -3, 5, 2, '#26306a')
      H(3, -1, 7, 1, '#3a4690')
      H(6, -4, 2, 1, WHITE)
      H(9, -1, 1, 3, '#7a8ae0')
    }
  },
  // 银色长卷发蓝发梢、月牙发卡、女仆头饰、藏青束腰配白裙、琴键裙边
  kimi: {
    hair: ['#d4d6e6', '#f6f6fc', '#a4a8c4'],
    cut: 'long',
    tips: '#a8c8ec',
    eyes: ['#8c84c8', '#8c84c8'],
    top: ['#ffffff', '#f0f0f6', '#c8c8d8'],
    sleeve: ['#ffffff', '#f0f0f6', '#c8c8d8'],
    skirt: ['#2a2c5a', '#1c1e44', WHITE],
    skirtLen: 'long',
    legs: ['#f6f6fa', '#d8d8e4'],
    shoe: '#1c1e44',
    dress: (P, g, top, end) => {
      P(5, 10, 3, 1, INK)
      P(4, 12, 5, 3, '#2a2c5a')
      P(6, 12, 1, 3, '#c8c8d8')
      if (!g.seated) {
        P(6, top + 1, 3, end - top - 1, '#f6f6fa')
        // 琴键裙边
        for (let x = 1; x < 12; x += 2) P(x, end - 1, 1, 1, INK)
      }
    },
    head: (H) => {
      H(3, -2, 7, 1, WHITE)
      H(10, -2, 1, 1, GOLD)
      H(11, -1, 1, 2, GOLD)
      H(10, 1, 1, 1, GOLD)
      H(2, -2, 2, 1, INK)
    }
  },
  // 黑色长直发、狐耳狐尾、额头上推着眼罩、黑白长裙
  glm: {
    hair: ['#1e1a24', '#3c3646', '#100e14'],
    cut: 'long',
    eyes: ['#4a4658', '#4a4658'],
    top: ['#ffffff', '#eeeef2', '#c8c8d0'],
    sleeve: ['#ffffff', '#eeeef2', '#c8c8d0'],
    skirt: ['#26222c', '#16141a', '#8a8698'],
    skirtLen: 'long',
    legs: ['#f4f4f6', '#d0d0d8'],
    shoe: '#26222c',
    back: (P, g) => {
      const t = '#26222c'
      const top = g.seated ? 11 : 14
      parts(P, g, [
        [1, top, 3, 3, t],
        [-1, top - 4, 4, 6, t],
        [-2, top - 6, 3, 3, t],
        [-2, top - 8, 3, 2, '#f0eef4'],
        [0, top - 3, 1, 3, '#3c3646']
      ])
    },
    dress: (P, g, top, end) => {
      P(5, 10, 3, 1, INK)
      P(6, 11, 1, 2, '#3a5a9a')
      P(4, 14, 5, 1, INK)
      if (!g.seated) P(7, top + 1, 3, end - top - 2, '#f4f4f6')
    },
    head: (H) => {
      ears(H, '#26222c', '#f0eef4', true)
      // 推到额头上的眼罩，画着闭着的眼
      H(3, 0, 7, 1, '#f0eef4')
      H(4, 0, 1, 1, INK)
      H(7, 0, 1, 1, INK)
    }
  },
  // 橙色短卷发、白贝雷帽、奶白外套、格子铅笔裙、粉色球鞋
  minimax: {
    hair: ['#f08a5a', '#fbb890', '#c8603a'],
    cut: 'short',
    eyes: ['#e0606a', '#e0606a'],
    top: ['#fffaf2', '#f2e8da', '#d6c8b4'],
    sleeve: ['#fffaf2', '#f2e8da', '#d6c8b4'],
    skirt: ['#c8a888', '#a88868', '#a88868'],
    skirtLen: 'pencil',
    legs: [C.skinA, C.skinAShade],
    socks: WHITE,
    shoe: '#e86a7a',
    dress: (P, g, top, end) => {
      P(6, 10, 1, 4, '#e0707e')
      P(6, 13, 2, 2, WHITE)
      P(3, 10, 1, 5, '#f2a0b0')
      if (!g.seated)
        for (let y = top + 1; y < end; y += 2) P(4 + ((y >> 1) % 2) * 2, y, 1, 1, '#8a6a4e')
    },
    head: (H) => {
      const cream = '#f6f0e8'
      H(5, -4, 2, 1, cream)
      H(2, -3, 9, 1, cream)
      H(1, -2, 11, 2, cream)
      H(1, -1, 11, 1, '#e0707e')
      H(10, 0, 1, 1, '#e0707e')
    }
  },
  // 棕色齐耳短发、黄色背带裙、白衬衫
  doubao: {
    hair: ['#5a3a2a', '#7a5440', '#3c2418'],
    cut: 'bob',
    eyes: ['#4a3020', '#4a3020'],
    top: ['#ffffff', '#f4f2ee', '#d4d0c8'],
    sleeve: ['#ffffff', '#f4f2ee', '#d4d0c8'],
    skirt: ['#f6c83a', '#d8a020', '#fff0b0'],
    skirtLen: 'knee',
    legs: ['#f6f6fa', '#d8d8e4'],
    shoe: '#7a4a2a',
    dress: (P) => {
      // 背带
      P(4, 10, 1, 5, '#f6c83a')
      P(8, 10, 1, 5, '#f6c83a')
      P(4, 13, 5, 2, '#f6c83a')
      P(4, 13, 1, 2, '#d8a020')
    },
    head: (H) => {
      H(9, 0, 2, 1, '#f6c83a')
      H(10, -1, 1, 1, '#f6c83a')
    }
  }
}

/** 身后垂下来的头发：先画，身子盖住 */
function backHair(a: Girl, H: Paint): void {
  const [c, hi, sh] = a.hair
  switch (a.cut) {
    case 'long':
    case 'braid': {
      const end = a.cut === 'braid' ? 16 : 19
      H(0, 1, 3, end, c)
      H(-1, 4, 1, end - 5, c)
      H(0, 4, 1, end - 6, sh)
      H(2, 3, 1, 5, hi)
      // 发梢：一高一低，卷一点
      H(-1, end - 1, 1, 1, c)
      H(1, end + 1, 1, 1, c)
      if (a.tips) {
        H(-1, end - 3, 1, 2, a.tips)
        H(0, end - 2, 3, 3, a.tips)
      }
      break
    }
    case 'twin':
      // 两条双马尾：后面这条
      H(-1, 0, 2, 2, c)
      H(-3, 2, 3, 11, c)
      H(-4, 5, 1, 6, c)
      H(-2, 13, 2, 2, c)
      H(-2, 3, 1, 8, hi)
      H(-3, 9, 1, 3, sh)
      break
    case 'short':
      H(0, 2, 3, 8, c)
      H(-1, 5, 1, 4, c)
      H(0, 6, 1, 3, sh)
      break
    case 'bob':
      H(0, 2, 3, 8, c)
      H(0, 5, 1, 4, sh)
      break
  }
}

/** 头顶、刘海、鬓发：画在脸上面 */
function frontHair(a: Girl, H: Paint): void {
  const [c, hi, sh] = a.hair
  H(3, -2, 7, 1, c)
  H(2, -1, 9, 1, c)
  H(1, 0, 11, 3, c)
  // 天使环
  H(4, -1, 3, 1, hi)
  H(3, 0, 2, 1, hi)
  H(8, 0, 2, 1, hi)
  // 耳后那一侧的鬓发
  H(1, 3, 2, 6, c)
  H(1, 3, 1, 6, sh)
  if (a.cut === 'bob') {
    // 齐刘海 + 齐耳
    H(2, 3, 9, 1, c)
    H(10, 4, 2, 6, c)
    H(2, 9, 1, 1, c)
    return
  }
  // 碎刘海：三缕，眼睛那两格露出来
  H(2, 3, 2, 1, c)
  H(6, 3, 2, 1, c)
  H(10, 3, 1, 1, c)
  H(7, 4, 1, 1, c)
  // 脸前那一侧的鬓发，长发的垂到下巴下面
  const long = a.cut !== 'short'
  H(11, 2, 1, long ? 9 : 7, c)
  H(10, 6, 1, long ? 4 : 2, c)
  if (a.cut === 'twin') {
    // 前面这条马尾
    H(11, 0, 2, 2, c)
    H(12, 2, 2, 11, c)
    H(13, 5, 1, 6, sh)
    H(12, 13, 2, 2, c)
    H(12, 3, 1, 6, hi)
  }
  if (a.cut === 'braid') {
    // 麻花辫搭在胸前
    H(10, 9, 2, 8, c)
    for (const y of [10, 12, 14]) H(10, y, 1, 1, hi)
    H(10, 17, 2, 1, GOLD)
  }
}

function face(a: Girl, H: Paint, b: Body, g: Pose): void {
  const skin = b.skin
  H(3, 1, 7, 1, skin)
  H(2, 2, 9, 6, skin)
  H(3, 8, 7, 1, skin)
  H(4, 9, 5, 1, skin)
  H(2, 2, 1, 6, b.skinShade)
  H(4, 9, 1, 1, b.skinShade)
  if (g.closed) {
    // 闭眼：弯弯的一道
    H(4, 5, 2, 1, INK)
    H(8, 5, 2, 1, INK)
  } else {
    // 大眼睛：上睫毛（近眼外角翘一格）、高光、瞳色两行
    H(4, 4, 2, 1, INK)
    H(8, 4, 3, 1, INK)
    H(4, 5, 1, 1, WHITE)
    H(5, 5, 1, 1, a.eyes[0])
    H(8, 5, 1, 1, WHITE)
    H(9, 5, 1, 1, a.eyes[1])
    H(4, 6, 2, 1, a.eyes[0])
    H(8, 6, 2, 1, a.eyes[1])
  }
  H(3, 7, 1, 1, BLUSH)
  H(9, 7, 1, 1, BLUSH)
  if (g.talking) H(7, 7, 1, 2, '#c8505a')
  else H(7, 8, 1, 1, b.skinLine)
}

export function girl(look: ModelLook, b: Body, g: Pose): void {
  const a = LOOKS[look]
  const P = b.P
  const H: Paint = (x, y, w, h, color) => P(x + g.dx, y + g.dy, w, h, color)

  a.back?.(P, g)
  backHair(a, H)

  // 裙子和腿
  const [sk, skShade, trim] = a.skirt
  const [leg, legShade] = a.legs
  let skirtEnd: number
  if (g.seated) {
    // 坐着：大腿平伸（裙子盖着），小腿垂下
    const drape = { mini: 0, knee: 2, pencil: 2, long: 4 }[a.skirtLen]
    P(3, 15, 9, 2, sk)
    P(3, 16, 9, 1, skShade)
    P(9, 17, 2, 4, leg)
    P(9, 17, 1, 4, legShade)
    if (a.socks) P(9, 19, 2, 2, a.socks)
    if (drape) {
      P(9, 17, 3, drape, sk)
      P(9, 16 + drape, 3, 1, trim)
    }
    P(9, 21, 3, 1, a.shoe)
    skirtEnd = 17
  } else {
    const rows = { mini: 4, knee: 6, pencil: 6, long: 9 }[a.skirtLen]
    skirtEnd = 15 + rows
    // 腿
    const legTop = skirtEnd
    const legH = 25 - legTop
    const walk = g.walk
    const legsAt: [number, number] =
      walk === 0 || walk === 2 ? (walk === 0 ? [3, 8] : [8, 3]) : walk < 0 ? [4, 7] : [5, 6]
    for (const [i, x] of legsAt.entries()) {
      P(x, legTop, 2, legH, i === 0 ? legShade : leg)
      if (a.socks) P(x, 22, 2, 3, a.socks)
      P(x, 25, i === 0 ? 2 : 3, 1, a.shoe)
    }
    // 裙子：上窄下宽
    if (a.skirtLen === 'pencil') {
      P(3, 15, 7, rows, sk)
      P(3, 15, 2, rows, skShade)
    } else {
      const sway = walk === 0 ? -1 : walk === 2 ? 1 : 0
      P(3, 15, 7, 1, sk)
      P(2, 16, 9, Math.min(2, rows - 1), sk)
      if (rows > 3) P(1 + sway, 18, 11, rows - 3, sk)
      P(2, 15, 2, 1, skShade)
      P(1 + sway, 18, 2, Math.max(0, rows - 3), skShade)
      P(2, 16, 2, 2, skShade)
    }
    const wide = a.skirtLen === 'pencil' ? [3, 7] : a.skirtLen === 'mini' ? [2, 9] : [1, 11]
    P(wide[0]!, skirtEnd - 1, wide[1]!, 1, trim)
  }

  // 上衣：肩到腰，腰收一格
  const [hi, mid, lo] = a.top
  const rows = a.crop ? 3 : 4
  P(3, 10, 7, rows, mid)
  P(3, 10, 2, rows, lo)
  P(8, 11, 1, 2, hi)
  if (a.crop) P(4, 13, 5, 2, b.skin)
  else P(4, 14, 5, 1, mid)
  a.dress?.(P, g, 15, skirtEnd)

  face(a, H, b, g)
  frontHair(a, H)
  a.head?.(H)
}
