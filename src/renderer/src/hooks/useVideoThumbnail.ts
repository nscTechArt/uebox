/**
 * 视频缩略图 Hook
 *
 * 优先用 Chromium 自带的解码器抽帧（渲染进程里 video + canvas），抽不到再退回
 * 主进程的 FFmpeg。这个顺序是有意的：应用不再随包分发 FFmpeg，绝大多数常见
 * 格式（mp4 / webm / mov 的 H.264）Chromium 自己就能解，不该为了缩略图逼用户
 * 去装 FFmpeg。装了的人则继续享受对 ProRes、部分 HEVC 之类的支持。
 */

import { captureVideoFirstFrame, isVideoFile } from '@renderer/utils/videoThumbnail'
import { resolveErrorText } from '@renderer/views/AssetManagement/utils/assetVaultHelpers'

/**
 * 抽一帧并存成缩略图。
 *
 * 先试 Chromium 解码：成功就把 base64 交给主进程落盘，全程不需要 FFmpeg。
 * 失败（编解码器不支持、文件损坏）再退回主进程的 FFmpeg 路径 ——
 * 没装 FFmpeg 时那条路径会返回明确的「请先安装」错误。
 *
 * base64 落盘走 `asset.saveThumbnail` —— 和自定义封面同一条通道，它返回纯文件名
 * 并且在远程库上会先把文件推到服务端。两条路径返回的都是文件名，可以直接写库。
 */
interface ThumbnailResult {
  success: boolean
  data?: string
  error?: string
}

async function extractThumbnail(filePath: string, assetKey: string): Promise<ThumbnailResult> {
  try {
    const base64 = await captureVideoFirstFrame(filePath)
    const saved = (await window.api.asset.saveThumbnail(base64, assetKey)) as ThumbnailResult
    if (saved?.success) {
      console.log('[VideoThumbnail] 由 Chromium 解码生成')
      return saved
    }
    console.warn('[VideoThumbnail] 保存 Chromium 抽帧失败，改用 FFmpeg:', saved?.error)
  } catch (error) {
    console.warn('[VideoThumbnail] Chromium 解不了这个视频，改用 FFmpeg:', error)
  }

  return (await window.api.video.extractAndSaveThumbnail(filePath, assetKey)) as ThumbnailResult
}

/**
 * 使用 FFmpeg 为视频资产生成缩略图
 * @param assetKey 资产唯一键
 * @param filePath 文件路径
 * @returns 是否成功生成缩略图
 */
export async function handleVideoAssetImported(
  assetKey: string,
  filePath: string
): Promise<{ success: boolean; thumbnailPath?: string; error?: string }> {
  try {
    // 检查是否为视频文件
    if (!isVideoFile(filePath)) {
      return {
        success: false,
        error: '不是视频文件'
      }
    }

    console.log(`[VideoThumbnail] 开始为视频资产生成缩略图: ${assetKey}`)

    const result = await extractThumbnail(filePath, assetKey)

    if (!result.success) {
      throw new Error(result.error || '提取视频帧失败')
    }

    console.log(`[VideoThumbnail] 缩略图生成成功: ${result.data}`)

    // 更新数据库中的资产记录，设置 customPoster 字段。
    // 只能写纯文件名 —— 带目录前缀会被 db:assetData:update 的字段闸挡下来，
    // 而这个 hook 的调用点是「列表里没封面的视频」，写不进去就每次刷新都重抽一遍。
    const updateResult = await (window as any).api.database.assetData.update(assetKey, {
      customPoster: result.data
    })

    if (!updateResult.success) {
      throw new Error(updateResult.error || '写入缩略图字段失败')
    }

    return {
      success: true,
      thumbnailPath: result.data
    }
  } catch (error) {
    console.error('[VideoThumbnail] 视频缩略图生成失败:', error)
    return {
      success: false,
      error: resolveErrorText(error, error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * 批量处理视频资产
 * @param assets 资产列表 { assetKey, filePath }
 * @param onProgress 进度回调
 * @returns 处理结果
 */
export async function batchHandleVideoAssets(
  assets: Array<{ assetKey: string; filePath: string }>,
  onProgress?: (current: number, total: number) => void
): Promise<Array<{ assetKey: string; success: boolean; error?: string }>> {
  const results: Array<{ assetKey: string; success: boolean; error?: string }> = []

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]
    const result = await handleVideoAssetImported(asset.assetKey, asset.filePath)
    results.push({
      assetKey: asset.assetKey,
      success: result.success,
      error: result.error
    })

    if (onProgress) {
      onProgress(i + 1, assets.length)
    }
  }

  return results
}

/**
 * 检查 FFmpeg 是否可用
 * @returns FFmpeg 可用状态
 */
export async function checkFFmpegAvailable(): Promise<{
  available: boolean
  ffmpegPath?: string
  error?: string
}> {
  try {
    const result = await (window as any).api.video.checkFFmpegAvailable()
    return {
      available: result.success && result.data,
      ffmpegPath: result.ffmpegPath,
      error: result.error
    }
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
