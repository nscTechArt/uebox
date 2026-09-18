/**
 * 发一条消息要做的那几件**和页面无关**的事。
 *
 * 它们原来长在 `useChatFlow` 的闭包里，只有挂着的助手页能用。但「发出去」这件事
 * 不该由页面拥有：排着的跟进消息要在用户切去别的页面之后照样发得出去
 * （见 `followUpDelivery.ts`），那时一个助手页都没挂着。
 *
 * 所以把不依赖视图的那部分搬到这里，两条路（页面输入框、后台投递）调同一份 ——
 * 各写一份的话，两边迟早在「会话标题怎么起」「工程戳盖不盖」上分叉。
 */

import type { ChatMessageContent, MultimodalContentItem } from '../../../store/modules/chatMessages'
import type { ChatSession, ChatSessionProject } from '../../../store/modules/chatSessions'
import { autoNameSession } from './sessionAutoTitle'
import { stampSessionProject } from './sessionProjectBinding'

/** 文本 + 图片 → 消息体。没有图就是一条纯文本，不套数组 */
export function buildMultimodalContent(text: string, images: string[]): ChatMessageContent {
  if (!images || images.length === 0) {
    return text
  }
  const contentArray: MultimodalContentItem[] = []
  if (text.trim()) {
    contentArray.push({ type: 'text', text: text.trim() })
  }
  for (const imageUrl of images) {
    contentArray.push({
      type: 'image_url',
      image_url: { url: imageUrl, detail: 'auto' }
    })
  }
  return contentArray
}

/**
 * 只写这里真正用到的那几个方法，不写整个 store 的类型。
 *
 * 调用方两边（`useChatFlow` 和后台投递）传的都是同一个 Pinia store，那边的类型
 * 是 `any`（存量），这里按结构收窄一层 —— 至少这个文件里拼错方法名会被编译器逮住。
 */
export interface EnsureSessionDeps {
  chatStore: {
    ensureSession: (sessionId: string, title: string) => void
    sessionById: (sessionId: string) => ChatSession | null
    updateTitle: (sessionId: string, title: string) => void
    appendMessage: (sessionId: string, text: string) => void
    setProject: (sessionId: string, project: ChatSessionProject | null) => void
  }
  tabsStore: { updateTabTitleByPath: (path: string, title: string) => void }
  route: { path: string; fullPath: string; query?: Record<string, unknown> }
  /** 未命名会话的兜底标题（i18n 已经取好，这一层不认 key） */
  unnamedTitle: string
}

/**
 * 确保会话存在，并在第一条消息时把标题定下来。
 *
 * 标题分两步：先把消息前 20 字截下来顶上，这一步是同步的，侧边栏立刻有字；
 * 再交给轻量模型起个真名字（`sessionAutoTitle.ts`），几秒后悄悄换掉。模型那步
 * 失败就保持截断标题不动。
 *
 * 标签页标题只在**用户正站在助手路由上**时才跟着改：后台投递发生时他可能正看着
 * 素材库，改那个标签的标题会改到不相干的页上去。
 */
export function ensureSessionWithTitle(
  sessionId: string,
  messageText: string,
  deps: EnsureSessionDeps
): void {
  const { chatStore, tabsStore, route, unnamedTitle } = deps
  chatStore.ensureSession(sessionId, unnamedTitle)
  const session = chatStore.sessionById(sessionId)
  if (session && session.title === unnamedTitle) {
    const autoTitle = messageText.replace(/\s+/g, ' ').slice(0, 20) || unnamedTitle
    chatStore.updateTitle(sessionId, autoTitle)
    const isAssistantRoute =
      route.path === '/dev-assistant' || route.path.startsWith('/dev-assistant/')
    if (isAssistantRoute) {
      tabsStore.updateTabTitleByPath(route.fullPath, autoTitle)
    }

    // 标签页按**发这条消息时**那个路径改，不按模型回来时用户站在哪：这一栏属于
    // 这条会话的那个标签，用户切走了它也还在，改的仍然是对的那一个
    autoNameSession(sessionId, messageText, autoTitle, {
      getTitle: (id) => chatStore.sessionById(id)?.title,
      applyTitle: (id, title) => {
        chatStore.updateTitle(id, title)
        if (isAssistantRoute) {
          tabsStore.updateTabTitleByPath(route.fullPath, title)
        }
      }
    })
  }
  chatStore.appendMessage(sessionId, messageText)

  // 用户在某个工程下点「+」新建的会话（`?project=`），首次发消息时盖上工程戳，
  // 侧边栏据此分组。没带这个参数就是「纯会话」，进侧边栏的「对话」区。
  stampSessionProject({
    sessionId,
    getSession: (id: string) => chatStore.sessionById(id),
    setProject: (id: string, project: ChatSessionProject | null) =>
      chatStore.setProject(id, project),
    preferredProjectName: typeof route.query?.project === 'string' ? route.query.project : ''
  })
}
