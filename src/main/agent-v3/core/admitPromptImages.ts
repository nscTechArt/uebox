/**
 * 聊天附件里的图，进上下文之前过一遍关口。
 *
 * ## 为什么主进程还要再查一遍
 *
 * 渲染层确实压过（`InputComposer` 的 `compressImageToTarget`，目标 300KB），
 * 但那是**尽力而为**：压缩抛异常时它回退用原文件，而且那条压缩只在
 * 「走输入框贴图」这一条路上。主进程这边收到的是一个数组，谁塞的、压没压过，
 * 从类型上完全看不出来。
 *
 * 一张没压住的 4MB 图进了 transcript，代价不是这一轮 —— pi 每轮重发整条
 * transcript，**之后每一轮**都带着它，直到厂商网关回 413。所以边界上要查，
 * 不能信上游。工具那边已经这么做了（见 `tools/defineTool.ts`），附件这条
 * 是最后一个没接上关口的入口。
 */

import type { ImageContent } from '@earendil-works/pi-ai'

import { admitImageForContext } from '../tools/contextImage'

export interface AdmittedPromptImages {
  /** 过了关口、可以进上下文的图 */
  images: ImageContent[]
  /**
   * 要跟着一起说给模型听的话：哪张缩过、哪张没进去。
   *
   * 不能省。模型看不到图而上下文里又没有交代时，它会当成「这个文件是空的」
   * 往下推 —— 比看不见更糟的是不知道自己看不见。
   */
  notices: string[]
}

/**
 * @param images 渲染层递来的图片块，可能一张都没有
 */
export async function admitPromptImages(
  images: readonly ImageContent[] | undefined
): Promise<AdmittedPromptImages> {
  if (!images || images.length === 0) return { images: [], notices: [] }

  const admitted: ImageContent[] = []
  const notices: string[] = []

  for (const image of images) {
    const result = await admitImageForContext({
      data: image.data,
      mimeType: image.mimeType
    })

    for (const block of Array.isArray(result) ? result : [result]) {
      if (block.type === 'image') {
        admitted.push({ ...image, data: block.data, mimeType: block.mimeType })
      } else {
        notices.push(block.text)
      }
    }
  }

  return { images: admitted, notices }
}
