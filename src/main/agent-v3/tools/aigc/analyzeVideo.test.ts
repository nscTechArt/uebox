/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 这一组守的是「看过和没看过要分得清」：
 * 看成了要把描述原样交出去，没配模型要报错而不是编一段画面。
 */

const analyzeVideoSource = vi.fn()

vi.mock('../../../services/videoAnalysis/videoSourceAnalysis', () => ({
  analyzeVideoSource: (...args: unknown[]) => analyzeVideoSource(...args)
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
