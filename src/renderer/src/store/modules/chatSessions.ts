import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import { chatHistoryStorage } from '../../utils/chatHistoryStorage'
import { agentV3API } from '@renderer/api/agentV3'
import { useChatSidebarStore } from './chatSidebarStore'

export interface BoundNotebook {
  notebookId: string
  title: string
}

/**
 * 会话归属的 UE 工程。
 *
 * 第一次发消息时，如果当时有已连接的 UE 工程，就把它盖在会话上（见
 * `views/Assistant/composables/sessionProjectBinding.ts`）；之后侧边栏按它分组。
 * 没盖上工程的会话就是「纯会话」——只是聊天，跟哪个工程都没关系。
 */
export interface ChatSessionProject {
  projectName: string
  projectPath?: string
  engineVersion?: string
}

/**
 * 一条会话的权限档位。
 *
 * `read-only` 是界面上那一档「只读」（工具清单里根本没有写工具），
 * 其余三档直接对应内核的审批档位。
 */
export type ChatPermissionMode = 'read-only' | AgentV3ApprovalMode

/**
 * 尚未发送的图片。
 *
 * File 与 data URL 都只允许留在 renderer 内存中；不能跟会话历史一起序列化，
 * 否则几张图片就足以把持久层撑大。
 */
export interface ChatImageDraft {
  id: string
  file: File
  preview: string
  url?: string
  uploading: boolean
  error?: string
}

/** 所有会话合计最多暂存 20MB 图片原始字节，避免长期切换 Tab 让内存无界增长。 */
export const MAX_IMAGE_DRAFT_BYTES = 20 * 1024 * 1024

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  /** 最近一次内容活动；只在新建会话或新增消息时更新，用于侧边栏“最近”排序 */
  updatedAt: number
  lastMessagePreview?: string
  boundNotebook?: BoundNotebook | null
  /** 会话归属的 UE 工程；不存在表示纯会话 */
  project?: ChatSessionProject | null
  /** 侧边栏置顶 */
  pinned?: boolean
  /** 置顶时间，用于置顶区内部排序 */
  pinnedAt?: number
  /** 已归档：从主列表收起，但不删除 */
  archived?: boolean
  /** 归档时间，用于已归档区排序 */
  archivedAt?: number
  /**
   * 后台跑完的任务还没被看过。
   *
   * 只在「任务完成时用户不在这条会话里」才置位，侧边栏用一个蓝点提示；
   * 打开这条会话就自动清掉。
   */
  taskDone?: boolean
  /** 任务完成的时间 */
  taskDoneAt?: number
  agentMode?: boolean
  agentSessionId?: string
  /**
   * 上一次内核报上来的上下文用量。
   *
   * **要跟着会话一起存盘。** 只放在内存里的话，刷新页面、切走再切回来、
   * 重开应用之后指示器就空了 —— 用户明明有一屋子历史，却要再发一条消息
   * 才能知道自己用了多少，那正是他想避免的。
   */
  contextUsage?: { tokens: number; contextWindow: number }
  agentHistory?: any[]
  agentCurrentText?: string
  isImageGenerationMode?: boolean
  skillMode?: boolean
}

export const useChatSessionsStore = defineStore(
  'chat-sessions',
  () => {
    const sessions = ref<ChatSession[]>([])
    /** 仅保留到本次应用运行结束；草稿不属于聊天记录，不写入持久层。 */
    const draftsById = ref<Record<string, string>>({})
    const imageDraftsById = ref<Record<string, ChatImageDraft[]>>({})

    /**
     * 每条会话自己的权限档位。
     *
     * **单独一张表，不挂在 `ChatSession` 上**：会话要发出第一条消息才会进
     * `sessions`（见 Welcome 里的 `ensureSession`），而用户完全可能一开新标签
     * 就先把权限调成只读再打字 —— 挂在会话记录上的话，那次选择会被静默丢掉。
     *
     * 没有记录表示「跟随设置页的默认档位」，见 `composables/sessionPermissionMode.ts`。
     */
    const permissionModeById = ref<Record<string, ChatPermissionMode>>({})

    function sessionById(id: string): ChatSession | null {
      return sessions.value.find((session) => session.id === id) || null
    }

    /**
     * 按**内核**会话 id 反查界面上的这条会话。
     *
     * 一条会话有两个 id：界面这边的 `id`（标签页、消息、草稿都用它），和内核
     * 那边的 `agentSessionId`（`agent-v3:*` 全部通道用它）。主进程报上来的东西
     * ——资产锁的锁主、语音派活的目标——带的都是后者，拿它去 `sessionById`
     * 永远查不到，界面就只能显示一句「不认识的会话」。
     */
    function sessionByAgentSessionId(agentSessionId: string): ChatSession | null {
      if (!agentSessionId) return null
      return sessions.value.find((session) => session.agentSessionId === agentSessionId) || null
    }

    const sortedSessions = computed<ChatSession[]>(() => {
      return [...sessions.value].sort((left, right) => right.updatedAt - left.updatedAt)
    })

    /**
     * 会话列表里该露面的那些。
     *
     * 页面内嵌的助手（知识库详情页、蓝图库 / 材质库详情页）各自有一条固定 id
     * 的会话，跟着那个条目走。它们不进侧边栏 —— 用户开十个蓝图就是十条，
     * 会把他真正的对话冲得找不着，而且那些会话只在对应页面里有意义。
     */
    const listableSessions = computed<ChatSession[]>(() => {
      return sortedSessions.value.filter(
        (session) =>
          !session.id.startsWith('notebook-chat-') && !session.id.startsWith('library-chat-')
      )
    })

    /** 侧边栏主列表：不含已归档 */
    const displayableSessions = computed<ChatSession[]>(() => {
      return listableSessions.value.filter((session) => !session.archived)
    })

    /** 已归档的会话，单独一区收着 */
    const archivedSessions = computed<ChatSession[]>(() => {
      return listableSessions.value.filter((session) => session.archived)
    })

    function createSession(id: string, initialTitle?: string): ChatSession {
      const existing = sessions.value.find((session) => session.id === id)
      if (existing) {
        return existing
      }

      const now = Date.now()
      const title = (initialTitle || 'AI会话').trim() || 'AI会话'
      const session: ChatSession = {
        id,
        title,
        createdAt: now,
        updatedAt: now
      }

      sessions.value.unshift(session)
      return session
    }

    function ensureSession(id: string, initialTitle?: string): ChatSession {
      return sessionById(id) || createSession(id, initialTitle)
    }

    function updateTitle(id: string, title: string): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session) return

      const nextTitle = String(title || '').trim()
      if (!nextTitle || session.title === nextTitle) return

      session.title = nextTitle
    }

    function appendMessage(id: string, text: string): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session) return

      const preview = String(text || '').trim()
      if (preview) {
        session.lastMessagePreview = preview.slice(0, 80)
      }
      session.updatedAt = Date.now()
    }

    function clearPreview(id: string): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session) return
      if (session.lastMessagePreview === '') return

      session.lastMessagePreview = ''
    }

    function getDraft(id: string): string {
      return draftsById.value[id] || ''
    }

    function setDraft(id: string, content: string): void {
      if (!id) return
      if (content) {
        draftsById.value[id] = content
      } else {
        delete draftsById.value[id]
      }
    }

    function getImageDraft(id: string): ChatImageDraft[] {
      return imageDraftsById.value[id] || []
    }

    function getImageDraftBytes(): number {
      return Object.values(imageDraftsById.value).reduce(
        (total, images) => total + images.reduce((sum, image) => sum + image.file.size, 0),
        0
      )
    }

    /**
     * 原子替换一条会话的图片草稿。
     *
     * 先扣掉这条会话的旧草稿再计算，替换/删除不会被总量上限误伤。
     */
    function trySetImageDraft(id: string, images: ChatImageDraft[]): boolean {
      if (!id) return false

      const previousBytes = getImageDraft(id).reduce((sum, image) => sum + image.file.size, 0)
      const nextBytes = images.reduce((sum, image) => sum + image.file.size, 0)
      if (getImageDraftBytes() - previousBytes + nextBytes > MAX_IMAGE_DRAFT_BYTES) return false

      if (images.length > 0) {
        imageDraftsById.value[id] = images
      } else {
        delete imageDraftsById.value[id]
      }
      return true
    }

    function clearDraft(id: string): void {
      delete draftsById.value[id]
      delete imageDraftsById.value[id]
    }

    function removeSession(id: string): void {
      removeSessions([id])
    }

    /**
     * 批量版的 `removeSession`：一次滤掉一组。
     *
     * 单独存在的原因同 `chatMessages.dropSessions` —— 每次变更都会把整个
     * sessions 数组序列化进 localStorage，批量删除必须合并成一次变更，
     * 不然 N 条会话就是 N 次全量写盘加 N 次列表重排。
     */
    function removeSessions(ids: string[]): void {
      if (ids.length === 0) return

      const doomed = new Set(ids)
      sessions.value = sessions.value.filter((session) => !doomed.has(session.id))
      ids.forEach(clearDraft)

      // 档位表跟着一起清。留着的话它会随用户开会话一直长，而且哪天 id 撞上
      // （会话 id 是外面给的）新会话会莫名其妙继承一个别人的权限档位
      const nextModes = { ...permissionModeById.value }
      let removed = false
      for (const id of ids) {
        if (nextModes[id] === undefined) continue
        delete nextModes[id]
        removed = true
      }
      if (removed) permissionModeById.value = nextModes
    }

    /** 没设过就返回 undefined —— 「没设过」和「设成了某一档」不是一回事 */
    function getPermissionMode(id: string): ChatPermissionMode | undefined {
      return id ? permissionModeById.value[id] : undefined
    }

    function setPermissionMode(id: string, mode: ChatPermissionMode): void {
      if (!id || permissionModeById.value[id] === mode) return

      permissionModeById.value = { ...permissionModeById.value, [id]: mode }
    }

    /**
     * 设置/取消置顶。
     *
     * 刻意不动 `updatedAt`：置顶是「我关心它」，不是「它刚有新消息」。
     * 把它顶到「最近更新」的第一位会让排序失真——取消置顶后顺序也回不去了。
     */
    function setPinned(id: string, pinned: boolean): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || Boolean(session.pinned) === pinned) return

      session.pinned = pinned
      session.pinnedAt = pinned ? Date.now() : undefined
    }

    function togglePinned(id: string): boolean {
      const session = sessions.value.find((item) => item.id === id)
      if (!session) return false

      setPinned(id, !session.pinned)
      return Boolean(session.pinned)
    }

    /**
     * 归档/取消归档。
     *
     * 和置顶一样不动 `updatedAt`：归档是收纳动作，不是新内容。
     * 归档时顺手取消置顶——一条会话不该既在置顶区又在已归档区。
     */
    function setArchived(id: string, archived: boolean): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || Boolean(session.archived) === archived) return

      session.archived = archived
      session.archivedAt = archived ? Date.now() : undefined
      if (archived && session.pinned) {
        session.pinned = false
        session.pinnedAt = undefined
      }
    }

    function toggleArchived(id: string): boolean {
      const session = sessions.value.find((item) => item.id === id)
      if (!session) return false

      setArchived(id, !session.archived)
      return Boolean(session.archived)
    }

    /** 标记「这条会话的任务跑完了，还没看」 */
    function markTaskDone(id: string): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || session.taskDone) return

      session.taskDone = true
      session.taskDoneAt = Date.now()
    }

    /** 打开会话时清掉提示 */
    function clearTaskDone(id: string): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || !session.taskDone) return

      session.taskDone = false
      session.taskDoneAt = undefined
    }

    function getProject(id: string): ChatSessionProject | null {
      return withSidebarProjectPath(sessionById(id)?.project || null)
    }

    /**
     * 老会话只存了名字时，用侧栏里那份补上路径。
     *
     * 这里**不必**防「同名不同目录」：`chatSidebarStore.addManualProject` 按归一化
     * 名字去重，同一个名字在清单里永远只有一条。真要防的话也防不在这一层 ——
     * 得防在入库那边。
     */
    function withSidebarProjectPath(project: ChatSessionProject | null): ChatSessionProject | null {
      if (!project || project.projectPath?.trim()) return project
      const saved = useChatSidebarStore().manualProjects.find((item) =>
        sameProjectName(item.projectName, project.projectName)
      )
      if (!saved?.projectPath?.trim()) return project
      return {
        ...project,
        projectPath: saved.projectPath.trim(),
        ...(project.engineVersion || !saved.engineVersion
          ? {}
          : { engineVersion: saved.engineVersion })
      }
    }

    /**
     * 绑定/解绑会话所属的 UE 工程。
     *
     * 同样不动 `updatedAt`——改分组不是产生了新内容。
     */
    function setProject(id: string, project: ChatSessionProject | null): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session) return

      project = withSidebarProjectPath(project)
      const current = session.project || null
      const next = project
        ? {
            projectName: project.projectName.trim(),
            projectPath: project.projectPath?.trim() || undefined,
            engineVersion: project.engineVersion?.trim() || undefined
          }
        : null

      if (next && !next.projectName) return
      if (
        current?.projectName === next?.projectName &&
        current?.projectPath === next?.projectPath &&
        current?.engineVersion === next?.engineVersion
      ) {
        return
      }

      session.project = next
      pushProjectToMain(session)
    }

    /**
     * 把归属告诉主进程。
     *
     * 归属真正的主人是主进程那张表。随消息捎带的那份戳只在表里还空着时用来
     * 初始化，所以会话发过第一条消息之后，**只改 store 是改不动归属的** ——
     * 胶囊上写着新工程，引擎命令还发往旧的那个。用户点一下就是一次明确的写，
     * 和模型调 `set_session_project` 是同一件事，该走同一条路。
     *
     * 还没跑过的会话没有内核 id，这时不用发：它的第一条消息会带着戳下去，
     * 主进程照那份戳初始化，结果一样。
     */
    function pushProjectToMain(session: ChatSession): void {
      const agentSessionId = session.agentSessionId?.trim()
      if (!agentSessionId) return

      // 走 `api/agentV3.ts` 而不是直接碰 `window.api`：AGENTS.md 硬规则 5 要求
      // 渲染层一律经过 `src/renderer/src/api/*` 并用 `unwrapResult()`。这里不是
      // 形式问题 —— 主进程把 `{ success: false }` 当正常返回值 resolve，不过
      // `unwrapResult()` 的话失败根本不会变成 rejection，下面的 catch 永远不执行
      void agentV3API
        .setSessionProject({ sessionId: agentSessionId, project: session.project })
        .catch((error: unknown) => {
          // 界面已经改了，这条只是让主进程跟上。失败就让下一次改动或下一条
          // 消息的戳去补，不弹错打扰用户
          console.warn('[chatSessions] 同步会话归属到主进程失败:', error)
        })
    }

    /**
     * 解除会话的工程归属。
     *
     * 这里直接写 `null` 而不是走 `setProject` 的去重：`undefined`（从没定过）
     * 和 `null`（用户明说了「不归属」）不是一回事 —— 首条消息的自动归属
     * （`sessionProjectBinding`）就靠这个区别决定要不要盖戳，去重会把
     * 「从没定过 → 明说不归属」这一步吃掉。
     */
    function clearProject(id: string): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session) return

      session.project = null
      pushProjectToMain(session)
    }

    function sameProjectName(left: string, right: string): boolean {
      return left.trim().toLowerCase() === right.trim().toLowerCase()
    }

    /**
     * 把某个工程下所有会话的工程名改掉（侧边栏「重命名项目」用）。
     *
     * @returns 改动的会话数
     */
    function renameProject(projectName: string, nextName: string): number {
      const target = nextName.trim()
      if (!projectName.trim() || !target) return 0

      let changed = 0
      for (const session of sessions.value) {
        const current = session.project?.projectName
        if (!current || !sameProjectName(current, projectName)) continue

        // 走 `setProject` 而不是直接赋值：归属的主人在主进程那张表上，直接写
        // store 只改了投影。只有名字的归属（侧边栏「在这个工程下新建会话」盖的
        // 就是这种）尤其要紧 —— 那时名字**就是**匹配键，表里还留着旧名字的话，
        // 整个进程里这条会话都认不回工程，`engineAvailable` 一直是 false
        setProject(session.id, { ...session.project, projectName: target })
        changed += 1
      }
      return changed
    }

    /** 某个工程下的所有会话（含已归档） */
    function sessionsOfProject(projectName: string): ChatSession[] {
      if (!projectName.trim()) return []
      return sessions.value.filter((session) => {
        const current = session.project?.projectName
        return Boolean(current) && sameProjectName(current as string, projectName)
      })
    }

    function getAgentMode(id: string): boolean {
      return sessionById(id)?.agentMode ?? true
    }

    function setAgentMode(id: string, agentMode: boolean): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || (session.agentMode ?? true) === agentMode) return

      session.agentMode = agentMode
    }

    function getAgentSessionId(id: string): string {
      return sessionById(id)?.agentSessionId || ''
    }

    function setAgentSessionId(id: string, sessionId: string): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || session.agentSessionId === sessionId) return

      session.agentSessionId = sessionId
    }

    function getContextUsage(id: string): ChatSession['contextUsage'] {
      return sessionById(id)?.contextUsage
    }

    /**
     * 记下内核报上来的上下文用量。
     *
     * 故意**不动 `updatedAt`** —— 那个字段决定侧边栏的排序，用量每轮更新一次，
     * 跟着动会让会话列表因为「没说话但数字变了」而重排。
     */
    function setContextUsage(id: string, usage: { tokens: number; contextWindow: number }): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session) return
      session.contextUsage = usage
    }

    function clearContextUsage(id: string): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session?.contextUsage) return
      session.contextUsage = undefined
    }

    function getAgentHistory(id: string): any[] {
      return sessionById(id)?.agentHistory || []
    }

    function setAgentHistory(id: string, history: any[]): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || session.agentHistory === history) return

      session.agentHistory = history
    }

    function getAgentCurrentText(id: string): string {
      return sessionById(id)?.agentCurrentText || ''
    }

    function setAgentCurrentText(id: string, text: string): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || session.agentCurrentText === text) return

      session.agentCurrentText = text
    }

    function getBoundNotebook(id: string): BoundNotebook | null {
      return sessionById(id)?.boundNotebook || null
    }

    function setBoundNotebook(id: string, boundNotebook: BoundNotebook | null): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session) return

      const current = session.boundNotebook
      if (
        current?.notebookId === boundNotebook?.notebookId &&
        current?.title === boundNotebook?.title
      ) {
        return
      }

      session.boundNotebook = boundNotebook ? { ...boundNotebook } : null
    }

    function clearBoundNotebook(id: string): void {
      setBoundNotebook(id, null)
    }

    function getImageGenerationMode(id: string): boolean {
      return sessionById(id)?.isImageGenerationMode ?? false
    }

    function setImageGenerationMode(id: string, isImageGenerationMode: boolean): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || (session.isImageGenerationMode ?? false) === isImageGenerationMode) return

      session.isImageGenerationMode = isImageGenerationMode
    }
    function getSkillMode(id: string): boolean {
      return sessionById(id)?.skillMode ?? false
    }

    function setSkillMode(id: string, skillMode: boolean): void {
      const session = sessions.value.find((item) => item.id === id)
      if (!session || (session.skillMode ?? false) === skillMode) return

      session.skillMode = skillMode
    }

    return {
      sessions,
      draftsById,
      imageDraftsById,
      permissionModeById,
      getPermissionMode,
      setPermissionMode,
      sortedSessions,
      displayableSessions,
      archivedSessions,
      sessionById,
      sessionByAgentSessionId,
      createSession,
      ensureSession,
      updateTitle,
      appendMessage,
      clearPreview,
      getDraft,
      setDraft,
      getImageDraft,
      getImageDraftBytes,
      trySetImageDraft,
      clearDraft,
      removeSession,
      removeSessions,
      setPinned,
      togglePinned,
      setArchived,
      toggleArchived,
      markTaskDone,
      clearTaskDone,
      getProject,
      setProject,
      clearProject,
      renameProject,
      sessionsOfProject,
      getAgentMode,
      setAgentMode,
      getAgentSessionId,
      setAgentSessionId,
      getContextUsage,
      setContextUsage,
      clearContextUsage,
      getAgentHistory,
      setAgentHistory,
      getAgentCurrentText,
      setAgentCurrentText,
      getBoundNotebook,
      setBoundNotebook,
      clearBoundNotebook,
      getImageGenerationMode,
      setImageGenerationMode,
      getSkillMode,
      setSkillMode
    }
  },
  {
    persist: {
      ...usePersistOptions<{
        sessions: ChatSession[]
        permissionModeById: Record<string, ChatPermissionMode>
        draftsById: Record<string, string>
      }>({
        key: 'chat-sessions',
        // 档位要存盘：重开应用之后，用户设成只读的那条会话还得是只读的 ——
        // 不存的话它会悄悄退回默认档，而他以为自己锁上了
        //
        // 草稿同理，而且更直接：用户在输入框里打了半段话没发，关掉应用再打开，
        // 那段话本来会消失。切会话时它是留着的（内存里），偏偏关应用不留 ——
        // 对用户来说这两件事没有区别，凭什么一个记一个不记
        paths: ['sessions', 'permissionModeById', 'draftsById']
      }),
      // 跟 chat-messages 一起落磁盘：会话里挂着 agentHistory（整条过程时间线），
      // 留在 localStorage 里迟早撑爆配额。
      storage: chatHistoryStorage
    }
  }
)
