/**
 * 豪华像素版（V2）的画法。和简约版共用同一套模拟（OfficeSim），几何用 V2_PROFILE。
 *
 * 分工：
 *   - 静态家具（吧台、盆栽、书架、沙发、窗框、软木板、挂钟、饮水机、吊兰）是像素图素材，
 *     见 spritesV2.ts。素材里留了洞的地方（窗玻璃）由这里先画动态内容再盖上素材。
 *   - 跟着数据动的东西都在这里画：人、工位（桌椅显示器要和 Q 版人的比例对上）、
 *     屏幕内容、便利贴、霓虹招牌、光影、粒子、猫。
 *
 * 人是 13×26 的 Q 版：头 11×10，三档肤色、发丝高光、衬衫明暗、两只眼睛带高光。
 */

import type { TaskStatus } from '@core/shared/agentTeam'

import type { ModelLook } from '../modelLook'
import type { Actor, BubbleIcon, DeskSlot, OfficeSim, Particle, Pose } from '../officeSim'
import { C, FONT, HAIRS, PRODUCER_SHIRT, SHIRTS } from './artV2'
import { girl, LOOKS } from './looksV2'
import type { SpriteSet } from './spritesV2'

type Ctx = CanvasRenderingContext2D

export interface DrawStateV2 {
  board: TaskStatus[]
  hover: string | null
  selected: string | null
  now: Date
  sprites: SpriteSet
  cat: OfficeCat
  /** 每人此刻在调的工具名（屏幕上画蓝图还是材质图要看它） */
  tools: ReadonlyMap<string, string>
}

function rect(ctx: Ctx, color: string, x: number, y: number, w: number, h: number): void {
  if (w <= 0 || h <= 0) return
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x), Math.round(y), w, h)
}

function frame(ctx: Ctx, color: string, x: number, y: number, w: number, h: number): void {
  rect(ctx, color, x, y, w, 1)
  rect(ctx, color, x, y + h - 1, w, 1)
  rect(ctx, color, x, y, 1, h)
  rect(ctx, color, x + w - 1, y, 1, h)
}

/** 半透明的一块（光、影）。像素风里用整格叠色，不用渐变 */
function glaze(
  ctx: Ctx,
  color: string,
  alpha: number,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  ctx.globalAlpha = alpha
  rect(ctx, color, x, y, w, h)
  ctx.globalAlpha = 1
}

/**
 * 一圈光：一行一行的椭圆，三层套着，越往里越亮。像素画里的光都是这样分层的方块，
 * 不是柔和的渐变
 */
function pool(
  ctx: Ctx,
  color: string,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  alpha: number
): void {
  ctx.fillStyle = color
  for (const k of [1, 0.66, 0.38]) {
    ctx.globalAlpha = alpha
    const rr = Math.max(1, Math.round(ry * k))
    for (let dy = -rr; dy <= rr; dy++) {
      const half = Math.round(rx * k * Math.sqrt(1 - (dy / (rr + 0.5)) ** 2))
      if (half > 0) ctx.fillRect(Math.round(cx - half), Math.round(cy + dy), half * 2, 1)
    }
  }
  ctx.globalAlpha = 1
}

const hash = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

function sprite(
  ctx: Ctx,
  set: SpriteSet,
  name: string,
  x: number,
  bottom: number
): { x: number; y: number; w: number; h: number } | null {
  const s = set[name]
  if (!s) return null
  const y = Math.round(bottom - s.h)
  ctx.drawImage(s.img, Math.round(x), y)
  return { x: Math.round(x), y, w: s.w, h: s.h }
}

// ── 时间和光 ──────────────────────────────────────────────────────────────

interface Light {
  hour: number
  night: boolean
  dusk: boolean
}

function lightOf(now: Date): Light {
  const hour = now.getHours() + now.getMinutes() / 60
  const night = hour < 6.5 || hour >= 19
  return { hour, night, dusk: !night && hour >= 17 }
}

export function drawOfficeV2(ctx: Ctx, sim: OfficeSim, state: DrawStateV2): void {
  const L = sim.layout
  const light = lightOf(state.now)
  const S = state.sprites

  wall(ctx, sim)
  const walls = wallPlan(sim, S)
  for (let i = 0; i < L.windows.length; i++) windowWithSky(ctx, sim, S, L.windows[i]!, i, light)
  if (walls.neon !== null) neonSign(ctx, sim, walls.neon, light)
  if (walls.poster !== null) blueprintPoster(ctx, walls.poster)
  corkBoard(ctx, sim, S, state.board)
  clock(ctx, S, L.boardX + Math.floor(L.boardW / 2) - 6, 6, state.now)
  floor(ctx, sim)
  if (!light.night) for (const x of L.windows) sunPatch(ctx, sim, x, light)
  hangingPlants(ctx, sim, S, walls.plants)

  // 左边：吧台、饮水机、大盆栽；沙发角
  const bar = sprite(ctx, S, 'coffee_bar', L.machineX, L.floorY + 1)
  if (bar && sim.brewUntil > sim.time) brewing(ctx, sim, bar)
  sprite(ctx, S, 'water_cooler', L.coolerX, L.floorY + 1)
  plant(ctx, sim, S)
  if (L.sofaX !== null) lounge(ctx, sim, S, L.sofaX, light)

  const actors = [...sim.actors.values()]
  for (const [id, desk] of L.desks) chairBack(ctx, sim, desk, sim.actors.get(id))
  for (const actor of actors) if (actor.seated) person(ctx, sim, actor, light)
  for (const [id, desk] of L.desks)
    deskAndScreen(ctx, sim, desk, sim.actors.get(id), light, state.tools.get(id) ?? '')
  for (const actor of actors) if (actor.seated) arms(ctx, sim, actor)

  state.cat.step(sim)
  state.cat.draw(ctx, sim)

  const standing = actors.filter((a) => !a.seated).sort((a, b) => a.x - b.x)
  for (const actor of standing) {
    person(ctx, sim, actor, light)
    arms(ctx, sim, actor)
  }

  if (light.night) nightLighting(ctx, sim, light)
  else if (light.dusk) glaze(ctx, C.skyDusk, 0.08, 0, 0, L.width, L.height)

  for (const p of sim.particles) particle(ctx, p, sim.time)
  for (const actor of actors) {
    if (actor.bubble) bubble(ctx, sim, actor, actor.bubble.icon, !!actor.bubble.alert)
    const color =
      actor.id === state.selected ? C.brassLight : actor.id === state.hover ? C.cream : null
    if (color && !actor.bubble) marker(ctx, sim, actor, color)
  }
}

// ── 墙和地板 ──────────────────────────────────────────────────────────────

function wall(ctx: Ctx, sim: OfficeSim): void {
  const L = sim.layout
  const top = 6
  rect(ctx, C.wall, 0, 0, L.width, L.wallY)
  // 墙纸：竖条 + 小菱形暗纹
  for (let x = 0; x < L.width; x += 8) rect(ctx, C.wallLight, x, top, 1, L.wallY - top)
  for (let y = top + 5; y < L.wallY - 18; y += 10) {
    for (let x = 4 + ((y / 10) % 2) * 4; x < L.width; x += 8) {
      rect(ctx, C.wallMotif, x, y, 1, 1)
      rect(ctx, C.wallMotif, x - 1, y + 1, 3, 1)
      rect(ctx, C.wallMotif, x, y + 2, 1, 1)
    }
  }
  // 顶上的木线脚
  rect(ctx, C.woodDeep, 0, 0, L.width, 2)
  rect(ctx, C.wood, 0, 2, L.width, 2)
  rect(ctx, C.woodHi, 0, 2, L.width, 1)
  rect(ctx, C.woodDark, 0, 4, L.width, 1)
  rect(ctx, C.wallDark, 0, 5, L.width, 1)
  // 护墙板
  const wainTop = L.wallY - 18
  rect(ctx, C.woodDark, 0, wainTop, L.width, 18)
  rect(ctx, C.woodHi, 0, wainTop, L.width, 1)
  rect(ctx, C.wood, 0, wainTop + 1, L.width, 2)
  rect(ctx, C.woodDeep, 0, wainTop + 3, L.width, 1)
  for (let x = 2; x < L.width - 10; x += 16) {
    rect(ctx, C.wood, x, wainTop + 6, 12, 9)
    rect(ctx, C.woodDeep, x, wainTop + 6, 12, 1)
    rect(ctx, C.woodDeep, x, wainTop + 6, 1, 9)
    rect(ctx, C.woodLight, x + 11, wainTop + 7, 1, 8)
    rect(ctx, C.woodLight, x + 1, wainTop + 14, 11, 1)
  }
  // 踢脚线
  rect(ctx, C.woodDeep, 0, L.wallY - 2, L.width, 2)
}

function floor(ctx: Ctx, sim: OfficeSim): void {
  const L = sim.layout
  const top = L.wallY
  rect(ctx, C.plank, 0, top, L.width, L.height - top)
  // 木地板：横缝 + 错开的竖缝 + 木纹
  let row = 0
  for (let y = top; y < L.height; y += 5, row++) {
    rect(ctx, C.plankSeam, 0, y, L.width, 1)
    rect(ctx, row % 2 ? C.plankLight : C.plank, 0, y + 1, L.width, 1)
    const offset = (row * 23) % 31
    for (let x = offset; x < L.width; x += 31) {
      rect(ctx, C.plankSeam, x, y + 1, 1, 4)
      rect(ctx, C.plankHi, x + 1, y + 1, 1, 1)
    }
    for (let i = 0; i < L.width / 9; i++) {
      const gx = Math.floor(hash(row * 97 + i) * L.width)
      rect(ctx, C.plankDark, gx, y + 2 + (i % 3), 3 + (i % 4), 1)
    }
  }
  // 贴墙一道暗影，地板有了纵深
  glaze(ctx, C.shadow, 0.35, 0, top, L.width, 2)
  glaze(ctx, C.shadow, 0.15, 0, top + 2, L.width, 3)
}

/** 白天窗户投在地板上的一块光 */
function sunPatch(ctx: Ctx, sim: OfficeSim, x: number, light: Light): void {
  const L = sim.layout
  const lean = Math.round((light.hour - 13) * 2)
  ctx.globalAlpha = light.dusk ? 0.1 : 0.14
  ctx.fillStyle = C.dayLight
  for (let y = L.wallY + 1; y < L.height; y++) {
    const k = y - L.wallY
    ctx.fillRect(x + 2 + Math.round((k * lean) / 12), y, 22, 1)
  }
  ctx.globalAlpha = 1
}

function windowWithSky(
  ctx: Ctx,
  sim: OfficeSim,
  S: SpriteSet,
  x: number,
  index: number,
  light: Light
): void {
  const s = S.window
  if (!s) return
  const y = 14
  const t = sim.time
  // 先画天，再盖窗框（窗玻璃在素材里是洞）
  for (const hole of s.holes) {
    const hx = x + hole.x
    const hy = y + hole.y
    const { w, h } = hole
    if (light.night) {
      rect(ctx, C.skyNight, hx, hy, w, h)
      rect(ctx, C.skyNightLight, hx, hy + h - 3, w, 3)
      for (let i = 0; i < 3; i++) {
        const sx = hx + Math.floor(hash(index * 31 + hole.x * 7 + i) * w)
        const sy = hy + Math.floor(hash(index * 17 + hole.y * 5 + i) * (h - 3))
        if (Math.sin(t * 1.4 + i * 2.3 + hole.x) > -0.2) rect(ctx, C.star, sx, sy, 1, 1)
      }
    } else {
      rect(ctx, light.dusk ? C.skyDuskHigh : C.skyDay, hx, hy, w, h)
      rect(
        ctx,
        light.dusk ? C.skyDusk : C.skyDayLight,
        hx,
        hy + Math.floor(h / 2),
        w,
        Math.ceil(h / 2)
      )
      const drift = (t * 1.2 + index * 37 + hole.x * 3) % (w + 12)
      const cx = hx + Math.round(drift) - 8
      const left = Math.max(hx, cx)
      const right = Math.min(hx + w, cx + 7)
      rect(ctx, C.cloud, left, hy + 3, right - left, 1)
      const left2 = Math.max(hx, cx + 2)
      const right2 = Math.min(hx + w, cx + 5)
      rect(ctx, C.cloud, left2, hy + 2, right2 - left2, 1)
    }
    // 远处的城市
    for (let i = 0; i < w; i += 3) {
      const bh = 2 + Math.floor(hash(index * 13 + hole.x + i) * 5)
      if (hole.y + h < s.h * 0.55) continue
      rect(ctx, light.night ? C.cityNight : C.city, hx + i, hy + h - bh, 3, bh)
      if (light.night && hash(i + index * 7) > 0.5)
        rect(ctx, C.cityLight, hx + i + 1, hy + h - bh + 1, 1, 1)
    }
  }
  // 太阳 / 月亮挂在第一扇窗的左上格
  const first = s.holes[0]
  if (index === 0 && first) {
    if (light.night) {
      rect(ctx, C.star, x + first.x + 2, y + first.y + 2, 3, 3)
      rect(ctx, C.skyNight, x + first.x + 3, y + first.y + 2, 2, 2)
    } else {
      const dip = light.dusk ? 4 : 0
      rect(ctx, C.sun, x + first.x + 2, y + first.y + 2 + dip, 3, 3)
    }
  }
  ctx.drawImage(s.img, x, y)
}

const NEON_TEXT = 'UEBOX STUDIO'
const NEON_W = NEON_TEXT.length * 4 - 1
const POSTER_W = 22

interface WallPlan {
  neon: number | null
  poster: number | null
  plants: number[]
}

/**
 * 墙上挂什么、挂哪：窗户位置由布局定，其余的找空墙。
 * 招牌尽量挂在工位区正中，蓝图画挂在大盆栽上方，吊兰塞进剩下的空当，最多三盆。
 */
function wallPlan(sim: OfficeSim, S: SpriteSet): WallPlan {
  const L = sim.layout
  const taken: [number, number][] = L.windows.map((x) => [x - 3, x + 30])
  taken.push([L.boardX - 4, L.width])
  const free = (from: number, to: number): boolean =>
    from >= 2 && taken.every(([a, b]) => to <= a || from >= b)
  const take = (from: number, to: number): void => void taken.push([from, to])

  let poster: number | null = L.plantX + 2
  if (free(poster - 2, poster + POSTER_W + 2)) take(poster - 2, poster + POSTER_W + 2)
  else poster = null

  let neon: number | null = null
  const desks = [...L.desks.values()]
  if (desks.length) {
    const mid = Math.round((desks[0]!.x + desks.at(-1)!.x + desks.at(-1)!.width) / 2)
    // 从正中往两边找，第一个放得下的位置
    for (let d = 0; d < L.width; d += 4) {
      for (const x of [mid - Math.round(NEON_W / 2) - d, mid - Math.round(NEON_W / 2) + d]) {
        if (neon === null && free(x - 6, x + NEON_W + 6)) neon = x
      }
      if (neon !== null) break
    }
    if (neon !== null) take(neon - 6, neon + NEON_W + 6)
  }

  const plants: number[] = []
  const pw = S.hanging_plant?.w ?? 19
  for (let x = 4; x < L.boardX && plants.length < 3; x += 6) {
    if (free(x - 4, x + pw + 4)) {
      plants.push(x)
      take(x - 18, x + pw + 18)
    }
  }
  return { neon, poster, plants }
}

function neonSign(ctx: Ctx, sim: OfficeSim, x: number, light: Light): void {
  const text = NEON_TEXT
  const w = NEON_W
  const y = 12
  // 偶尔闪一下，像真霓虹
  const flicker = Math.sin(sim.time * 37) > 0.97 && Math.sin(sim.time * 3.1) > 0.6
  const on = !flicker
  rect(ctx, C.woodDeep, x - 3, y - 3, w + 6, 11)
  rect(ctx, C.lineGreen, x - 2, y - 2, w + 4, 9)
  if (on) pool(ctx, C.neon, x + w / 2, y + 2, w / 2 + 8, 9, light.night ? 0.1 : 0.05)
  let cx = x
  for (const ch of text) {
    const rows = FONT[ch] ?? FONT[' ']!
    rows.forEach((bits, row) => {
      for (let col = 0; col < 3; col++) {
        if (!(bits & (4 >> col))) continue
        rect(ctx, on ? C.neonGlow : C.neonDim, cx + col, y + row, 1, 1)
        if (on && row === 4) rect(ctx, C.neon, cx + col, y + 5, 1, 1)
      }
    })
    cx += 4
  }
  // 两根挂绳
  rect(ctx, C.woodDeep, x, 5, 1, y - 8)
  rect(ctx, C.woodDeep, x + w - 1, 5, 1, y - 8)
}

function corkBoard(ctx: Ctx, sim: OfficeSim, S: SpriteSet, tasks: TaskStatus[]): void {
  const L = sim.layout
  const s = S.corkboard
  const x = L.boardX
  const y = 22
  const w = s?.w ?? L.boardW
  const h = s?.h ?? 26
  if (s) ctx.drawImage(s.img, x, y)
  else {
    rect(ctx, C.cork, x, y, w, h)
    frame(ctx, C.woodDark, x, y, w, h)
  }
  // 便利贴：一项任务一张，颜色按状态；完成的打钩，受阻的歪着
  const color: Record<TaskStatus, string> = {
    todo: C.noteTodo,
    doing: C.noteDoing,
    done: C.noteDone,
    blocked: C.noteBlocked
  }
  const inner = { x: x + 3, y: y + 3, w: w - 6, h: h - 6 }
  const perRow = Math.max(1, Math.floor(inner.w / 7))
  tasks.slice(0, perRow * 3).forEach((status, i) => {
    const col = i % perRow
    const row = Math.floor(i / perRow)
    const nx = inner.x + col * 7 + Math.round(hash(i) * 1)
    const ny = inner.y + row * 7 + (status === 'blocked' ? 1 : 0)
    rect(ctx, C.shadow, nx + 1, ny + 1, 6, 6)
    rect(ctx, color[status], nx, ny, 6, 6)
    rect(ctx, C.cream, nx, ny, 6, 1)
    rect(ctx, C.pin, nx + 2, ny, 2, 1)
    if (status === 'done') {
      rect(ctx, C.leafDark, nx + 1, ny + 3, 1, 1)
      rect(ctx, C.leafDark, nx + 2, ny + 4, 1, 1)
      rect(ctx, C.leafDark, nx + 3, ny + 3, 1, 1)
      rect(ctx, C.leafDark, nx + 4, ny + 2, 1, 1)
    } else {
      rect(ctx, C.creamDark, nx + 1, ny + 2, 4, 1)
      rect(ctx, C.creamDark, nx + 1, ny + 4, 3, 1)
    }
  })
  // 制作人在写：一张新便利贴上的字一笔一笔出来
  const strokes = Math.floor(sim.boardInk / 4)
  if (strokes > 0) {
    const nx = x + w - 10
    const ny = y + h - 10
    rect(ctx, C.noteTodo, nx, ny, 7, 7)
    rect(ctx, C.pin, nx + 3, ny, 1, 1)
    for (let i = 0; i < Math.min(strokes, 3); i++)
      rect(ctx, C.line, nx + 1, ny + 2 + i * 2, 2 + ((i * 3) % 4), 1)
  }
  if (sim.rainUntil > sim.time) {
    const cx = x + Math.floor(w / 2) - 6
    rect(ctx, C.creamDark, cx, y - 9, 12, 3)
    rect(ctx, C.creamDark, cx + 2, y - 10, 7, 1)
    for (let i = 0; i < 4; i++) {
      const dy = (sim.time * 20 + i * 5) % 8
      rect(ctx, C.codeC, cx + 1 + i * 3, y - 6 + dy, 1, 2)
    }
  }
}

function clock(ctx: Ctx, S: SpriteSet, x: number, y: number, now: Date): void {
  const s = S.clock
  if (!s) return
  ctx.drawImage(s.img, x, y)
  const cx = x + Math.floor(s.w / 2)
  const cy = y + Math.floor(s.h / 2)
  const hand = (angle: number, length: number, color: string): void => {
    for (let r = 0; r <= length; r++)
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
  hand(minutes * (Math.PI / 30), Math.max(2, Math.floor(s.w / 2) - 2), C.line)
  hand(
    ((now.getHours() % 12) + minutes / 60) * (Math.PI / 6),
    Math.max(1, Math.floor(s.w / 2) - 3),
    C.terraDark
  )
}

function hangingPlants(ctx: Ctx, sim: OfficeSim, S: SpriteSet, xs: number[]): void {
  const s = S.hanging_plant
  if (!s) return
  // 吊兰轻轻晃
  xs.forEach((x, i) => {
    const sway = Math.round(Math.sin(sim.time * 0.9 + i * 1.7) * 0.6)
    ctx.drawImage(s.img, x + sway, 5)
  })
}

function plant(ctx: Ctx, sim: OfficeSim, S: SpriteSet): void {
  const s = S.plant_big
  if (!s) return
  const L = sim.layout
  const shake = sim.plantShakeUntil > sim.time ? Math.round(Math.sin(sim.time * 45)) : 0
  if (!shake) {
    ctx.drawImage(s.img, L.plantX, L.floorY + 1 - s.h)
    return
  }
  // 被点了：上半截晃
  const cut = Math.floor(s.h * 0.55)
  ctx.drawImage(s.img, 0, 0, s.w, cut, L.plantX + shake, L.floorY + 1 - s.h, s.w, cut)
  ctx.drawImage(s.img, 0, cut, s.w, s.h - cut, L.plantX, L.floorY + 1 - s.h + cut, s.w, s.h - cut)
}

function brewing(ctx: Ctx, sim: OfficeSim, bar: { x: number; y: number }): void {
  // 咖啡机出水口下一道细流
  const drip = Math.floor(sim.time * 8) % 3
  rect(ctx, C.woodDeep, bar.x + 8, bar.y + 22 + drip, 1, 1)
}

function lounge(ctx: Ctx, sim: OfficeSim, S: SpriteSet, x: number, light: Light): void {
  const L = sim.layout
  // 地毯
  const rugW = 54
  rect(ctx, C.tealDark, x - 2, L.floorY - 2, rugW, 4)
  rect(ctx, C.teal, x - 1, L.floorY - 2, rugW - 2, 3)
  for (let i = 1; i < rugW - 3; i += 4) rect(ctx, C.cream, x + i, L.floorY - 1, 2, 1)
  sprite(ctx, S, 'bookshelf', x + 58, L.floorY + 1)
  sprite(ctx, S, 'sofa', x, L.floorY + 1)
  // 落地灯
  const lx = x + 49
  rect(ctx, C.brassDark, lx + 2, L.floorY - 24, 1, 24)
  rect(ctx, C.brassDark, lx, L.floorY, 5, 1)
  rect(ctx, C.creamDark, lx - 1, L.floorY - 28, 7, 4)
  rect(ctx, C.cream, lx, L.floorY - 28, 5, 3)
  if (light.night || light.dusk) {
    pool(ctx, C.warm, lx + 2, L.floorY - 16, 16, 16, 0.08)
    rect(ctx, C.warm, lx, L.floorY - 24, 5, 1)
  }
}

// ── 工位 ─────────────────────────────────────────────────────────────────

function chairBack(ctx: Ctx, sim: OfficeSim, desk: DeskSlot, owner: Actor | undefined): void {
  const f = sim.layout.floorY
  const x = desk.seatX
  const away = owner && !owner.seated ? 1 : 0
  // 侧面的办公椅：靠背、坐垫、气杆、五星脚
  rect(ctx, C.line, x + away, f - 17, 3, 11)
  rect(ctx, C.teal, x + 1 + away, f - 16, 2, 9)
  rect(ctx, C.tealLight, x + 1 + away, f - 16, 1, 6)
  rect(ctx, C.line, x + 1, f - 7, 11, 2)
  rect(ctx, C.teal, x + 2, f - 7, 9, 1)
  rect(ctx, C.bezelLight, x + 6, f - 5, 1, 4)
  rect(ctx, C.bezel, x + 2, f - 1, 9, 1)
  rect(ctx, C.line, x + 2, f, 2, 1)
  rect(ctx, C.line, x + 9, f, 2, 1)
}

function deskAndScreen(
  ctx: Ctx,
  sim: OfficeSim,
  desk: DeskSlot,
  owner: Actor | undefined,
  light: Light,
  tool: string
): void {
  const f = sim.layout.floorY
  const x = desk.deskX
  const w = desk.deskW
  const top = f - 10
  // 桌面：亮边 + 厚度 + 描边
  rect(ctx, C.woodDeep, x - 1, top - 1, w + 2, 1)
  rect(ctx, C.woodHi, x, top, w, 1)
  rect(ctx, C.wood, x, top + 1, w, 1)
  rect(ctx, C.woodDark, x, top + 2, w, 1)
  // 右边一组抽屉，左边留出放腿的地方
  const dw = Math.min(11, w - 10)
  const dx = x + w - dw
  rect(ctx, C.woodDeep, dx, top + 3, dw, f - top - 2)
  rect(ctx, C.wood, dx + 1, top + 3, dw - 2, f - top - 3)
  for (let i = 0; i < 2; i++) {
    const dy = top + 4 + i * 4
    rect(ctx, C.woodDark, dx + 1, dy + 3, dw - 2, 1)
    rect(ctx, C.brass, dx + Math.floor(dw / 2) - 1, dy + 1, 2, 1)
  }
  rect(ctx, C.woodDeep, x + 1, top + 3, 1, f - top - 2)
  rect(ctx, C.woodDark, x + 2, top + 3, 1, f - top - 3)
  // 键盘
  rect(ctx, C.bezel, x, top - 2, 6, 2)
  rect(ctx, C.bezelLight, x + 1, top - 2, 4, 1)
  // 显示器
  const mx = desk.monitorX
  const mw = 18
  const mh = 13
  const my = top - 3 - mh
  rect(ctx, C.brassDark, mx + 8, top - 3, 2, 3)
  rect(ctx, C.brass, mx + 6, top - 1, 6, 1)
  rect(ctx, C.line, mx - 1, my - 1, mw + 2, mh + 2)
  rect(ctx, C.bezel, mx, my, mw, mh)
  rect(ctx, C.bezelLight, mx, my, mw, 1)
  screen(ctx, sim, mx + 1, my + 1, mw - 2, mh - 2, owner, tool)
  // 屏幕亮着时，往人脸上打一点光

  // 桌上的小东西
  if (owner) trinket(ctx, sim, x + w - 4, top - 1, owner, light)
  if (desk.mugUntil > sim.time) {
    rect(ctx, C.line, x + w - 9, top - 4, 4, 4)
    rect(ctx, C.cream, x + w - 8, top - 4, 2, 3)
    rect(ctx, C.woodDeep, x + w - 8, top - 4, 2, 1)
    rect(ctx, C.line, x + w - 5, top - 3, 1, 2)
  }
}

function trinket(
  ctx: Ctx,
  sim: OfficeSim,
  x: number,
  base: number,
  owner: Actor,
  light: Light
): void {
  switch (owner.style % 6) {
    case 0: // 多肉
      rect(ctx, C.terraDark, x - 1, base - 2, 4, 3)
      rect(ctx, C.terra, x, base - 2, 2, 2)
      rect(ctx, C.leaf, x - 1, base - 4, 1, 2)
      rect(ctx, C.leafLight, x, base - 5, 1, 3)
      rect(ctx, C.leaf, x + 1, base - 4, 1, 2)
      break
    case 1: // 相框
      rect(ctx, C.woodDeep, x - 1, base - 5, 4, 6)
      rect(ctx, C.skyDay, x, base - 4, 2, 2)
      rect(ctx, C.leaf, x, base - 2, 2, 2)
      break
    case 2: // 台灯
      rect(ctx, C.brassDark, x, base - 5, 1, 6)
      rect(ctx, C.brass, x - 2, base - 6, 4, 2)
      if (light.night) pool(ctx, C.warm, x, base - 3, 7, 5, 0.12)
      break
    case 3: // 默认材质的灰白棋盘方块
      rect(ctx, C.line, x - 2, base - 4, 5, 5)
      rect(ctx, C.ueGrey, x - 1, base - 3, 3, 3)
      rect(ctx, C.ueLight, x - 1, base - 3, 1, 1)
      rect(ctx, C.ueLight, x + 1, base - 3, 1, 1)
      rect(ctx, C.ueLight, x, base - 2, 1, 1)
      rect(ctx, C.ueLight, x - 1, base - 1, 1, 1)
      rect(ctx, C.ueLight, x + 1, base - 1, 1, 1)
      break
    case 4: {
      // 灰色小人偶（引擎模板里那个），偶尔挥一下手
      const wave = Math.floor(sim.time * 1.3) % 7 === 0 ? 1 : 0
      rect(ctx, C.ueGrey, x, base - 7, 2, 2)
      rect(ctx, C.ueGrey, x, base - 5, 2, 3)
      rect(ctx, C.ueDark, x - 1, base - 5 - wave, 1, 2)
      rect(ctx, C.ueDark, x + 2, base - 5, 1, 2)
      rect(ctx, C.ueDark, x, base - 2, 1, 3)
      rect(ctx, C.ueDark, x + 1, base - 2, 1, 3)
      rect(ctx, C.ueLight, x, base - 7, 1, 1)
      break
    }
    default: // 一摞书
      rect(ctx, C.teal, x - 2, base - 1, 5, 2)
      rect(ctx, C.rose, x - 1, base - 3, 4, 2)
      rect(ctx, C.codeA, x - 2, base - 4, 4, 1)
  }
}

function screen(
  ctx: Ctx,
  sim: OfficeSim,
  x: number,
  y: number,
  w: number,
  h: number,
  owner: Actor | undefined,
  tool: string
): void {
  const t = sim.time
  const pose = owner?.seated ? owner.pose : null
  const shirt = owner ? shirtOf(owner)[0] : C.codeC
  if (!owner || !owner.seated) {
    // 屏保：一只像素小鱼慢慢游
    rect(ctx, C.screen, x, y, w, h)
    const fx = x + Math.floor(((Math.sin(t * 0.4 + (owner?.style ?? 0)) + 1) / 2) * (w - 3))
    const fy = y + 2 + Math.floor(((Math.cos(t * 0.3) + 1) / 2) * (h - 5))
    rect(ctx, C.tealDark, fx, fy, 3, 2)
    rect(ctx, C.tealDark, fx + 3, fy, 1, 1)
    return
  }
  rect(ctx, C.screen, x, y, w, h)
  // 改蓝图、改材质的时候，屏幕上是节点图（虚幻的老朋友）
  if (pose === 'type' && /^(blueprint|material)_/.test(tool)) {
    nodeGraph(ctx, t, x, y, w, h, tool.startsWith('material') ? C.leafLight : C.codeB, owner.style)
    return
  }
  switch (pose) {
    case 'type': {
      // 编辑器：行号 + 彩色代码一行行冒出来
      rect(ctx, C.bezelLight, x, y, 2, h)
      const lines = Math.floor(t * 2.4 + owner.style * 3)
      for (let row = 0; row < h - 1; row++) {
        const n = lines - (h - 2) + row
        if (n < 0) continue
        const indent = Math.floor(hash(n) * 3) * 2
        let cx = x + 3 + indent
        const parts = 1 + Math.floor(hash(n + 7) * 3)
        for (let p = 0; p < parts && cx < x + w - 1; p++) {
          const len = Math.min(1 + Math.floor(hash(n * 3 + p) * 4), x + w - 1 - cx)
          const color = [C.codeA, C.codeB, C.codeC, C.codeD, C.cream][
            Math.floor(hash(n + p * 13) * 5)
          ]!
          rect(ctx, color, cx, y + row + 1, len, 1)
          cx += len + 1
        }
      }
      if (Math.floor(t * 3) % 2 === 0) rect(ctx, C.cream, x + w - 2, y + h - 2, 1, 1)
      break
    }
    case 'read': {
      rect(ctx, C.cream, x + 1, y, w - 2, h)
      const scroll = Math.floor(t * 1.2)
      for (let row = 1; row < h - 1; row += 2) {
        const n = row + scroll * 2
        rect(ctx, C.creamDark, x + 2, y + row, w - 4 - Math.floor(hash(n) * 4), 1)
      }
      rect(ctx, shirt, x + 1, y + 1 + (Math.floor(t * 1.2) % 4) * 2, 1, 1)
      break
    }
    case 'lean': {
      const k = (t * 0.22) % 1
      rect(ctx, C.bezelLight, x + 1, y + h - 4, w - 2, 2)
      rect(ctx, C.screenGlow, x + 1, y + h - 4, Math.max(1, Math.round((w - 2) * k)), 2)
      const spin = [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
        [2, 2],
        [1, 2],
        [0, 2],
        [0, 1]
      ]
      const head = Math.floor(t * 10) % spin.length
      for (let i = 0; i < 3; i++) {
        const [dx, dy] = spin[(head - i + spin.length) % spin.length]!
        rect(
          ctx,
          i === 0 ? C.screenGlow : C.tealDark,
          x + Math.floor(w / 2) - 1 + dx!,
          y + 1 + dy!,
          1,
          1
        )
      }
      break
    }
    case 'look': {
      rect(ctx, C.skyDay, x, y, w, h)
      rect(ctx, C.leafLight, x, y + h - 3, w, 3)
      rect(ctx, C.leaf, x + 2, y + h - 6, 5, 3)
      rect(ctx, C.leaf, x + 3, y + h - 7, 3, 1)
      rect(ctx, C.leafDark, x + 9, y + h - 5, 4, 2)
      rect(ctx, C.sun, x + w - 4, y + 1, 2, 2)
      if ((t * 0.45) % 1 < 0.06) rect(ctx, C.cream, x, y, w, h)
      // 取景框四角
      rect(ctx, C.cream, x, y, 2, 1)
      rect(ctx, C.cream, x + w - 2, y + h - 1, 2, 1)
      break
    }
    case 'play': {
      rect(ctx, C.skyNight, x, y, w, h)
      rect(ctx, C.leafDark, x, y + h - 2, w, 2)
      const jump = Math.abs(Math.sin(t * 5)) * 4
      rect(ctx, shirt, x + 3, y + h - 4 - Math.round(jump), 2, 2)
      const enemy = w - 1 - Math.floor((t * 7) % w)
      rect(ctx, C.codeB, x + enemy, y + h - 3, 2, 1)
      rect(ctx, C.codeA, x + ((Math.floor(t * 2) * 5) % w), y + 2, 1, 1)
      break
    }
    case 'sleep': {
      rect(ctx, C.bezel, x, y, w, h)
      // 断网了的小插头
      rect(ctx, C.codeB, x + Math.floor(w / 2) - 1, y + 2, 2, 4)
      rect(ctx, C.codeB, x + Math.floor(w / 2) - 1, y + 7, 2, 1)
      break
    }
    default: {
      // 坐着等：对话框里一个闪烁的光标
      rect(ctx, C.bezelLight, x + 1, y + 2, w - 2, 5)
      rect(ctx, C.screen, x + 2, y + 3, w - 4, 3)
      if (Math.floor(t * 2) % 2 === 0) rect(ctx, C.screenGlow, x + 3, y + 4, 2, 1)
      for (let row = h - 3; row < h - 1; row += 2) rect(ctx, C.tealDark, x + 1, y + row, w - 5, 1)
    }
  }
}

/** 屏幕上的节点图：网格底、两三个带色头的节点、白色执行线，新节点一个个冒出来 */
function nodeGraph(
  ctx: Ctx,
  t: number,
  x: number,
  y: number,
  w: number,
  h: number,
  header: string,
  seed: number
): void {
  rect(ctx, C.ueGraph, x, y, w, h)
  for (let gx = x + 2; gx < x + w; gx += 4) rect(ctx, C.ueGrid, gx, y, 1, h)
  for (let gy = y + 2; gy < y + h; gy += 4) rect(ctx, C.ueGrid, x, gy, w, 1)
  const step = Math.floor(t * 0.8 + seed) % 4
  const nodes = [
    [1, 1],
    [Math.floor(w / 2) - 1, 4],
    [w - 6, 1]
  ].slice(0, 1 + Math.min(2, step))
  nodes.forEach(([nx, ny], i) => {
    const px = x + nx!
    const py = y + ny!
    if (i > 0) {
      const [ax, ay] = nodes[i - 1]!
      const from = { x: x + ax! + 5, y: y + ay! + 2 }
      const to = { x: px - 1, y: py + 2 }
      for (let k = 0; k <= 4; k++) {
        const e = k / 4
        rect(
          ctx,
          C.cream,
          Math.round(from.x + (to.x - from.x) * e),
          Math.round(from.y + (to.y - from.y) * e),
          1,
          1
        )
      }
    }
    rect(ctx, C.ueNode, px, py, 5, 4)
    rect(ctx, i === 0 ? C.codeB : header, px, py, 5, 1)
    rect(ctx, C.cream, px + 4, py + 2, 1, 1)
  })
}

/** 墙上一幅框起来的蓝图：节点、连线，挂在大盆栽上方 */
function blueprintPoster(ctx: Ctx, x: number): void {
  const y = 14
  const w = POSTER_W
  const h = 16
  rect(ctx, C.woodDeep, x - 1, y - 1, w + 2, h + 2)
  rect(ctx, C.ueGraph, x, y, w, h)
  for (let gx = x + 1; gx < x + w; gx += 3) rect(ctx, C.ueGrid, gx, y, 1, h)
  for (let gy = y + 1; gy < y + h; gy += 3) rect(ctx, C.ueGrid, x, gy, w, 1)
  const node = (nx: number, ny: number, head: string): void => {
    rect(ctx, C.ueNode, x + nx, y + ny, 7, 5)
    rect(ctx, head, x + nx, y + ny, 7, 1)
    rect(ctx, C.cream, x + nx + 6, y + ny + 2, 1, 1)
  }
  node(1, 2, C.codeB)
  node(13, 8, C.codeC)
  // 一根执行线：横、竖、横
  rect(ctx, C.cream, x + 8, y + 4, 3, 1)
  rect(ctx, C.cream, x + 10, y + 4, 1, 6)
  rect(ctx, C.cream, x + 10, y + 10, 3, 1)
  rect(ctx, C.leafLight, x + 4, y + 11, 8, 1)
  rect(ctx, C.leafLight, x + 4, y + 8, 1, 3)
  // 画框上的一点高光
  rect(ctx, C.woodHi, x - 1, y - 1, w + 2, 1)
}

// ── 人 ───────────────────────────────────────────────────────────────────

export interface Body {
  top: number
  P: (lx: number, ly: number, w: number, h: number, color: string) => void
  shirt: [string, string, string]
  skin: string
  skinShade: string
  skinLine: string
  hair: [string, string]
  lean: number
  nod: number
}

const W = 13
const STAND_H = 26
/** 坐下时头顶离地多高 */
const SIT_H = 22

function shirtOf(actor: Actor): [string, string, string] {
  return actor.crew < 0 ? PRODUCER_SHIRT : SHIRTS[actor.crew % SHIRTS.length]!
}

function bodyOf(ctx: Ctx, sim: OfficeSim, actor: Actor): Body {
  const f = sim.layout.floorY
  const hop = actor.hop > 0 ? Math.round(Math.abs(Math.sin(actor.hop * Math.PI * 2.2)) * 4) : 0
  const walkBob = actor.pose === 'walk' && Math.floor(actor.stride) % 2 === 1 ? 1 : 0
  // 呼吸：站着的人每两三秒肩膀起伏一格
  const breathe =
    !actor.seated && actor.pose === 'stand' && Math.sin(sim.time * 2.4 + actor.style) > 0.7 ? 1 : 0
  const top = f - (actor.seated ? SIT_H - 1 : STAND_H - 1) - hop - walkBob + breathe
  const x = Math.round(actor.x)
  const dir = actor.facing
  const P = (lx: number, ly: number, w: number, h: number, color: string): void => {
    const px = dir === 1 ? x + lx : x + (W - lx - w)
    rect(ctx, color, px, top + ly, w, h)
  }
  const darkSkin = (actor.style + Math.max(0, actor.crew)) % 3 === 2
  const look = actor.look ? LOOKS[actor.look] : undefined
  return {
    top,
    P,
    shirt: look?.sleeve ?? shirtOf(actor),
    skin: look ? C.skinA : darkSkin ? C.skinB : C.skinA,
    skinShade: look ? C.skinAShade : darkSkin ? C.skinBShade : C.skinAShade,
    skinLine: look ? C.skinALine : darkSkin ? C.skinBLine : C.skinALine,
    hair: look
      ? [look.hair[0], look.hair[1]]
      : HAIRS[[0, 2, 1, 3, 4, 0, 1, 2][actor.style % 8]! % HAIRS.length]!,
    lean: actor.pose === 'lean' ? -1 : actor.pose === 'look' || actor.pose === 'sleep' ? 1 : 0,
    nod: actor.pose === 'sleep' ? 4 : 0
  }
}

function person(ctx: Ctx, sim: OfficeSim, actor: Actor, light: Light): void {
  const b = bodyOf(ctx, sim, actor)
  const { P } = b
  const f = sim.layout.floorY
  const [shirtHi, shirtMid, shirtLo] = b.shirt
  // 影子：脚下一块椭圆
  if (!actor.seated) glaze(ctx, C.shadow, 0.3, Math.round(actor.x) + 2, f, 9, 2)
  if (actor.look) {
    // 认得出模型的队员：照那家的看板娘画，一整套另画（见 looksV2）
    const asleep = actor.pose === 'sleep'
    girl(actor.look, b, {
      seated: actor.seated,
      walk: actor.pose === 'walk' ? Math.floor(actor.stride) % 4 : -1,
      closed: asleep || sim.blinking(actor),
      talking: actor.pose === 'chat' && Math.floor(sim.time * 6) % 2 === 0,
      dx: b.lean + (asleep ? 2 : 0),
      dy: b.nod
    })
    return
  }

  if (actor.seated) {
    // 坐着：大腿横着、小腿垂下
    P(4, 15, 7, 2, C.pants)
    P(4, 16, 7, 1, C.pantsShade)
    P(9, 17, 2, 4, C.pants)
    P(9, 17, 1, 4, C.pantsShade)
    P(9, 21, 3, 1, C.shoe)
    P(11, 21, 1, 1, C.shoeHi)
  } else if (actor.pose === 'walk') {
    const phase = Math.floor(actor.stride) % 4
    if (phase === 1 || phase === 3) {
      P(5, 18, 3, 7, C.pants)
      P(5, 18, 1, 7, C.pantsShade)
      P(5, 25, 4, 1, C.shoe)
    } else {
      const flip = phase === 2
      P(4, 18, 5, 2, C.pants)
      P(3, 20, 2, 5, flip ? C.pants : C.pantsShade)
      P(8, 20, 2, 5, flip ? C.pantsShade : C.pants)
      P(2, 25, 3, 1, C.shoe)
      P(8, 25, 3, 1, C.shoe)
      P(10, 25, 1, 1, C.shoeHi)
    }
  } else {
    P(4, 18, 2, 7, C.pantsShade)
    P(7, 18, 2, 7, C.pants)
    P(4, 25, 3, 1, C.shoe)
    P(7, 25, 3, 1, C.shoe)
    P(9, 25, 1, 1, C.shoeHi)
  }

  // 身子：后背暗、前胸亮，领口露一点脖子
  const rows = actor.seated ? 5 : 8
  const lx = 3 + b.lean
  P(lx, 10, 7, rows, shirtMid)
  P(lx, 10, 2, rows, shirtLo)
  P(lx + 5, 11, 2, Math.min(3, rows - 1), shirtHi)
  P(lx + 3, 10, 2, 1, b.skinShade)
  if (actor.producer) {
    // 制作人：白衬衫领口 + 黄铜色领带
    P(lx + 3, 10, 3, 2, C.cream)
    P(lx + 4, 11, 1, 3, C.brass)
  }
  if (!actor.seated) P(3, 17, 7, 1, C.pantsShade)

  head(sim, actor, b)
  // 夜里屏幕前的人脸被映得发青一点（在 deskAndScreen 里叠），这里不用管
  void light
}

function head(sim: OfficeSim, actor: Actor, b: Body): void {
  const dx = b.lean + (actor.pose === 'sleep' ? 2 : 0)
  const dy = b.nod
  const H = (lx: number, ly: number, w: number, h: number, color: string): void =>
    b.P(lx + dx, ly + dy, w, h, color)
  // 脸：圆一点的 Q 版大头
  H(3, 0, 7, 1, b.skinLine)
  H(2, 1, 1, 1, b.skinLine)
  H(10, 1, 1, 1, b.skinLine)
  H(1, 2, 1, 6, b.skinLine)
  H(11, 2, 1, 6, b.skinLine)
  H(2, 8, 1, 1, b.skinLine)
  H(10, 8, 1, 1, b.skinLine)
  H(3, 9, 7, 1, b.skinLine)
  H(3, 1, 7, 8, b.skin)
  H(2, 2, 9, 6, b.skin)
  H(2, 2, 2, 6, b.skinShade)
  // 眼睛：两只，近的那只带高光；眨眼、望天、睡着
  const asleep = actor.pose === 'sleep'
  const blink = !asleep && sim.blinking(actor)
  const up = actor.pose === 'gaze' ? -1 : 0
  if (asleep || blink) {
    H(6, 5, 2, 1, b.skinLine)
    H(9, 5, 2, 1, b.skinLine)
  } else {
    H(6, 4 + up, 1, 2, C.eye)
    H(9, 4 + up, 2, 2, C.eye)
    H(10, 4 + up, 1, 1, C.glint)
  }
  H(5, 6, 1, 1, C.blush)
  H(10, 6, 1, 1, C.blush)
  const talking = actor.pose === 'chat' && Math.floor(sim.time * 6) % 2 === 0
  H(8, 7, talking ? 2 : 1, 1, talking ? b.skinLine : b.skinShade)
  hair(actor, H, b)
}

function hair(actor: Actor, H: Body['P'], b: Body): void {
  const [c, hi] = b.hair
  const style = actor.style % 8
  // 共同的头顶：盖住上半个头，前面留刘海
  const cap = (): void => {
    H(3, -1, 7, 1, c)
    H(2, 0, 9, 1, c)
    H(1, 1, 11, 2, c)
    H(1, 3, 3, 3, c)
    H(4, 3, 2, 1, c)
    H(9, 3, 2, 1, c)
    H(4, 0, 4, 1, hi)
    H(3, 1, 2, 1, hi)
  }
  switch (style) {
    case 0: // 短发
      cap()
      H(1, 6, 2, 2, c)
      break
    case 1: // 及肩长发
      cap()
      H(0, 3, 3, 9, c)
      H(1, 12, 2, 1, c)
      H(1, 4, 1, 6, hi)
      break
    case 2: // 丸子头 + 圆眼镜
      cap()
      H(2, -4, 4, 3, c)
      H(3, -4, 2, 1, hi)
      H(5, 3, 3, 3, C.line)
      H(6, 4, 1, 1, b.skin)
      H(8, 3, 3, 3, C.line)
      H(9, 4, 1, 1, b.skin)
      H(10, 4, 1, 1, C.eye)
      H(6, 4, 1, 1, C.eye)
      break
    case 3: {
      // 鸭舌帽，和衬衫同色
      const [sh, sm, sl] = b.shirt
      H(3, -2, 7, 1, sm)
      H(2, -1, 9, 3, sm)
      H(3, -1, 4, 1, sh)
      H(9, 1, 4, 1, sl)
      H(1, 2, 2, 4, c)
      break
    }
    case 4: // 刺儿头
      for (const lx of [2, 4, 6, 8, 10]) H(lx, -2, 1, 1, c)
      H(2, -1, 9, 1, c)
      cap()
      break
    case 5: {
      // 毛线帽
      H(5, -4, 2, 1, C.cream)
      H(3, -3, 7, 1, C.rose)
      H(2, -2, 9, 2, C.rose)
      H(2, -2, 9, 1, C.roseLight)
      H(1, 0, 11, 2, C.cream)
      H(1, 2, 2, 3, c)
      break
    }
    case 6: // 制作人：背头 + 耳麦
      cap()
      H(3, -2, 7, 1, C.bezel)
      H(2, -1, 1, 1, C.bezel)
      H(10, -1, 1, 1, C.bezel)
      H(1, 3, 2, 3, C.bezel)
      H(1, 4, 1, 1, C.tealLight)
      H(3, 6, 5, 1, C.bezelLight)
      break
    default: // 高马尾
      cap()
      H(-1, 0, 2, 2, c)
      H(-2, 2, 2, 5, c)
      H(-2, 3, 1, 3, hi)
      H(0, 1, 1, 1, C.rose)
  }
}

function arms(ctx: Ctx, sim: OfficeSim, actor: Actor): void {
  const b = bodyOf(ctx, sim, actor)
  const { P } = b
  const t = sim.time
  const [, sleeve, sleeveLo] = b.shirt
  const hand = b.skin
  const seed = actor.style * 1.3
  const pose: Pose = actor.pose
  switch (pose) {
    case 'type': {
      const tap = Math.floor(t * 10 + seed) % 2
      P(6, 11, 5, 2, sleeve)
      P(6, 12, 5, 1, sleeveLo)
      P(11, 11 + tap, 2, 1, hand)
      P(12, 12 - tap, 1, 1, hand)
      break
    }
    case 'read':
    case 'look':
      P(7 + b.lean, 11, 2, 3, sleeve)
      P(9 + b.lean, 8, 2, 3, sleeve)
      P(10 + b.lean, 7, 2, 2, hand)
      break
    case 'lean':
      P(1, 2, 2, 8, sleeve)
      P(1, 2, 1, 8, sleeveLo)
      P(1, 1, 2, 1, hand)
      break
    case 'play': {
      const bounce = Math.floor(t * 6) % 2
      P(6, 11, 4, 2, sleeve)
      P(9, 10 - bounce, 4, 2, C.bezel)
      P(9, 10 - bounce, 1, 1, C.codeB)
      P(12, 10 - bounce, 1, 1, C.codeC)
      break
    }
    case 'sleep':
      P(6, 12, 6, 2, sleeve)
      P(6, 13, 6, 1, sleeveLo)
      break
    case 'drink':
      P(7, 11, 2, 3, sleeve)
      P(8, 8, 2, 3, sleeve)
      P(9, 6, 3, 3, C.cream)
      P(9, 6, 3, 1, C.woodDeep)
      P(12, 7, 1, 1, C.cream)
      break
    case 'stretch':
    case 'cheer':
      P(2, -4, 2, 14, sleeve)
      P(9, -4, 2, 14, sleeve)
      P(2, -5, 2, 1, hand)
      P(9, -5, 2, 1, hand)
      break
    case 'water':
      P(7, 12, 3, 2, sleeve)
      P(10, 11, 4, 3, C.teal)
      P(10, 11, 4, 1, C.tealLight)
      P(14, 10, 2, 1, C.teal)
      break
    case 'write': {
      const reach = Math.floor(t * 4) % 3
      P(7, 7 + reach, 4, 2, sleeve)
      P(11, 6 + reach, 2, 2, hand)
      P(13, 6 + reach, 1, 2, C.rose)
      break
    }
    case 'facepalm':
      P(7, 9, 2, 5, sleeve)
      P(8, 5, 3, 3, hand)
      break
    case 'chat': {
      const wave = Math.floor(t * 3 + seed) % 2
      P(7, 11 - wave, 3, 2, sleeve)
      P(10, 10 - wave, 2, 2, hand)
      break
    }
    case 'gaze':
      P(2, 12, 2, 3, sleeveLo)
      break
    case 'walk': {
      const swing = Math.floor(actor.stride) % 4
      const ax = swing === 0 ? 4 : swing === 2 ? 8 : 6
      P(ax, 11, 2, 5, sleeve)
      P(ax, 11, 1, 5, sleeveLo)
      P(ax, 16, 2, 1, hand)
      break
    }
    default:
      if (actor.seated) {
        P(6, 11, 4, 2, sleeve)
        P(10, 11, 2, 1, hand)
      } else {
        P(6, 11, 2, 5, sleeve)
        P(6, 11, 1, 5, sleeveLo)
        P(6, 16, 2, 1, hand)
      }
  }
  if (actor.carrying === 'cup' && pose === 'walk') {
    P(8, 11, 3, 3, C.cream)
    P(8, 11, 3, 1, C.woodDeep)
  }
  if (actor.carrying === 'book' && (pose === 'read' || pose === 'sit')) {
    const [, mid, lo] = SHIRTS[(Math.max(0, actor.crew) + 3) % SHIRTS.length]!
    P(9, 8, 3, 5, mid)
    P(9, 8, 1, 5, lo)
    P(10, 9, 2, 3, C.cream)
  }
}

// ── 夜里的光 ──────────────────────────────────────────────────────────────

function nightLighting(ctx: Ctx, sim: OfficeSim, light: Light): void {
  const L = sim.layout
  glaze(ctx, C.nightTint, 0.32, 0, 0, L.width, L.height)
  // 显示器、落地灯一圈圈的暖光（分层的方块光，像素画常用的那种）
  for (const [id, desk] of L.desks) {
    const owner = sim.actors.get(id)
    const on = owner?.seated && owner.mode.kind !== 'out'
    pool(
      ctx,
      on ? C.screenGlow : C.tealDark,
      desk.monitorX + 9,
      L.floorY - 18,
      18,
      11,
      on ? 0.07 : 0.03
    )
  }
  if (L.sofaX !== null) pool(ctx, C.warm, L.sofaX + 51, L.floorY - 14, 22, 16, 0.07)
  // 吊灯一样的窗光：夜里窗户反而是暗的，留给星星
  void light
}

// ── 气泡、粒子、标记 ─────────────────────────────────────────────────────

const ICONS: Record<BubbleIcon, string[]> = {
  dots: ['.......', 'x..x..x', '.......'],
  bang: ['..x..', '..x..', '..x..', '.....', '..x..'],
  mail: ['xxxxxxx', 'xx...xx', 'x.x.x.x', 'x..x..x', 'xxxxxxx'],
  note: ['...xxx', '...x.x', '...x..', '.xxx..', 'xxxx..'],
  heart: ['.xx.xx.', 'xxxxxxx', 'xxxxxxx', '.xxxxx.', '..xxx..', '...x...'],
  check: ['......x', '.....x.', 'x...x..', '.x.x...', '..x....'],
  cross: ['x...x', '.x.x.', '..x..', '.x.x.', 'x...x'],
  q: ['.xxx.', 'x...x', '...x.', '..x..', '.....', '..x..']
}

function bubble(ctx: Ctx, sim: OfficeSim, actor: Actor, icon: BubbleIcon, alert: boolean): void {
  const head = sim.headOf(actor)
  const rows = ICONS[icon]
  const w = Math.max(...rows.map((r) => r.length)) + 4
  const h = rows.length + 4
  const x = Math.round(Math.min(sim.layout.width - w, Math.max(0, head.x - Math.floor(w / 2))))
  const bob = Math.round(Math.sin(sim.time * 3 + actor.style) * 0.6)
  const y = head.y - h - 6 + bob
  const edge = alert ? C.noteBlocked : C.line
  rect(ctx, edge, x + 1, y, w - 2, h)
  rect(ctx, edge, x, y + 1, w, h - 2)
  rect(ctx, C.cream, x + 1, y + 1, w - 2, h - 2)
  rect(ctx, C.creamMid, x + 1, y + h - 2, w - 2, 1)
  rect(ctx, edge, head.x - 1, y + h, 3, 1)
  rect(ctx, edge, head.x, y + h + 1, 1, 1)
  rect(ctx, C.cream, head.x, y + h - 1, 1, 1)
  const color =
    icon === 'heart' || icon === 'cross' || alert
      ? C.rose
      : icon === 'check'
        ? C.leaf
        : icon === 'mail'
          ? C.teal
          : C.line
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] !== 'x') continue
      const lift = icon === 'dots' && Math.floor(sim.time * 4) % 3 === Math.floor(rx / 3) ? -1 : 0
      rect(ctx, color, x + 2 + rx, y + 2 + ry + lift, 1, 1)
    }
  })
}

function marker(ctx: Ctx, sim: OfficeSim, actor: Actor, color: string): void {
  const head = sim.headOf(actor)
  const bob = Math.round(Math.sin(sim.time * 4))
  const y = head.y - 9 + bob
  rect(ctx, C.line, head.x - 3, y - 1, 7, 1)
  rect(ctx, color, head.x - 2, y, 5, 1)
  rect(ctx, color, head.x - 1, y + 1, 3, 1)
  rect(ctx, color, head.x, y + 2, 1, 1)
}

function particle(ctx: Ctx, p: Particle, t: number): void {
  const k = p.life / p.max
  if (k > 0.75 && Math.floor(t * 20) % 2 === 0 && p.kind !== 'plane') return
  const x = Math.round(p.x)
  const y = Math.round(p.y)
  switch (p.kind) {
    case 'steam':
      rect(ctx, C.cloud, x + Math.round(Math.sin(p.life * 5)), y, 1, 1)
      if (k < 0.4) rect(ctx, C.cloud, x + 1 + Math.round(Math.sin(p.life * 5)), y + 1, 1, 1)
      break
    case 'z': {
      const big = k > 0.4
      const s = big ? 4 : 3
      rect(ctx, C.cream, x, y, s, 1)
      for (let i = 1; i < s - 1; i++) rect(ctx, C.cream, x + s - 1 - i, y + i, 1, 1)
      rect(ctx, C.cream, x, y + s - 1, s, 1)
      break
    }
    case 'spark':
      rect(ctx, C.brassLight, x, y, 1, 1)
      if (k < 0.35) {
        rect(ctx, C.sun, x - 1, y, 3, 1)
        rect(ctx, C.sun, x, y - 1, 1, 3)
      }
      break
    case 'confetti': {
      const palette = [
        C.rose,
        C.codeA,
        C.tealLight,
        C.leafLight,
        C.roseLight,
        C.codeC,
        C.brassLight
      ]
      const color = palette[((p.tone ?? 0) + 1 + palette.length) % palette.length]!
      const flip = Math.sin(p.life * 8 + p.x) > 0
      rect(ctx, color, x, y, flip ? 2 : 1, flip ? 1 : 2)
      break
    }
    case 'leaf':
      rect(ctx, C.leafLight, x, y, 2, 1)
      rect(ctx, C.leaf, x + 1, y + 1, 1, 1)
      break
    case 'drop':
      rect(ctx, C.codeC, x, y, 1, 2)
      break
    case 'bubble':
      rect(ctx, C.skyDayLight, x, y, 1, 1)
      break
    case 'plane': {
      const dir = p.vx >= 0 ? 1 : -1
      const px = (lx: number, ly: number, w: number, color: string): void =>
        rect(ctx, color, dir === 1 ? x + lx : x - lx - w + 1, y + ly, w, 1)
      px(0, 0, 3, C.cream)
      px(0, 1, 7, C.cream)
      px(2, 2, 3, C.creamDark)
      px(0, 1, 1, C.line)
      if (p.from && p.to) {
        for (let i = 1; i <= 4; i++) {
          const back = Math.max(0, k - i * 0.04)
          const e = back * back * (3 - 2 * back)
          const tx = p.from.x + (p.to.x - p.from.x) * e
          const ty = p.from.y + (p.to.y - p.from.y) * e - Math.sin(Math.PI * back) * 14
          if (i % 2 === 0) rect(ctx, C.cream, Math.round(tx), Math.round(ty) + 1, 1, 1)
        }
      }
      break
    }
  }
}

// ── 工作室的猫 ────────────────────────────────────────────────────────────

/**
 * 一只橘猫。纯装饰：在地上溜达、找地方趴着睡，被点了会喵一声。
 * 它自己的一点状态，跟着模拟的时钟走，不进模拟（不影响谁在干嘛）。
 */
export class OfficeCat {
  x = 70
  target = 70
  facing: 1 | -1 = 1
  state: 'walk' | 'sit' | 'sleep' = 'sit'
  until = 3
  meowUntil = 0
  private last = 0

  step(sim: OfficeSim): void {
    const dt = Math.min(0.1, Math.max(0, sim.time - this.last))
    this.last = sim.time
    if (sim.reduced) return
    if (this.state === 'walk') {
      const dx = this.target - this.x
      if (Math.abs(dx) < 0.5) {
        this.state = Math.random() < 0.5 ? 'sleep' : 'sit'
        this.until =
          sim.time + (this.state === 'sleep' ? 14 + Math.random() * 16 : 4 + Math.random() * 5)
      } else {
        this.facing = dx > 0 ? 1 : -1
        this.x += Math.sign(dx) * Math.min(Math.abs(dx), 12 * dt)
      }
      return
    }
    if (sim.time > this.until) {
      this.state = 'walk'
      const L = sim.layout
      this.target = 10 + Math.random() * (L.boardX - 20)
    }
  }

  poke(sim: OfficeSim): void {
    this.meowUntil = sim.time + 1.4
    if (this.state === 'sleep') this.state = 'sit'
    this.until = Math.max(this.until, sim.time + 3)
  }

  hit(sim: OfficeSim, x: number, y: number): boolean {
    const f = sim.layout.floorY
    return x >= this.x - 1 && x <= this.x + 10 && y >= f - 9 && y <= f + 1
  }

  draw(ctx: Ctx, sim: OfficeSim): void {
    const f = sim.layout.floorY
    const x = Math.round(this.x)
    const P = (lx: number, ly: number, w: number, h: number, color: string): void => {
      const px = this.facing === 1 ? x + lx : x + (10 - lx - w)
      rect(ctx, color, px, f + ly, w, h)
    }
    const o = C.catOrange
    const d = C.catOrangeDark
    glaze(ctx, C.shadow, 0.25, x, f, 10, 2)
    if (this.state === 'sleep') {
      // 团成一团，尾巴绕过来
      P(1, -4, 8, 4, o)
      P(1, -4, 8, 1, C.line)
      P(0, -3, 1, 3, C.line)
      P(9, -3, 1, 3, C.line)
      P(2, -3, 2, 1, d)
      P(5, -2, 2, 1, d)
      P(6, -5, 3, 2, o)
      P(6, -6, 1, 1, C.line)
      P(8, -6, 1, 1, C.line)
      P(1, -1, 5, 1, C.catCream)
      const breathe = Math.sin(sim.time * 2) > 0 ? 1 : 0
      if (breathe) P(2, -5, 4, 1, o)
      if (Math.sin(sim.time * 0.7) > 0.6) {
        rect(ctx, C.cream, x + 5, f - 10 - Math.round((sim.time * 3) % 3), 2, 1)
      }
    } else {
      const step = this.state === 'walk' && Math.floor(sim.time * 8) % 2 === 1
      // 身子、四条腿、竖着的尾巴、耳朵
      P(1, -5, 6, 3, o)
      P(1, -5, 6, 1, C.line)
      P(2, -4, 2, 1, d)
      P(1, -2, 1, 2, o)
      P(step ? 3 : 2, -2, 1, 2, d)
      P(5, -2, 1, 2, o)
      P(step ? 7 : 6, -2, 1, 2, d)
      P(0, -9 + (this.state === 'sit' ? 1 : 0), 1, 5, o)
      P(0, -9 + (this.state === 'sit' ? 1 : 0), 1, 1, C.line)
      P(6, -8, 4, 4, o)
      P(6, -9, 1, 1, C.line)
      P(9, -9, 1, 1, C.line)
      P(8, -7, 1, 1, C.line)
      P(9, -6, 1, 1, C.blush)
      P(7, -5, 3, 1, C.catCream)
    }
    if (this.meowUntil > sim.time) {
      const by = f - 18
      const bx = Math.min(sim.layout.width - 9, x + 6)
      rect(ctx, C.line, bx, by, 9, 7)
      rect(ctx, C.cream, bx + 1, by + 1, 7, 5)
      // ♥
      rect(ctx, C.rose, bx + 2, by + 2, 2, 1)
      rect(ctx, C.rose, bx + 5, by + 2, 2, 1)
      rect(ctx, C.rose, bx + 2, by + 3, 5, 1)
      rect(ctx, C.rose, bx + 3, by + 4, 3, 1)
    }
  }
}

// ── 名片上的小人 ─────────────────────────────────────────────────────────

/** 名片小人的画布：左边留 2 格给马尾，头顶留 6 格给丸子头和举起的手 */
export const PORTRAIT_W = W + 4
export const PORTRAIT_H = STAND_H + 7

/**
 * 任务板角色卡上的小人：和办公室里是同一个人（同发型、同肤色、同衬衫），
 * 用同一套画法画在一块小画布上。没有工位和场景，只要人。
 *
 * @param time 秒。拿来眨眼、敲键盘那几下的节奏；传同一个值画出来就是同一帧
 */
export function drawPortraitV2(
  ctx: Ctx,
  who: { crew: number; style: number; producer?: boolean; look?: ModelLook; seated?: boolean },
  pose: Pose,
  time: number
): void {
  const actor = {
    id: '',
    name: '',
    producer: !!who.producer,
    style: who.style,
    crew: who.crew,
    look: who.look,
    x: 2,
    facing: 1,
    pose,
    seated: !!who.seated,
    hop: 0,
    stride: 0,
    blinkAt: 0
  } as unknown as Actor
  // 站着的人头顶在 floorY - 25：落在第 6 行，脚底贴着画布底（下面留 1 行给影子）
  const blink = (time + who.style * 0.7) % 3.6 < 0.14
  const sim = {
    layout: { floorY: PORTRAIT_H - 2 },
    time,
    blinking: () => blink
  } as unknown as OfficeSim
  ctx.clearRect(0, 0, PORTRAIT_W, PORTRAIT_H)
  person(ctx, sim, actor, { hour: 12, night: false, dusk: false })
  arms(ctx, sim, actor)
}
