import { nextTick, type Ref, type ComputedRef } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { aiAPI } from '../../../api/ai'
import { agentV3API } from '../../../api/agentV3'
import type { EditorSnapshot } from '@core/shared/editorSnapshot'
import type {
  ChatMessageContent,
  ExcelFileInfo,
  MentionedSource
} from '../../../store/modules/chatMessages'
import { bubbleAttachments, type ChatMediaFile } from './turnAttachments'
import { fileToBase64 } from '../../../utils/imageUpload'
import {
  buildMultimodalContent,
  ensureSessionWithTitle as ensureSessionWithTitleShared
} from './chatSendPrimitives'
import { shouldMarkTaskDone } from './sessionTaskDone'
import { getFormattedErrorMessage } from '@renderer/utils/errorMessage'
import { useI18n } from 'vue-i18n'
import type { AgentRunOutcome } from './agentHandlerShared'

/**
 * 助手输入框的发送链路。
 *
 * ## 这个文件曾经有 1600 行
 *
 * 那时它是**另一条推理链路**：自己排队、自己拿令牌、自己解 SSE、自己做知识库
 * 检索再把片段拼进提示词，最后打一次一问一答的补全。Agent 那条路在旁边并行
 * 长了一年，两边各修各的 bug。
 *
 * 现在只剩两件事：生图模式交给生图接口，**其余一律交给 Agent**。知识库问答
 * 也在其中 —— 检索变成了 Agent 自己能调的工具（`search_notebook_sources`），
 * 它可以看完第一批片段再换个说法查第二次，而拼提示词那条路只能查一次。
 */

/**
 * 知识库来源项接口
 */
export interface NotebookSourceItem {
  id: string
  title: string
  type:
    | 'file'
    | 'link'
    | 'youtube'
    | 'bilibili'
    | 'text'
    | 'note'
    | 'video'
    | 'image'
    | 'ue-project'
    | 'wechat'
    | 'mp'
  content?: string
  sourceUrl?: string
  /** 媒体 URL（用于视频的 临时媒体 URL） */
  mediaUrl?: string
  loading?: boolean
  error?: string | null
}

export interface UseChatFlowParams {
  sid: Ref<string>
  chatStore: any
  chatMsgStore: any
  tabsStore: any
  route: any
  /** 知识库问答这类「不给富输入」的宿主。图片、Excel 在那儿不该收 */
  chatOnlyMode?: Ref<boolean> | ComputedRef<boolean>
  isImageGenerationMode: Ref<boolean>
  executeAgent: (
    message: ChatMessageContent,
    excelContext?: string,
    options?: {
      onFinished?: (outcome: AgentRunOutcome) => void
      editorSnapshot?: EditorSnapshot | null
      sessionProject?: { projectName: string; projectPath?: string; engineVersion?: string } | null
      mediaFiles?: ChatMediaFile[]
    }
  ) => Promise<void>
  scrollToBottom: () => void
  updateContextChips: (text: string) => void
  pushUser: (
    content: ChatMessageContent,
    mentionedSources?: MentionedSource[],
    excelFiles?: ExcelFileInfo[]
  ) => void
  pushAssistantTyping: () => string
}

export function useChatFlow(params: UseChatFlowParams) {
  const { t } = useI18n()
  const {
    sid,
    chatStore,
    chatMsgStore,
    tabsStore,
    route,
    chatOnlyMode,
    isImageGenerationMode,
    executeAgent,
    scrollToBottom,
    updateContextChips,
    pushUser,
    pushAssistantTyping
  } = params

  function generateSessionId(): string {
    const t = Date.now().toString(36)
    const r = Math.random().toString(36).slice(2, 8)
    return `${t}${r}`
  }

  function normalizeSid(raw: string): string {
    const t = String(raw || '').trim()
    if (t) return t
    return generateSessionId()
  }

  /**
   * 确保会话存在并在首次发送消息时设置标题。
   *
   * 实现搬去了 `chatSendPrimitives` —— 后台投递那条路（没有页面挂着）要调同一份。
   */
  function ensureSessionWithTitle(sessionId: string, messageText: string): void {
    ensureSessionWithTitleShared(sessionId, messageText, {
      chatStore,
      tabsStore,
      route,
      unnamedTitle: t('assistant.chatFlow.unnamedSession')
    })
  }

  /** 从 markdown 里取图片地址：`![alt](url)` */
  function extractImageUrlFromMarkdown(markdown: string): string | null {
    if (typeof markdown !== 'string') return null
    const match = markdown.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/)
    return match ? match[1] : null
  }

  /** 上一条 AI 回复里的图片。生图模式下的「接着改这张」靠它 */
  function getLastAssistantImageUrl(): string | null {
    const messages = chatMsgStore.getMessages(sid.value)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && msg.status === 'done') {
        const content = msg.content
        if (typeof content === 'string') {
          const imageUrl = extractImageUrlFromMarkdown(content)
          if (imageUrl && imageUrl.startsWith('http')) {
            return imageUrl
          }
        }
      }
    }
    return null
  }

  async function urlToBase64(imageUrl: string): Promise<string> {
    const response = await fetch(imageUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`)
    }
    const blob = await response.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  function generateDisplayTitle(text: string, images: string[], isImageGenMode: boolean): string {
    if (text) return text
    if (isImageGenMode) return t('assistant.chatFlow.imageGenTitle')
    if (images.length > 0) return t('assistant.chatFlow.imageChatTitle')
    return t('assistant.chatFlow.unnamedSession')
  }

  async function respondWithImageGeneration(
    prompt: string,
    typingId: string,
    imageBase64?: string
  ): Promise<void> {
    // 捕获当前的会话ID
    const currentSid = sid.value

    try {
      chatMsgStore.replaceTyping(
        currentSid,
        typingId,
        t('assistant.chatFlow.generatingImage'),
        false
      )

      const params: Parameters<typeof aiAPI.generateImage>[0] = {
        prompt,
        imageSize: '1K',
        aspectRatio: '1:1'
      }

      // 有图就是图生图
      if (imageBase64) {
        params.image = imageBase64
      }

      const response = await aiAPI.generateImage(params)

      if (response && response.images && response.images.length > 0) {
        const imageUrl = response.images[0].url
        const markdownImage = `![${prompt}](${imageUrl})`
        chatMsgStore.replaceTyping(currentSid, typingId, markdownImage, true)
        chatStore.appendMessage(currentSid, markdownImage)
        if (shouldMarkTaskDone(route.path, route.query?.sid, currentSid)) {
          chatStore.markTaskDone(currentSid)
        }
      } else {
        throw new Error(t('assistant.chatFlow.imageGenFailedNoUrl'))
      }
    } catch (error) {
      console.error('图片生成失败:', error)
      const errorMsg = getFormattedErrorMessage(error, t('assistant.chatFlow.imageGenFailed'))

      chatMsgStore.replaceTyping(
        currentSid,
        typingId,
        `${t('assistant.chatFlow.errorPrefix')}: ${errorMsg}`,
        true
      )
      message.error(errorMsg)
    }
  }

  /**
   * 把 @ 提及的来源写进这一轮的话里。
   *
   * 不改检索范围而是加一句话：范围是模型该判断的事 —— 它看到片段的来源名，
   * 自己就能挑。硬缩范围的话，用户提了 A 但答案在 B 里时，模型连 B 存在都不知道。
   */
  function withSourceScope(
    content: ChatMessageContent,
    sources: NotebookSourceItem[]
  ): ChatMessageContent {
    if (sources.length === 0) return content
    // 笔记要标出来：它不在知识库检索工具的范围里，模型得知道去用笔记工具找。
    // 只给个标题，模型不知道该往哪儿翻
    const label = (s: NotebookSourceItem): string =>
      s.type === 'note' ? `笔记《${s.title}》` : s.title
    const scope = `\n\n（这个问题只看这几份来源：${sources.map(label).join('、')}）`
    if (typeof content === 'string') return content + scope
    return content.map((item, index) =>
      index === 0 && item.type === 'text' ? { ...item, text: (item.text || '') + scope } : item
    )
  }

  /**
   * 把这一轮交给 agent，顺带把闪存安顿好。
   *
   * 两条路：
   *
   * - 负载里**已经有** `editorSnapshot` 键 —— 说明提交那一刻已经定过了
   *   （排队投递、排队转直发、Spotlight）。原样用，不重抓。
   * - 没有 —— 用户此刻正按下发送，现抓一次。
   *
   * 闪存不进界面：它是**后台的潜规则**，用户不需要每条消息下面都被告知
   * 「你当时选了什么」——那是他自己刚做的事。
   */
  async function deliverWithEditorSnapshot(
    payload: {
      editorSnapshot?: EditorSnapshot | null
      sessionProject?: { projectName: string; projectPath?: string; engineVersion?: string } | null
      excelContext?: string
      mediaFiles?: ChatMediaFile[]
    },
    buildContent: () => ChatMessageContent
  ): Promise<void> {
    let snapshot = payload.editorSnapshot
    let sessionProject = payload.sessionProject

    if (!('editorSnapshot' in payload)) {
      const captured = await agentV3API.captureEditorSnapshot({
        sessionProject: chatStore.getProject?.(sid.value) ?? null
      })
      snapshot = captured.ok ? captured.snapshot : null
      if (captured.ok) {
        // 快照来自哪个工程，这一轮就钉在哪个工程上
        sessionProject = {
          projectName: captured.snapshot.project.projectName,
          ...(captured.snapshot.project.projectPath
            ? { projectPath: captured.snapshot.project.projectPath }
            : {})
        }
      }
    }

    await executeAgent(buildContent(), payload.excelContext, {
      editorSnapshot: snapshot ?? null,
      ...(sessionProject ? { sessionProject } : {}),
      ...(payload.mediaFiles?.length ? { mediaFiles: payload.mediaFiles } : {})
    })
  }

  async function handleSend(payload: {
    content: string
    images: string[]
    imageFiles?: File[]
    forcedSources?: NotebookSourceItem[]
    excelContext?: string
    excelFiles?: Array<{ fileName: string; rowCount?: number }>
    /** 文档与音视频的元数据，气泡上显示用 */
    docFiles?: Array<{ fileName: string; kind?: 'document' | 'video' | 'audio' }>
    /** 随消息带过去的音视频路径，agent 自己决定怎么看 */
    mediaFiles?: ChatMediaFile[]
    /** 实时语音必须走 Agent，即使用户此前停在生图模式。 */
    forceAgent?: boolean
    /** 语音转写已经作为普通用户气泡显示，交给 Agent 执行时不要再显示一遍。 */
    suppressUserMessage?: boolean
    /**
     * 用户按下发送那一刻的编辑器快照（闪存）。
     *
     * **这个键存在就说明已经定好了**（抓到的那份，或者用户点掉了 = `null`），
     * 这里绝不重抓。「排队转直接发送」那条路正是靠这一条天然正确：
     * 它带的是入队那一刻的快照，不是现在的。
     *
     * 键不存在才现抓一次 —— 那是用户此刻正按下发送的情况。
     */
    editorSnapshot?: EditorSnapshot | null
    /** 快照来自哪个工程；抓的和执行的必须是同一个 */
    sessionProject?: { projectName: string; projectPath?: string; engineVersion?: string } | null
  }): Promise<void> {
    const text = String(payload.content || '').trim()
    const allowRichInputs = !chatOnlyMode?.value
    const images = allowRichInputs ? payload.images || [] : []
    const imageFiles = allowRichInputs ? payload.imageFiles || [] : []
    const forcedSources = payload.forcedSources || []
    const excelContext = allowRichInputs ? payload.excelContext : undefined
    const excelFiles = allowRichInputs ? payload.excelFiles : undefined
    const mediaFiles = allowRichInputs ? (payload.mediaFiles ?? []) : []
    const attachmentChips = allowRichInputs
      ? bubbleAttachments(excelFiles, payload.docFiles)
      : undefined

    if (
      !text &&
      images.length === 0 &&
      imageFiles.length === 0 &&
      !excelContext &&
      mediaFiles.length === 0
    )
      return

    const messageContent = buildMultimodalContent(text, images)
    const displayText = generateDisplayTitle(text, images, isImageGenerationMode.value)

    if (isImageGenerationMode.value && !payload.forceAgent) {
      // 生图模式下贴了图就显示成多模态气泡，让用户看得见自己发了什么
      const userMessageContent = images.length > 0 ? messageContent : text
      pushUser(userMessageContent)
      const typingId = pushAssistantTyping()
      updateContextChips(text)
      ensureSessionWithTitle(sid.value, text)

      // 这次要不要图生图：优先用刚上传的那张，没有就接着改上一张出图
      let imageBase64: string | undefined

      if (imageFiles.length > 0) {
        try {
          imageBase64 = await fileToBase64(imageFiles[0])
        } catch (error) {
          console.error('图片转换为 base64 失败:', error)
          message.error(t('assistant.chatFlow.imageConvertFailed'))
        }
      } else {
        const lastImageUrl = getLastAssistantImageUrl()
        if (lastImageUrl) {
          try {
            imageBase64 = await urlToBase64(lastImageUrl)
          } catch (error) {
            // 静默失败，退回文生图 —— 上一张取不回来不该让这次生成也做不成
            console.error('上一条图片URL转换为 base64 失败:', error)
          }
        }
      }

      respondWithImageGeneration(text, typingId, imageBase64)
    } else {
      // @ 提及的来源：气泡上照常显示，同时写进这一轮的话里。
      // 检索工具搜的是整个知识库，不认「只看这几份」—— 说在提示词里，
      // 模型自己按来源名筛，比悄悄把范围缩掉更可控
      const mentionedSources: MentionedSource[] | undefined =
        forcedSources.length > 0
          ? forcedSources.map((s) => ({ id: s.id, title: s.title, type: s.type }))
          : undefined
      if (!payload.suppressUserMessage) pushUser(messageContent, mentionedSources, attachmentChips)
      updateContextChips(displayText)
      ensureSessionWithTitle(sid.value, displayText)
      void deliverWithEditorSnapshot({ ...payload, mediaFiles }, () =>
        withSourceScope(messageContent, forcedSources)
      )
    }

    nextTick(() => {
      scrollToBottom()
    })
  }

  return {
    handleSend,
    respondWithImageGeneration,
    ensureSessionWithTitle,
    normalizeSid
  }
}
