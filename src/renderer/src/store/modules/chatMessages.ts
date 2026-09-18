import { defineStore } from 'pinia'
import { ref, toRaw } from 'vue'
import type { AgentTurnUsage } from '@core/shared/agentUsage'
import { snapshotAgentProcess } from '../../utils/agentProcessSnapshot'
import { TYPING_PLACEHOLDER, isTypingPlaceholder } from '../../utils/typingPlaceholder'
import type { ChatMessagesPersistedState } from '../../utils/chatMessagesPersistence'

export type ChatRole = 'user' | 'assistant'

/**
 * 过程时间线条目。
 *
 * 这里原本照抄了一份定义，理由写的是「避免循环依赖」—— 但它是**纯类型**导入，
 * 编译后什么都不剩，构不成运行时环。两份定义的下场是各改各的：给时间线加
 * `text` 条目时只改了组件那份，这里就直接类型不兼容了。认一份。
 */
export type { AgentProcessItem } from '@renderer/views/Assistant/components/AgentProcessLog.types'
import type { AgentProcessItem } from '@renderer/views/Assistant/components/AgentProcessLog.types'

/**
 * 多模态消息内容项
 */
export interface MultimodalContentItem {
  type: 'text' | 'image_url' | 'file_url'
  text?: string
  image_url?: {
    url: string
    detail?: 'low' | 'high' | 'auto'
  }
  /** 文件 URL（用于视频的 临时媒体 URL） */
  file_url?: {
    url: string
    mimeType?: string
  }
}

/**
 * 聊天消息内容类型（支持纯文本或多模态内容）
 */
export type ChatMessageContent = string | MultimodalContentItem[]

/**
 * @提及来源信息
 */
export interface MentionedSource {
  id: string
  title: string
  type: string
}

/**
 * 上传的 Excel 文件信息
 */
export interface ExcelFileInfo {
  fileName: string
  rowCount?: number
}

/**
 * Agent 执行上下文（用于后续对话的历史注入）
 * 保存执行过程中产生的结构化信息，让 AI 能"记住"之前的操作结果
 */
export interface ExecutionContext {
  /** 搜索到的资产列表 */
  searchedAssets?: Array<{
    name: string
    type: string
    path: string
    assetKey?: string
  }>
  /** 当前项目信息 */
  projectInfo?: {
    projectName: string
    projectPath: string
    contentPath?: string
    engineVersion?: string
  }
  /** 创建的对象（Actor、Blueprint等） */
  createdObjects?: Array<{
    name: string
    type: string
    path?: string
  }>
  /** 工具执行摘要 */
  toolSummary?: Array<{
    toolName: string
    success: boolean
    summary: string
  }>
}

export interface ResponseMetadataSkill {
  name: string
  source?: 'user' | 'builtin'
  directory?: string
}

/**
 * 这一轮真的动了什么（写操作清单），由 changeSummary 算出来。
 *
 * 和上面的 `AgentProcessItem` 同样的教训：这里原本照抄了一份字段，然后
 * `changeSummary` 那边加 `detail`（命令原文、改了哪些属性）时没人想起来同步 ——
 * 结果类型上说这个字段不存在，运行时它却一直在，界面还在读它。认一份。
 */
export type { ChangeEntry as ResponseMetadataChange } from '@renderer/views/Assistant/composables/changeSummary'
import type { ChangeEntry as ResponseMetadataChange } from '@renderer/views/Assistant/composables/changeSummary'

export interface ResponseMetadata {
  usedSkills?: ResponseMetadataSkill[]
  /** 本轮改动清单；只读操作不进来，空数组表示这轮什么都没改 */
  changes?: ResponseMetadataChange[]
  /** 本轮真实计费用量，来自厂商回包（见 shared/agentUsage.ts），不是渲染层估的 */
  usage?: AgentTurnUsage
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: ChatMessageContent
  status?: 'typing' | 'done'
  /** Terminal runtime outcome, separate from the assistant's answer. */
  outcome?: 'error' | 'stopped'
  suggestions?: string[]
  suggestionsLoading?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolResults?: Array<{ toolName: string; result: any }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actionButtons?: Array<{ label: string; action: string; data?: any }>
  agentProcess?: AgentProcessItem[]
  thinking?: string // 思考过程内容
  startTime?: number // 消息开始时间（用于计算duration）
  citations?: Array<{
    id: string
    title: string
    url?: string
    filePath?: string
    content?: string
    sourceId: string
    type?: string
  }>
  /** 用户消息中@提及的来源列表 */
  mentionedSources?: MentionedSource[]
  /** 用户上传的 Excel 文件列表 */
  excelFiles?: ExcelFileInfo[]
  /** Agent 执行上下文 - 用于历史注入，让 AI 记住操作结果 */
  executionContext?: ExecutionContext
  /** Response provenance metadata */
  responseMetadata?: ResponseMetadata
}

/** 刷新页面时还停在「正在打字」的那条回复 */
export interface HydratedTypingMessage {
  sid: string
  messageId: string
}

/**
 * 恢复缓存时发现的、还挂在 typing 上的回复。
 *
 * **不在这里就地判死。** agent 跑在主进程，刷新只重启了界面，这条回复很可能
 * 还在跑；以前这里直接把它改成「会话已中断（页面刷新）」，那是**猜**的，
 * 而且猜错的那一半后台还在继续改用户的工程。
 *
 * 真正的裁决在 `views/Assistant/composables/agentReattach.ts`：它问一次主进程
 * 谁还活着，活着的接回来，剩下的才标中断。那一步在应用启动时必然会跑
 * （`main.ts`），并且问不到主进程时会退回「全部标中断」的老行为。
 */
const hydratedTypingMessages: HydratedTypingMessage[] = []

/** 取走并清空待裁决清单 —— 只该由重连流程调用一次 */
export function takeHydratedTypingMessages(): HydratedTypingMessage[] {
  return hydratedTypingMessages.splice(0, hydratedTypingMessages.length)
}

/**
 * 给一条中断的回复贴上收尾文案。
 *
 * 内容还是初始占位符就整条换掉（这轮一个字都没输出），已经有正文就在末尾
 * 补一行标记 —— 用户写了一半的那段回复不该因为一次刷新就没了。
 */
export function interruptedTypingContent(content: ChatMessageContent): ChatMessageContent {
  if (typeof content !== 'string') return content
  if (isTypingPlaceholder(content) || content.trim() === '') return '会话已中断（页面刷新）'
  return `${content}\n\n*[会话已中断（页面刷新）]*`
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function restoreMessages(value: unknown): Record<string, ChatMessage[]> {
  if (!isObjectRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, ChatMessage[]] =>
      Array.isArray(entry[1])
    )
  )
}

function restoreStringRecord(value: unknown): Record<string, string> {
  if (!isObjectRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function restoreNumberRecord(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  )
}

export const useChatMessagesStore = defineStore(
  'chat-messages',
  () => {
    const messagesBySid = ref<Record<string, ChatMessage[]>>({})
    const stoppedBySid = ref<Record<string, boolean>>({})
    // 压缩历史摘要缓存：只保存每个会话的历史对话摘要（assistant消息）
    const historySummaryBySid = ref<Record<string, string>>({})
    // 已压缩的user消息计数：记录每个会话已经压缩了多少条user消息
    const compressedUserCountBySid = ref<Record<string, number>>({})

    /**
     * 获取指定会话的消息列表
     * @param sid 会话ID
     * @returns 消息数组（若不存在返回空数组）
     */
    function getMessages(sid: string): ChatMessage[] {
      const k = String(sid || '').trim()
      if (!k) return []
      return messagesBySid.value[k] || []
    }

    /**
     * 确保会话消息容器存在
     * @param sid 会话ID
     */
    function ensureContainer(sid: string): void {
      const k = String(sid || '').trim()
      if (!k) return
      if (!messagesBySid.value[k]) {
        messagesBySid.value[k] = []
      }
    }

    /**
     * 推入一条用户消息
     * @param sid 会话ID
     * @param content 文本内容或多模态内容
     * @param mentionedSources 可选的@提及来源列表
     * @param excelFiles 可选的 Excel 文件列表
     */
    function pushUser(
      sid: string,
      content: ChatMessageContent,
      mentionedSources?: MentionedSource[],
      excelFiles?: ExcelFileInfo[]
    ): string {
      ensureContainer(sid)
      const id = `${Date.now()}-u-${Math.random().toString(16).slice(2)}`
      const message: ChatMessage = { id, role: 'user', content, status: 'done' }
      if (mentionedSources && mentionedSources.length > 0) {
        message.mentionedSources = mentionedSources
      }
      if (excelFiles && excelFiles.length > 0) {
        message.excelFiles = excelFiles
      }
      messagesBySid.value[sid].push(message)
      return id
    }

    /**
     * 推入一条助手"打字中"的占位消息
     * @param sid 会话ID
     * @returns 占位消息ID
     */
    function pushAssistantTyping(sid: string, startTime?: number): string {
      ensureContainer(sid)
      const id = `${Date.now()}-a-${Math.random().toString(16).slice(2)}`
      const now = Date.now()

      // 调试日志：追踪是谁创建了 typing 消息
      console.log('[chatMessages] pushAssistantTyping 调用', {
        sid,
        newId: id,
        existingMessageCount: messagesBySid.value[sid]?.length || 0,
        stack: new Error().stack?.split('\n').slice(1, 5).join('\n')
      })

      // 如果有传入startTime，使用它；否则查找前一条用户消息的时间；最后使用当前时间
      let messageStartTime = startTime
      if (!messageStartTime) {
        const arr = messagesBySid.value[sid]
        // 从后往前查找最后一条用户消息
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i].role === 'user') {
            // 从消息ID中提取时间戳（格式：timestamp-u-xxx 或 timestamp-a-xxx）
            const match = arr[i].id.match(/^(\d+)-/)
            if (match) {
              messageStartTime = parseInt(match[1], 10)
            } else {
              messageStartTime = now
            }
            break
          }
        }
        if (!messageStartTime) {
          messageStartTime = now
        }
      }
      messagesBySid.value[sid].push({
        id,
        role: 'assistant',
        content: TYPING_PLACEHOLDER,
        status: 'typing',
        startTime: messageStartTime
      })
      return id
    }

    /**
     * 直接推入一条完成的助手消息
     * @param sid 会话ID
     * @param content 文本内容
     * @param options 可选配置（toolResults, actionButtons, agentProcess等）
     * @returns 消息ID
     */
    function pushAssistant(
      sid: string,
      content: string,
      options?: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolResults?: Array<{ toolName: string; result: any }>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actionButtons?: Array<{ label: string; action: string; data?: any }>
        agentProcess?: AgentProcessItem[]
      }
    ): string {
      ensureContainer(sid)
      const id = `${Date.now()}-a-${Math.random().toString(16).slice(2)}`
      const message: ChatMessage = {
        id,
        role: 'assistant',
        content,
        status: 'done',
        toolResults: options?.toolResults,
        actionButtons: options?.actionButtons,
        agentProcess: options?.agentProcess ? snapshotAgentProcess(options.agentProcess) : undefined
      }
      messagesBySid.value[sid].push(message)
      return id
    }

    /**
     * 替换助手“打字中”为最终文本或中间态
     * @param sid 会话ID
     * @param typingId 占位消息ID
     * @param content 替换文本内容
     * @param done 是否完成（true 则标记为 done）
     */
    /**
     * 替换助手“打字中”为最终文本或中间态，并可附加工具结果等元数据
     * @param sid 会话ID
     * @param typingId 占位消息ID
     * @param content 替换文本内容
     * @param done 是否完成（true 则标记为 done）
     * @param options 可选元数据（toolResults、actionButtons、agentProcess）
     */
    function replaceTyping(
      sid: string,
      typingId: string,
      content: string,
      done: boolean,
      options?: {
        outcome?: ChatMessage['outcome']
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolResults?: Array<{ toolName: string; result: any }>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actionButtons?: Array<{ label: string; action: string; data?: any }>
        agentProcess?: AgentProcessItem[]
        thinking?: string
        citations?: Array<{
          id: string
          title: string
          url?: string
          filePath?: string
          content?: string
          sourceId: string
          type?: string
        }>
        executionContext?: ExecutionContext
        responseMetadata?: ResponseMetadata
      }
    ): void {
      ensureContainer(sid)
      const arr = messagesBySid.value[sid]
      const idx = arr.findIndex((m) => m.id === typingId)
      if (idx >= 0) {
        const msg = arr[idx]
        // 性能优化：就地更新属性，避免创建新对象
        // 这减少了 Vue 响应式系统在高频流式更新时的开销
        msg.content = content
        msg.outcome = options?.outcome
        const newStatus = done ? 'done' : 'typing'
        if (done) {
          console.log('[chatMessages] replaceTyping 设置状态为 done', {
            sid,
            typingId,
            previousStatus: msg.status,
            newStatus,
            stack: new Error().stack?.split('\n').slice(1, 4).join('\n')
          })
        }
        msg.status = newStatus

        // 仅在提供时更新可选属性
        if (options?.toolResults !== undefined) {
          msg.toolResults = options.toolResults
        }
        if (options?.actionButtons !== undefined) {
          msg.actionButtons = options.actionButtons
        }
        if (options?.agentProcess !== undefined) {
          msg.agentProcess = snapshotAgentProcess(options.agentProcess)
        }
        if (options?.thinking !== undefined) {
          msg.thinking = options.thinking
        }
        if (options?.citations !== undefined) {
          msg.citations = options.citations
        }
        if (options?.executionContext !== undefined) {
          msg.executionContext = options.executionContext
        }
        if (options?.responseMetadata !== undefined) {
          msg.responseMetadata = options.responseMetadata
        }
        // startTime 保持不变，不需要更新
      }
    }

    /**
     * 追加文本到助手占位消息（流式）
     * @param sid 会话ID
     * @param typingId 占位消息ID
     * @param delta 增量文本
     */
    function appendToTyping(sid: string, typingId: string, delta: string): void {
      ensureContainer(sid)
      const arr = messagesBySid.value[sid]
      const idx = arr.findIndex((m) => m.id === typingId)
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], content: `${arr[idx].content}${delta}` }
      }
    }

    /**
     * 停止当前流式生成（标记为完成）
     * @param sid 会话ID
     * @param typingId 占位消息ID
     */
    function stopTyping(sid: string, typingId: string): void {
      ensureContainer(sid)
      stoppedBySid.value[sid] = true
      const arr = messagesBySid.value[sid]
      const idx = arr.findIndex((m) => m.id === typingId)
      if (idx >= 0) {
        let newContent = arr[idx].content
        if (typeof newContent === 'string') {
          if (isTypingPlaceholder(newContent)) {
            // 如果内容还是初始的占位符，说明还没有任何输出，显示为"用户终止"
            newContent = '用户终止'
          } else {
            // 如果已有输出内容，在后面附加"用户终止"
            newContent = `${newContent}\n\n*[用户终止]*`
          }
        }
        arr[idx] = { ...arr[idx], content: newContent, status: 'done' }
      }
    }

    /**
     * 查询会话是否已请求停止
     * @param sid 会话ID
     */
    function isStopped(sid: string): boolean {
      return !!stoppedBySid.value[String(sid || '').trim()]
    }

    /**
     * 清空指定会话消息
     * @param sid 会话ID
     */
    function clearSessionMessages(sid: string): void {
      const k = String(sid || '').trim()
      if (!k) return
      messagesBySid.value[k] = []
    }

    /** 用一份独立快照替换某个会话的消息（MiniChat → 主窗口同步）。 */
    function replaceSessionMessages(sid: string, messages: ChatMessage[]): void {
      const k = String(sid || '').trim()
      if (!k || !Array.isArray(messages)) return
      messagesBySid.value[k] = JSON.parse(JSON.stringify(messages)) as ChatMessage[]
    }

    /**
     * 会话被删除时，把它在这个 store 里的所有痕迹拿掉。
     *
     * 与 `clearSessionMessages` 的区别是**删键**而不是置空：置空只清正文，
     * 留下的空数组、摘要、压缩计数会一直躺在历史文件里，删得越多攒得
     * 越厚，而它们对应的会话早已不存在。
     *
     * 四个 map 一个都不能漏 —— 只删 messagesBySid 的话，同一个 sid 万一被
     * 复用（新会话恰好用了旧 id），历史摘要会以「上一段对话的记忆」的身份
     * 被注入进去。
     */
    function dropSession(sid: string): void {
      dropSessions([sid])
    }

    /**
     * 批量版的 `dropSession`：一次清掉一组会话在这四张 map 里的所有痕迹。
     *
     * 单独存在的原因是动作语义：一批会话应当在同一个检查点里消失，不能让
     * 中间态落盘后留下只有摘要、没有正文的半截记录。
     */
    function dropSessions(sids: string[]): void {
      for (const sid of sids) {
        const k = String(sid || '').trim()
        if (!k) continue
        delete messagesBySid.value[k]
        delete stoppedBySid.value[k]
        delete historySummaryBySid.value[k]
        delete compressedUserCountBySid.value[k]
      }
    }

    /**
     * 设置消息的建议列表
     * @param sid 会话ID
     * @param messageId 消息ID
     * @param suggestions 建议数组
     */
    function setSuggestions(sid: string, messageId: string, suggestions: string[]): void {
      ensureContainer(sid)
      const arr = messagesBySid.value[sid]
      const idx = arr.findIndex((m) => m.id === messageId)
      console.log('[chatMessages] setSuggestions 调用', {
        sid,
        messageId,
        suggestions,
        found: idx >= 0,
        messageCount: arr.length,
        allMessageIds: arr.map((m) => m.id)
      })
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], suggestions }
        console.log('[chatMessages] setSuggestions 成功设置', {
          messageId,
          newSuggestions: arr[idx].suggestions
        })
      } else {
        console.warn('[chatMessages] setSuggestions 失败: 找不到消息ID', messageId)
      }
    }

    /**
     * 设置消息的建议加载状态
     * @param sid 会话ID
     * @param messageId 消息ID
     * @param loading 是否正在加载
     */
    function setSuggestionsLoading(sid: string, messageId: string, loading: boolean): void {
      ensureContainer(sid)
      const arr = messagesBySid.value[sid]
      const idx = arr.findIndex((m) => m.id === messageId)
      console.log('[chatMessages] setSuggestionsLoading 调用', {
        sid,
        messageId,
        loading,
        found: idx >= 0
      })
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], suggestionsLoading: loading }
      }
    }

    /**
     * 从消息内容中提取纯文本
     * @param content 消息内容（字符串或多模态数组）
     * @returns 提取的纯文本
     */
    function extractTextFromContent(content: ChatMessageContent): string {
      if (typeof content === 'string') {
        return content
      }
      // 多模态内容：拼接所有文本部分
      return content
        .filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text)
        .join('\n')
    }

    /**
     * 从消息内容中提取图片URL列表
     * @param content 消息内容（字符串或多模态数组）
     * @returns 图片URL数组
     */
    function extractImagesFromContent(content: ChatMessageContent): string[] {
      if (typeof content === 'string') {
        return []
      }
      return content
        .filter((item) => item.type === 'image_url' && item.image_url?.url)
        .map((item) => item.image_url!.url)
    }

    /**
     * 删除指定索引及之后的所有消息
     * @param sid 会话ID
     * @param fromIndex 起始索引（包含该索引）
     */
    function deleteMessagesFromIndex(sid: string, fromIndex: number): void {
      const k = String(sid || '').trim()
      if (!k) return
      const arr = messagesBySid.value[k]
      if (!arr || fromIndex < 0 || fromIndex >= arr.length) return
      messagesBySid.value[k] = arr.slice(0, fromIndex)
      // 删除消息时，同时清空历史摘要和计数
      delete historySummaryBySid.value[k]
      delete compressedUserCountBySid.value[k]
    }

    /**
     * 摘掉一条消息上的操作按钮，消息本身留在原地。
     *
     * 用在「点了就不该再点第二次」的按钮上（报错气泡的「继续尝试」）。
     * 之前那版是把整条消息删掉 —— 而 Agent 跑一轮的全部过程日志（思考、每次
     * 工具调用、进度）都攒在**这同一条**消息里，报错文案只是最后盖上去的一层。
     * 删掉按钮所在的消息，等于把那一轮用户能看见的记录全抹了：屏幕上只剩自己
     * 发的那句话和一句「从断点继续执行…」，像是任务从头开始了（其实没有，
     * 模型上下文在主进程那份会话里，续跑照旧接着断点走）。
     */
    function clearActionButtons(sid: string, messageId: string): void {
      const k = String(sid || '').trim()
      const id = String(messageId || '').trim()
      if (!k || !id) return
      const msg = messagesBySid.value[k]?.find((message) => message.id === id)
      if (!msg?.actionButtons) return
      // 就地改：整条消息（含整轮过程日志）留着，只有按钮消失
      msg.actionButtons = undefined
    }

    /**
     * 更新用户消息内容
     * @param sid 会话ID
     * @param messageId 消息ID
     * @param newContent 新的消息内容
     */
    function updateUserMessage(
      sid: string,
      messageId: string,
      newContent: ChatMessageContent
    ): void {
      const k = String(sid || '').trim()
      if (!k) return
      const arr = messagesBySid.value[k]
      if (!arr) return
      const idx = arr.findIndex((m) => m.id === messageId)
      if (idx >= 0 && arr[idx].role === 'user') {
        arr[idx] = { ...arr[idx], content: newContent }
      }
    }

    /**
     * 获取已压缩的user消息数
     * @param sid 会话ID
     * @returns 已压缩的user消息数，如果不存在则返回0
     */
    function getCompressedUserCount(sid: string): number {
      const k = String(sid || '').trim()
      if (!k) return 0
      return compressedUserCountBySid.value[k] || 0
    }

    /**
     * 设置已压缩的user消息数
     * @param sid 会话ID
     * @param count 已压缩的user消息数
     */
    function setCompressedUserCount(sid: string, count: number): void {
      const k = String(sid || '').trim()
      if (!k) return
      compressedUserCountBySid.value[k] = count
    }

    /**
     * 获取历史摘要（用于AI请求时插入）
     * @param sid 会话ID
     * @returns 历史摘要文本，如果不存在则返回null
     */
    function getHistorySummary(sid: string): string | null {
      const k = String(sid || '').trim()
      if (!k) return null
      return historySummaryBySid.value[k] || null
    }

    /**
     * 设置历史摘要（保存压缩后的摘要文本）
     * @param sid 会话ID
     * @param summary 摘要文本
     */
    function setHistorySummary(sid: string, summary: string): void {
      const k = String(sid || '').trim()
      if (!k) return
      historySummaryBySid.value[k] = summary
    }

    /**
     * 清空历史摘要
     * @param sid 会话ID
     */
    function clearHistorySummary(sid: string): void {
      const k = String(sid || '').trim()
      if (!k) return
      delete historySummaryBySid.value[k]
    }

    /**
     * 清空历史摘要（已废弃，保留兼容）
     */
    function clearHistorySummary_deprecated(sid: string): void {
      const k = String(sid || '').trim()
      if (!k) return
      delete historySummaryBySid.value[k]
    }

    /**
     * 把一个会话的消息复制到另一个会话（会话分支用）。
     *
     * `upToIndex` 是分叉点的下标，连它一起复制、后面的丢掉；不给就整份复制。
     * 先按下标切再滤 typing，不能反过来 —— 下标是调用方在**没滤过**的这份
     * 列表上数出来的，先滤会让它错位。
     *
     * 深拷贝是必须的：两边之后各聊各的，共享引用会让分支里的编辑
     * 写穿回源会话。JSON 往返而不是 structuredClone —— store 里的消息是
     * Vue 响应式代理，structuredClone 直接 DataCloneError；而且这些数据
     * 本来就是 JSON 持久化的，往返一遍丢不了的才是真会丢的。
     * typing 状态的丢弃 —— 分支建立时会话必然不在跑，
     * 万一混进来一条，它在新会话里也永远不会有人收尾。
     */
    function copySessionMessages(
      fromSid: string,
      toSid: number | string,
      upToIndex?: number
    ): void {
      const from = String(fromSid || '').trim()
      const to = String(toSid || '').trim()
      if (!from || !to || from === to) return

      const source = messagesBySid.value[from]
      if (!Array.isArray(source) || source.length === 0) return

      const kept = typeof upToIndex === 'number' ? source.slice(0, upToIndex + 1) : source

      messagesBySid.value[to] = kept
        .filter((m) => m.status !== 'typing')
        .map((m) => JSON.parse(JSON.stringify(m)) as ChatMessage)
    }

    /**
     * 把一条中断的回复收尾。
     *
     * 页面刷新后，问过主进程、确认这条会话**真的已经不在跑了**才调这里。
     * 已经收过尾（status 不是 typing）的不再动 —— 重连流程和事件流可能先后
     * 都碰到同一条消息，重复贴一遍标记会变成「会话已中断」叠两行。
     */
    function markTypingInterrupted(sid: string, messageId: string): void {
      const arr = messagesBySid.value[String(sid || '').trim()]
      if (!Array.isArray(arr)) return

      const idx = arr.findIndex((m) => m.id === messageId)
      if (idx < 0 || arr[idx].status !== 'typing') return

      arr[idx] = {
        ...arr[idx],
        content: interruptedTypingContent(arr[idx].content),
        status: 'done'
      }
    }

    /**
     * 导出持久化快照。
     *
     * `toRaw` 很关键：对 5 MB 的 Vue 深层代理直接 JSON.stringify 会比原始对象慢
     * 数倍。快照只在检查点读取，流式事件路径不碰整份历史。
     */
    function exportChatMessagesPersistence(): ChatMessagesPersistedState {
      return {
        messagesBySid: toRaw(messagesBySid.value),
        historySummaryBySid: toRaw(historySummaryBySid.value),
        compressedUserCountBySid: toRaw(compressedUserCountBySid.value)
      }
    }

    /** 从磁盘快照恢复，并登记仍在运行、需要向主进程核实的 typing 消息。 */
    function hydrateChatMessagesPersistence(snapshot: unknown): void {
      const persisted = isObjectRecord(snapshot) ? snapshot : {}
      messagesBySid.value = restoreMessages(persisted.messagesBySid)
      historySummaryBySid.value = restoreStringRecord(persisted.historySummaryBySid)
      compressedUserCountBySid.value = restoreNumberRecord(persisted.compressedUserCountBySid)
      // 停止标记只属于当前渲染进程，不跨启动恢复。
      stoppedBySid.value = {}
      hydratedTypingMessages.splice(0, hydratedTypingMessages.length)

      for (const sid in messagesBySid.value) {
        const messages = messagesBySid.value[sid]
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]
          if (msg.role === 'assistant' && msg.status === 'typing') {
            hydratedTypingMessages.push({ sid, messageId: msg.id })
          }

          // 追加提问请求活在渲染层，刷新后无法恢复，不能留一个永远转圈的按钮。
          if (msg.suggestionsLoading) {
            messages[i] = { ...msg, suggestionsLoading: false }
          }
        }
      }

      if (hydratedTypingMessages.length > 0) {
        console.log(
          `[chatMessages] hydrate: ${hydratedTypingMessages.length} 条回复还挂在 typing 上，等重连流程裁决`
        )
      }
    }

    return {
      messagesBySid,
      stoppedBySid,
      getMessages,
      ensureContainer,
      pushUser,
      pushAssistantTyping,
      pushAssistant,
      replaceTyping,
      appendToTyping,
      stopTyping,
      isStopped,
      clearSessionMessages,
      replaceSessionMessages,
      dropSession,
      dropSessions,
      copySessionMessages,
      setSuggestions,
      setSuggestionsLoading,
      extractTextFromContent,
      extractImagesFromContent,
      deleteMessagesFromIndex,
      clearActionButtons,
      updateUserMessage,
      getCompressedUserCount,
      setCompressedUserCount,
      getHistorySummary,
      setHistorySummary,
      clearHistorySummary,
      markTypingInterrupted,
      exportChatMessagesPersistence,
      hydrateChatMessagesPersistence
    }
  },
  {}
)
