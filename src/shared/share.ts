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
    authorLink: string
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
  /** 上次分享时填的署名和主页，省得每次重填 */
  author: string
  authorLink: string
  /** 这个名字之前分享过（本机存着修改码），这次提交是更新 */
  isUpdate: boolean
}

export interface SharedSkillSubmitInput {
  name: string
  author: string
  authorLink: string
  note: string
}

export interface SharedSkillSubmitResult {
  id: string
  isUpdate: boolean
  statusUrl: string
}

/** 技能页上的来源标记：从共享库装的技能 */
export interface SharedSkillOrigin {
  version: number
  author: string
}
