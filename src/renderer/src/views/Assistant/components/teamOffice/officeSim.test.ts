import { describe, expect, it } from 'vitest'

import {
  computeLayout,
  minSceneWidth,
  OfficeSim,
  PRODUCER_ID,
  seededRandom,
  SPRITE_W,
  type MemberInput,
  type Mode
} from './officeSim'

const member = (id: string, mode: Mode, crew = 0): MemberInput => ({
  id,
  name: id,
  style: crew,
  crew,
  mode
})

function run(sim: OfficeSim, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += 1 / 30) {
    sim.step(1 / 30)
    each?.()
  }
}

describe('布局', () => {
  it('最窄时工位也不重叠、不出画面，制作人站在白板右边', () => {
    for (const count of [1, 3, 6, 8]) {
      const ids = Array.from({ length: count }, (_, i) => `m${i}`)
      const layout = computeLayout(minSceneWidth(count), ids)
      const desks = [...layout.desks.values()]
      desks.forEach((desk, i) => {
        expect(desk.deskX + desk.deskW).toBeLessThanOrEqual(desk.x + desk.width)
        if (i > 0)
          expect(desk.seatX).toBeGreaterThanOrEqual(desks[i - 1]!.deskX + desks[i - 1]!.deskW)
      })
      expect(desks.at(-1)!.x + desks.at(-1)!.width).toBeLessThanOrEqual(layout.boardX)
      expect(layout.producerX + SPRITE_W).toBeLessThanOrEqual(layout.width)
    }
  })
})

describe('谁在哪', () => {
  it('打开时干活的人已经坐在工位上，不从门口走进来', () => {
    const sim = new OfficeSim(300, { random: seededRandom(1) })
    sim.sync([member('a', { kind: 'work', tool: 'write' })], { kind: 'board' }, { fresh: true })
    const a = sim.actors.get('a')!
    expect(a.seated).toBe(true)
    expect(a.x).toBe(sim.layout.desks.get('a')!.seatX)
    expect(a.pose).toBe('type')
    expect(sim.actors.get(PRODUCER_ID)!.pose).toBe('write')
  })

  it('闲着的人一开工：放下手上的事，走回工位坐下，姿势跟着工具变', () => {
    const sim = new OfficeSim(300, { random: seededRandom(2) })
    sim.sync([member('a', { kind: 'idle' })], { kind: 'idle' }, { fresh: true })
    run(sim, 3)
    sim.sync([member('a', { kind: 'work', tool: 'run' })], { kind: 'idle' })
    expect(sim.actors.get('a')!.errand).toBeNull()
    run(sim, 12)
    const a = sim.actors.get('a')!
    expect(a.seated).toBe(true)
    expect(a.pose).toBe('lean')
    sim.sync([member('a', { kind: 'work', tool: 'read' })], { kind: 'idle' })
    run(sim, 0.2)
    expect(a.pose).toBe('read')
  })

  it('等回话的人头上一直冒省略号，回了就没了；停工的人趴着睡', () => {
    const sim = new OfficeSim(300, { random: seededRandom(3) })
    sim.sync(
      [member('a', { kind: 'wait' }), member('b', { kind: 'out' }, 1)],
      { kind: 'idle' },
      { fresh: true }
    )
    run(sim, 0.5)
    expect(sim.actors.get('a')!.bubble?.icon).toBe('dots')
    expect(sim.actors.get('b')!.pose).toBe('sleep')
    sim.sync([member('a', { kind: 'work', tool: 'write' }), member('b', { kind: 'out' }, 1)], {
      kind: 'idle'
    })
    run(sim, 0.2)
    expect(sim.actors.get('a')!.bubble).toBeNull()
  })

  it('闲着的一群人到处走，但同一个地方一次只站一个人', () => {
    const sim = new OfficeSim(360, { random: seededRandom(4) })
    const members = Array.from({ length: 5 }, (_, i) => member(`m${i}`, { kind: 'idle' }, i))
    sim.sync(members, { kind: 'idle' }, { fresh: true })
    const visited = new Set<string>()
    run(sim, 90, () => {
      const spots = [...sim.actors.values()].map((a) => a.errand?.spot).filter(Boolean) as string[]
      expect(new Set(spots).size).toBe(spots.length)
      for (const a of sim.actors.values()) if (a.errand?.arrived) visited.add(a.errand.kind)
    })
    // 九十秒里总该有人去冲咖啡、聊天、回工位坐坐
    expect(visited.size).toBeGreaterThanOrEqual(4)
  })

  it('新招来的人从门口走进来', () => {
    const sim = new OfficeSim(300, { random: seededRandom(5) })
    sim.sync([], { kind: 'idle' }, { fresh: true })
    sim.sync([member('new', { kind: 'work', tool: 'write' })], { kind: 'idle' })
    const a = sim.actors.get('new')!
    expect(a.x).toBeLessThan(0)
    run(sim, 15)
    expect(a.seated).toBe(true)
  })
})

describe('事件', () => {
  it('留言是一架纸飞机，落地时收信人头上冒个信封', () => {
    const sim = new OfficeSim(300, { random: seededRandom(6) })
    sim.sync(
      [
        member('a', { kind: 'work', tool: 'write' }),
        member('b', { kind: 'work', tool: 'write' }, 1)
      ],
      { kind: 'board' },
      { fresh: true }
    )
    sim.mail('a', PRODUCER_ID)
    expect(sim.particles.filter((p) => p.kind === 'plane')).toHaveLength(1)
    let flying = 0
    while (sim.particles.some((p) => p.kind === 'plane') && flying++ < 300) sim.step(1 / 30)
    expect(sim.particles.filter((p) => p.kind === 'plane')).toHaveLength(0)
    expect(sim.actors.get(PRODUCER_ID)!.bubble?.icon).toBe('mail')
  })

  it('验收通过撒彩带、大家一起跳；没过白板下雨', () => {
    const sim = new OfficeSim(300, { random: seededRandom(7) })
    sim.sync([member('a', { kind: 'idle' })], { kind: 'idle' }, { fresh: true })
    sim.verdict('pass')
    expect(sim.particles.some((p) => p.kind === 'confetti')).toBe(true)
    expect(sim.actors.get('a')!.hop).toBeGreaterThan(0)
    sim.verdict('fail')
    expect(sim.rainUntil).toBeGreaterThan(sim.time)
  })

  it('减少动效：不走路直接到位，不放粒子', () => {
    const sim = new OfficeSim(300, { random: seededRandom(8), reduced: true })
    sim.sync([member('a', { kind: 'idle' })], { kind: 'idle' }, { fresh: true })
    sim.sync([member('a', { kind: 'work', tool: 'write' })], { kind: 'idle' })
    run(sim, 1)
    expect(sim.actors.get('a')!.seated).toBe(true)
    sim.done('a')
    sim.mail('a', PRODUCER_ID)
    sim.verdict('pass')
    run(sim, 1)
    expect(sim.particles).toHaveLength(0)
  })

  it('点人能点中，点空地点不中', () => {
    const sim = new OfficeSim(300, { random: seededRandom(9) })
    sim.sync([member('a', { kind: 'work', tool: 'write' })], { kind: 'board' }, { fresh: true })
    const head = sim.headOf(sim.actors.get('a')!)
    expect(sim.hit(head.x, head.y + 4)?.id).toBe('a')
    expect(sim.hit(head.x, 2)).toBeNull()
  })
})
