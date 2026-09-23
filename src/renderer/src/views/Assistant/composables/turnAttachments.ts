/**
 * 这一轮带着的附件，怎么变成 agent 真正收到的那条用户消息。
 *
 * ## 音视频只带路径，不预先分析
 *
 * 原来拖进来那一刻就让视频模型看一遍，把描述塞进对话。两个毛病：那时用户还一个字
 * 没打，模型只能泛泛描述，用户真正要问的细节多半不在里面；而且拖进来就花一次调用。
 * agent 自己有 `analyze_video`，能带着用户的问题去看 —— 把路径交给它就够了。
 * 当前模型看不了视频时，它自己会说，不需要这边先替它判断、再抽帧兜底。
 *
 * ## 为什么附件上下文要并进用户那条消息
 *
 * `executeAgent` 只把**最后一条**用户消息发给内核（历史由内核按 sessionId 自己恢复）。
 * 附件上下文原来是作为它前面**单独一条**推进历史的，于是从来没发出去过 ——
 * 用户拖了视频问「视频里有什么」，模型回「没看到视频」。并成一条就不会再丢。
 */

import type {
  ChatMessageContent,
  ExcelFileInfo,
  MultimodalContentItem
} from '../../../store/modules/chatMessages'

/** 随消息带过去的音视频。只有路径，内容由 agent 自己去看 */
export interface ChatMediaFile {
  filePath: string
  fileName: string
  kind: 'video' | 'audio'
}

/** 音视频附件写成给 agent 看的一段话：是什么、在哪、怎么看 */
export function describeMediaFiles(files: ChatMediaFile[]): string | undefined {
  if (files.length === 0) return undefined
  const lines = files.map(
    (file) => `- ${file.kind === 'video' ? '视频' : '音频'}：${file.fileName}（本地路径：${file.filePath}）`
  )
  return [
    '【用户附带的音视频】',
    ...lines,
    '这些文件没有预先分析。需要知道内容时，用 `analyze_video` 去看（`video_path` 填上面的路径，`question` 填用户想知道的）。'
  ].join('\n')
}

/**
 * 把附件上下文并进用户这条消息。
 *
 * 附件放在前面、用户的话放在最后：模型读到问题时，要看的东西已经在眼前了。
 * 什么都没有就原样返回，不改消息的形状。
 */
export function mergeTurnContext(
  content: ChatMessageContent,
  contextTexts: string[]
): ChatMessageContent {
  const contexts = contextTexts.filter((text) => text.trim())
  if (contexts.length === 0) return content

  const items: MultimodalContentItem[] =
    typeof content === 'string'
      ? content.trim()
        ? [{ type: 'text', text: content }]
        : []
      : content.map((item) => ({ ...item }))

  items.unshift({
    type: 'text',
    text: `【用户这条消息附带的文件】\n\n${contexts.join('\n\n---\n\n')}`
  })

  // 只有文字的话仍然回一段纯文本，和不带附件时的消息形状一致
  if (items.every((item) => item.type === 'text')) {
    return items.map((item) => item.text ?? '').join('\n\n')
  }
  return items
}

/**
 * 气泡上那一排附件标签。Excel、文档、音视频合成一排 —— 原来只显示 Excel，
 * 拖了视频发出去，气泡上什么都没有，用户没法确认它到底带上了没有。
 */
export function bubbleAttachments(
  excelFiles?: Array<{ fileName: string; rowCount?: number }>,
  docFiles?: Array<{ fileName: string; kind?: 'document' | 'video' | 'audio' }>
): ExcelFileInfo[] | undefined {
  const list: ExcelFileInfo[] = [
    ...(excelFiles ?? []).map((file) => ({ ...file, kind: 'excel' as const })),
    ...(docFiles ?? []).map((file) => ({ fileName: file.fileName, kind: file.kind ?? 'document' }))
  ]
  return list.length > 0 ? list : undefined
}
