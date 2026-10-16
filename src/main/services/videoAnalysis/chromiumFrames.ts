/**
 * 用盒子自带的 Chromium 解码视频、抽帧拼联系表。
 *
 * ## 为什么不只靠 FFmpeg
 *
 * FFmpeg 不随包分发（GPL，见 `ffmpegPath.ts`），大多数用户机器上没有。
 * 以前视频模型一看不成，agent 就只能自己去 shell 里找 ffmpeg —— 真机上落进了 WSL，
 * 找不到、输出还是乱码，最后反过来请用户「补几张关键帧截图」。
 *
 * 盒子本身就是 Chromium，MP4（H.264）/ WebM / MOV 这些常见格式它解得开，
 * 素材库的视频缩略图走的也是这条。所以先用它抽帧，解不开的格式（AVI、部分 HEVC）
 * 再交给用户装的 FFmpeg。
 *
 * ## 怎么做的
 *
 * 开一个不显示、静音的窗口，用一个独立会话：它只认两个地址 —— 一张空白页和这一段视频，
 * 别的文件、网络一概拿不到。两者同源，视频画到 canvas 上不会被污染。
 * （直接导航到视频地址让 Chromium 出媒体页的做法在 Electron 里会报 ERR_FAILED，试过。）
 * 逐个时间点 seek、画进网格，每格左下角标上时间，模型说「0:12 那一帧」用户对得上。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { serveLocalFile } from '../../utils/localResourceServer'
import type { VideoFramesResult } from './videoFrameFallback'

/** 独立会话里的两个地址。scheme 借用已注册为特权协议的 local-resource，canvas 才能读像素 */
const ORIGIN = 'local-resource://video-frames'
const PAGE_HTML =
  '<!doctype html><meta charset="utf-8"><video src="/video" muted preload="auto"></video>'

/** 与 FFmpeg 那条同一套网格：4×6 一张，最多两张 */
const COLUMNS = 4
const ROWS = 6
const MAX_SHEETS = 2
const MAX_FRAMES = COLUMNS * ROWS * MAX_SHEETS
/** 4 × 288 = 1152，正好是 `CONTACT_SHEET_MAX_WIDTH`，压缩时不用再缩 */
const CELL_WIDTH = 288
/** 短片子最密每秒两帧，再密只是重复画面 */
const MAX_FPS = 2

/** 整段抽帧的上限。解码器卡死时（不支持的编码常见）不能让 agent 一直等 */
const TOTAL_TIMEOUT_MS = 120_000

/** 抽哪几个时间点：均匀取每段的中点，避开片头片尾的黑场 */
export function frameTimes(durationSec: number): number[] {
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(durationSec * MAX_FPS)))
  return Array.from({ length: count }, (_, i) => ((i + 0.5) * durationSec) / count)
}

/**
 * 在媒体页里跑的那段脚本。返回每张联系表的 JPEG data URL。
 * 写成字符串是因为它跑在另一个页面里，拿不到这个模块的任何东西。
 */
function pageScript(times: number[]): string {
  return `(async () => {
    const times = ${JSON.stringify(times)}
    const columns = ${COLUMNS}, rows = ${ROWS}, cellWidth = ${CELL_WIDTH}
    const video = document.querySelector('video')
    if (!video) throw new Error('这个文件不是浏览器能打开的视频')
    video.pause()
    video.muted = true
    const once = (name, ms) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('解码超时')), ms)
      video.addEventListener(name, () => { clearTimeout(timer); resolve() }, { once: true })
      video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('解不开这个视频的编码')) }, { once: true })
    })
    if (video.readyState < 2) await once('loadeddata', 20000)
    if (!video.videoWidth) throw new Error('这个文件没有画面')
    const cellHeight = Math.round(cellWidth * video.videoHeight / video.videoWidth)
    const perSheet = columns * rows
    const label = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0')
    const sheets = []
    for (let start = 0; start < times.length; start += perSheet) {
      const batch = times.slice(start, start + perSheet)
      const usedRows = Math.ceil(batch.length / columns)
      const canvas = document.createElement('canvas')
      canvas.width = columns * cellWidth
      canvas.height = usedRows * cellHeight
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < batch.length; i++) {
        video.currentTime = batch[i]
        await once('seeked', 10000)
        const x = (i % columns) * cellWidth, y = Math.floor(i / columns) * cellHeight
        ctx.drawImage(video, x, y, cellWidth, cellHeight)
        ctx.strokeStyle = '#000'
        ctx.strokeRect(x, y, cellWidth, cellHeight)
        const text = label(batch[i])
        ctx.font = 'bold 15px sans-serif'
        const w = ctx.measureText(text).width + 10
        ctx.fillStyle = 'rgba(0,0,0,0.7)'
        ctx.fillRect(x + 4, y + cellHeight - 24, w, 20)
        ctx.fillStyle = '#fff'
        ctx.fillText(text, x + 9, y + cellHeight - 9)
      }
      sheets.push(canvas.toDataURL('image/jpeg', 0.9))
    }
    return { duration: video.duration, sheets }
  })()`
}

/**
 * 用 Chromium 把视频抽成联系表，落到临时目录。返回形状与 FFmpeg 那条一致，
 * 调用方读完用 `cleanupContactSheets` 删。
 */
export async function chromiumContactSheets(filePath: string): Promise<VideoFramesResult> {
  const { BrowserWindow, session } = await import('electron')
  const isolated = session.fromPartition(`video-frames-${randomUUID()}`, { cache: false })
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${ORIGIN}/`) })
  })
  isolated.protocol.handle('local-resource', async (request) =>
    new URL(request.url).pathname === '/video'
      ? serveLocalFile(filePath, request.headers.get('range'))
      : new Response(PAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  )
  const window = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏窗口默认会被节流，seek 回调会慢到超时
      backgroundThrottling: false
    }
  })
  // 页面里的 <video> 已经静音，这里再兜一层：窗口不显示也照样能出声
  window.webContents.setAudioMuted(true)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  let timer: NodeJS.Timeout | undefined
  try {
    const work = (async () => {
      await window.loadURL(`${ORIGIN}/`)
      // 先探时长，再按时长定抽哪几帧
      const duration = Number(
        await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const video = document.querySelector('video')
          if (!video) return reject(new Error('这个文件不是浏览器能打开的视频'))
          video.pause()
          // 坏文件在脚本跑起来之前就已经报错了，事件不会再来一次
          if (video.error) return reject(new Error('解不开这个视频的编码'))
          if (video.readyState >= 1) return resolve(video.duration)
          video.addEventListener('loadedmetadata', () => resolve(video.duration), { once: true })
          video.addEventListener('error', () => reject(new Error('解不开这个视频的编码')), { once: true })
          setTimeout(() => reject(new Error('读不出视频时长')), 20000)
        })`)
      )
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('读不出视频时长')
      const times = frameTimes(duration)
      const result = (await window.webContents.executeJavaScript(pageScript(times))) as {
        sheets: string[]
      }
      return { duration, times, sheets: result.sheets }
    })()
    // 超时先到时，窗口一销毁 work 也会失败 —— 那一下没人等，别让它成为未处理的拒绝
    work.catch(() => {})
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('抽帧超时')), TOTAL_TIMEOUT_MS)
    })
    const { duration, times, sheets } = await Promise.race([work, timeout])
    if (sheets.length === 0) throw new Error('没有抽出任何画面')

    const workDir = path.join(tmpdir(), `uebox-frames-${randomUUID()}`)
    await fs.mkdir(workDir, { recursive: true })
    const sheetPaths: string[] = []
    for (const [index, dataUrl] of sheets.entries()) {
      const target = path.join(workDir, `sheet_${index + 1}.jpg`)
      await fs.writeFile(target, Buffer.from(dataUrl.replace(/^data:[^,]+,/, ''), 'base64'))
      sheetPaths.push(target)
    }
    return {
      success: true,
      sheetPaths,
      frameCount: times.length,
      fps: times.length / duration,
      durationSec: duration,
      labeled: true
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    if (!window.isDestroyed()) window.destroy()
  }
}
