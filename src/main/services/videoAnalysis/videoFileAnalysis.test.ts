/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 这一组守的是「读盘这一段别把后端能力吃掉」：
 * 没配模型要说清去哪配、压缩产物读完必须删、原片一根手指都不许动。
 */

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  findConfiguredVideoModel: vi.fn(),
  analyzeVideoWithConfiguredModel: vi.fn(),
  compressVideoFast: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn()
}))

vi.mock('fs', () => ({
  promises: { stat: mocks.stat, readFile: mocks.readFile, unlink: mocks.unlink }
}))
vi.mock('../../ai/store', () => ({ readSettings: mocks.readSettings }))
vi.mock('./configuredVideoAnalysis', () => ({
  findConfiguredVideoModel: mocks.findConfiguredVideoModel,
  analyzeVideoWithConfiguredModel: mocks.analyzeVideoWithConfiguredModel
}))
vi.mock('../videoCompressor', () => ({ compressVideoFast: mocks.compressVideoFast }))

const { analyzeLocalVideoFile, NO_VIDEO_MODEL_HINT } = await import('./videoFileAnalysis')

const MB = 1024 * 1024

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readSettings.mockResolvedValue({ version: 3, providers: [], roles: {} })
  mocks.findConfiguredVideoModel.mockReturnValue({
    provider: { displayName: '阿里云百炼' },
    model: { id: 'qwen3.8-max' }
  })
  mocks.stat.mockResolvedValue({ size: 8 * MB })
  mocks.readFile.mockResolvedValue(Buffer.from('video-bytes'))
  mocks.analyzeVideoWithConfiguredModel.mockResolvedValue({ success: true, markdown: '一个人走过' })
  mocks.unlink.mockResolvedValue(undefined)
})

describe('看一段本地视频', () => {
  it('把文件读成 base64 发出去，并说清是谁看的', async () => {
    const result = await analyzeLocalVideoFile({ filePath: 'C:/vault/AIGC/视频/a.mp4' })

    expect(result).toEqual({
      success: true,
      model: '阿里云百炼:qwen3.8-max',
      markdown: '一个人走过'
    })
    expect(mocks.analyzeVideoWithConfiguredModel.mock.calls[0][0]).toMatchObject({
      data: Buffer.from('video-bytes').toString('base64'),
      mimeType: 'video/mp4'
    })
  })

  it('问题原样带下去 —— 问得具体才有用', async () => {
    await analyzeLocalVideoFile({ filePath: 'C:/a.mov', prompt: '镜头是怎么运动的' })

    expect(mocks.analyzeVideoWithConfiguredModel.mock.calls[0][0]).toMatchObject({
      prompt: '镜头是怎么运动的',
      mimeType: 'video/quicktime'
    })
  })

  /** 「不可用」三个字帮不了任何人，要说去哪勾 */
  it('没配视频模型时给出去哪配，且一个字节都不读', async () => {
    mocks.findConfiguredVideoModel.mockReturnValue(null)

    const result = await analyzeLocalVideoFile({ filePath: 'C:/a.mp4' })

    expect(result.success).toBe(false)
    expect(result.error).toBe(NO_VIDEO_MODEL_HINT)
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it('文件不在就直说，不去发一个空请求', async () => {
    mocks.stat.mockRejectedValue(new Error('ENOENT'))

    const result = await analyzeLocalVideoFile({ filePath: 'C:/missing.mp4' })

    expect(result.error).toContain('C:/missing.mp4')
    expect(mocks.analyzeVideoWithConfiguredModel).not.toHaveBeenCalled()
  })

  it('不是视频文件的路径当场拦掉', async () => {
    const result = await analyzeLocalVideoFile({ filePath: 'C:/a.png' })

    expect(result.success).toBe(false)
    expect(mocks.stat).not.toHaveBeenCalled()
  })
})

describe('太大的先压一遍', () => {
  beforeEach(() => {
    mocks.stat.mockResolvedValue({ size: 220 * MB })
    mocks.compressVideoFast.mockResolvedValue({
      success: true,
      outputPath: 'C:/temp/a-compressed.mp4'
    })
  })

  it('读的是压缩产物，删的也是它 —— 素材库里那份原片不动', async () => {
    const result = await analyzeLocalVideoFile({ filePath: 'C:/vault/big.mp4' })

    expect(result.compressed).toBe(true)
    expect(mocks.readFile).toHaveBeenCalledWith('C:/temp/a-compressed.mp4')
    expect(mocks.unlink).toHaveBeenCalledWith('C:/temp/a-compressed.mp4')
    expect(mocks.unlink).not.toHaveBeenCalledWith('C:/vault/big.mp4')
  })

  it('分析失败也要把临时文件收干净', async () => {
    mocks.analyzeVideoWithConfiguredModel.mockResolvedValue({ success: false, error: '厂商 429' })

    const result = await analyzeLocalVideoFile({ filePath: 'C:/vault/big.mp4' })

    expect(result.success).toBe(false)
    expect(mocks.unlink).toHaveBeenCalledWith('C:/temp/a-compressed.mp4')
  })

  it('压不下来就如实说，不硬发一个必然超限的请求', async () => {
    mocks.compressVideoFast.mockResolvedValue({ success: false, error: '找不到 ffmpeg' })

    const result = await analyzeLocalVideoFile({ filePath: 'C:/vault/big.mp4' })

    expect(result.error).toContain('找不到 ffmpeg')
    expect(mocks.analyzeVideoWithConfiguredModel).not.toHaveBeenCalled()
  })
})
