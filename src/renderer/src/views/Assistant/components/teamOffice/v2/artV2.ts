/**
 * 豪华像素版（V2）的美术设定：调色板、几何、像素字体。
 *
 * ## 为什么这里写死颜色
 *
 * 简约版跟着主题走（墨线单色）。豪华版是一幅「画」—— 像素画的质感全靠一套手调的
 * 有限调色板：同一种木头要有亮、中、暗、描边四档，叶子要有三档绿，暖光要和墙纸
 * 互相衬。这些不是界面颜色，不承担文字对比度，也不该随主题反相（深色主题下把
 * 木地板反成浅色只会很怪）。所以它和图片素材一样，是**美术数据**，集中写在这一个文件里，
 * 界面的其余部分照旧只用主题 token。
 *
 * 参考气质：温暖的木质咖啡馆 + 绿植 + 霓虹招牌，像《风来之国》那一路的室内像素画。
 */

import type { OfficeProfile } from '../officeSim'

export const C = {
  // 描边：深棕，不用纯黑
  line: '#2b1d1a',
  lineGreen: '#1d2b22',
  // 墙纸：鼠尾草绿 + 暗纹
  wall: '#4d6a55',
  wallLight: '#5a7a60',
  wallDark: '#3e5646',
  wallMotif: '#668a6b',
  // 护墙板、木作
  wood: '#7a5238',
  woodLight: '#93684a',
  woodDark: '#5a3a28',
  woodDeep: '#43291d',
  woodHi: '#b0835b',
  // 地板
  plank: '#8d5c3d',
  plankLight: '#a06b47',
  plankDark: '#714830',
  plankSeam: '#553522',
  plankHi: '#bb8a5e',
  // 奶油色、黄铜
  cream: '#f0e4c8',
  creamMid: '#d8c7a2',
  creamDark: '#b5a17c',
  brass: '#d8a648',
  brassLight: '#f2cf7a',
  brassDark: '#9a6b2c',
  // 绿植
  leaf: '#4f8f4f',
  leafLight: '#76b763',
  leafDark: '#2f5f3a',
  leafDeep: '#20412a',
  // 陶盆
  terra: '#b9653f',
  terraLight: '#d6845a',
  terraDark: '#8a462b',
  // 点缀
  teal: '#3f8f8a',
  tealLight: '#62b6a8',
  tealDark: '#2b625f',
  rose: '#d9667a',
  roseLight: '#f39aa6',
  plum: '#7a4f8f',
  // 天
  skyDay: '#9fd4e6',
  skyDayLight: '#cdeef3',
  skyDusk: '#f0a35c',
  skyDuskHigh: '#c96a6a',
  skyNight: '#1d2948',
  skyNightLight: '#2c3d66',
  cloud: '#f6f2e6',
  star: '#f5e9b8',
  sun: '#ffd36e',
  city: '#5d6f8a',
  cityNight: '#26324f',
  cityLight: '#ffd36e',
  // 屏幕
  bezel: '#22252b',
  bezelLight: '#3a3e47',
  screen: '#16283a',
  screenGlow: '#7fe3d0',
  codeA: '#f2cf7a',
  codeB: '#ee8f8f',
  codeC: '#9fd4e6',
  codeD: '#b6e38a',
  // 霓虹
  neon: '#ff6fa8',
  neonGlow: '#ffb3d1',
  neonDim: '#8a3a5c',
  // 软木板、便利贴
  cork: '#b88a5a',
  corkDark: '#9a6f45',
  corkDot: '#8a6038',
  noteTodo: '#f2dc7a',
  noteDoing: '#8fc6f0',
  noteDone: '#9ad58a',
  noteBlocked: '#f09090',
  pin: '#d9667a',
  // 人
  skinA: '#f2c6a0',
  skinAShade: '#d9a07c',
  skinALine: '#9a5f45',
  skinB: '#c88a62',
  skinBShade: '#a86c4a',
  skinBLine: '#6e4130',
  blush: '#e8907c',
  eye: '#2b1d1a',
  glint: '#ffffff',
  pants: '#3b3654',
  pantsShade: '#2a2640',
  shoe: '#2b1d1a',
  shoeHi: '#4a3a34',
  // 夜里的暖光、白天的窗光
  warm: '#ffd38a',
  dayLight: '#fff3d6',
  nightTint: '#141c36',
  shadow: '#1c1410',
  // 虚幻的小东西：节点图、默认材质、灰人偶
  ueGraph: '#1b2230',
  ueGrid: '#232c3c',
  ueNode: '#2e3646',
  ueGrey: '#9a9ca3',
  ueLight: '#d2d4d8',
  ueDark: '#6b6e76',
  // 猫
  catOrange: '#e0913f',
  catOrangeDark: '#b86a26',
  catCream: '#f6e2c0'
} as const

/** 衬衫：[亮, 中, 暗]。制作人穿深蓝西装 */
export const SHIRTS: [string, string, string][] = [
  ['#86a6ee', '#5b7fd1', '#3f5ba3'],
  ['#f0907a', '#d96a55', '#a84a3c'],
  ['#f2cf7a', '#d8a648', '#9a6b2c'],
  ['#73c2b4', '#3f8f8a', '#2b625f'],
  ['#b58ad0', '#8a5aa3', '#5f3d75'],
  ['#9ccf7a', '#5f9e4f', '#3f6e36']
]
export const PRODUCER_SHIRT: [string, string, string] = ['#4a5f94', '#2f3f6a', '#1f2a4a']

/** 发色：[主色, 高光] */
export const HAIRS: [string, string][] = [
  ['#3a2a24', '#5c4236'],
  ['#1f1b24', '#3a3444'],
  ['#8a4f2a', '#b07040'],
  ['#c9a35a', '#e8c880'],
  ['#5a3a5a', '#7e5680']
]

/**
 * V2 的几何。人 13×26（坐下矮 4），场景 112 高，地板带 30 像素，能看出纵深。
 * 吧台、饮水机、大盆栽在左，软木板和制作人在右，中间按人数排工位。
 */
export const V2_PROFILE: OfficeProfile = {
  sceneH: 112,
  floorY: 100,
  wallY: 82,
  spriteW: 13,
  spriteH: 26,
  sitDrop: 4,
  // 吧台 31 宽、饮水机 9 宽、大盆栽 27 宽（见 sprites/）
  machineX: 3,
  coolerX: 37,
  plantX: 49,
  deskStart: 82,
  boardW: 38,
  producerInset: 20,
  boardGap: 10,
  slotMin: 42,
  slotMax: 50,
  deskOffset: 12,
  seatOffset: 1,
  deskWMin: 24,
  deskWMax: 36,
  deskPad: 16,
  monitorW: 18,
  // 沙发 46 + 落地灯 + 书架 27
  sofaNeed: 88,
  windowW: 27,
  windowStart: 82,
  windowEvery: 96,
  walkSpeed: 28,
  hurrySpeed: 46,
  spots: { machine: 14, cooler: 11, plant: 28, sofa: 14, peek: -16 },
  steam: { machine: [9, -24], mug: [-7, -13] },
  hit: { plant: [0, 27, -48, 0], machine: [2, 16, -30, -14] }
}

/**
 * 3×5 像素字体，只收招牌和白板用得到的字。
 * 每个字 5 行，每行 3 位（1 = 亮）。
 */
export const FONT: Record<string, number[]> = {
  A: [0b010, 0b101, 0b111, 0b101, 0b101],
  B: [0b110, 0b101, 0b110, 0b101, 0b110],
  D: [0b110, 0b101, 0b101, 0b101, 0b110],
  E: [0b111, 0b100, 0b110, 0b100, 0b111],
  I: [0b111, 0b010, 0b010, 0b010, 0b111],
  O: [0b010, 0b101, 0b101, 0b101, 0b010],
  S: [0b011, 0b100, 0b010, 0b001, 0b110],
  T: [0b111, 0b010, 0b010, 0b010, 0b010],
  U: [0b101, 0b101, 0b101, 0b101, 0b111],
  X: [0b101, 0b101, 0b010, 0b101, 0b101],
  N: [0b101, 0b111, 0b111, 0b111, 0b101],
  W: [0b101, 0b101, 0b101, 0b111, 0b101],
  // 数字和几个符号：任务板上的计数、进度用（PixelText）
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b011, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b010, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '/': [0b001, 0b001, 0b010, 0b100, 0b100],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
  '×': [0b000, 0b101, 0b010, 0b101, 0b000],
  '!': [0b010, 0b010, 0b010, 0b000, 0b010],
  '.': [0b000, 0b000, 0b000, 0b000, 0b010],
  ' ': [0, 0, 0, 0, 0]
}
