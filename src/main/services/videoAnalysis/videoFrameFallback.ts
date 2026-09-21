/**
 * 没有视频模型时的退路：把视频抽成帧，拼成联系表，当图片喂给当前对话模型。
 *
 * ## 为什么要这条退路
 *
 * `analyzeLocalVideoFile` 要求用户在 设置 → 模型 里勾了「视频」能力的模型。
 * 没勾就只能返回一句「去哪配」—— 对话模型自己明明看得了图片，却因为拿不到
 * 视频的任何一帧而只能干瞪眼，用户看到的是「盒子说它瞎」。
 *
 * 抽帧不是视频理解的等价物：**没有声音、没有帧间运动**，快切和镜头运动会丢。
 * 所以它只在首选路径不可用时兜底，而且结果里必须写明这是抽帧看的，
 * 免得模型拿着一叠静帧去回答「节奏怎么样」。
 *
 * ## 为什么拼联系表而不是发一叠单帧
 *
 * 一帧一张图，30 秒的片子就是几十个 image block，既烧 token 又挤爆
 * `requestBudget` 的 3MB。拼成网格后模型仍然按时间顺序看得到每一格，
 * 代价只有两三张图。`tools/contextImage.ts` 里的界面截图走的也是这套。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { findFFmpeg } from '../ffmpegPath'

/** 一张联系表放几格。4×6 = 24 格，1080p 竖屏缩到 192 宽仍能看清构图 */
const SHEET_COLUMNS = 4
const SHEET_ROWS = 6
const FRAMES_PER_SHEET = SHEET_COLUMNS * SHEET_ROWS

/**
 * 最多出几张表。
 *
 * 两张 = 48 帧。再多，单条消息里的图片预算就该由视频一个人占满了 ——
 * 长片子宁可抽得稀一点，也不要挤掉用户自己带的图。
 */
const MAX_SHEETS = 2

/** 每格的宽度。高度按原片比例走，竖屏片子不会被压扁 */
const CELL_WIDTH = 240

/** 抽帧的上限时长。超过就按比例稀释，而不是只看开头 */
const MAX_FRAMES = FRAMES_PER_SHEET * MAX_SHEETS

export interface VideoFramesResult {
  success: boolean
  /** 联系表的绝对路径，按时间先后排列。调用方读完自己删 */
  sheetPaths?: string[]
  /** 实际抽了多少帧 */
  frameCount?: number
  /** 抽帧密度，形如 `0.5`（每秒半帧）。写给模型看，好让它知道两格之间隔了多久 */
  fps?: number
  /** 视频时长（秒）。探不出来时缺省 */
  durationSec?: number
  error?: string
}

/** 跑一条 ffmpeg，把 stderr 收回来。ffmpeg 的信息输出一向在 stderr */
function runFFmpeg(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('ffmpeg 超时'))
    }, timeoutMs)

    child.stdout?.on('data', (data) => {
      output += data.toString()
    })
    child.stderr?.on('data', (data) => {
      output += data.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`ffmpeg 启动失败：${error.message}`))
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(output)
    })
  })
}

/**
 * 探时长。
 *
 * 用 `ffmpeg -i` 而不是 ffprobe —— 与 `videoCompressor` 同一个理由：
 * 用户装的那份 ffmpeg 不一定带 ffprobe，而 `-i` 一定在。
 * 它没有输出文件时会以非零码退出，这是正常的，只看 stderr 里的 Duration。
 */
async function probeDurationSec(exe: string, filePath: string): Promise<number | undefined> {
  const output = await runFFmpeg(exe, ['-i', filePath, '-hide_banner'], 30_000).catch(() => '')
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/i)
  if (!match) return undefined
  const seconds =
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    (match[4] ? Number(`0.${match[4]}`) : 0)
  return seconds > 0 ? seconds : undefined
}

/**
 * 把视频抽成联系表。
 *
 * 抽帧密度按时长自适应：短片子密一点（最多 2 帧/秒），长片子稀一点，
 * 总帧数始终压在 {@link MAX_FRAMES} 以内 —— 这样 10 秒的广告和 10 分钟的
 * 录屏进上下文的体积是一样的。
 *
 * @param filePath 视频绝对路径
 */
export async function extractVideoContactSheets(filePath: string): Promise<VideoFramesResult> {
  const exe = await findFFmpeg()
  if (!exe) {
    return {
      success: false,
      error:
        '没有能看视频的模型，也没有 FFmpeg 可以抽帧。二选一：' +
        '到 设置 → 模型 给某个模型勾上「视频」能力，或安装 FFmpeg' +
        '（Windows：winget install Gyan.FFmpeg）。'
    }
  }

  try {
    await fs.access(filePath)
  } catch {
    return { success: false, error: `找不到视频文件：${filePath}` }
  }

  const durationSec = await probeDurationSec(exe, filePath)

  // 探不出时长就按 1 帧/秒抽，靠 -frames:v 卡住总数 —— 宁可只看开头，
  // 也好过因为一个探测失败就整段放弃
  const fps = durationSec ? Math.min(2, Math.max(0.1, MAX_FRAMES / durationSec)) : 1

  const workDir = path.join(tmpdir(), `uebox-frames-${randomUUID()}`)
  await fs.mkdir(workDir, { recursive: true })
  const pattern = path.join(workDir, 'sheet_%d.png')

  try {
    await runFFmpeg(
      exe,
      [
        '-v',
        'error',
        '-i',
        filePath,
        '-vf',
        `fps=${fps},scale=${CELL_WIDTH}:-2,tile=${SHEET_COLUMNS}x${SHEET_ROWS}:margin=4:padding=4`,
        '-frames:v',
        String(MAX_SHEETS),
        pattern
      ],
      180_000
    )

    const produced = (await fs.readdir(workDir))
      .filter((name) => name.endsWith('.png'))
      // sheet_2 要排在 sheet_10 前面，按字典序会错，所以取数字排
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
      .map((name) => path.join(workDir, name))

    if (produced.length === 0) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
      return { success: false, error: '抽帧没有产出任何画面，这个文件可能不是有效的视频' }
    }

    // 最后一张往往没铺满，按满格算会多报。差值不影响模型理解，但别谎报精确值
    const frameCount = produced.length * FRAMES_PER_SHEET

    return {
      success: true,
      sheetPaths: produced,
      frameCount,
      fps,
      ...(durationSec ? { durationSec } : {})
    }
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
    return {
      success: false,
      error: `抽帧失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** 联系表读完就该删。传入 {@link extractVideoContactSheets} 给的任意一条路径即可 */
export async function cleanupContactSheets(sheetPaths: string[]): Promise<void> {
  const dir = sheetPaths[0] ? path.dirname(sheetPaths[0]) : undefined
  if (!dir) return
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

/**
 * 给模型的说明文字。
 *
 * 必须和联系表一起发 —— 模型拿到一张网格图，如果不知道这是「一段视频按
 * 时间顺序抽的帧」，很可能当成一堆无关截图去解读。
 */
export function describeContactSheets(result: VideoFramesResult, fileName: string): string {
  const interval = result.fps ? (1 / result.fps).toFixed(1) : '约 1'
  const duration = result.durationSec ? `${result.durationSec.toFixed(1)} 秒` : '未知时长'
  return [
    `【视频 ${fileName}】没有配置能看视频的模型，改为抽帧给你看。`,
    `时长 ${duration}，按每 ${interval} 秒一帧抽出，拼成 ${result.sheetPaths?.length ?? 0} 张联系表，`,
    `每张按**从左到右、从上到下**的顺序排列时间。`,
    '',
    '注意这不是在看视频：**没有声音，也看不到帧与帧之间的运动**。',
    '快速剪辑、镜头运动、转场细节都可能丢在两帧之间。',
    '涉及节奏、音效、运镜的判断请说明这是基于静帧的推测，不要当成看过原片。'
  ].join('\n')
}
