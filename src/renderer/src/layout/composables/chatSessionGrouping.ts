import type { ChatSession } from '@renderer/store/modules/chatSessions'

/** 侧边栏组织方式：按 UE 工程分组，或平铺成一个列表 */
export type ChatGroupMode = 'project' | 'flat'

/** 组内排序方式 */
export type ChatSortMode = 'recent' | 'created' | 'name'

export const PINNED_GROUP_KEY = 'pinned'
export const FLAT_GROUP_KEY = 'all'
export const UNASSIGNED_GROUP_KEY = 'unassigned'

/** 当前已连接的 UE 工程（只取分组需要的字段） */
export interface ConnectedProjectRef {
  projectName: string
  projectPath?: string
  engineVersion?: string
}

export type ChatSessionGroupKind = 'pinned' | 'project' | 'unassigned' | 'all'

export interface ChatSessionGroup {
  key: string
  kind: ChatSessionGroupKind
  /** 工程分组的工程名；其余分组为空串，标题由界面按 kind 取 i18n 文案 */
  projectName: string
  projectPath: string
  engineVersion: string
  /** 该工程当前是否正连着编辑器 */
  connected: boolean
  /** 用户把这个工程置顶了：排在「项目」区最前 */
  pinned: boolean
  sessions: ChatSession[]
}

export interface GroupChatSessionsOptions {
  mode: ChatGroupMode
  sortMode: ChatSortMode
  connectedProjects?: ConnectedProjectRef[]
  /** 用户手动加进来的工程，没有对话也要占一行 */
  manualProjects?: ConnectedProjectRef[]
  /** 被置顶的工程名 */
  pinnedProjects?: string[]
  /** 用户主动从侧边栏移走的工程；连接状态不能把它重新带回来 */
  hiddenProjects?: string[]
  keyword?: string
  /**
   * 是否把「已连接但还没有任何对话」的工程也列出来。
   * 搜索时应传 false —— 搜索结果里出现一个空分组只会碍事。
   */
  includeEmptyConnected?: boolean
}

/**
 * 工程分组 key。
 *
 * 按**工程名**（忽略大小写）归组，而不是按路径：同一个工程可能一次带着路径、
 * 一次只有名字（不同来源盖的戳），按路径分会把一个工程劈成两组，
 * 而用户眼里它就是一个工程。
 */
export function projectGroupKey(projectName: string): string {
  return `project:${projectName.trim().toLowerCase()}`
}

function sessionProjectName(session: ChatSession): string {
  return session.project?.projectName?.trim() || ''
}

/** 某个会话当前落在哪个分组里（用于打开会话时把它所在的分组展开） */
export function sessionGroupKey(session: ChatSession, mode: ChatGroupMode): string {
  if (session.pinned) return PINNED_GROUP_KEY
  if (mode === 'flat') return FLAT_GROUP_KEY

  const projectName = sessionProjectName(session)
  return projectName ? projectGroupKey(projectName) : UNASSIGNED_GROUP_KEY
}

/**
 * 侧边栏的三个顶层区：置顶 / 项目 / 对话。
 *
 * 「项目」下面才是一个个 UE 工程，「对话」放没归工程的会话——两者同级。
 */
export const SECTION_PINNED_KEY = 'section:pinned'
export const SECTION_PROJECTS_KEY = 'section:projects'
export const SECTION_PLAIN_KEY = 'section:plain'

/** 某个会话属于哪个顶层区 */
export function sessionSectionKey(session: ChatSession, mode: ChatGroupMode): string {
  if (session.pinned) return SECTION_PINNED_KEY
  if (mode === 'flat') return SECTION_PLAIN_KEY
  return sessionProjectName(session) ? SECTION_PROJECTS_KEY : SECTION_PLAIN_KEY
}

/** 会话是否命中搜索词（标题 / 最后一条消息 / 所属工程） */
export function matchChatSession(session: ChatSession, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return true

  const haystack = [session.title, session.lastMessagePreview || '', sessionProjectName(session)]
    .join('\n')
    .toLowerCase()

  return haystack.includes(needle)
}

export function filterChatSessions(sessions: ChatSession[], keyword: string): ChatSession[] {
  const needle = keyword.trim()
  if (!needle) return [...sessions]
  return sessions.filter((session) => matchChatSession(session, needle))
}

function compareByMode(left: ChatSession, right: ChatSession, mode: ChatSortMode): number {
  if (mode === 'name') {
    const byName = left.title.localeCompare(right.title, 'zh-Hans-CN')
    if (byName !== 0) return byName
  } else if (mode === 'created') {
    const byCreated = right.createdAt - left.createdAt
    if (byCreated !== 0) return byCreated
  } else {
    const byUpdated = right.updatedAt - left.updatedAt
    if (byUpdated !== 0) return byUpdated
  }

  // 同权重时先看谁刚被置顶，再按更新时间，最后拿 id 兜底保证排序稳定
  const byPinnedAt = (right.pinnedAt || 0) - (left.pinnedAt || 0)
  if (byPinnedAt !== 0) return byPinnedAt

  const byUpdated = right.updatedAt - left.updatedAt
  if (byUpdated !== 0) return byUpdated

  return left.id.localeCompare(right.id)
}

export function sortChatSessions(sessions: ChatSession[], mode: ChatSortMode): ChatSession[] {
  return [...sessions].sort((left, right) => compareByMode(left, right, mode))
}

function groupSortValue(group: ChatSessionGroup, mode: ChatSortMode): number {
  return group.sessions.reduce((latest, session) => {
    const value = mode === 'created' ? session.createdAt : session.updatedAt
    return Math.max(latest, value)
  }, 0)
}

function compareProjectGroups(
  left: ChatSessionGroup,
  right: ChatSessionGroup,
  mode: ChatSortMode
): number {
  // 用户手动置顶的工程压过一切
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1
  }

  // 其次是正连着编辑器的工程：那是用户此刻真正在做的事
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1
  }

  if (mode === 'name') {
    return left.projectName.localeCompare(right.projectName, 'zh-Hans-CN')
  }

  const byActivity = groupSortValue(right, mode) - groupSortValue(left, mode)
  if (byActivity !== 0) return byActivity

  return left.projectName.localeCompare(right.projectName, 'zh-Hans-CN')
}

function createGroup(
  key: string,
  kind: ChatSessionGroupKind,
  overrides: Partial<ChatSessionGroup> = {}
): ChatSessionGroup {
  return {
    key,
    kind,
    projectName: '',
    projectPath: '',
    engineVersion: '',
    connected: false,
    pinned: false,
    sessions: [],
    ...overrides
  }
}

/**
 * 把会话切成侧边栏要渲染的分组。
 *
 * 顺序固定为：置顶 → 已连接工程 → 其余工程 → 纯会话。
 * 置顶的会话**只**出现在置顶区，不在原工程里重复一份。
 */
export function groupChatSessions(
  sessions: ChatSession[],
  options: GroupChatSessionsOptions
): ChatSessionGroup[] {
  const {
    mode,
    sortMode,
    connectedProjects = [],
    manualProjects = [],
    pinnedProjects = [],
    hiddenProjects = [],
    keyword = ''
  } = options
  const pinnedProjectKeys = new Set(pinnedProjects.map((name) => projectGroupKey(name)))
  const hiddenProjectKeys = new Set(hiddenProjects.map((name) => projectGroupKey(name)))
  const includeEmptyConnected = options.includeEmptyConnected ?? !keyword.trim()

  const visible = filterChatSessions(sessions, keyword)
  const pinned = visible.filter((session) => session.pinned)
  const rest = visible.filter((session) => !session.pinned)

  const groups: ChatSessionGroup[] = []

  if (pinned.length > 0) {
    groups.push(
      createGroup(PINNED_GROUP_KEY, 'pinned', { sessions: sortChatSessions(pinned, sortMode) })
    )
  }

  if (mode === 'flat') {
    groups.push(createGroup(FLAT_GROUP_KEY, 'all', { sessions: sortChatSessions(rest, sortMode) }))
    return groups
  }

  const connectedByKey = new Map<string, ConnectedProjectRef>()
  for (const project of connectedProjects) {
    const name = project.projectName?.trim()
    if (!name) continue
    const key = projectGroupKey(name)
    if (hiddenProjectKeys.has(key)) continue
    connectedByKey.set(key, project)
  }

  const projectGroups = new Map<string, ChatSessionGroup>()
  const unassigned: ChatSession[] = []

  for (const session of rest) {
    const projectName = sessionProjectName(session)
    if (!projectName) {
      unassigned.push(session)
      continue
    }

    const key = projectGroupKey(projectName)
    if (hiddenProjectKeys.has(key)) {
      unassigned.push(session)
      continue
    }

    const existing = projectGroups.get(key)
    if (existing) {
      existing.sessions.push(session)
      existing.projectPath = existing.projectPath || session.project?.projectPath || ''
      existing.engineVersion = existing.engineVersion || session.project?.engineVersion || ''
      continue
    }

    const connected = connectedByKey.get(key)
    projectGroups.set(
      key,
      createGroup(key, 'project', {
        projectName,
        projectPath: connected?.projectPath || session.project?.projectPath || '',
        engineVersion: connected?.engineVersion || session.project?.engineVersion || '',
        connected: Boolean(connected),
        pinned: pinnedProjectKeys.has(key),
        sessions: [session]
      })
    )
  }

  if (includeEmptyConnected) {
    for (const [key, project] of connectedByKey) {
      if (projectGroups.has(key)) continue
      projectGroups.set(
        key,
        createGroup(key, 'project', {
          projectName: project.projectName.trim(),
          projectPath: project.projectPath || '',
          engineVersion: project.engineVersion || '',
          connected: true,
          pinned: pinnedProjectKeys.has(key)
        })
      )
    }
  }

  // 手动添加的工程始终占一行——用户点「+」加进来的，空着也得看得见
  for (const project of manualProjects) {
    const projectName = project.projectName?.trim()
    if (!projectName) continue

    const key = projectGroupKey(projectName)
    if (hiddenProjectKeys.has(key)) continue
    if (projectGroups.has(key)) continue

    const connected = connectedByKey.get(key)
    projectGroups.set(
      key,
      createGroup(key, 'project', {
        projectName,
        projectPath: connected?.projectPath || project.projectPath || '',
        engineVersion: connected?.engineVersion || project.engineVersion || '',
        connected: Boolean(connected),
        pinned: pinnedProjectKeys.has(key)
      })
    )
  }

  const sortedProjectGroups = [...projectGroups.values()]
    .map((group) => ({ ...group, sessions: sortChatSessions(group.sessions, sortMode) }))
    .sort((left, right) => compareProjectGroups(left, right, sortMode))

  groups.push(...sortedProjectGroups)

  if (unassigned.length > 0) {
    groups.push(
      createGroup(UNASSIGNED_GROUP_KEY, 'unassigned', {
        sessions: sortChatSessions(unassigned, sortMode)
      })
    )
  }

  return groups
}

/** 收集所有会话上出现过的工程名（用于「归入工程」菜单） */
export function collectKnownProjects(
  sessions: ChatSession[],
  connectedProjects: ConnectedProjectRef[] = []
): ConnectedProjectRef[] {
  const byKey = new Map<string, ConnectedProjectRef>()

  for (const project of connectedProjects) {
    const name = project.projectName?.trim()
    if (!name) continue
    byKey.set(projectGroupKey(name), {
      projectName: name,
      projectPath: project.projectPath,
      engineVersion: project.engineVersion
    })
  }

  for (const session of sessions) {
    const name = sessionProjectName(session)
    if (!name) continue
    const key = projectGroupKey(name)
    if (byKey.has(key)) continue
    byKey.set(key, {
      projectName: name,
      projectPath: session.project?.projectPath,
      engineVersion: session.project?.engineVersion
    })
  }

  return [...byKey.values()].sort((left, right) =>
    left.projectName.localeCompare(right.projectName, 'zh-Hans-CN')
  )
}

/** 侧边栏会话行右上角的活动状态 */
export type SessionActivity = 'waiting' | 'running' | 'done' | 'idle'

/**
 * 一条会话此刻该显示什么活动状态。
 *
 * 正在跑就转圈，跑完还没看就点蓝点 —— 两者互斥，正在跑的时候不该同时说「已完成」。
 *
 * **「等你回答」压过「正在跑」**，尽管此刻两者都成立（agent 阻塞在 `ask_user`
 * 里，这条会话在跑）。转圈说的是「它在忙，你等着就行」，而这里的事实正相反：
 * 它不会自己往下走了，`ask_user` 没有超时（见主进程 `host/questionChannel.ts`），
 * 要它继续只能由人来答。这两句话不能同时显示一个，得让更要紧的那句赢。
 */
export function sessionActivityState(
  isRunning: boolean,
  taskDone: boolean,
  awaitingAnswer = false
): SessionActivity {
  if (awaitingAnswer) return 'waiting'
  if (isRunning) return 'running'
  if (taskDone) return 'done'
  return 'idle'
}
