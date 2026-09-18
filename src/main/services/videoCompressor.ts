/**
 * 视频压缩服务
 * 使用 FFmpeg 双遍编码将视频压缩到指定大小以下（默认100MB）
 *
 * 核心策略：
 * 1. 安全余量：目标设定为 95MB，防止元数据溢出
 * 2. 音频优化：使用 AAC 96k 单声道，AI 听写/语音识别完全足够
 * 3. 双遍编码：精确控制体积的唯一"绝对"方法
 * 4. 降低帧率 (fps=15)：同样 100MB，15fps 画面清晰，60fps 全是马赛克
 * 5. 降低分辨率 (scale=1280:-2)：720p 是多模态大模型的推荐分辨率
 */

import { promises as fs } from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { app } from 'electron'
import { requireFFmpeg } from './ffmpegPath'

// FFmpeg 相关

/**
 * 压缩配置接口
 */
export interface CompressOptions {
  /** 目标文件大小 (MB)，默认 70MB（Base64 膨胀后约 93MB，确保不超 100MB 限制） */
  targetSizeMB?: number
  /** 目标帧率，默认 15fps */
  fps?: number
  /** 目标宽度，默认 1280 (720p) */
  width?: number
  /** 音频比特率 (kbps)，默认 96 */
  audioBitrate?: number
  /** 是否使用单声道，默认 true */
  monoAudio?: boolean
  /** CRF 最大值（质量下限），默认 32 */
  crfMax?: number
  /** 进度回调 */
  onProgress?: (progress: CompressProgress) => void
}

/**
 * 压缩进度信息
 */
export interface CompressProgress {
  /** 当前阶段：'probe' | 'pass1' | 'pass2' | 'done' */
  stage: 'probe' | 'pass1' | 'pass2' | 'done'
  /** 百分比进度 (0-100) */
  percent: number
  /** 当前处理时间 (秒) */
  currentTime?: number
  /** 总时长 (秒) */
  totalDuration?: number
}

/**
 * 压缩结果接口
 */
export interface CompressResult {
  success: boolean
  /** 输出文件路径 */
  outputPath?: string
  /** 输出文件大小 (bytes) */
  outputSize?: number
  /** 输出文件大小 (MB) */
  outputSizeMB?: number
  /** 原始文件大小 (bytes) */
  originalSize?: number
  /** 压缩率 */
  compressionRatio?: number
  /** 错误信息 */
  error?: string
}

/**
 * 视频元数据接口
 */
interface VideoMetadata {
  duration: number // 秒
  width: number
  height: number
  fps: number
  bitrate: number // kbps
  hasAudio: boolean
}

/**
 * 获取 FFmpeg 可执行文件路径
 */

/**
 * 执行 FFmpeg 命令并获取输出
 */
function execFFmpeg(args: string[], onProgress?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    requireFFmpeg().then((ffmpegExe) => {
      const process = spawn(ffmpegExe, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''

      process.stdout?.on('data', (data) => {
        stdout += data.toString()
      })

      process.stderr?.on('data', (data) => {
        const line = data.toString()
        stderr += line
        if (onProgress) {
          onProgress(line)
        }
      })

      process.on('close', (code) => {
        if (code === 0) {
          resolve(stdout || stderr)
        } else {
          reject(new Error(`FFmpeg 退出码 ${code}: ${stderr.slice(-500)}`))
        }
      })

      process.on('error', (err) => {
        reject(new Error(`FFmpeg 启动失败: ${err.message}`))
      })
    })
  })
}

/**
 * 获取视频元数据
 * 使用 ffmpeg -i 命令获取视频信息（ffprobe 可能不存在）
 */
async function probeVideo(inputPath: string): Promise<VideoMetadata> {
  const ffmpegExe = await requireFFmpeg()

  return new Promise((resolve, reject) => {
    // 使用 ffmpeg -i 获取视频信息（会输出到 stderr 并返回错误码 1）
    const args = ['-i', inputPath, '-hide_banner']

    console.log('[VideoCompressor] 正在获取视频信息...')

    const ffmpeg = spawn(ffmpegExe, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let output = ''

    // ffmpeg 的信息输出到 stderr
    ffmpeg.stderr?.on('data', (data) => {
      output += data.toString()
    })

    ffmpeg.stdout?.on('data', (data) => {
      output += data.toString()
    })

    ffmpeg.on('close', () => {
      // ffmpeg -i 会返回错误码 1（因为没有输出文件），这是正常的
      console.log('[VideoCompressor] FFmpeg 输出长度:', output.length)

      try {
        // 解析 Duration: HH:MM:SS.ms 或 Duration: HH:MM:SS
        let duration = 0
        const durationPatterns = [
          /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/i,
          /Duration:\s*(\d+):(\d+):(\d+)/i
        ]
        for (const pattern of durationPatterns) {
          const match = output.match(pattern)
          if (match) {
            duration =
              parseInt(match[1]) * 3600 +
              parseInt(match[2]) * 60 +
              parseInt(match[3]) +
              (match[4] ? parseInt(match[4]) / 100 : 0)
            console.log('[VideoCompressor] 解析时长:', duration, '秒')
            break
          }
        }

        // 解析分辨率: 多种可能的格式
        let width = 1920
        let height = 1080
        const resolutionPatterns = [
          /,\s*(\d{3,4})x(\d{3,4})[\s,\[]/,
          /Video:.*?(\d{3,4})x(\d{3,4})/i,
          /(\d{3,4})x(\d{3,4})\s*\[/
        ]
        for (const pattern of resolutionPatterns) {
          const match = output.match(pattern)
          if (match) {
            width = parseInt(match[1])
            height = parseInt(match[2])
            console.log('[VideoCompressor] 解析分辨率:', width, 'x', height)
            break
          }
        }

        // 解析帧率: XX fps 或 XX.XX fps
        let fps = 30
        const fpsPatterns = [
          /,\s*(\d+(?:\.\d+)?)\s*fps/i,
          /(\d+(?:\.\d+)?)\s*fps,/i,
          /(\d+(?:\.\d+)?)\s*tbr/i
        ]
        for (const pattern of fpsPatterns) {
          const match = output.match(pattern)
          if (match) {
            fps = parseFloat(match[1])
            console.log('[VideoCompressor] 解析帧率:', fps, 'fps')
            break
          }
        }

        // 解析比特率: XXX kb/s
        let bitrate = 0
        const bitrateMatch = output.match(/bitrate:\s*(\d+)\s*kb\/s/i)
        if (bitrateMatch) {
          bitrate = parseInt(bitrateMatch[1])
          console.log('[VideoCompressor] 解析比特率:', bitrate, 'kb/s')
        }

        // 检测是否有音频流
        const hasAudio = /Audio:/i.test(output) || /Stream.*audio/i.test(output)
        console.log('[VideoCompressor] 检测音频:', hasAudio)

        // 验证关键信息是否解析成功
        if (duration === 0) {
          console.error('[VideoCompressor] 无法解析视频时长，输出:', output.slice(0, 500))
          reject(new Error('无法解析视频时长'))
          return
        }

        if (width === 1920 && height === 1080 && !output.includes('1920x1080')) {
          console.warn('[VideoCompressor] 使用默认分辨率 1920x1080（可能未正确解析）')
        }

        resolve({
          duration,
          width,
          height,
          fps,
          bitrate,
          hasAudio
        })
      } catch (e) {
        console.error('[VideoCompressor] 解析视频信息失败:', e)
        console.error('[VideoCompressor] FFmpeg 输出:', output.slice(0, 1000))
        reject(new Error(`解析视频信息失败: ${e}`))
      }
    })

    ffmpeg.on('error', (err) => {
      console.error('[VideoCompressor] FFmpeg 启动失败:', err)
      reject(new Error(`FFmpeg 启动失败: ${err.message}`))
    })
  })
}

/**
 * 解析 FFmpeg 进度输出
 */
function parseProgress(line: string, totalDuration: number): number | null {
  // FFmpeg 进度格式: time=00:01:23.45
  const match = line.match(/time=(\d+):(\d+):(\d+)\.(\d+)/)
  if (match) {
    const currentTime =
      parseInt(match[1]) * 3600 +
      parseInt(match[2]) * 60 +
      parseInt(match[3]) +
      parseInt(match[4]) / 100
    return Math.min(100, (currentTime / totalDuration) * 100)
  }
  return null
}

/**
 * 压缩视频到指定大小以下
 *
 * @param inputPath - 输入视频路径
 * @param outputPath - 输出视频路径（可选，默认在输入文件同目录生成）
 * @param options - 压缩配置
 * @returns 压缩结果
 */
export async function compressVideo(
  inputPath: string,
  outputPath?: string,
  options: CompressOptions = {}
): Promise<CompressResult> {
  const {
    targetSizeMB = 70, // Base64 编码膨胀 ~33%，70MB -> 约 93MB，确保不超限
    fps = 15,
    width = 1280,
    audioBitrate = 96,
    monoAudio = true,
    crfMax = 32,
    onProgress
  } = options

  try {
    // 检查输入文件
    const inputStats = await fs.stat(inputPath)
    const inputSizeMB = inputStats.size / (1024 * 1024)

    console.log(`[VideoCompressor] 开始压缩: ${inputPath}`)
    console.log(`[VideoCompressor] 原始大小: ${inputSizeMB.toFixed(2)} MB`)

    // 如果文件已经小于目标大小，直接返回
    if (inputSizeMB <= targetSizeMB) {
      console.log(`[VideoCompressor] 文件已小于目标大小，无需压缩`)
      return {
        success: true,
        outputPath: inputPath,
        outputSize: inputStats.size,
        outputSizeMB: inputSizeMB,
        originalSize: inputStats.size,
        compressionRatio: 1
      }
    }

    // 获取视频信息
    onProgress?.({ stage: 'probe', percent: 0 })
    const metadata = await probeVideo(inputPath)
    console.log(`[VideoCompressor] 视频信息:`, metadata)

    // 计算目标比特率
    // 目标大小 (bytes) = (视频比特率 + 音频比特率) * 时长 / 8
    // 视频比特率 = (目标大小 * 8 / 时长) - 音频比特率
    const targetSizeBytes = targetSizeMB * 1024 * 1024
    const totalBitrate = (targetSizeBytes * 8) / metadata.duration / 1000 // kbps
    const videoBitrate = Math.max(100, Math.floor(totalBitrate - audioBitrate - 10)) // 额外留 10kbps 余量

    console.log(`[VideoCompressor] 目标视频比特率: ${videoBitrate} kbps`)

    // 生成输出路径
    if (!outputPath) {
      const dir = path.dirname(inputPath)
      const ext = path.extname(inputPath)
      const name = path.basename(inputPath, ext)
      outputPath = path.join(dir, `${name}_compressed.mp4`)
    }

    // 确保输出目录存在
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    // 临时文件用于双遍编码
    const tempDir = path.join(app.getPath('temp'), 'video-compress')
    await fs.mkdir(tempDir, { recursive: true })
    const passLogFile = path.join(tempDir, `ffmpeg2pass-${Date.now()}`)

    const ffmpegExe = await requireFFmpeg()

    // 调试日志：打印关键路径
    console.log('[VideoCompressor] FFmpeg 路径:', ffmpegExe)
    console.log('[VideoCompressor] 临时目录:', tempDir)
    console.log('[VideoCompressor] passLogFile:', passLogFile)
    console.log('[VideoCompressor] 输入文件:', inputPath)
    console.log('[VideoCompressor] 输出文件:', outputPath)

    // 视频滤镜：缩放 + 降帧率
    const videoFilter = `scale=${width}:-2,fps=${fps}`

    // 音频参数
    const audioParams = metadata.hasAudio
      ? ['-c:a', 'aac', '-b:a', `${audioBitrate}k`, '-ac', monoAudio ? '1' : '2']
      : ['-an']

    // ===== 第一遍：分析 =====
    console.log(`[VideoCompressor] 开始第一遍编码...`)
    onProgress?.({ stage: 'pass1', percent: 0, totalDuration: metadata.duration })

    const pass1Args = [
      '-y',
      '-i',
      inputPath,
      '-vf',
      videoFilter,
      '-c:v',
      'libx264',
      '-b:v',
      `${videoBitrate}k`,
      '-crf',
      crfMax.toString(),
      '-preset',
      'veryfast',
      '-pass',
      '1',
      '-passlogfile',
      passLogFile,
      '-an', // 第一遍不需要音频
      '-f',
      'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null'
    ]

    await new Promise<void>((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpegExe, pass1Args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tempDir // 使用临时目录作为工作目录
      })

      ffmpegProcess.stderr?.on('data', (data) => {
        const line = data.toString()
        const percent = parseProgress(line, metadata.duration)
        if (percent !== null) {
          onProgress?.({
            stage: 'pass1',
            percent: percent,
            currentTime: (percent / 100) * metadata.duration,
            totalDuration: metadata.duration
          })
        }
      })

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`第一遍编码失败，退出码: ${code}`))
        }
      })

      ffmpegProcess.on('error', reject)
    })

    // 等待文件系统同步，确保 passlog 文件完全释放（Windows 文件锁问题）
    await new Promise((resolve) => setTimeout(resolve, 500))

    // ===== 第二遍：实际编码 =====
    console.log(`[VideoCompressor] 开始第二遍编码...`)
    onProgress?.({ stage: 'pass2', percent: 0, totalDuration: metadata.duration })

    const pass2Args = [
      '-y',
      '-i',
      inputPath,
      '-vf',
      videoFilter,
      '-c:v',
      'libx264',
      '-b:v',
      `${videoBitrate}k`,
      '-crf',
      crfMax.toString(),
      '-preset',
      'veryfast',
      '-pass',
      '2',
      '-passlogfile',
      passLogFile,
      ...audioParams,
      '-movflags',
      '+faststart', // 优化网络播放
      outputPath
    ]

    await new Promise<void>((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpegExe, pass2Args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tempDir // 使用临时目录作为工作目录
      })
      let stderrOutput = '' // 捕获完整的 stderr 输出

      ffmpegProcess.stderr?.on('data', (data) => {
        const line = data.toString()
        stderrOutput += line
        const percent = parseProgress(line, metadata.duration)
        if (percent !== null) {
          onProgress?.({
            stage: 'pass2',
            percent: percent,
            currentTime: (percent / 100) * metadata.duration,
            totalDuration: metadata.duration
          })
        }
      })

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          console.error('[VideoCompressor] 第二遍编码失败，stderr:', stderrOutput.slice(-1000))
          reject(new Error(`第二遍编码失败，退出码: ${code}`))
        }
      })

      ffmpegProcess.on('error', (err) => {
        console.error('[VideoCompressor] 第二遍进程错误:', err)
        reject(err)
      })
    })

    // 清理临时文件
    try {
      const tempFiles = await fs.readdir(tempDir)
      for (const file of tempFiles) {
        if (file.startsWith('ffmpeg2pass')) {
          await fs.unlink(path.join(tempDir, file)).catch(() => {})
        }
      }
    } catch {
      // 忽略清理错误
    }

    // 检查输出文件大小
    const outputStats = await fs.stat(outputPath)
    const outputSizeMB = outputStats.size / (1024 * 1024)

    console.log(`[VideoCompressor] 压缩完成: ${outputSizeMB.toFixed(2)} MB`)
    console.log(
      `[VideoCompressor] 压缩率: ${((1 - outputStats.size / inputStats.size) * 100).toFixed(1)}%`
    )

    onProgress?.({ stage: 'done', percent: 100 })

    // 如果压缩后仍然超过目标大小，输出警告
    if (outputSizeMB > targetSizeMB + 5) {
      console.warn(
        `[VideoCompressor] 警告：压缩后仍超过目标大小 (${outputSizeMB.toFixed(2)} MB > ${targetSizeMB} MB)`
      )
    }

    return {
      success: true,
      outputPath,
      outputSize: outputStats.size,
      outputSizeMB,
      originalSize: inputStats.size,
      compressionRatio: outputStats.size / inputStats.size
    }
  } catch (error) {
    console.error('[VideoCompressor] 压缩失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 快速压缩（单遍，速度更快但大小控制不精确）
 * 适用于不需要严格控制大小的场景
 */
export async function compressVideoFast(
  inputPath: string,
  outputPath?: string,
  options: Omit<CompressOptions, 'onProgress'> = {}
): Promise<CompressResult> {
  const {
    targetSizeMB = 70,
    fps = 15,
    width = 1280,
    audioBitrate = 96,
    monoAudio = true,
    crfMax = 32
  } = options

  try {
    const inputStats = await fs.stat(inputPath)
    const inputSizeMB = inputStats.size / (1024 * 1024)

    if (inputSizeMB <= targetSizeMB) {
      return {
        success: true,
        outputPath: inputPath,
        outputSize: inputStats.size,
        outputSizeMB: inputSizeMB,
        originalSize: inputStats.size,
        compressionRatio: 1
      }
    }

    if (!outputPath) {
      const dir = path.dirname(inputPath)
      const ext = path.extname(inputPath)
      const name = path.basename(inputPath, ext)
      outputPath = path.join(dir, `${name}_compressed.mp4`)
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    const metadata = await probeVideo(inputPath)
    const targetSizeBytes = targetSizeMB * 1024 * 1024
    const totalBitrate = (targetSizeBytes * 8) / metadata.duration / 1000
    const videoBitrate = Math.max(100, Math.floor(totalBitrate - audioBitrate - 10))

    const videoFilter = `scale=${width}:-2,fps=${fps}`
    const audioParams = metadata.hasAudio
      ? ['-c:a', 'aac', '-b:a', `${audioBitrate}k`, '-ac', monoAudio ? '1' : '2']
      : ['-an']

    // 单遍编码
    const args = [
      '-y',
      '-i',
      inputPath,
      '-vf',
      videoFilter,
      '-c:v',
      'libx264',
      '-crf',
      crfMax.toString(),
      '-maxrate',
      `${videoBitrate}k`,
      '-bufsize',
      `${videoBitrate * 2}k`,
      '-preset',
      'veryfast',
      ...audioParams,
      '-movflags',
      '+faststart',
      outputPath
    ]

    await execFFmpeg(args)

    const outputStats = await fs.stat(outputPath)

    return {
      success: true,
      outputPath,
      outputSize: outputStats.size,
      outputSizeMB: outputStats.size / (1024 * 1024),
      originalSize: inputStats.size,
      compressionRatio: outputStats.size / inputStats.size
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export default {
  compressVideo,
  compressVideoFast
}
