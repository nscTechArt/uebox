/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../services/dashscope/urlAnalyzer', () => ({
  VISION_KEY_HINT: 'missing-key',
  analyzeUrl: vi.fn()
}))

import { resolveBilibiliVideoUrl } from './bilibili'

describe('resolveBilibiliVideoUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('从 B 站页面解析并解码临时播放直链', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        text: async () =>
          '<script>window.__INITIAL_STATE__={"playUrlInfo":[{"url":"https:\\u002F\\u002Fcdn.example\\u002Fvideo.mp4?a=1&amp;b=2"}]}</script>'
      })
    )

    await expect(
      resolveBilibiliVideoUrl('https://www.bilibili.com/video/BV1example')
    ).resolves.toEqual({ success: true, data: 'https://cdn.example/video.mp4?a=1&b=2' })
  })

  it('拒绝非 B 站地址且不发起网络请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveBilibiliVideoUrl('https://example.com/video/BV1example')).resolves.toEqual({
      success: false,
      data: '',
      error: '请提供有效的 Bilibili 视频 URL'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('页面没有播放信息时返回明确失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: async () => '<html></html>' }))

    await expect(
      resolveBilibiliVideoUrl('https://www.bilibili.com/video/BV1example')
    ).resolves.toEqual({
      success: false,
      data: '',
      error: '无法获取视频真实地址，可能视频不存在或受限'
    })
  })
})
