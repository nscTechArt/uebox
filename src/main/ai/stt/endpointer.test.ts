/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { createEndpointer, frameLevelDb } from './endpointer'

const RATE = 16_000
const BYTES_PER_MS = (RATE * 2) / 1000

/** 一段正弦波，`db` 是 RMS 响度（dBFS）。拿它当「有人在说话」 */
function tone(ms: number, db = -20): Buffer {
  const samples = (RATE * ms) / 1000
  const amplitude = Math.pow(10, db / 20) * Math.SQRT2 * 0x8000
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2)
  }
  return pcm
}

/** 一段固定响度的噪声。`db` 为 null 时是数字静音 */
function noise(ms: number, db: number | null = null): Buffer {
  const samples = (RATE * ms) / 1000
  const pcm = Buffer.alloc(samples * 2)
  if (db === null) return pcm
  // 方波 ±a 的 RMS 就是 a，响度可控，又不用随机数（测试要可复现）
  const amplitude = Math.round(Math.pow(10, db / 20) * 0x8000)
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2)
  return pcm
}

/**
 * 像说话的一段：字与字之间有换气。
 *
 * 一直不停的单音会被当成底噪（风扇就是这样），这正是断句器该有的行为 ——
 * 所以长段的测试要用这个，不能用 `tone`。
 */
function speech(ms: number): Buffer {
  const parts: Buffer[] = []
  for (let left = ms; left > 0; left -= 280) {
    parts.push(tone(Math.min(220, left)))
    if (left > 220) parts.push(noise(Math.min(60, left - 220), -55))
  }
  return Buffer.concat(parts)
}

/** 按采集那头的节奏（200 毫秒一包）喂进去，收齐所有说完的句子 */
function feed(endpointer: ReturnType<typeof createEndpointer>, pcm: Buffer): Buffer[] {
  const out: Buffer[] = []
  const packet = 200 * BYTES_PER_MS
  for (let offset = 0; offset < pcm.length; offset += packet) {
    out.push(...endpointer.push(pcm.subarray(offset, offset + packet)))
  }
  return out
}

const ms = (pcm: Buffer): number => pcm.length / BYTES_PER_MS

describe('frameLevelDb', () => {
  it('全零是最低档，不是 -Infinity', () => {
    expect(frameLevelDb(Buffer.alloc(640))).toBe(-100)
  })

  it('正弦波按 RMS 算', () => {
    expect(frameLevelDb(tone(20, -20))).toBeCloseTo(-20, 0)
  })
})

describe('断句', () => {
  it('一直安静：一句都不出，松手也没有', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    expect(feed(endpointer, noise(3_000))).toEqual([])
    expect(endpointer.end()).toBeNull()
  })

  it('说一句、静下来：静满 800 毫秒交出这一句，前面补一点、后面留一点', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    const out = feed(endpointer, Buffer.concat([noise(500), tone(1_000), noise(1_000)]))
    expect(out).toHaveLength(1)
    // 1000 毫秒的话 + 开口前补的 300 + 结尾留的 200，判开口那几帧有一点出入
    expect(ms(out[0])).toBeGreaterThanOrEqual(1_400)
    expect(ms(out[0])).toBeLessThanOrEqual(1_560)
    expect(endpointer.speaking).toBe(false)
  })

  it('静音还没够就松手：正在说的那句直接交出来', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    expect(feed(endpointer, Buffer.concat([noise(500), tone(800), noise(300)]))).toEqual([])
    expect(endpointer.speaking).toBe(true)
    const tail = endpointer.end()
    expect(tail).not.toBeNull()
    expect(ms(tail!)).toBeGreaterThanOrEqual(1_000)
    expect(endpointer.speaking).toBe(false)
  })

  it('两句之间停够了：分成两句', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    const out = feed(
      endpointer,
      Buffer.concat([noise(500), tone(600), noise(1_000), tone(600), noise(1_000)])
    )
    expect(out).toHaveLength(2)
  })

  it('句中停顿不到 800 毫秒：还是一句', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    const out = feed(
      endpointer,
      Buffer.concat([noise(500), tone(600), noise(400), tone(600), noise(1_000)])
    )
    expect(out).toHaveLength(1)
  })

  it('碰一下麦（一帧爆音）不算开口', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    expect(feed(endpointer, Buffer.concat([noise(500), tone(20), noise(2_000)]))).toEqual([])
    expect(endpointer.end()).toBeNull()
  })

  it('一声短促的响动（不到 160 毫秒）够不上一句，不送去识别', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    expect(feed(endpointer, Buffer.concat([noise(500), tone(100), noise(1_500)]))).toEqual([])
  })

  it('持续的底噪不算说话，盖在底噪上的话照样认得出', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    // 风扇声 -40 dB 一直开着：开头就是它，没有「安静房间」可比
    const fan = (length: number): Buffer => noise(length, -40)
    const out = feed(endpointer, Buffer.concat([fan(2_000), tone(800, -15), fan(1_500)]))
    expect(out).toHaveLength(1)
    expect(endpointer.end()).toBeNull()
  })

  it('比底噪高、但低于绝对下限的（呼吸声）不算说话', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    expect(feed(endpointer, Buffer.concat([noise(500), tone(1_000, -58), noise(1_000)]))).toEqual(
      []
    )
  })

  it('一口气说超过 30 秒：就地切一刀先交出去，后半段接着算', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    const out = feed(endpointer, Buffer.concat([noise(500), speech(31_000)]))
    expect(out).toHaveLength(1)
    expect(ms(out[0])).toBe(30_000)
    expect(endpointer.speaking).toBe(true)
    const rest = endpointer.end()
    expect(rest).not.toBeNull()
    expect(ms(rest!)).toBeGreaterThan(900)
  })

  it('包长不对齐帧：零头留到下一包，一个样本都不丢', () => {
    const endpointer = createEndpointer({ sampleRate: RATE })
    const pcm = Buffer.concat([noise(500), tone(1_000)])
    // 每包 333 字节：既不是帧长的整数倍，还是奇数
    for (let offset = 0; offset < pcm.length; offset += 333) {
      endpointer.push(pcm.subarray(offset, offset + 333))
    }
    const tail = endpointer.end()
    expect(tail).not.toBeNull()
    expect(ms(tail!)).toBeGreaterThanOrEqual(1_000)
  })
})
