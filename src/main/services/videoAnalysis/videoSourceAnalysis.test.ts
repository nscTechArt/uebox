/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({ local: vi.fn(), frames: vi.fn() }))
vi.mock('./videoFileAnalysis', () => ({
  analyzeLocalVideoFile: mocks.local,
  NO_VIDEO_MODEL_HINT: '没有视频模型'
}))
vi.mock('./videoFrameFallback', () => ({ extractVideoFrames: mocks.frames }))
import { analyzeVideoSource } from './videoSourceAnalysis'

/** 远端分支会把响应体写进临时文件，用一段可读的假字节就够。 */
const videoResponse = (): Response => new Response(new Uint8Array([1, 2, 3, 4]))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.local.mockResolvedValue({ success: true, markdown: '摘要', model: 'test:model' })
})
afterEach(() => vi.unstubAllGlobals())

it('本地文件继续走原来的分析与压缩流程', async () => {
  mocks.local.mockResolvedValue({ success: true, compressed: true })
  expect(await analyzeVideoSource({ source: 'C:/video.mp4', prompt: '问题' })).toMatchObject({
    compressed: true
  })
  expect(mocks.local).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: 'C:/video.mp4', prompt: '问题' })
  )
})

/**
 * 这一条是整个远端分支存在的理由：直链带着 Referer 由本进程取回来，
 * 交给厂商去 fetch 的话 B 站一律 403、Gemini 的 fileUri 也不收这种地址。
 */
it('B 站页面解析后自己下载，带上 CDN 要的 Referer', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        '<script>{"playUrlInfo":[{"url":"https://cdn.example/play?x=1&amp;y=2"}]}</script>'
      )
    )
    .mockResolvedValueOnce(videoResponse())
  vi.stubGlobal('fetch', fetchMock)

  const source = 'https://www.bilibili.com/video/BV1example?p=2'
  expect(await analyzeVideoSource({ source, prompt: '问题' })).toMatchObject({
    success: true,
    markdown: '摘要'
  })

  expect(fetchMock.mock.calls[0][0]).toBe(source)
  const [downloadUrl, options] = fetchMock.mock.calls[1]
  expect(downloadUrl).toBe('https://cdn.example/play?x=1&y=2')
  expect(options.headers).toMatchObject({ Referer: 'https://www.bilibili.com/' })

  // 落盘的临时文件交给本地分析那一套，用完必须删掉
  const filePath = mocks.local.mock.calls[0][0].filePath as string
  expect(filePath).toMatch(/\.mp4$/)
  expect(mocks.local).toHaveBeenCalledWith(expect.objectContaining({ prompt: '问题' }))
  await expect(fs.stat(filePath)).rejects.toThrow()
})

it('视频直链按扩展名落盘，查询参数不影响判断', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(videoResponse()))
  await analyzeVideoSource({ source: 'https://cdn.example/a.webm?token=abc' })
  expect(mocks.local.mock.calls[0][0].filePath).toMatch(/\.webm$/)
})

it.each(['https://b23.tv/abc', 'https://example.com/page', 'https://www.bilibili.com/space/123'])(
  '不把不支持的页面当视频：%s',
  async (source) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await analyzeVideoSource({ source })).toMatchObject({ success: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.local).not.toHaveBeenCalled()
  }
)

it('解析失败时不下载也不分析', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  expect(
    await analyzeVideoSource({ source: 'https://www.bilibili.com/video/BV1example' })
  ).toMatchObject({ success: false, error: expect.stringContaining('无法获取') })
  expect(mocks.local).not.toHaveBeenCalled()
})

it('下载失败时给出明确错误，不留临时文件', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })))
  expect(await analyzeVideoSource({ source: 'https://cdn.example/a.mp4' })).toMatchObject({
    success: false,
    error: expect.stringContaining('403')
  })
  expect(mocks.local).not.toHaveBeenCalled()
})

/** 建一个真实存在的临时视频文件，跑完删掉 */
async function withVideo(name: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'uebox-src-test-'))
  const file = path.join(dir, name)
  await fs.writeFile(file, 'x')
  try {
    await fn(file)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/**
 * 真机反馈：视频模型没看成，agent 只能自己去 shell 抽帧，落进 WSL 失败，最后请用户截图。
 * 要了 framesFallback 就由这里抽帧交回去，用户不用做任何事。
 */
it('视频模型没看成时改抽帧，并带上没看成的原因', async () => {
  await withVideo('rain.mp4', async (file) => {
    mocks.local.mockResolvedValue({ success: false, model: 'x:y', error: 'HTTP 400: bad video' })
    mocks.frames.mockResolvedValue({ success: true, sheetPaths: ['/tmp/s1.jpg'], frameCount: 20 })
    expect(await analyzeVideoSource({ source: file, framesFallback: true })).toMatchObject({
      success: true,
      error: 'HTTP 400: bad video',
      frames: { sheetPaths: ['/tmp/s1.jpg'] }
    })
    expect(mocks.frames).toHaveBeenCalledWith(file)
  })
})

it('没要抽帧的调用方照旧拿到失败', async () => {
  mocks.local.mockResolvedValue({ success: false, error: 'no model' })
  expect(await analyzeVideoSource({ source: 'C:/video.mp4' })).toMatchObject({ success: false })
  expect(mocks.frames).not.toHaveBeenCalled()
})

it('文件本身不在就不抽帧，原样报找不到', async () => {
  mocks.local.mockResolvedValue({ success: false, error: 'not found: C:/nope.mp4' })
  expect(await analyzeVideoSource({ source: 'C:/nope.mp4', framesFallback: true })).toMatchObject({
    success: false,
    error: 'not found: C:/nope.mp4'
  })
  expect(mocks.frames).not.toHaveBeenCalled()
})

it('抽帧也失败时两边的原因都说出来', async () => {
  await withVideo('a.avi', async (file) => {
    mocks.local.mockResolvedValue({ success: false, error: 'no model' })
    mocks.frames.mockResolvedValue({ success: false, error: 'cannot decode' })
    const result = await analyzeVideoSource({ source: file, framesFallback: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain('no model')
    expect(result.error).toContain('cannot decode')
  })
})
