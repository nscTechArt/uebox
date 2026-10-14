import { describe, expect, it } from 'vitest'

import { computeLayout, minSceneWidth, OfficeSim, seededRandom } from '../officeSim'
import { V2_PROFILE } from './artV2'
import { findHoles } from './spritesV2'

describe('素材里的洞', () => {
  it('被不透明像素围住的透明区才算洞，连着边的不算，一两个像素的毛边不算', () => {
    const map = [
      '..........',
      '.########.',
      '.#..#...#.',
      '.#..#...#.',
      '.########.',
      '.#.######.',
      '.########.'
    ]
    const holes = findHoles((x, y) => (map[y]![x] === '#' ? 255 : 0), map[0]!.length, map.length)
    // 左边 2×2 和下面那 1 格太小，算毛边
    expect(holes).toEqual([{ x: 5, y: 2, w: 3, h: 2 }])
  })
})

describe('豪华版的几何', () => {
  it('最窄时工位不重叠、不压到白板，制作人站得下', () => {
    for (const count of [1, 3, 5, 8]) {
      const ids = Array.from({ length: count }, (_, i) => `m${i}`)
      const layout = computeLayout(minSceneWidth(count, V2_PROFILE), ids, V2_PROFILE)
      const desks = [...layout.desks.values()]
      desks.forEach((desk, i) => {
        expect(desk.deskX + desk.deskW).toBeLessThanOrEqual(desk.x + desk.width)
        if (i > 0)
          expect(desk.seatX).toBeGreaterThanOrEqual(desks[i - 1]!.deskX + desks[i - 1]!.deskW)
      })
      expect(desks.at(-1)!.x + desks.at(-1)!.width).toBeLessThanOrEqual(layout.boardX)
      expect(desks[0]!.x).toBeGreaterThanOrEqual(V2_PROFILE.deskStart)
      expect(layout.producerX + V2_PROFILE.spriteW).toBeLessThanOrEqual(layout.width)
    }
  })

  it('同一套模拟换上豪华版几何也照常跑：开工的人坐回自己的工位', () => {
    const sim = new OfficeSim(320, { random: seededRandom(1), profile: V2_PROFILE })
    sim.sync(
      [{ id: 'a', name: 'a', style: 0, crew: 0, mode: { kind: 'idle' } }],
      { kind: 'idle' },
      { fresh: true }
    )
    for (let t = 0; t < 3; t += 1 / 30) sim.step(1 / 30)
    sim.sync([{ id: 'a', name: 'a', style: 0, crew: 0, mode: { kind: 'work', tool: 'write' } }], {
      kind: 'idle'
    })
    for (let t = 0; t < 12; t += 1 / 30) sim.step(1 / 30)
    const a = sim.actors.get('a')!
    expect(a.seated).toBe(true)
    expect(a.x).toBe(sim.layout.desks.get('a')!.seatX)
    expect(sim.headOf(a).y).toBe(V2_PROFILE.floorY - V2_PROFILE.spriteH + 1 + V2_PROFILE.sitDrop)
  })
})
