/**
 * 聊天附件解释的 IPC 出口。
 *
 * 渲染层只管把绝对路径递进来，怎么解释是主进程的事 —— 视频要起 ffmpeg、
 * 文档要加载 anydoc 原生模块，这两件都不该在渲染进程里发生。
 *
 * 抽帧产物是临时文件，渲染层读不到磁盘，所以这里**压完直接回传 data URL**：
 * 联系表本来就要当图片进上下文，多一趟「回传路径 → 渲染层再来要内容」
 * 只会多一次往返，还得额外管生命周期。读完即删，临时目录不留。
 */

import { ipcMain } from 'electron'
import { promises as fs } from 'fs'

import { CONTACT_SHEET_MAX_WIDTH, compressForContext } from '../agent-v3/tools/contextImage'
import {
  ingestAttachment,
  releaseIngestedImages,
  type AttachmentIngestResult
} from '../services/attachmentIngest'

/** 回给渲染层的结果：图片路径换成了可以直接塞进 `<img>` 和模型请求的 data URL */
export interface AttachmentIngestIpcResult
  extends Omit<AttachmentIngestResult, 'imagePaths' | 'success'> {
  success: boolean
  /** `data:image/png;base64,...`，按时间先后排列 */
  images?: string[]
}

export function registerAttachmentIPC(): void {
  ipcMain.handle(
    'attachment:ingest',
    async (event, args: { filePath: string }): Promise<AttachmentIngestIpcResult> => {
      const result = await ingestAttachment({
        filePath: args?.filePath,
        // 视频那条可能要跑一两分钟（压缩、上传、抽帧），全程静默用户会以为卡死
        onProgress: (note) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('attachment:ingest-progress', { filePath: args?.filePath, note })
          }
        }
      })

      const { imagePaths, ...rest } = result
      if (!imagePaths || imagePaths.length === 0) return rest

      try {
        // 必须压。一张 4×6 的 1080p 联系表出片就有 2MB，两张直接顶穿
        // `requestBudget` 的 3MB —— 而 pi 每轮重发整条 transcript，
        // 一次顶穿会毒死这条会话之后的每一轮。走 `compressForContext` 的
        // 拼图档（更宽的 1152，见 CONTACT_SHEET_MAX_WIDTH），每张压到 180KB 上下
        const compressed = await Promise.all(
          imagePaths.map(async (p) =>
            compressForContext(await fs.readFile(p), { maxWidth: CONTACT_SHEET_MAX_WIDTH })
          )
        )

        const images = compressed
          .filter((image): image is NonNullable<typeof image> => image !== null)
          .map((image) => `data:${image.mimeType};base64,${image.data}`)

        if (images.length === 0) {
          return { ...rest, success: false, error: '抽出来的帧压不进上下文' }
        }
        return { ...rest, images }
      } catch (error) {
        return {
          ...rest,
          success: false,
          error: `联系表读取失败：${error instanceof Error ? error.message : String(error)}`
        }
      } finally {
        await releaseIngestedImages(imagePaths)
      }
    }
  )
}
