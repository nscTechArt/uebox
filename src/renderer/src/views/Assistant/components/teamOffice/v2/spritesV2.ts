/**
 * V2 的静态家具素材：像素图，原图由图像模型按「64 格画布、品红底」生成，
 * 再用 scripts 之外的一次性脚本采样回真正的像素网格、抠掉品红（成品就是这里这些 PNG）。
 *
 * 素材里被品红包住的透明区是「洞」（窗玻璃）：画的时候先在洞里画天，再盖素材。
 * 洞的位置不写死，加载时从透明像素里算出来 —— 换一张素材不用改代码。
 */

import bookshelf from './sprites/bookshelf.png'
import clock from './sprites/clock.png'
import coffeeBar from './sprites/coffee_bar.png'
import corkboard from './sprites/corkboard.png'
import hangingPlant from './sprites/hanging_plant.png'
import plantBig from './sprites/plant_big.png'
import sofa from './sprites/sofa.png'
import waterCooler from './sprites/water_cooler.png'
import windowFrame from './sprites/window.png'

export interface SpriteRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Sprite {
  img: HTMLImageElement
  w: number
  h: number
  /** 被不透明像素围住的透明区 */
  holes: SpriteRect[]
}

export type SpriteSet = Partial<Record<string, Sprite>>

const SOURCES: Record<string, string> = {
  bookshelf,
  clock,
  coffee_bar: coffeeBar,
  corkboard,
  hanging_plant: hangingPlant,
  plant_big: plantBig,
  sofa,
  water_cooler: waterCooler,
  window: windowFrame
}

/** 从边上灌水：灌不到的透明像素就是洞，按连通块给出外接矩形 */
export function findHoles(
  alpha: (x: number, y: number) => number,
  w: number,
  h: number
): SpriteRect[] {
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = y * w + x
    if (outside[i] || alpha(x, y) > 0) return
    outside[i] = 1
    stack.push(i)
  }
  for (let x = 0; x < w; x++) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    push(0, y)
    push(w - 1, y)
  }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    const y = Math.floor(i / w)
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }
  const seen = new Uint8Array(w * h)
  const holes: SpriteRect[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (seen[i] || outside[i] || alpha(x, y) > 0) continue
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      const queue = [i]
      seen[i] = 1
      while (queue.length) {
        const j = queue.pop()!
        const jx = j % w
        const jy = Math.floor(j / w)
        minX = Math.min(minX, jx)
        maxX = Math.max(maxX, jx)
        minY = Math.min(minY, jy)
        maxY = Math.max(maxY, jy)
        for (const [nx, ny] of [
          [jx + 1, jy],
          [jx - 1, jy],
          [jx, jy + 1],
          [jx, jy - 1]
        ] as const) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const k = ny * w + nx
          if (seen[k] || outside[k] || alpha(nx, ny) > 0) continue
          seen[k] = 1
          queue.push(k)
        }
      }
      // 一两个像素的透明点是抠图的毛边，不算洞
      if ((maxX - minX + 1) * (maxY - minY + 1) >= 6)
        holes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 })
    }
  }
  return holes.sort((a, b) => a.y - b.y || a.x - b.x)
}

function load(src: string): Promise<Sprite> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      const data = ctx ? (ctx.drawImage(img, 0, 0), ctx.getImageData(0, 0, w, h).data) : null
      const holes = data ? findHoles((x, y) => data[(y * w + x) * 4 + 3]!, w, h) : []
      resolve({ img, w, h, holes })
    }
    img.onerror = () => reject(new Error(`素材加载失败：${src}`))
    img.src = src
  })
}

let cache: Promise<SpriteSet> | null = null

/** 所有素材一起加载，只加载一次。某一张坏了就少画那一样，不拖累别的 */
export function loadSprites(): Promise<SpriteSet> {
  cache ??= Promise.all(
    Object.entries(SOURCES).map(async ([name, src]) => {
      try {
        return [name, await load(src)] as const
      } catch {
        return [name, undefined] as const
      }
    })
  ).then((entries) => Object.fromEntries(entries.filter(([, s]) => s)) as SpriteSet)
  return cache
}
