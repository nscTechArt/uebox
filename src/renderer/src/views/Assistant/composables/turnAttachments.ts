/**
 * 这一轮带着的附件，怎么变成 agent 真正收到的那条用户消息。
 *
 * ## 音视频不预先分析，只把路径交给主进程
 *
 * 原来拖进来那一刻就让视频模型看一遍，把描述塞进对话。两个毛病：那时用户还一个字
 * 没打，模型只能泛泛描述，用户真正要问的细节多半不在里面；而且拖进来就花一次调用。
 * 现在路径随消息交给主进程：配了对象存储、当前模型又能看视频，就换成链接让它在
 * 同一轮里直接看；否则只给路径，agent 自己用 `analyze_video` 去看
 * （见主进程 `agent-v3/core/promptMedia.ts`）。
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

/** 附件种类。卡片据此选图标和颜色 */
export type AttachmentKind = NonNullable<ExcelFileInfo['kind']>

/** 随消息带过去的音视频。只有路径，怎么让模型看由主进程决定 */
export interface ChatMediaFile {
  filePath: string
  fileName: string
  kind: 'video' | 'audio'
}

/** 和主进程 `parseGoalCommand` 同一个认法 */
const GOAL_COMMAND = /^\s*\/goal\b/

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

  const block: MultimodalContentItem = {
    type: 'text',
    text: `【用户这条消息附带的文件】\n\n${contexts.join('\n\n---\n\n')}`
  }
  // `/goal …` 是给主进程认的命令，只认消息开头（`parseGoalCommand`）。附件块垫在它前面，
  // 带着表格发 /goal 就不进目标模式了 —— 这种时候附件跟在命令那段后面
  const first = items[0]
  if (first?.type === 'text' && GOAL_COMMAND.test(first.text ?? '')) items.splice(1, 0, block)
  else items.unshift(block)

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

/**
 * 气泡附件卡片副标题里的扩展名：`clip.final.MP4` → `MP4`。
 * 没有扩展名、或者点号开头的隐藏文件，回空串 —— 副标题只剩种类，不凭空编一个
 */
export function attachmentExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toUpperCase()
}

/**
 * 插话随话带的非图片附件。
 *
 * 图片单独走 `images`（要内联、要过视觉关口），这里是剩下那些：音视频只带路径，
 * 文档 / 表格带解析好的正文，`files` 只给时间线画卡片用 —— 不画的话回头看只剩
 * 一句「看这个视频」，而「这个」是哪个再也说不清。
 */
export interface SteerAttachments {
  mediaFiles?: ChatMediaFile[]
  contextText?: string
  files?: ExcelFileInfo[]
}

/**
 * 只带附件没打字的插话，替用户补的那句话。没有附件时返回空串。
 *
 * 空着不行：模型拿到一段没头没尾的附件不知道该干嘛；而插话「已生效」的回执是
 * 按原话匹配的，空串对不上号，这条会一直挂着「未生效」。
 */
export function attachmentsOnlySteerText(
  t: (key: string, params: Record<string, unknown>) => string,
  imageCount: number,
  files?: readonly ExcelFileInfo[]
): string {
  const names = [
    ...(files ?? []).map((file) => file.fileName),
    ...(imageCount > 0 ? [t('assistantInputComposer.steerImageCount', { count: imageCount })] : [])
  ]
  return names.length > 0
    ? t('assistantInputComposer.steerAttachmentsOnly', { names: names.join('、') })
    : ''
}
