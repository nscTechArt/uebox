/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 这一组守的是「看过和没看过要分得清」：
 * 看成了要把描述原样交出去，没配模型要报错而不是编一段画面。
 */

const analyzeVideoSource = vi.fn()

vi.mock('../../../services/videoAnalysis/videoSourceAnalysis', () => ({
  analyzeVideoSource: (...args: unknown[]) => analyzeVideoSource(...args)
}))

const cleanupContactSheets = vi.fn()
vi.mock('../../../services/videoAnalysis/videoFrameFallback', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cleanupContactSheets: (...args: unknown[]) => cleanupContactSheets(...args)
}))

vi.mock('../../../services/videoAnalysis/videoFileAnalysis', () => ({
  NO_VIDEO_MODEL_HINT: 'no-video-model-hint'
}))

vi.mock('../contextImage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  compressForContext: async () => ({ data: 'c2hlZXQ=', mimeType: 'image/jpeg' })
}))

import { createAnalyzeVideoTool } from './analyzeVideo'

const tool = createAnalyzeVideoTool()

const run = async (args: Record<string, unknown>): Promise<unknown> => tool.execute('c1', args)

const textOf = (result: unknown): string =>
  (result as { content: { type: string; text?: string }[] }).content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')

const detailsOf = (result: unknown): Record<string, unknown> =>
  (result as { details: Record<string, unknown> }).details

beforeEach(() => {
  vi.clearAllMocks()
  analyzeVideoSource.mockResolvedValue({
    success: true,
    model: '阿里云百炼:qwen3.8-max',
    markdown: '红衣女子立于光下，镜头缓慢前推。'
  })
})

describe('看视频', () => {
  it('把描述原样交出去，并说清是哪个模型看的', async () => {
    const result = await run({ video_path: 'C:/vault/AIGC/视频/烛影临渊.mp4' })

    expect(textOf(result)).toContain('红衣女子立于光下')
    expect(textOf(result)).toContain('阿里云百炼:qwen3.8-max')
    expect(detailsOf(result).video_path).toBe('C:/vault/AIGC/视频/烛影临渊.mp4')
  })

  it('问题传下去', async () => {
    await run({ video_path: 'C:/a.mp4', question: '节奏会不会太慢' })

    expect(analyzeVideoSource.mock.calls[0][0]).toMatchObject({
      source: 'C:/a.mp4',
      prompt: '节奏会不会太慢'
    })
  })

  /** defineTool 把 isError 的结果抛出去，所以这里断言 rejects */
  it('没配视频模型时报错，不给一段看起来像看过的描述', async () => {
    analyzeVideoSource.mockResolvedValue({
      success: false,
      error: '没有能看视频的模型。请到 偏好设置 → AI …'
    })

    await expect(run({ video_path: 'C:/a.mp4' })).rejects.toThrow(/没有能看视频的模型/)
  })

  /** 压过的片子画质不是原片，拿它评画质会误导 */
  it('压缩过要说出来', async () => {
    analyzeVideoSource.mockResolvedValue({
      success: true,
      model: 'x:y',
      markdown: '一段风景',
      compressed: true
    })

    const result = await run({ video_path: 'C:/big.mp4' })

    expect(textOf(result)).toContain('压缩')
    expect(detailsOf(result).compressed).toBe(true)
  })
})

it('接受 B 站链接并传给公共入口', async () => {
  await run({ video_path: 'https://www.bilibili.com/video/BV1example?p=2', question: '总结' })
  expect(analyzeVideoSource).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'https://www.bilibili.com/video/BV1example?p=2',
      prompt: '总结'
    })
  )
})

/**
 * 真机反馈：视频模型没看成，agent 自己去 shell 抽帧落进 WSL，最后请用户补截图。
 * 这一组守的是：看不成时工具自己交回关键帧，并如实说明这是静帧。
 */
describe('视频模型看不成时改看关键帧', () => {
  const withSheet = async (fn: (sheet: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'uebox-sheet-test-'))
    const sheet = path.join(dir, 'sheet_1.jpg')
    await fs.writeFile(sheet, 'jpg')
    try {
      await fn(sheet)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  it('要求抽帧兜底', async () => {
    await run({ video_path: 'C:/a.mp4' })
    expect(analyzeVideoSource.mock.calls[0][0]).toMatchObject({ framesFallback: true })
  })

  it('联系表作为图片交回去，说清没看成的原因和静帧的局限，读完就删', async () => {
    await withSheet(async (sheet) => {
      analyzeVideoSource.mockResolvedValue({
        success: true,
        model: 'x:y',
        error: 'HTTP 400: video_url not supported',
        frames: {
          success: true,
          sheetPaths: [sheet],
          frameCount: 20,
          fps: 2,
          durationSec: 10,
          labeled: true
        }
      })

      const result = (await run({ video_path: 'C:/雨天参考.mp4' })) as {
        content: { type: string }[]
      }

      expect(result.content.filter((part) => part.type === 'image')).toHaveLength(1)
      const text = textOf(result)
      expect(text).toContain('雨天参考.mp4')
      expect(text).toContain('video_url not supported')
      expect(text).toContain('没有声音')
      expect(text).toContain('左下角标着')
      expect(detailsOf(result).frames).toBe(true)
      expect(cleanupContactSheets).toHaveBeenCalledWith([sheet])
    })
  })

  it('没配视频模型时也看关键帧，并提示去哪配能连声音一起看', async () => {
    await withSheet(async (sheet) => {
      analyzeVideoSource.mockResolvedValue({
        success: true,
        error: 'no-video-model-hint',
        frames: { success: true, sheetPaths: [sheet], frameCount: 20, fps: 2 }
      })

      const text = textOf(await run({ video_path: 'C:/a.mp4' }))
      expect(text).toContain('没有配置能看视频的模型')
      expect(text).toContain('设置 → 模型')
    })
  })
})
