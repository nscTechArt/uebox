/**
 * 共享技能在主进程和界面之间传的数据。
 *
 * 安装的三条入口（网页唤起、Agent 工具、`uebox skills add`）最后都变成一条
 * `SharedSkillInstallRequest` 发给主窗口，用户在确认框里点了确认才写盘。
 */

export const SHARE_INSTALL_REQUEST_CHANNEL = 'share:install-request'
export const SHARE_INSTALL_FAILED_CHANNEL = 'share:install-failed'

export interface SharedSkillFile {
  path: string
  content: string
}

export type SharedSkillConflict =
  | { kind: 'none' }
  | { kind: 'update'; fromVersion: number }
  | { kind: 'own' }
  | { kind: 'builtin' }

export interface SharedSkillInstallRequest {
  requestId: string
  /**
   * 谁发起的：网页上的按钮，或者工具调用（盒子 Agent、命令行、外部 MCP 客户端走的是
   * 同一个工具，工具里分不出来，所以不再细分）
   */
  origin: 'link' | 'tool'
  skill: {
    id: string
    description: string
    author: string
    version: number
    updatedAt: string
    installs: number
    files: SharedSkillFile[]
  }
  conflict: SharedSkillConflict
  pageUrl: string
}

export type SharedSkillInstallOutcome =
  | { status: 'installed'; id: string; version: number }
  | { status: 'declined'; id: string }
  | { status: 'failed'; id: string; error: string }

/** 网页唤起时出错（地址认不出、技能已下架、连不上），界面上直接提示 */
export interface SharedSkillInstallFailure {
  ref: string
  error: string
}

export interface SharedSkillPack {
  name: string
  files: SharedSkillFile[]
  skipped: string[]
  /** 连接的 UEBox 账户名（作者名）；没连接为 null，界面让用户先连接 */
  account: string | null
}

export interface SharedSkillSubmitResult {
  id: string
  version: number
  /** pending：新账户的第一份，管理员看过才公开 */
  status: 'published' | 'pending'
  url: string
}

/** 连接账户时给用户看的校验码和授权页地址（浏览器已经打开） */
export interface SharedSkillConnectPrompt {
  userCode: string
  verificationUri: string
}

export const SHARE_CONNECT_PROMPT_CHANNEL = 'share:connect-prompt'

/** 技能页上的来源标记：从共享库装的技能 */
export interface SharedSkillOrigin {
  version: number
  author: string
}
