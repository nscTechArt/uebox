import type { Message } from '@earendil-works/pi-ai'
import { assistantMessage } from './piCompletion'

/**
 * OpenAI 格式 → pi 的消息格式转换。
 *
 * 渲染层与各专家内部沿用的是 OpenAI 的 `{ type: 'image_url', image_url: { url } }`
 * 形状（早期直接把请求体发给官方网关，网关就吃这个格式）。内核收的是 pi 的
 * `{ type: 'image', data, mimeType }`，得先转过去。
 *
 * **图片只收 base64。** pi 不会替我们去下载 URL —— 传一个 http 链接过去，
 * 模型收到的是一串它读不懂的字符，而不是图。所以这里遇到非 data URL 的图片
 * 直接丢掉那一项：少一张图，好过让模型对着一句 URL 编内容。
 */

/** OpenAI 格式的多模态内容项 */
export interface OpenAIContentItem {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
    detail?: 'low' | 'high' | 'auto'
  }
}

/** pi 的 UserMessage.content 里那两种块 */
type PiContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

function toPiContent(items: OpenAIContentItem[]): PiContentItem[] {
  const content: PiContentItem[] = []
  for (const item of items) {
    if (item.type === 'text' && item.text) {
      content.push({ type: 'text', text: item.text })
      continue
    }

    const url = item.image_url?.url
    if (item.type !== 'image_url' || !url) continue

    const match = url.match(/^data:([^;]+);base64,(.*)$/)
    if (!match) {
      // 外链图片：pi 不下载，透过去等于给模型一串乱码
      console.warn('[消息转换] 丢掉一张非 base64 图片，内核不收图片链接')
      continue
    }
    content.push({ type: 'image', data: match[2], mimeType: match[1] })
  }
  return content
}

export function convertToPiMessages(messages: unknown[]): Message[] {
  return messages.flatMap((msg) => {
    const message = msg as { role?: string; content?: unknown }
    // pi 的 Context 只收 user / assistant，系统提示词是 Context 上的独立字段
    const role = message.role === 'assistant' ? 'assistant' : 'user'

    if (typeof message.content === 'string') {
      return [
        role === 'assistant'
          ? assistantMessage(message.content)
          : ({ role, content: message.content, timestamp: 0 } as Message)
      ]
    }

    if (Array.isArray(message.content)) {
      const content = toPiContent(message.content as OpenAIContentItem[])
      if (content.length === 0) return []
      // assistant 那条在 pi 里不收图片块，取文本即可
      if (role === 'assistant') {
        return [
          assistantMessage(
            content
              .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
          )
        ]
      }
      return [{ role, content, timestamp: 0 } as Message]
    }

    return []
  })
}

/** 消息里是否含图。决定要不要走 vision 角色 */
export function messagesHaveImages(messages: unknown[]): boolean {
  return messages.some((msg) => {
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) return false
    return content.some(
      (part: { type?: string }) => part?.type === 'image' || part?.type === 'image_url'
    )
  })
}

/** 取出系统提示词并拼成一段。pi 把它放在 Context 上，不混在消息列表里 */
export function extractSystemPrompt(messages: unknown[]): string | undefined {
  const parts = messages
    .filter((msg) => (msg as { role?: string }).role === 'system')
    .map((msg) => {
      const content = (msg as { content?: unknown }).content
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .filter((part: { type?: string }) => part?.type === 'text')
        .map((part: { text?: string }) => part.text ?? '')
        .join('\n')
    })
    .filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}
