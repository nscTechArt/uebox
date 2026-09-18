/**
 * 视频缩略图回写库的那一跳。
 *
 * 红灯用例：抽帧成功后往 customPoster 里写 `thumbnails/video-xxx.png`。
 * `db:assetData:update` 的字段闸只收纯文件名（缩略图字段是后台删文件的定位依据，
 * 见 sqliteDataBase/ipc/assetData/updateGuard.ts），所以这次更新每次都被拒；
 * 而拒了以后老代码只打一行 console.error 就返回 success —— 列表看到这个视频仍然
 * 没封面，下次刷新继续抽帧，每抽一次在库里多丢一张带时间戳的 PNG。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureVideoFirstFrame = vi.fn()
const saveThumbnail = vi.fn()
const extractAndSaveThumbnail = vi.fn()
const update = vi.fn()

vi.mock('@renderer/utils/videoThumbnail', () => ({
  captureVideoFirstFrame: (...args: unknown[]) => captureVideoFirstFrame(...args),
  isVideoFile: (name: string) => name.toLowerCase().endsWith('.mp4')
}))

vi.stubGlobal('window', {
  api: {
    asset: { saveThumbnail: (...args: unknown[]) => saveThumbnail(...args) },
    video: { extractAndSaveThumbnail: (...args: unknown[]) => extractAndSaveThumbnail(...args) },
    database: { assetData: { update: (...args: unknown[]) => update(...args) } }
  }
})

const { handleVideoAssetImported } = await import('./useVideoThumbnail')

describe('handleVideoAssetImported', () => {
  beforeEach(() => {
    captureVideoFirstFrame.mockReset()
    saveThumbnail.mockReset()
    extractAndSaveThumbnail.mockReset()
    update.mockReset()
    update.mockResolvedValue({ success: true })
  })

  it('Chromium 抽帧写库的值必须是纯文件名 —— 带目录前缀会被字段闸挡下', async () => {
    captureVideoFirstFrame.mockResolvedValue('data:image/png;base64,AAAA')
    saveThumbnail.mockResolvedValue({ success: true, data: 'custom-abc-123.png' })

    const result = await handleVideoAssetImported('abc', 'D:/vault/a.mp4')

    expect(result.success).toBe(true)
    const [assetKey, updates] = update.mock.calls[0] as [string, { customPoster: string }]
    expect(assetKey).toBe('abc')
    // 闸的判据（updateGuard → thumbnailGuard.isPlainFileName）：不能带任何目录分隔符
    expect(updates.customPoster).toBe('custom-abc-123.png')
    expect(updates.customPoster).not.toMatch(/[\\/]/)
    expect(extractAndSaveThumbnail).not.toHaveBeenCalled()
  })

  it('Chromium 解不了才退回 FFmpeg，回来的同样直接写库', async () => {
    captureVideoFirstFrame.mockRejectedValue(new Error('unsupported codec'))
    extractAndSaveThumbnail.mockResolvedValue({ success: true, data: 'video-abc-123.png' })

    const result = await handleVideoAssetImported('abc', 'D:/vault/a.mp4')

    expect(result.success).toBe(true)
    expect(update).toHaveBeenCalledWith('abc', { customPoster: 'video-abc-123.png' })
  })

  it('库没写进去就不许报成功 —— 报了成功调用方不会拉黑，下次刷新还会再抽一遍', async () => {
    captureVideoFirstFrame.mockResolvedValue('data:image/png;base64,AAAA')
    saveThumbnail.mockResolvedValue({ success: true, data: 'custom-abc-123.png' })
    update.mockResolvedValue({ success: false, error: '不允许通过通用更新接口这样修改这些字段' })

    const result = await handleVideoAssetImported('abc', 'D:/vault/a.mp4')

    expect(result.success).toBe(false)
    expect(result.error).toContain('不允许通过通用更新接口')
  })

  it('不是视频文件直接拒，不去碰解码器', async () => {
    const result = await handleVideoAssetImported('abc', 'D:/vault/a.uasset')

    expect(result.success).toBe(false)
    expect(captureVideoFirstFrame).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})
