/**
 * 把 OfficeSim 画到画布上。坐标全是场景像素（整数），画布外面按整数倍放大，
 * 所以每一笔都是一个实心方块 —— 像素风靠的就是这个，不用贴图。
 *
 * 人物是侧身的（朝左 / 朝右），家具是正面的：显示器要让人看见屏幕上在干嘛，
 * 这是横版像素游戏里常见的「人侧、物正」画法。
 */

import type { TaskStatus } from '@core/shared/agentTeam'

import type { OfficePalette } from './officePalette'
import {
  SIT_DROP,
  SPRITE_H,
  SPRITE_W,
  type Actor,
  type BubbleIcon,
  type DeskSlot,
  type OfficeSim,
  type Particle,
  type Pose
} from './officeSim'

type Ctx = CanvasRenderingContext2D

export interface DrawState {
  /** 白板上的任务格子，顺序同任务板 */
  board: TaskStatus[]
  hover: string | null
  selected: string | null
  /** 墙上的钟和窗外的天跟着真实时间 */
  now: Date
}

function rect(ctx: Ctx, color: string, x: number, y: number, w: number, h: number): void {
  if (w <= 0 || h <= 0) return
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x), Math.round(y), w, h)
}

/** 空心框 */
function frame(ctx: Ctx, color: string, x: number, y: number, w: number, h: number): void {
  rect(ctx, color, x, y, w, 1)
  rect(ctx, color, x, y + h - 1, w, 1)
  rect(ctx, color, x, y, 1, h)
  rect(ctx, color, x + w - 1, y, 1, h)
}

/** 圆角框：四个角各缺一个像素 */
function roundFrame(
  ctx: Ctx,
  color: string,
  fill: string,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  rect(ctx, fill, x + 1, y + 1, w - 2, h - 2)
  rect(ctx, color, x + 1, y, w - 2, 1)
  rect(ctx, color, x + 1, y + h - 1, w - 2, 1)
  rect(ctx, color, x, y + 1, 1, h - 2)
  rect(ctx, color, x + w - 1, y + 1, 1, h - 2)
}

const hash = (n: number): number => {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

export function drawOffice(ctx: Ctx, sim: OfficeSim, pal: OfficePalette, state: DrawState): void {
  const L = sim.layout
  const t = sim.time
  const hour = state.now.getHours() + state.now.getMinutes() / 60
  const night = hour < 6.5 || hour >= 19
  const dusk = !night && hour >= 17

  room(ctx, sim, pal)
  for (let i = 0; i < L.windows.length; i++) windowPane(ctx, pal, L.windows[i]!, t, hour, i)
  lamps(ctx, sim, pal, night)
  poster(ctx, sim, pal)
  clock(ctx, pal, L.clockX, 3, state.now)
  board(ctx, sim, pal, state.board)
  kitchen(ctx, sim, pal)
  plant(ctx, sim, pal)
  if (L.sofaX !== null) sofa(ctx, sim, pal, L.sofaX, night || dusk)

  const actors = [...sim.actors.values()]
  // 椅子在人后面，桌子在人前面（手要搭在键盘上）
  for (const [id, desk] of L.desks) chair(ctx, pal, desk, L.floorY, sim.actors.get(id))
  for (const actor of actors) if (actor.seated) person(ctx, sim, pal, actor)
  for (const [id, desk] of L.desks) deskAndScreen(ctx, sim, pal, desk, sim.actors.get(id), night)
  for (const actor of actors) if (actor.seated) arms(ctx, sim, pal, actor)
  const standing = actors
    .filter((a) => !a.seated)
    .sort((a, b) => Number(a.producer) - Number(b.producer))
  for (const actor of standing) {
    person(ctx, sim, pal, actor)
    arms(ctx, sim, pal, actor)
  }

  for (const p of sim.particles) particle(ctx, pal, p, t)
  for (const actor of actors) {
    if (actor.bubble) bubble(ctx, sim, pal, actor, actor.bubble.icon, !!actor.bubble.alert)
    const marked =
      actor.id === state.selected ? pal.accent : actor.id === state.hover ? pal.ink2 : null
    if (marked && !actor.bubble) marker(ctx, sim, actor, marked)
  }
}

// ── 房间 ─────────────────────────────────────────────────────────────────

function room(ctx: Ctx, sim: OfficeSim, pal: OfficePalette): void {
  const L = sim.layout
  rect(ctx, pal.wall, 0, 0, L.width, L.wallY)
  rect(ctx, pal.faint, 0, 0, L.width, 1)
  // 墙裙：一条细线往上收
  rect(ctx, pal.floorLine, 0, L.wallY - 7, L.width, 1)
  rect(ctx, pal.floor, 0, L.wallY, L.width, L.height - L.wallY)
  rect(ctx, pal.ink2, 0, L.wallY, L.width, 1)
  rect(ctx, pal.faint, 0, L.wallY + 1, L.width, 1)
  // 地板：两道横缝，竖缝错开
  for (const [row, offset] of [
    [L.wallY + 5, 0],
    [L.floorY + 3, 9]
  ] as const) {
    rect(ctx, pal.floorLine, 0, row, L.width, 1)
    for (let x = offset; x < L.width; x += 18) rect(ctx, pal.floorLine, x, row - 3, 1, 3)
  }
}

function windowPane(
  ctx: Ctx,
  pal: OfficePalette,
  x: number,
  t: number,
  hour: number,
  index: number
): void {
  const y = 9
  const w = 18
  const h = 20
  const night = hour < 6.5 || hour >= 19
  const dusk = !night && hour >= 17
  rect(ctx, night ? pal.nightSky : pal.daySky, x + 1, y + 1, w - 2, h - 2)
  if (night) {
    // 星星一闪一闪，月亮挂在第一扇窗
    for (let i = 0; i < 5; i++) {
      const sx = x + 2 + Math.floor(hash(index * 7 + i) * (w - 4))
      const sy = y + 2 + Math.floor(hash(index * 13 + i) * (h - 8))
      if (Math.sin(t * 1.3 + i * 2.1) > -0.3) rect(ctx, pal.star, sx, sy, 1, 1)
    }
    if (index === 0) {
      rect(ctx, pal.star, x + w - 7, y + 3, 3, 3)
      rect(ctx, pal.nightSky, x + w - 6, y + 3, 2, 2)
    }
  } else {
    // 太阳从早到晚往下落，傍晚变暖
    const k = Math.max(0, Math.min(1, (hour - 6.5) / 12.5))
    if (index === 0) {
      const sy =
        y + 3 + Math.round(Math.sin(k * Math.PI) < 0.5 ? (1 - Math.sin(k * Math.PI)) * 9 : 0)
      rect(ctx, dusk ? pal.danger : pal.warning, x + 3, sy, 3, 3)
    }
    // 云慢慢飘
    const drift = (t * 1.5 + index * 23) % (w + 10)
    const cx = x + 1 + Math.round(drift) - 8
    for (const [dx, dy, cw] of [
      [0, 1, 6],
      [2, 0, 3]
    ] as const) {
      const left = Math.max(x + 1, cx + dx)
      const right = Math.min(x + w - 1, cx + dx + cw)
      rect(ctx, pal.star, left, y + 8 + dy, right - left, 1)
    }
  }
  // 远处的楼
  for (let i = 0; i < 4; i++) {
    const bh = 3 + Math.floor(hash(index * 3 + i) * 5)
    const bx = x + 1 + i * 4
    rect(ctx, pal.faint, bx, y + h - 1 - bh, 3, bh)
    if (night && hash(index + i * 9) > 0.4) rect(ctx, pal.warning, bx + 1, y + h - bh, 1, 1)
  }
  frame(ctx, pal.ink2, x, y, w, h)
  rect(ctx, pal.ink2, x + Math.floor(w / 2), y, 1, h)
  rect(ctx, pal.ink2, x, y + Math.floor(h / 2), w, 1)
  // 窗台
  rect(ctx, pal.ink2, x - 1, y + h, w + 2, 1)
}

function lamps(ctx: Ctx, sim: OfficeSim, pal: OfficePalette, night: boolean): void {
  const L = sim.layout
  for (const desk of L.desks.values()) {
    const x = desk.monitorX + 4
    // 吊灯线别穿过窗户
    if (L.windows.some((w) => x + 5 >= w - 1 && x - 2 <= w + 18)) continue
    rect(ctx, pal.faint, x + 1, 1, 1, 7)
    rect(ctx, pal.ink2, x - 1, 8, 5, 2)
    rect(ctx, pal.ink2, x - 2, 10, 7, 1)
    if (night) {
      // 夜里灯亮：灯罩下一小片暖光，用棋盘格抖出来
      rect(ctx, pal.warning, x, 11, 3, 1)
      for (let dy = 12; dy < 16; dy++)
        for (let dx = -2 + (dy % 2); dx < 5 + (dy - 12); dx += 2)
          rect(ctx, pal.warning, x + dx, dy, 1, 1)
    }
  }
}

function poster(ctx: Ctx, sim: OfficeSim, pal: OfficePalette): void {
  const L = sim.layout
  // 厨房上方的吊柜
  frame(ctx, pal.faint, 2, 16, 28, 9)
  rect(ctx, pal.faint, 16, 16, 1, 9)
  rect(ctx, pal.ink2, 13, 20, 1, 2)
  rect(ctx, pal.ink2, 19, 20, 1, 2)
  // 工位上方的海报：一座山 —— 好歹是个做游戏的地方
  if (L.desks.size >= 3) {
    const first = [...L.desks.values()][Math.floor(L.desks.size / 2)]!
    const x = first.x + Math.floor(first.width / 2) - 6
    if (!L.windows.some((w) => Math.abs(w - x) < 22)) {
      rect(ctx, pal.paper, x + 1, 13, 11, 13)
      frame(ctx, pal.ink2, x, 12, 13, 15)
      rect(ctx, pal.success, x + 3, 21, 7, 2)
      rect(ctx, pal.success, x + 5, 19, 3, 2)
      rect(ctx, pal.success, x + 6, 18, 1, 1)
      rect(ctx, pal.warning, x + 8, 15, 2, 2)
    }
  }
}

function clock(ctx: Ctx, pal: OfficePalette, x: number, y: number, now: Date): void {
  const s = 7
  rect(ctx, pal.paper, x + 1, y + 1, s - 2, s - 2)
  roundFrame(ctx, pal.ink2, pal.paper, x, y, s, s)
  const cx = x + 3
  const cy = y + 3
  rect(ctx, pal.ink, cx, cy, 1, 1)
  const hand = (angle: number, length: number, color: string): void => {
    for (let r = 1; r <= length; r++)
      rect(
        ctx,
        color,
        cx + Math.round(Math.sin(angle) * r),
        cy - Math.round(Math.cos(angle) * r),
        1,
        1
      )
  }
  const minutes = now.getMinutes() + now.getSeconds() / 60
  hand(((now.getHours() % 12) + minutes / 60) * (Math.PI / 6), 1, pal.ink)
  hand(minutes * (Math.PI / 30), 2, pal.ink2)
}

function board(ctx: Ctx, sim: OfficeSim, pal: OfficePalette, tasks: TaskStatus[]): void {
  const L = sim.layout
  const x = L.boardX
  const y = 13
  const w = L.boardW
  const h = 21
  rect(ctx, pal.paper, x + 1, y + 1, w - 2, h - 2)
  frame(ctx, pal.ink2, x, y, w, h)
  rect(ctx, pal.ink2, x + 2, y + h, w - 4, 1)
  rect(ctx, pal.ink2, x + 3, y + h + 1, 1, L.wallY - y - h - 1)
  rect(ctx, pal.ink2, x + w - 4, y + h + 1, 1, L.wallY - y - h - 1)
  // 任务格子：完成 / 进行中 / 受阻 / 待办
  const tone: Record<TaskStatus, string> = {
    done: pal.success,
    doing: pal.accent,
    blocked: pal.danger,
    todo: pal.faint
  }
  const perRow = Math.floor((w - 4) / 3)
  tasks.slice(0, perRow * 2).forEach((status, i) => {
    const col = i % perRow
    const row = Math.floor(i / perRow)
    const cx = x + 2 + col * 3
    const cy = y + 2 + row * 3
    if (status === 'todo') frame(ctx, tone.todo, cx, cy, 2, 2)
    else rect(ctx, tone[status], cx, cy, 2, 2)
  })
  // 制作人写下的东西：一道一道慢慢出来
  const strokes = Math.floor(sim.boardInk)
  for (let i = 0; i < strokes; i++) {
    const row = Math.floor(i / 6)
    if (row > 3) break
    const sx = x + 2 + (i % 6) * 4 + Math.floor(hash(i) * 2)
    const sy = y + 9 + row * 3
    rect(ctx, i % 7 === 3 ? pal.accent : pal.ink2, sx, sy, 2 + Math.floor(hash(i + 50) * 2), 1)
  }
  // 验收没过：白板上下一小会儿雨
  if (sim.rainUntil > sim.time) {
    const cx = x + Math.floor(w / 2) - 4
    rect(ctx, pal.ink2, cx, y - 6, 8, 2)
    rect(ctx, pal.ink2, cx + 2, y - 7, 4, 1)
    for (let i = 0; i < 3; i++) {
      const dy = (sim.time * 18 + i * 5) % 6
      rect(ctx, pal.accent, cx + 1 + i * 3, y - 4 + dy, 1, 1)
    }
  }
}

function kitchen(ctx: Ctx, sim: OfficeSim, pal: OfficePalette): void {
  const L = sim.layout
  const f = L.floorY
  // 操作台
  rect(ctx, pal.paper, 2, f - 9, 17, 9)
  frame(ctx, pal.ink2, 2, f - 9, 17, 10)
  rect(ctx, pal.ink2, 1, f - 10, 19, 1)
  rect(ctx, pal.faint, 10, f - 7, 1, 7)
  rect(ctx, pal.ink2, 8, f - 5, 1, 1)
  rect(ctx, pal.ink2, 12, f - 5, 1, 1)
  // 咖啡机
  const mx = L.machineX
  const brewing = sim.brewUntil > sim.time
  rect(ctx, pal.paper, mx + 1, f - 22, 7, 12)
  frame(ctx, pal.ink, mx, f - 23, 9, 13)
  rect(ctx, pal.ink, mx + 1, f - 19, 7, 1)
  rect(
    ctx,
    brewing && Math.floor(sim.time * 4) % 2 === 0 ? pal.warning : pal.success,
    mx + 6,
    f - 21,
    1,
    1
  )
  rect(ctx, pal.ink, mx + 3, f - 18, 3, 1)
  if (brewing) {
    rect(ctx, pal.ink2, mx + 4, f - 17, 1, 2 + (Math.floor(sim.time * 6) % 2))
    frame(ctx, pal.ink, mx + 3, f - 13, 3, 3)
  }
  // 饮水机
  const cx = L.coolerX
  rect(ctx, pal.paper, cx + 1, f - 11, 5, 11)
  frame(ctx, pal.ink2, cx, f - 12, 7, 13)
  rect(ctx, pal.accent, cx + 3, f - 9, 1, 1)
  rect(ctx, pal.accentSoft, cx + 1, f - 20, 5, 8)
  frame(ctx, pal.ink2, cx + 1, f - 20, 5, 8)
  rect(ctx, pal.ink2, cx + 2, f - 21, 3, 1)
  const level = 2 + Math.floor((Math.sin(sim.time * 0.05) + 1) * 2)
  rect(ctx, pal.accent, cx + 2, f - 13 - level, 3, 1)
}

function plant(ctx: Ctx, sim: OfficeSim, pal: OfficePalette): void {
  const L = sim.layout
  const f = L.floorY
  const x = L.plantX
  const shake = sim.plantShakeUntil > sim.time ? Math.round(Math.sin(sim.time * 40)) : 0
  const sway = Math.round(Math.sin(sim.time * 0.8)) * 0
  rect(ctx, pal.paper, x + 1, f - 5, 5, 5)
  frame(ctx, pal.ink2, x, f - 6, 7, 7)
  rect(ctx, pal.ink2, x - 1, f - 6, 9, 1)
  const leaves: [number, number, number][] = [
    [3, -7, 1],
    [3, -8, 1],
    [3, -9, 1],
    [2, -10, 1],
    [1, -11, 2],
    [4, -10, 1],
    [5, -11, 2],
    [3, -13, 1],
    [2, -14, 3],
    [0, -9, 2],
    [5, -8, 2],
    [-1, -13, 2],
    [6, -14, 2],
    [3, -16, 1]
  ]
  for (const [dx, dy, w] of leaves) {
    const lean = dy < -10 ? shake + sway : 0
    rect(ctx, pal.success, x + dx + lean, f + dy, w, 1)
  }
}

function sofa(ctx: Ctx, sim: OfficeSim, pal: OfficePalette, x: number, lampOn: boolean): void {
  const f = sim.layout.floorY
  rect(ctx, pal.paper, x + 1, f - 11, 22, 9)
  frame(ctx, pal.ink2, x, f - 12, 24, 6)
  frame(ctx, pal.ink2, x, f - 7, 24, 5)
  rect(ctx, pal.ink2, x - 1, f - 9, 3, 7)
  rect(ctx, pal.ink2, x + 22, f - 9, 3, 7)
  rect(ctx, pal.faint, x + 12, f - 6, 1, 3)
  rect(ctx, pal.ink2, x + 1, f - 2, 1, 2)
  rect(ctx, pal.ink2, x + 22, f - 2, 1, 2)
  // 落地灯
  const lx = x + 28
  rect(ctx, pal.ink2, lx + 2, f - 22, 1, 22)
  rect(ctx, pal.ink2, lx, f, 5, 1)
  rect(ctx, pal.ink2, lx - 1, f - 26, 7, 1)
  rect(ctx, pal.ink2, lx, f - 25, 5, 3)
  if (lampOn) rect(ctx, pal.warning, lx + 1, f - 22, 3, 1)
}

// ── 工位 ─────────────────────────────────────────────────────────────────

function chair(
  ctx: Ctx,
  pal: OfficePalette,
  desk: DeskSlot,
  f: number,
  owner: Actor | undefined
): void {
  const x = desk.seatX
  // 人站起来走了，椅子微微转开一点
  const turned = owner && !owner.seated ? 1 : 0
  rect(ctx, pal.ink2, x + 1 + turned, f - 12, 1, 10)
  rect(ctx, pal.ink2, x + 1 + turned, f - 12, 2, 1)
  rect(ctx, pal.ink2, x + 1, f - 2, 7, 1)
  rect(ctx, pal.ink2, x + 4, f - 1, 1, 1)
  rect(ctx, pal.ink2, x + 2, f, 1, 1)
  rect(ctx, pal.ink2, x + 6, f, 1, 1)
}

function deskAndScreen(
  ctx: Ctx,
  sim: OfficeSim,
  pal: OfficePalette,
  desk: DeskSlot,
  owner: Actor | undefined,
  night: boolean
): void {
  const f = sim.layout.floorY
  const x = desk.deskX
  const w = desk.deskW
  // 桌面和两条腿（桌面比坐着的腿高一格，手正好搭在键盘上）
  rect(ctx, pal.ink2, x, f - 4, w, 1)
  rect(ctx, pal.faint, x, f - 3, w, 1)
  rect(ctx, pal.ink2, x + 1, f - 3, 1, 4)
  rect(ctx, pal.ink2, x + w - 2, f - 3, 1, 4)
  // 键盘
  rect(ctx, pal.ink, x, f - 5, 4, 1)
  // 显示器
  const mx = desk.monitorX
  rect(ctx, pal.ink2, mx + 5, f - 6, 1, 2)
  rect(ctx, pal.ink2, mx + 3, f - 5, 5, 1)
  rect(ctx, pal.bezel, mx, f - 16, 11, 10)
  screen(ctx, sim, pal, mx + 1, f - 15, 9, 8, owner)
  // 桌上的小东西：一人一样，按发型分
  if (owner) trinket(ctx, sim, pal, x + w - 2, f - 5, owner, night)
  if (desk.mugUntil > sim.time) {
    frame(ctx, pal.ink, x + w - 6, f - 7, 3, 3)
    rect(ctx, pal.ink, x + w - 3, f - 6, 1, 1)
  }
}

function trinket(
  ctx: Ctx,
  sim: OfficeSim,
  pal: OfficePalette,
  x: number,
  y: number,
  owner: Actor,
  night: boolean
): void {
  const crew = pal.crew[Math.max(0, owner.crew) % pal.crew.length]!
  switch (owner.style % 6) {
    case 0: // 仙人掌
      rect(ctx, pal.success, x, y - 3, 1, 3)
      rect(ctx, pal.success, x - 1, y - 2, 1, 1)
      rect(ctx, pal.ink2, x - 1, y, 3, 1)
      break
    case 1: // 相框
      frame(ctx, pal.ink2, x - 1, y - 3, 3, 4)
      break
    case 2: // 台灯
      rect(ctx, pal.ink2, x, y - 3, 1, 4)
      rect(ctx, pal.ink2, x - 1, y - 4, 3, 1)
      if (night) rect(ctx, pal.warning, x - 1, y - 3, 1, 1)
      break
    case 3: // 魔方
      rect(ctx, crew, x - 1, y - 1, 2, 2)
      rect(ctx, pal.warning, x, y - 1, 1, 1)
      break
    case 4: // 手办：偶尔点个头
      rect(ctx, pal.ink, x, y - 3 + (Math.floor(sim.time * 1.2) % 5 === 0 ? 1 : 0), 1, 1)
      rect(ctx, crew, x, y - 1, 1, 2)
      break
    default: // 一摞书
      rect(ctx, crew, x - 1, y, 3, 1)
      rect(ctx, pal.ink2, x - 1, y - 1, 3, 1)
      rect(ctx, pal.accent, x - 1, y - 2, 2, 1)
  }
}

/** 屏幕上演的是它此刻在干的事 */
function screen(
  ctx: Ctx,
  sim: OfficeSim,
  pal: OfficePalette,
  x: number,
  y: number,
  w: number,
  h: number,
  owner: Actor | undefined
): void {
  const t = sim.time
  const pose = owner?.seated ? owner.pose : null
  const crew = owner ? pal.crew[Math.max(0, owner.crew) % pal.crew.length]! : pal.ink2
  const working = owner?.mode.kind === 'work' || owner?.mode.kind === 'wait'
  if (!owner || (!owner.seated && !working)) {
    // 没人：屏保，一个小点慢慢飘
    rect(ctx, pal.bezel, x, y, w, h)
    const px = Math.floor((Math.sin(t * 0.7 + (owner?.style ?? 0)) + 1) * 0.5 * (w - 1))
    const py = Math.floor((Math.cos(t * 0.5) + 1) * 0.5 * (h - 1))
    rect(ctx, pal.ink2, x + px, y + py, 1, 1)
    return
  }
  rect(ctx, pal.screen, x, y, w, h)
  switch (pose) {
    case 'type': {
      // 代码一行一行冒出来，满了往上滚
      const lines = Math.floor(t * 2.2 + owner.style)
      for (let row = 0; row < h - 1; row++) {
        const n = lines - (h - 2) + row
        if (n < 0) continue
        const indent = Math.floor(hash(n) * 3)
        const len = 2 + Math.floor(hash(n + 99) * (w - 3 - indent))
        rect(
          ctx,
          n % 4 === 0 ? crew : pal.ink2,
          x + 1 + indent,
          y + row + 1,
          Math.min(len, w - 2 - indent),
          1
        )
      }
      if (Math.floor(t * 3) % 2 === 0) rect(ctx, pal.star, x + w - 2, y + h - 2, 1, 1)
      break
    }
    case 'read': {
      // 一页白纸，字一行行往上滚
      rect(ctx, pal.star, x + 1, y, w - 2, h)
      const scroll = Math.floor(t * 0.8)
      for (let row = 1; row < h; row += 2) {
        const n = row + scroll * 2
        rect(ctx, pal.ink2, x + 2, y + row, w - 4 - Math.floor(hash(n) * 3), 1)
      }
      rect(ctx, crew, x, y + 2 + (Math.floor(t * 0.8) % 3) * 2, 1, 1)
      break
    }
    case 'lean': {
      // 跑东西：进度条 + 转圈
      const k = (t * 0.25) % 1
      frame(ctx, pal.star, x + 1, y + 4, w - 2, 2)
      rect(ctx, crew, x + 1, y + 4, Math.max(1, Math.round((w - 2) * k)), 2)
      const dots = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1]
      ]
      const [dx, dy] = dots[Math.floor(t * 6) % 4]!
      rect(ctx, pal.star, x + 4 + dx!, y + 1 + dy!, 1, 1)
      break
    }
    case 'look': {
      // 截图：一张小风景，咔嚓一下闪白
      rect(ctx, pal.accentSoft, x, y, w, h)
      rect(ctx, pal.success, x, y + h - 2, w, 2)
      rect(ctx, pal.success, x + 2, y + h - 4, 3, 2)
      rect(ctx, pal.success, x + 3, y + h - 5, 1, 1)
      rect(ctx, pal.warning, x + w - 3, y + 1, 2, 2)
      if ((t * 0.5) % 1 < 0.06) rect(ctx, pal.star, x, y, w, h)
      break
    }
    case 'play': {
      rect(ctx, pal.star, x, y + h - 1, w, 1)
      const jump = Math.abs(Math.sin(t * 5)) * 3
      rect(ctx, crew, x + 2, y + h - 3 - Math.round(jump), 2, 2)
      const enemy = w - 1 - Math.floor((t * 6) % w)
      rect(ctx, pal.danger, x + enemy, y + h - 2, 1, 1)
      break
    }
    case 'sleep': {
      rect(ctx, pal.bezel, x, y, w, h)
      rect(ctx, pal.danger, x + 4, y + 2, 1, 2)
      rect(ctx, pal.danger, x + 4, y + 5, 1, 1)
      break
    }
    default: {
      // 坐着等：一个闪烁的光标
      for (let row = 1; row < h - 2; row += 2) rect(ctx, pal.ink2, x + 1, y + row, w - 3 - row, 1)
      if (Math.floor(t * 2) % 2 === 0) rect(ctx, crew, x + 1, y + h - 2, 2, 1)
    }
  }
}

// ── 人 ───────────────────────────────────────────────────────────────────
//
// 精灵 9×19（坐下 9×15），大头身：头 7×8，身子 5 宽。lx/ly 都是朝右时的坐标。

interface Body {
  /** 头顶那一行的 y */
  top: number
  /** 画一个方块；朝左时自动镜像 */
  P: (lx: number, ly: number, w: number, h: number, color: string) => void
  shirt: string
  skin: string
  skinLine: string
  hairColor: string
  /** 身子往前 / 往后挪几格（靠背、趴桌） */
  lean: number
  /** 头往下沉几格 */
  nod: number
}

function bodyOf(ctx: Ctx, sim: OfficeSim, pal: OfficePalette, actor: Actor): Body {
  const f = sim.layout.floorY
  const hop = actor.hop > 0 ? Math.round(Math.abs(Math.sin(actor.hop * Math.PI * 2.2)) * 3) : 0
  const walkBob = actor.pose === 'walk' && Math.floor(actor.stride) % 2 === 1 ? 1 : 0
  const top = f - (SPRITE_H - 1) + (actor.seated ? SIT_DROP : 0) - hop - walkBob
  const x = Math.round(actor.x)
  const dir = actor.facing
  const P = (lx: number, ly: number, w: number, h: number, color: string): void => {
    const px = dir === 1 ? x + lx : x + (SPRITE_W - lx - w)
    rect(ctx, color, px, top + ly, w, h)
  }
  const shirt = actor.crew < 0 ? pal.accent : pal.crew[actor.crew % pal.crew.length]!
  const tone = (actor.style + Math.max(0, actor.crew)) % pal.skin.length
  const skin = pal.skin[tone]!
  const skinLine = pal.skinLine[tone]!
  const hairColor = pal.hair[[0, 2, 1, 0, 1, 0, 1, 2][actor.style % 8]! % pal.hair.length]!
  const lean = actor.pose === 'lean' ? -1 : actor.pose === 'look' || actor.pose === 'sleep' ? 1 : 0
  const nod = actor.pose === 'sleep' ? 3 : 0
  return { top, P, shirt, skin, skinLine, hairColor, lean, nod }
}

function person(ctx: Ctx, sim: OfficeSim, pal: OfficePalette, actor: Actor): void {
  const b = bodyOf(ctx, sim, pal, actor)
  const { P } = b
  const f = sim.layout.floorY
  // 脚下一小片影子
  if (!actor.seated) rect(ctx, pal.faint, Math.round(actor.x) + 2, f + 1, 6, 1)

  const legs = pal.pants
  const shoes = pal.shoes
  if (actor.seated) {
    P(3, 11, 5, 1, legs)
    P(7, 12, 1, 2, legs)
    P(7, 14, 2, 1, shoes)
  } else if (actor.pose === 'walk') {
    const phase = Math.floor(actor.stride) % 4
    if (phase === 1 || phase === 3) {
      P(4, 14, 2, 4, legs)
      P(4, 18, 3, 1, shoes)
    } else {
      P(3, 14, 3, 1, legs)
      P(2, 15, 1, 3, legs)
      P(6, 15, 1, 3, legs)
      P(1, 18, 2, 1, shoes)
      P(6, 18, 2, 1, shoes)
    }
  } else {
    P(3, 14, 1, 4, legs)
    P(5, 14, 1, 4, legs)
    P(3, 18, 2, 1, shoes)
    P(5, 18, 2, 1, shoes)
  }

  // 身子：坐着露三行，站着五行加一条裤腰
  P(2 + b.lean, 8, 5, actor.seated ? 3 : 5, b.shirt)
  if (!actor.seated) P(2, 13, 5, 1, legs)
  // 领口
  P(5 + b.lean, 8, 1, 1, b.skin)

  head(sim, pal, actor, b)
}

function head(sim: OfficeSim, pal: OfficePalette, actor: Actor, b: Body): void {
  const dx = b.lean + (actor.pose === 'sleep' ? 1 : 0)
  const dy = b.nod
  const H = (lx: number, ly: number, w: number, h: number, color: string): void =>
    b.P(lx + dx, ly + dy, w, h, color)
  const line = b.skinLine
  H(2, 0, 5, 1, line)
  H(1, 1, 1, 6, line)
  H(7, 1, 1, 6, line)
  H(2, 7, 5, 1, line)
  H(2, 1, 5, 6, b.skin)
  const eye = pal.shoes
  const asleep = actor.pose === 'sleep'
  if (asleep) H(5, 4, 2, 1, line)
  else if (sim.blinking(actor)) H(6, 4, 1, 1, line)
  else H(6, actor.pose === 'gaze' ? 2 : 3, 1, 2, eye)
  // 腮红：肤色的轮廓色点一下
  H(5, 5, 1, 1, line)
  // 说话时嘴一张一合
  if (actor.pose === 'chat' && Math.floor(sim.time * 6) % 2 === 0) H(6, 6, 1, 1, eye)
  hair(pal, actor, H, b)
}

function hair(pal: OfficePalette, actor: Actor, H: Body['P'], b: Body): void {
  const c = b.hairColor
  switch (actor.style % 8) {
    case 0: // 短发
      H(2, -1, 5, 1, c)
      H(1, 0, 7, 2, c)
      H(1, 2, 3, 2, c)
      H(1, 4, 2, 1, c)
      break
    case 1: // 长发
      H(2, -1, 5, 1, c)
      H(1, 0, 7, 2, c)
      H(1, 2, 3, 1, c)
      H(0, 2, 2, 8, c)
      break
    case 2: // 丸子头 + 眼镜
      H(1, -3, 3, 2, c)
      H(2, -1, 5, 1, c)
      H(1, 0, 7, 2, c)
      H(1, 2, 2, 2, c)
      H(4, 3, 4, 1, pal.shoes)
      break
    case 3: // 鸭舌帽（衬衫同色）
      H(2, -1, 5, 1, b.shirt)
      H(1, 0, 7, 2, b.shirt)
      H(6, 1, 3, 1, b.shirt)
      H(1, 2, 2, 3, c)
      break
    case 4: // 刺儿头
      for (const lx of [1, 3, 5, 7]) H(lx, -2, 1, 1, c)
      H(1, -1, 7, 1, c)
      H(1, 0, 7, 2, c)
      H(1, 2, 2, 2, c)
      break
    case 5: // 毛线帽
      H(4, -3, 1, 1, pal.ink2)
      H(2, -2, 5, 1, pal.ink2)
      H(1, -1, 7, 2, pal.ink2)
      H(1, 1, 7, 1, pal.shoes)
      H(1, 2, 2, 2, c)
      break
    case 6: // 制作人：耳麦
      H(2, -1, 5, 1, c)
      H(1, 0, 7, 2, c)
      H(1, 2, 2, 2, c)
      H(3, -2, 3, 1, pal.ink2)
      H(2, 3, 2, 2, pal.accent)
      H(4, 5, 3, 1, pal.ink2)
      break
    default: // 马尾
      H(2, -1, 5, 1, c)
      H(1, 0, 7, 2, c)
      H(1, 2, 2, 2, c)
      H(-1, 1, 2, 2, c)
      H(-2, 3, 2, 3, c)
  }
}

/** 胳膊和手里的东西单独画：坐着的人胳膊要搭到桌上，得在桌子之后画 */
function arms(ctx: Ctx, sim: OfficeSim, pal: OfficePalette, actor: Actor): void {
  const b = bodyOf(ctx, sim, pal, actor)
  const { P, skin } = b
  const t = sim.time
  const sleeve = pal.ink2
  const pose: Pose = actor.pose
  const seed = actor.style * 1.3
  switch (pose) {
    case 'type': {
      // 两只手轮流敲：一只落在键盘上，一只抬起一格
      const tap = Math.floor(t * 9 + seed) % 2
      P(5, 9, 3, 1, sleeve)
      P(8, 8 + tap, 1, 1, skin)
      P(9, 9 - tap, 1, 1, skin)
      break
    }
    case 'read':
    case 'look':
      P(5 + b.lean, 8, 1, 2, sleeve)
      P(6 + b.lean, 7, 1, 1, skin)
      break
    case 'lean':
      // 往后一靠，双手抱头
      P(0, 3, 1, 5, sleeve)
      P(0, 2, 1, 1, skin)
      break
    case 'play': {
      const bounce = Math.floor(t * 6) % 2
      P(5, 9, 2, 1, sleeve)
      P(7, 8 - bounce, 3, 1, pal.ink)
      P(8, 7 - bounce, 1, 1, pal.danger)
      break
    }
    case 'sleep':
      P(5, 9, 4, 1, sleeve)
      break
    case 'drink':
      P(5, 7, 1, 3, sleeve)
      P(6, 5, 2, 2, pal.paper)
      P(6, 5, 2, 1, pal.ink)
      P(8, 6, 1, 1, pal.ink)
      break
    case 'stretch':
    case 'cheer':
      P(2, -2, 1, 10, sleeve)
      P(6, -2, 1, 10, sleeve)
      P(2, -3, 1, 1, skin)
      P(6, -3, 1, 1, skin)
      break
    case 'water':
      P(5, 9, 2, 1, sleeve)
      P(7, 9, 3, 2, pal.ink2)
      P(10, 8, 1, 1, pal.ink2)
      break
    case 'write': {
      // 举手在白板上写，手上下挪
      const reach = Math.floor(t * 4) % 3
      P(5, 6 + reach, 3, 1, sleeve)
      P(8, 5 + reach, 1, 1, skin)
      P(9, 5 + reach, 1, 1, pal.accent)
      break
    }
    case 'facepalm':
      P(5, 6, 1, 4, sleeve)
      P(5, 4, 2, 2, skin)
      break
    case 'chat': {
      const wave = Math.floor(t * 3 + seed) % 2
      P(5, 9 - wave, 2, 1, sleeve)
      P(7, 8 - wave, 1, 1, skin)
      break
    }
    case 'gaze':
      P(1, 9, 1, 3, sleeve)
      break
    case 'walk': {
      const swing = Math.floor(actor.stride) % 4
      const ax = swing === 0 ? 3 : swing === 2 ? 5 : 4
      P(ax, 9, 1, 3, sleeve)
      P(ax, 12, 1, 1, skin)
      break
    }
    default:
      if (actor.seated) {
        P(5, 9, 3, 1, sleeve)
        P(8, 9, 1, 1, skin)
      } else {
        P(4, 9, 1, 3, sleeve)
        P(4, 12, 1, 1, skin)
      }
  }
  if (actor.carrying === 'cup' && pose === 'walk') {
    P(6, 9, 2, 2, pal.paper)
    P(6, 9, 2, 1, pal.ink)
  }
  if (actor.carrying === 'book' && (pose === 'read' || pose === 'sit')) {
    P(6, 7, 2, 3, pal.crew[(Math.max(0, actor.crew) + 2) % pal.crew.length]!)
  }
}

// ── 气泡、粒子、标记 ─────────────────────────────────────────────────────

const ICONS: Record<BubbleIcon, string[]> = {
  dots: ['.....', 'x.x.x', '.....'],
  bang: ['..x..', '..x..', '.....', '..x..'],
  mail: ['xxxxx', 'xx.xx', 'x.x.x', 'xxxxx'],
  note: ['...xx', '...x.', '.xxx.', '.xx..'],
  heart: ['xx.xx', 'xxxxx', '.xxx.', '..x..'],
  check: ['....x', '...x.', 'x.x..', '.x...'],
  cross: ['x...x', '.x.x.', '..x..', '.x.x.', 'x...x'],
  q: ['.xxx.', '...x.', '..x..', '.....', '..x..']
}

function bubble(
  ctx: Ctx,
  sim: OfficeSim,
  pal: OfficePalette,
  actor: Actor,
  icon: BubbleIcon,
  alert: boolean
): void {
  const head = sim.headOf(actor)
  const rows = ICONS[icon]
  const w = 9
  const h = rows.length + 4
  const x = Math.round(Math.min(sim.layout.width - w, Math.max(0, head.x - 4)))
  const bob = Math.round(Math.sin(sim.time * 3 + actor.style) * 0.6)
  const y = head.y - h - 4 + bob
  roundFrame(ctx, alert ? pal.danger : pal.ink, pal.paper, x, y, w, h)
  rect(ctx, alert ? pal.danger : pal.ink, head.x, y + h, 1, 1)
  const color =
    icon === 'heart' || icon === 'cross' || alert
      ? pal.danger
      : icon === 'check'
        ? pal.success
        : icon === 'mail'
          ? pal.accent
          : pal.ink
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] !== 'x') continue
      // 省略号一个一个跳
      const lift = icon === 'dots' && Math.floor(sim.time * 4) % 3 === Math.floor(rx / 2) ? -1 : 0
      rect(ctx, color, x + 2 + rx, y + 2 + ry + lift, 1, 1)
    }
  })
}

function marker(ctx: Ctx, sim: OfficeSim, actor: Actor, color: string): void {
  const head = sim.headOf(actor)
  const bob = Math.round(Math.sin(sim.time * 4))
  const y = head.y - 6 + bob
  rect(ctx, color, head.x - 1, y, 3, 1)
  rect(ctx, color, head.x, y + 1, 1, 1)
}

function particle(ctx: Ctx, pal: OfficePalette, p: Particle, t: number): void {
  const k = p.life / p.max
  // 快消失时隔帧画，像素风的「淡出」
  if (k > 0.75 && Math.floor(t * 20) % 2 === 0 && p.kind !== 'plane') return
  const x = Math.round(p.x)
  const y = Math.round(p.y)
  switch (p.kind) {
    case 'steam':
      rect(ctx, pal.ink2, x + Math.round(Math.sin(p.life * 5) * 1), y, 1, 1)
      break
    case 'z':
      if (k < 0.4) {
        rect(ctx, pal.ink2, x, y, 2, 1)
        rect(ctx, pal.ink2, x, y + 1, 2, 1)
      } else {
        rect(ctx, pal.ink2, x, y, 3, 1)
        rect(ctx, pal.ink2, x + 1, y + 1, 1, 1)
        rect(ctx, pal.ink2, x, y + 2, 3, 1)
      }
      break
    case 'spark':
      rect(ctx, pal.warning, x, y, 1, 1)
      if (k < 0.3) {
        rect(ctx, pal.warning, x - 1, y, 3, 1)
        rect(ctx, pal.warning, x, y - 1, 1, 3)
      }
      break
    case 'confetti': {
      const color =
        p.tone === undefined || p.tone < 0 ? pal.accent : pal.crew[p.tone % pal.crew.length]!
      const flip = Math.sin(p.life * 8 + p.x) > 0
      rect(ctx, color, x, y, flip ? 2 : 1, flip ? 1 : 2)
      break
    }
    case 'leaf':
      rect(ctx, pal.success, x, y, 2, 1)
      break
    case 'drop':
      rect(ctx, pal.accent, x, y, 1, 2)
      break
    case 'bubble':
      rect(ctx, pal.paper, x, y, 1, 1)
      break
    case 'plane': {
      const dir = p.vx >= 0 ? 1 : -1
      const px = (lx: number, ly: number, w: number): void =>
        rect(ctx, pal.ink, dir === 1 ? x + lx : x - lx - w + 1, y + ly, w, 1)
      px(0, 0, 2)
      px(0, 1, 5)
      px(2, 2, 2)
      // 尾迹
      if (p.from) {
        for (let i = 1; i <= 3; i++) {
          const back = Math.max(0, k - i * 0.05)
          const e = back * back * (3 - 2 * back)
          const tx = p.from.x + ((p.to?.x ?? x) - p.from.x) * e
          const ty = p.from.y + ((p.to?.y ?? y) - p.from.y) * e - Math.sin(Math.PI * back) * 14
          if (i % 2 === 1) rect(ctx, pal.faint, Math.round(tx), Math.round(ty) + 1, 1, 1)
        }
      }
      break
    }
  }
}
