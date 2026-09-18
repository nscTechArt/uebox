import type { ChatSession, ChatSessionProject } from '@renderer/store/modules/chatSessions'

export interface StampSessionProjectDeps {
  sessionId: string
  getSession: (id: string) => ChatSession | null
  setProject: (id: string, project: ChatSessionProject | null) => void
  /**
   * 用户点「在这个工程下新建会话」时指定的工程名 —— 会话归属**只**认这个。
   * 侧边栏通过路由参数 `?project=` 传过来。
   */
  preferredProjectName?: string
}

/** 发过 IPC 的那份会话归属工程。字段是普通值，能被结构化克隆搬动 */
export interface SessionProjectPayload {
  projectName: string
  projectPath?: string
  engineVersion?: string
}

/**
 * 把会话上的工程戳拍成一个普通对象，再交给主进程。
 *
 * **不能直接把 store 里那份传下去**：Pinia 的 state 是 Vue 的响应式代理，
 * 结构化克隆搬不动 Proxy —— Electron 会抛 `An object could not be cloned.`，
 * 用户看到的就是发一条消息弹「Agent 执行异常」，正文一个字都没有。
 * （真机上踩过：加了工程归属透传之后，每条消息都这样。）
 *
 * 顺带把空名字归一成 null：那和「没定过归属」是同一件事，交给主进程按
 * 纯对话处理，而不是把会话锁死在一个名字是空串的工程上。
 */
export function toSessionProjectPayload(
  project: ChatSessionProject | null | undefined
): SessionProjectPayload | null {
  const projectName = project?.projectName?.trim()
  if (!projectName) return null

  return {
    projectName,
    ...(project?.projectPath ? { projectPath: String(project.projectPath) } : {}),
    ...(project?.engineVersion ? { engineVersion: String(project.engineVersion) } : {})
  }
}

/**
 * 只在「会话存在」且「还没定过归属」时盖戳。
 *
 * 定过就不再改：用户后来关了工程、开了另一个工程，甚至手动改过归属，
 * 都不该让这条老对话在侧边栏里跳到别的工程下面。
 *
 * `project === null` 是用户明说了「不归属任何工程」（顶栏胶囊或侧边栏的
 * 「移出项目」），和从没定过的 `undefined` 要分开看 —— 否则用户刚把会话
 * 移出工程，下一条消息又被自动塞回去。
 */
export function shouldStampSessionProject(session: ChatSession | null | undefined): boolean {
  if (!session) return false
  if (session.project === null) return false
  return !session.project?.projectName?.trim()
}

/**
 * 把用户指定的工程盖到会话上，供侧边栏按工程分组。
 *
 * **只认用户明说的那个工程**，不看编辑器此刻连着谁。
 *
 * 曾经的做法是「没指定就回落到当前连着的工程」，于是从侧边栏顶部点「新对话」
 * 建的会话，一发消息就自己跳进了当时连着的工程组里 —— 用户没选过任何工程，
 * 却在侧边栏里找不到它。更糟的是这个戳不只是分组：它把会话的引擎作用域也
 * 锁死了（见 `main/agent-v3/core/sessionScope.ts`），等那个工程哪天没开着，
 * 这条随手建的对话里 ue.* 工具会整个消失，只剩一句「去把它打开」。
 *
 * 想归属工程有的是明路：工程标题上的「+」、右上角的工程胶囊、右键「归入工程」。
 * 没走这些路的会话就是「纯会话」，跟着当前连接走。
 */
export function stampSessionProject(deps: StampSessionProjectDeps): ChatSessionProject | null {
  const { sessionId, getSession, setProject } = deps
  if (!sessionId) return null

  const preferred = deps.preferredProjectName?.trim()
  if (!preferred) return null

  if (!shouldStampSessionProject(getSession(sessionId))) {
    return null
  }

  const stamped: ChatSessionProject = { projectName: preferred }
  setProject(sessionId, stamped)
  return stamped
}
