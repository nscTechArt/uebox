/**
 * @vitest-environment node
 *
 * 时间轴拼图的契约测试。
 *
 * 测的不是「能不能拼出一张图」，而是几件**错了模型会看不出来**的事：
 * 格子顺序和时间的对应、少了帧有没有说、单格尺寸报得对不对。
 * 这些一旦错，返回的仍然是一张看着很正常的图，没人会发现。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  buildContactSheet,
  buildContactSheets,
  describeContactSheets,
  sheetColumns,
  type SheetFrame
} from './contactSheet'
import { CONTACT_SHEET_MAX_WIDTH } from '../../contextImage'

let dir = ''

/** 造一张纯色帧，宽高可指定 —— 尺寸不一致那条路要用 */
async function writeFrame(
  name: string,
  color: string,
  width = 1280,
  height = 720
): Promise<string> {
  const sharp = (await import('sharp')).default
  const file = path.join(dir, name)
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${color}"/></svg>`
  )
  await sharp(svg).png().toFile(file)
  return file
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ual-sheet-'))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('sheetColumns', () => {
  it('三张以内排成一行，再多就走近似正方的网格', () => {
    expect(sheetColumns(1)).toBe(1)
    expect(sheetColumns(3)).toBe(3)
    expect(sheetColumns(4)).toBe(2)
    expect(sheetColumns(6)).toBe(3)
    expect(sheetColumns(9)).toBe(3)
  })
})

describe('buildContactSheet', () => {
  it('九帧拼成 3×3，总宽不超过预算', async () => {
    const frames: SheetFrame[] = []
    for (let i = 0; i < 9; i++) {
      frames.push({ path: await writeFrame(`g${i}.png`, '#336699'), at: i * 0.5 })
    }

    const sheet = await buildContactSheet(frames)
    expect(sheet).not.toBeNull()
    expect(sheet!.columns).toBe(3)
    expect(sheet!.rows).toBe(3)
    expect(sheet!.used).toHaveLength(9)
    expect(sheet!.missing).toHaveLength(0)

    const sharp = (await import('sharp')).default
    const meta = await sharp(sheet!.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(CONTACT_SHEET_MAX_WIDTH)
    // 16:9 的帧拼成 3×3，整张也该是 16:9 上下
    expect(meta.height! / meta.width!).toBeCloseTo(9 / 16, 1)
  })

  /**
   * 读不回来的帧**不能悄悄跳过**。
   *
   * 少了两格而不说，模型看到的是一条连续的时间轴，会把两格之间发生的事
   * 当成没发生 —— 「角色一直站着没动」这种结论就是这么来的。
   */
  it('读不回来的帧记进 missing，并且在说明里点名', async () => {
    const good = await writeFrame('ok.png', '#aa3333')
    const sheet = await buildContactSheet([
      { path: good, at: 0 },
      { path: path.join(dir, 'nope.png'), at: 1 }
    ])

    expect(sheet!.used).toHaveLength(1)
    expect(sheet!.missing).toEqual([path.join(dir, 'nope.png')])
    expect(describeContactSheets([sheet!])).toContain('不完整')
  })

  it('一张都读不回来时返回 null，不给空网格', async () => {
    const sheet = await buildContactSheet([{ path: path.join(dir, 'ghost.png'), at: 0 }])
    expect(sheet).toBeNull()
  })

  it('空数组也返回 null', async () => {
    expect(await buildContactSheet([])).toBeNull()
  })

  /**
   * 尺寸不一致时留灰边而不是裁掉。窗口抓帧那条路的画面尺寸跟着编辑器
   * 窗口走，用户中途拖一下就变了 —— 而「东西跑出画面没有」恰恰发生在边缘。
   */
  it('尺寸不一致的帧按第一帧的长宽比留边，不拉伸也不裁切', async () => {
    const wide = await writeFrame('wide.png', '#224422', 1280, 720)
    const tall = await writeFrame('tall.png', '#442222', 720, 1280)
    const sheet = await buildContactSheet([
      { path: wide, at: 0 },
      { path: tall, at: 1 }
    ])
    expect(sheet!.used).toHaveLength(2)
    // 格子长宽比跟第一帧（16:9）
    expect(sheet!.cellHeight / sheet!.cellWidth).toBeCloseTo(9 / 16, 1)
  })
})

describe('describeContactSheets', () => {
  it('把每格的时间逐一列出来，并说清单格多大', async () => {
    const frames = [
      { path: await writeFrame('d0.png', '#111111'), at: 0 },
      { path: await writeFrame('d1.png', '#222222'), at: 1.25 },
      { path: await writeFrame('d2.png', '#333333'), at: 2.5 }
    ]
    const sheet = await buildContactSheet(frames)
    const text = describeContactSheets([sheet!])

    expect(text).toContain('1=0.0s')
    expect(text).toContain('2=1.3s')
    expect(text).toContain('3=2.5s')
    expect(text).toContain('从左到右、从上到下')
    expect(text).toContain(`${sheet!.cellWidth}×${sheet!.cellHeight}`)
  })

  /**
   * 进上下文的那一份被再缩过时，报的必须是**缩后**的单格尺寸。
   * 报原尺寸等于告诉模型「这里有 384 像素可看」，而它拿到的只有 256。
   */
  it('拼图进上下文时又被缩过，单格尺寸按缩后的算', async () => {
    const frames = [
      { path: await writeFrame('s0.png', '#111111'), at: 0 },
      { path: await writeFrame('s1.png', '#222222'), at: 1 }
    ]
    const sheet = await buildContactSheet(frames)
    const halfWidth = Math.round((sheet!.cellWidth * sheet!.columns) / 2)
    const text = describeContactSheets([sheet!], [halfWidth])

    expect(text).toContain(
      `${Math.round(sheet!.cellWidth / 2)}×${Math.round(sheet!.cellHeight / 2)}`
    )
  })
})

/**
 * 多张：一张最多九格，再多就再来一张。
 *
 * 错了都是「看着正常」的那种错：编号断了、两张不一样大、时间接不上，
 * 模型照样能从图上读出一个顺序来 —— 只是那个顺序是它自己编的。
 */
describe('buildContactSheets', () => {
  const makeFrames = async (count: number, tag: string): Promise<SheetFrame[]> => {
    const frames: SheetFrame[] = []
    for (let i = 0; i < count; i++) {
      frames.push({ path: await writeFrame(`${tag}${i}.png`, '#335577'), at: i * 0.5 })
    }
    return frames
  }

  it('九格以内还是一张', async () => {
    const sheets = await buildContactSheets(await makeFrames(9, 'one'))
    expect(sheets).toHaveLength(1)
    expect(sheets[0].used).toHaveLength(9)
  })

  /** 12 帧 = 6+6，不是 9+3：两张一样大才像同一条时间轴的两段 */
  it('超过九格切成多张，格子数尽量平均', async () => {
    const sheets = await buildContactSheets(await makeFrames(12, 'even'))
    expect(sheets).toHaveLength(2)
    expect(sheets.map((sheet) => sheet.used.length)).toEqual([6, 6])
  })

  it('27 帧切成三张满格', async () => {
    const sheets = await buildContactSheets(await makeFrames(27, 'full'))
    expect(sheets).toHaveLength(3)
    expect(sheets.map((sheet) => sheet.used.length)).toEqual([9, 9, 9])
  })

  /**
   * 编号必须跨图连着数。各自从 1 起的话，模型说「第 3 格开始变黑」
   * 时没人知道是哪一张的第 3 格 —— 它自己多半也不知道。
   */
  it('序号跨图连着排', async () => {
    const sheets = await buildContactSheets(await makeFrames(12, 'idx'))
    expect(sheets[0].startIndex).toBe(1)
    expect(sheets[1].startIndex).toBe(7)
  })

  /** 中间有帧读不回来时，后面的编号按**真放进去的**格子算，不按计划的帧数 */
  it('有帧读不回来时后面的编号不跟着偏', async () => {
    const frames = await makeFrames(12, 'lost')
    frames[1] = { path: path.join(dir, 'gone.png'), at: 0.5 }

    const sheets = await buildContactSheets(frames)

    expect(sheets[0].used).toHaveLength(5)
    expect(sheets[1].startIndex).toBe(6)
  })

  it('一帧都没有时返回空数组', async () => {
    expect(await buildContactSheets([])).toEqual([])
  })
})

describe('describeContactSheets 多张时', () => {
  it('说清几张、每张盖哪几格哪一段，以及编号是连着的', async () => {
    const frames: SheetFrame[] = []
    for (let i = 0; i < 12; i++) {
      frames.push({ path: await writeFrame(`m${i}.png`, '#553311'), at: i * 0.5 })
    }
    const sheets = await buildContactSheets(frames)
    const text = describeContactSheets(sheets)

    expect(text).toContain('2 张')
    expect(text).toContain('连着数')
    expect(text).toContain('第 1–6 格')
    expect(text).toContain('第 7–12 格')
    expect(text).toContain('0.0s–2.5s')
    expect(text).toContain('3.0s–5.5s')
    // 多张时不再逐格列时间：三十六个数会把正文淹掉，秒数画面上烧着
    expect(text).not.toContain('各格时间')
  })
})
