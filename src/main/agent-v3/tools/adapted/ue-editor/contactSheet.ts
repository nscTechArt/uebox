/**
 * 把一串按时间抓的帧拼成一张「时间轴拼图」（九宫格）。
 *
 * ## 为什么要拼，而不是把 N 张图都塞进去
 *
 * N 张图 = N 份图片预算。一张 768 宽的截图就值几万 token（见
 * `tools/contextImage.ts` 开头那次把上下文冲到 123 万的事故），九张就是
 * 九倍，而且模型还要自己在九个附件之间建立先后关系。
 *
 * 拼成一张之后只有一份预算，先后顺序由格子的位置和烧在画面上的编号
 * 直接给出 —— 时间轴这件事本来就该是**一张图上的空间关系**。
 *
 * ## 为什么每个格子上必须烧时间
 *
 * 不烧的话模型拿到的是九张长得差不多的图，它会自己编一个顺序出来，
 * 然后拿编出来的顺序讲因果（「先掉下去再变红」）。编号和秒数是画面里
 * 唯一能锚住时间的东西，不能只写在 message 里 —— 文字说的「第 3 格」
 * 和它眼睛看到的第 3 格对不上时，它信的是眼睛。
 *
 * ## 一张最多九格，再多就再来一张
 *
 * 两个旋钮是**分开**的，别拧成一个：
 *
 * - **一张几格** 决定看不看得清。总宽度固定在 1152，九格时每格 384×216，
 *   已经是「看得出东西在哪」的下限附近；十六格挤到 288 宽，二十五格就只剩
 *   两百出头，那时候拼得再多也只是把同一份信息糊得更均匀。
 * - **几张图** 决定盖多长时间。要连续看十几秒，就再来一张，不是把格子掰小。
 *
 * 所以格子尺寸是常数，帧数超过九就自动分成多张，**每张都是一份图片预算**——
 * 三张拼图约等于三次截图的代价，线性涨，涨得明明白白。这比「一张图里塞进
 * 三十六格然后谁也看不清」诚实：后者省下的预算换来的是一张下不了结论的图。
 *
 * 分张时格子数**尽量平均**（12 帧 = 6+6，不是 9+3）：两张一样大的图看起来
 * 才是一条连续的时间轴，9+3 会让人以为后三格是另一回事。
 *
 * ## 为什么用 contain 而不是 cover
 *
 * 帧与帧之间尺寸理论上一致（同一次采样同一条路），但窗口抓帧那条路
 * 是按编辑器窗口客户区走的，用户中途拖一下窗口大小就变了。cover 会
 * 裁掉边缘 —— 而「东西跑出画面了没有」恰恰常常发生在边缘。宁可留灰边。
 */

import { getSharp } from '../../../../utils/sharpLoader'
import { CONTACT_SHEET_MAX_WIDTH } from '../../contextImage'
import * as fs from 'fs/promises'

/** 一帧：磁盘上的文件，以及它是开跑后第几秒拍的 */
export interface SheetFrame {
  path: string
  /** 开跑后的秒数 */
  at: number
}

export interface ContactSheet {
  /** 拼好的 PNG 字节。压缩进上下文这一步由调用方走 compressForContext */
  buffer: Buffer
  columns: number
  rows: number
  /** 单个格子里画面本身的像素尺寸（不含格子之间的缝） */
  cellWidth: number
  cellHeight: number
  /** 真正放进去的帧，顺序即格子顺序（从左到右、从上到下） */
  used: SheetFrame[]
  /** 读不回来、没能放进去的帧路径 */
  missing: string[]
  /**
   * 第一格在整条时间轴上是第几帧（从 1 起）。
   *
   * 多张拼图时编号必须**连着排**：第二张的第一格是 10 而不是 1。
   * 各自从 1 数的话，模型说「第 3 格开始变黑」时没人知道是哪一张的第 3 格 ——
   * 而它多半自己也不知道。
   */
  startIndex: number
}

/**
 * 一张拼图最多几格。
 *
 * 不是随便定的：总宽 1152 / 3 列 = 每格 384×216，再密就掉到三百以下。
 * 要盖更长的时间，加图，不是加格 —— 理由见文件头。
 */
export const MAX_CELLS_PER_SHEET = 9

/** 格子之间的缝，也是整张图的底色。压深一点，好和游戏画面分开 */
const SHEET_BACKGROUND = { r: 24, g: 24, b: 27, alpha: 1 }
/** 缝宽（像素）。够看出边界就行，再宽就是白占预算 */
const GUTTER = 4

/**
 * 几列。
 *
 * 三张以内排成一行 —— 三格一行每格还有 384 宽，比排成 2×2 空一格强。
 * 再多就走近似正方的网格：格子越接近正方形，同样的总宽度下单格面积越大。
 */
export function sheetColumns(count: number): number {
  if (count <= 3) return Math.max(1, count)
  return Math.ceil(Math.sqrt(count))
}

/**
 * 烧在格子左上角的那块标签。
 *
 * 底下垫一层半透明黑：游戏画面什么颜色都可能出现，白字直接压上去
 * 遇到雪地或过曝的天空就完全看不见了 —— 而看不见的标签等于没有标签。
 */
function labelSvg(
  sheetWidth: number,
  sheetHeight: number,
  frames: SheetFrame[],
  columns: number,
  cellWidth: number,
  cellHeight: number,
  startIndex: number
): Buffer {
  const fontSize = Math.max(12, Math.round(cellHeight * 0.11))
  const padX = Math.round(fontSize * 0.45)
  const boxHeight = Math.round(fontSize * 1.6)

  const parts = frames.map((frame, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    const x = col * (cellWidth + GUTTER)
    const y = row * (cellHeight + GUTTER)
    const text = `${startIndex + index} · ${frame.at.toFixed(1)}s`
    // 宽度按字符数估，宁可宽一点：算窄了文字会顶出底板，又回到白字压白景
    const boxWidth = Math.round(fontSize * 0.62 * text.length + padX * 2)
    return (
      `<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" fill="#000000" fill-opacity="0.66"/>` +
      `<text x="${x + padX}" y="${y + Math.round(boxHeight * 0.72)}" ` +
      `font-family="sans-serif" font-size="${fontSize}" fill="#ffffff">${text}</text>`
    )
  })

  return Buffer.from(
    `<svg width="${sheetWidth}" height="${sheetHeight}" xmlns="http://www.w3.org/2000/svg">` +
      parts.join('') +
      `</svg>`
  )
}

/**
 * 拼图。一张都读不回来时返回 null —— 调用方据此告诉模型「这次没有画面」，
 * 而不是给它一张空网格让它对着灰格子下结论。
 */
export async function buildContactSheet(
  frames: SheetFrame[],
  options?: { maxWidth?: number; startIndex?: number }
): Promise<ContactSheet | null> {
  if (frames.length === 0) return null

  const sharp = await getSharp()
  const maxWidth = options?.maxWidth ?? CONTACT_SHEET_MAX_WIDTH
  const startIndex = options?.startIndex ?? 1

  // 先把能读的读出来。读不回来的帧要报上去，不能当没发生过：
  // 少了两格而不说，模型会把剩下七格当成完整的时间轴
  const loaded: Array<{ frame: SheetFrame; bytes: Buffer; width: number; height: number }> = []
  const missing: string[] = []
  for (const frame of frames) {
    try {
      const bytes = await fs.readFile(frame.path)
      const meta = await sharp(bytes).metadata()
      if (!meta.width || !meta.height) {
        missing.push(frame.path)
        continue
      }
      loaded.push({ frame, bytes, width: meta.width, height: meta.height })
    } catch {
      missing.push(frame.path)
    }
  }

  if (loaded.length === 0) return null

  const columns = sheetColumns(loaded.length)
  const rows = Math.ceil(loaded.length / columns)

  // 格子的长宽比跟第一帧走。几帧尺寸不一致时后面的会留灰边（contain），
  // 好过把画面拉变形 —— 变形的画面会让模型判错物体形状
  const aspect = loaded[0].height / loaded[0].width
  const cellWidth = Math.max(1, Math.floor((maxWidth - GUTTER * (columns - 1)) / columns))
  const cellHeight = Math.max(1, Math.round(cellWidth * aspect))

  const sheetWidth = cellWidth * columns + GUTTER * (columns - 1)
  const sheetHeight = cellHeight * rows + GUTTER * (rows - 1)

  const cells = await Promise.all(
    loaded.map(async (item) =>
      sharp(item.bytes)
        .resize({
          width: cellWidth,
          height: cellHeight,
          fit: 'contain',
          background: SHEET_BACKGROUND
        })
        .png()
        .toBuffer()
    )
  )

  const composites: Array<{ input: Buffer; left: number; top: number }> = cells.map(
    (input, index) => ({
      input,
      left: (index % columns) * (cellWidth + GUTTER),
      top: Math.floor(index / columns) * (cellHeight + GUTTER)
    })
  )

  const used = loaded.map((item) => item.frame)
  composites.push({
    input: labelSvg(sheetWidth, sheetHeight, used, columns, cellWidth, cellHeight, startIndex),
    left: 0,
    top: 0
  })

  const buffer = await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 3,
      background: SHEET_BACKGROUND
    }
  })
    .composite(composites)
    .png()
    .toBuffer()

  return { buffer, columns, rows, cellWidth, cellHeight, used, missing, startIndex }
}

/**
 * 按每张最多九格切开，拼成一串。
 *
 * 格子数尽量平均：12 帧 = 6+6 而不是 9+3。两张一样大的图看起来才是同一条
 * 时间轴的两段，9+3 的第二张看着像另一件事的补充说明。
 */
export async function buildContactSheets(
  frames: SheetFrame[],
  options?: { maxWidth?: number; maxPerSheet?: number }
): Promise<ContactSheet[]> {
  if (frames.length === 0) return []

  const maxPerSheet = options?.maxPerSheet ?? MAX_CELLS_PER_SHEET
  const sheetCount = Math.ceil(frames.length / maxPerSheet)
  const perSheet = Math.ceil(frames.length / sheetCount)

  const sheets: ContactSheet[] = []
  // 编号按**真正放进去的**格子累加，不是按计划的帧数 —— 中间有帧读不回来时
  // 按计划数会让后面每一张的编号都偏，而偏了没人看得出来
  let nextIndex = 1
  for (let start = 0; start < frames.length; start += perSheet) {
    const sheet = await buildContactSheet(frames.slice(start, start + perSheet), {
      maxWidth: options?.maxWidth,
      startIndex: nextIndex
    })
    if (!sheet) continue
    sheets.push(sheet)
    nextIndex += sheet.used.length
  }
  return sheets
}

/**
 * 给模型看的一句话：这几张图怎么读、哪张盖哪一段、单格多大。
 *
 * 单格尺寸必须说 —— 和 `describeResize` 同一条规矩。一张 1152 宽的九宫格
 * 里每格只有 384×216，模型不知道这件事时会把「看不清」当成「图上没有」，
 * 然后报告一个不存在的缺失。
 */
export function describeContactSheets(sheets: ContactSheet[], contextWidths?: number[]): string {
  if (sheets.length === 0) return ''

  const total = sheets.reduce((sum, sheet) => sum + sheet.used.length, 0)
  const missing = sheets.reduce((sum, sheet) => sum + sheet.missing.length, 0)

  // 进上下文的那一份如果被再缩过，格子的真实像素要按缩后的算
  const first = sheets[0]
  const scale = contextWidths?.[0] ? contextWidths[0] / (first.cellWidth * first.columns) : 1
  const shownW = Math.round(first.cellWidth * scale)
  const shownH = Math.round(first.cellHeight * scale)

  const lines: string[] = []

  if (sheets.length === 1) {
    lines.push(
      `这是一张时间轴拼图：${first.columns} 列 × ${first.rows} 行，共 ${total} 帧，` +
        `**从左到右、从上到下**按时间排列，每格左上角烧着「序号 · 开跑后第几秒」。`
    )
    lines.push(
      `各格时间：${first.used.map((frame, i) => `${i + 1}=${frame.at.toFixed(1)}s`).join(' ')}。`
    )
  } else {
    // 多张时不再逐格列时间：九格一张、四张就是三十六个数，正文会被这串数字淹掉。
    // 每张给起止区间，具体某一格的秒数**画面上烧着**，模型自己看得到
    lines.push(
      `这次是 **${sheets.length} 张**时间轴拼图，按时间先后接着排，一起看才是完整的一段。` +
        `每张都是从左到右、从上到下，每格左上角烧着「序号 · 开跑后第几秒」，` +
        `序号在几张图之间**连着数**（第二张接着第一张往下编）。`
    )
    lines.push(
      sheets
        .map((sheet, index) => {
          const last = sheet.used.length - 1
          return (
            `第 ${index + 1} 张：第 ${sheet.startIndex}–${sheet.startIndex + last} 格，` +
            `${sheet.used[0].at.toFixed(1)}s–${sheet.used[last].at.toFixed(1)}s`
          )
        })
        .join('；') + '。'
    )
  }

  lines.push(
    `单格只有 ${shownW}×${shownH} 像素 —— 能看出东西在哪、动没动、画面黑没黑、` +
      `大件东西在不在；看不清材质细节、小物件和任何文字。` +
      `**看不清就说看不清，别猜**；要看某一格的细节，用 ue_screenshot 重新拍一张。`
  )

  if (missing > 0) {
    lines.push(
      `⚠️ 有 ${missing} 帧没能读回来，不在图里 —— 时间轴是**不完整**的，` +
        `两格之间可能漏掉了事情。`
    )
  }

  return lines.join('\n')
}
