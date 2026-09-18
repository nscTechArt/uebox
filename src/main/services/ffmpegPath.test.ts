import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * FFmpeg 探测。
 *
 * 应用不再随包分发 FFmpeg，这段逻辑就是「功能能不能用」的唯一判据，
 * 判错的两种后果都很难看：漏检 → 明明装了却说没装；误报可用 →
 * 用户点下去拿到一句 ENOENT。
 */

const execCalls: string[] = []
/** 哪些路径「可执行」。其余一律当作执行失败 */
let executable = new Set<string>()

const execFileMock = (
  file: string,
  _args: string[],
  _options: unknown,
  callback: (error: Error | null) => void
): void => {
  execCalls.push(file)
  callback(executable.has(file) ? null : new Error('ENOENT'))
}
// 需要连 default 一起给：被测模块用的是具名导入，但 vitest 会校验整个模块形状
vi.mock('child_process', () => ({
  execFile: execFileMock,
  default: { execFile: execFileMock }
}))

/** 哪些路径「存在」。裸命令名不查这个表，直接交给 PATH */
let existing = new Set<string>()
vi.mock('fs', () => {
  const existsSync = (p: string): boolean => existing.has(p)
  return { existsSync, default: { existsSync } }
})

const { findFFmpeg, isFFmpegAvailable, requireFFmpeg, resetFFmpegCache } = await import(
  './ffmpegPath'
)

const BINARY = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const originalConfigured = process.env.UNREAL_BOX_FFMPEG_PATH

beforeEach(() => {
  execCalls.length = 0
  executable = new Set()
  existing = new Set()
  delete process.env.UNREAL_BOX_FFMPEG_PATH
  resetFFmpegCache()
})

afterEach(() => {
  if (originalConfigured === undefined) delete process.env.UNREAL_BOX_FFMPEG_PATH
  else process.env.UNREAL_BOX_FFMPEG_PATH = originalConfigured
})

describe('findFFmpeg', () => {
  it('PATH 里有就用 PATH 里的', async () => {
    executable.add(BINARY)

    expect(await findFFmpeg()).toBe(BINARY)
    expect(await isFFmpegAvailable()).toBe(true)
  })

  it('用户手动指定的路径优先级最高', async () => {
    const custom = '/opt/my-ffmpeg/ffmpeg'
    process.env.UNREAL_BOX_FFMPEG_PATH = custom
    existing.add(custom)
    executable.add(custom)
    // PATH 里也有，但不该被选中
    executable.add(BINARY)

    expect(await findFFmpeg()).toBe(custom)
  })

  it('都找不到时返回 null，而不是回退成裸命令名', async () => {
    // 回退成 'ffmpeg' 会让调用方以为可用，直到 spawn 时才炸出 ENOENT
    expect(await findFFmpeg()).toBeNull()
    expect(await isFFmpegAvailable()).toBe(false)
  })

  it('文件存在但跑不起来，不算可用', async () => {
    // 架构不符、缺动态库时就是这种情况，所以判据是能不能执行而不是文件在不在
    const custom = '/opt/broken/ffmpeg'
    process.env.UNREAL_BOX_FFMPEG_PATH = custom
    existing.add(custom)

    expect(await findFFmpeg()).toBeNull()
  })

  it('结果会缓存，不会反复起进程', async () => {
    executable.add(BINARY)

    await findFFmpeg()
    await findFFmpeg()
    await findFFmpeg()

    expect(execCalls).toHaveLength(1)
  })

  it('resetFFmpegCache 之后会重新探测 —— 用户装完不必重启应用', async () => {
    expect(await findFFmpeg()).toBeNull()

    executable.add(BINARY)
    resetFFmpegCache()

    expect(await findFFmpeg()).toBe(BINARY)
  })
})

describe('requireFFmpeg', () => {
  it('没装时抛出带安装指引的错误', async () => {
    await expect(requireFFmpeg()).rejects.toThrow(/FFmpeg/)
    await expect(requireFFmpeg()).rejects.toThrow(/winget|brew/)
  })

  it('装了就返回路径', async () => {
    executable.add(BINARY)
    await expect(requireFFmpeg()).resolves.toBe(BINARY)
  })
})
