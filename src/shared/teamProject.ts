/**
 * 团队工程（版本控制与资产协作）：主进程和渲染层共用的形状。
 *
 * 字段名照团队服务成员面的契约（ubas-vcs docs/design/vcs-collab-contract.md 第 4 节）原样搬过来，
 * 渲染层拿到的就是服务端的 JSON —— 这里不做第二套模型。界面文案、时间和时长的写法由渲染层
 * 按界面方案（vcs-collab-uiux.zh.md 2.3、2.5）拼，不在这里。
 */

export type TeamRole = 'member' | 'admin' | 'outsourcer' | 'build'

export interface PersonRef {
  id: string
  name: string
}

export interface Person extends PersonRef {
  online: boolean
  /** 最近一次在线；null = 从没上线 */
  lastSeenAt: number | null
  disabled: boolean
}

export interface TeamCompanyRef {
  id: string
  name: string
}

export interface TeamProjectSummary {
  id: string
  name: string
  role: TeamRole
  company: TeamCompanyRef | null
  archived: boolean
  frozen: boolean
  counts: { inbox: number; pending?: number }
  /** 目录服务里这个工程的资产库 id；外包拿到的是自己公司外包区的库 */
  library: string | null
}

export interface TeamMilestone {
  name: string
  number: number
  revision: string
  by: PersonRef
  at: number
}

export interface TeamFreeze {
  note: string
  by: PersonRef
  at: number
  /** 在等通过的提交数（「在等 3 个」） */
  waiting: number
}

export interface TeamCompany {
  id: string
  name: string
  enabled: boolean
  people: number
  area: { repository: string; library: string } | null
}

export interface TeamProject extends TeamProjectSummary {
  repository?: string
  loreRemote?: string
  branch?: string
  head?: { number: number; revision: string; at: number } | null
  /** 「工程还是空的」 */
  empty?: boolean
  freeze?: TeamFreeze | null
  milestones?: TeamMilestone[]
  branches?: Array<{ name: string; revision: string }>
  people?: Array<Person & { role: TeamRole; group: string | null }>
  /** 仅管理员 */
  companies?: TeamCompany[] | null
  inviteLink?: string | null
  /** 外包：自己公司的外包区 */
  area?: { repository: string; library: string } | null
}

export interface TeamMe {
  member: string
  displayName: string
  kind: 'employee' | 'outsourcer' | 'build'
  group: string | null
  serverAdmin: boolean
  mustChangePassword: boolean
  projects: Array<{ id: string; name: string; role: TeamRole; company: TeamCompanyRef | null }>
}

export type SubmitState = 'landed' | 'pending' | 'rejected' | 'conflict'

export interface TeamSubmit {
  number: number
  revision: string
  state: SubmitState
  author: PersonRef
  at: number
  message: string
  counts: { added: number; modified: number; deleted: number }
  milestone: { name: string; by: PersonRef; at: number } | null
  screenshot: string | null
  waitingFor: {
    kind: 'admins' | 'people'
    people: PersonRef[]
    reasons: Array<'freeze' | 'folder'>
    folders: string[]
  } | null
  approved: { by: PersonRef; at: number } | null
  rejected: { by: PersonRef; at: number; reason: string } | null
  conflict: { at: number; paths: string[]; message: string } | null
  builds: Array<{ machine: string; at: number }>
  delivery: { company: TeamCompanyRef; n: number } | null
  /** 缩略图条：最多 8 个内容哈希 */
  preview: string[]
  files: { total: number; truncated: boolean } | TeamSubmitFile[]
  can: { approve: boolean; reject: boolean; milestone: boolean }
}

export type ChangeAction = 'added' | 'modified' | 'deleted' | 'moved'

export interface TeamSubmitFile {
  path: string
  action: ChangeAction
  pathFrom: string | null
  hash: string | null
  size: number | null
  ofpa: { map: string } | null
}

export interface TeamSubmitQuery {
  limit?: number
  cursor?: string | null
  author?: string
  group?: string
  folder?: string
  milestones?: boolean
  state?: 'pending'
  q?: string
  from?: number
  to?: number
}

export interface TeamPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface TeamActivitySummary {
  total: number
  byGroup: Array<{ group: string; n: number }>
  byAuthor: Array<{ id: string; name: string; n: number }>
  longCheckouts: Array<{
    holder: PersonRef
    count: number
    oldestSince: number
    label: string
    paths: string[]
  }>
}

export interface TeamCheckout {
  path: string
  since: number
  ofpa: { map: string } | null
  pending: number | null
  rejected: { number: number; reason: string } | null
}

export interface TeamCheckoutGroup {
  holder: Person
  count: number
  oldestSince: number
  items: TeamCheckout[]
}

export interface TeamCheckouts {
  groups: TeamCheckoutGroup[]
  total: number
}

export interface TeamAsk {
  id: string
  from: PersonRef
  to: PersonRef
  paths: string[]
  at: number
  answer: null | {
    kind: 'submitted' | 'released' | 'still-editing'
    eta: '30m' | '1h' | 'today' | 'tomorrow' | null
    number: number | null
    at: number
  }
  escalated: { at: number; admins: PersonRef[] } | null
  assigned: string[]
}

export interface TeamDelivery {
  id: string
  company: TeamCompanyRef
  n: number
  by: PersonRef
  at: number
  message: string
  state: 'uploading' | 'waiting' | 'done'
  folder: string
  counts: { total: number; waiting: number; approved: number; rejected: number }
  submit: number | null
}

export interface TeamCheck {
  rule: TeamRuleId
  level: 'warn' | 'block'
  path: string
  folder: string
  params: Record<string, unknown>
  value: unknown
  setBy: PersonRef | null
}

export interface TeamDeliveryItem {
  path: string
  deliveredPath: string
  hash: string | null
  size: number | null
  state: 'waiting' | 'approved' | 'rejected'
  reason: string | null
  rejectedBy: PersonRef | null
  checks: TeamCheck[]
  missingReferences: string[]
}

export interface TeamInbox {
  approvals: Array<
    { type: 'submit'; submit: TeamSubmit } | { type: 'delivery'; delivery: TeamDelivery }
  >
  takeBack: Array<{ ask: TeamAsk; holder: Person; paths: string[]; label: string }>
}

export type TeamRuleId =
  | 'name-prefix'
  | 'texture-power-of-two'
  | 'texture-max-size'
  | 'no-broken-references'
  | 'file-max-size'

/** 五条检查，按界面方案 4.7 的顺序 */
export const TEAM_RULES: TeamRuleId[] = [
  'name-prefix',
  'texture-power-of-two',
  'texture-max-size',
  'no-broken-references',
  'file-max-size'
]

export type RuleLevel = 'off' | 'warn' | 'block'

export interface SubmitPeople {
  mode: 'inherit' | 'all' | 'only'
  people: Array<PersonRef | { group: string }>
}

export interface TeamFolderRules {
  path: string
  own: {
    submit: SubmitPeople | null
    checks: Partial<
      Record<TeamRuleId, { level: 'inherit' | RuleLevel; params?: Record<string, unknown> }>
    >
  }
  effective: {
    submit: { mode: 'all' | 'only'; people: Array<PersonRef | { group: string }>; from: string }
    checks: Array<{
      rule: TeamRuleId
      level: RuleLevel
      params: Record<string, unknown>
      from: string
      setBy: PersonRef | null
    }>
  }
  canEdit: boolean
}

export interface TeamRestrictedFolder {
  path: string
  people: Array<PersonRef | { group: string }>
  youCanSubmit: boolean
}

export interface TeamCompare {
  from: { number: number; milestone: string | null }
  to: { number: number; milestone: string | null }
  swapped: boolean
  submits: number
  counts: { added: number; modified: number; deleted: number }
  complete: boolean
  files: Array<{
    path: string
    action: ChangeAction
    pathFrom: string | null
    hash: string | null
    number: number
    author: PersonRef
  }>
}

export interface TeamHistory {
  path: string
  complete: boolean
  items: Array<{
    number: number
    author: PersonRef
    at: number
    message: string
    action: ChangeAction
    pathFrom: string | null
    hash: string | null
    milestone: string | null
  }>
}

export interface TeamDeletedItem {
  path: string
  number: number
  author: PersonRef
  at: number
  hash: string | null
  restoreFrom: number
}

export interface TeamBisect {
  id: string
  by: PersonRef
  at: number
  good: number
  bad: number
  state: 'running' | 'found' | 'ambiguous' | 'stopped'
  current: { number: number; revision: string; author: PersonRef; message: string } | null
  round: number
  roundsLeft: number
  remaining: number
  candidates: number
  steps: Array<{ number: number; verdict: 'good' | 'bad' | 'skip'; by: PersonRef; at: number }>
  result: { number: number } | { numbers: number[] } | null
}

export interface TeamReference {
  id: string
  company?: string
  by: PersonRef
  at: number
  note: string
  paths: string[]
}

export interface TeamNotification {
  id: string
  kind: string
  project: string
  at: number
  key: string
  data: Record<string, unknown>
}

/** 目录服务按内容哈希给的缩略图和类型（缩略图已换成本机协议地址） */
export interface TeamFact {
  class: string | null
  classCn: string | null
  classColor: string | null
  preview: string | null
  previewLarge: string | null
}

/**
 * 外包区（契约 4.10）里的路径 → 工程里的路径：`reference/Content/…`、`delivery/7/Content/…`
 * 下面的路径和工程里一致，放进 UE 工程时去掉这一层（「路径和团队工程保持一致」，方案 4.12）。
 * 不在这两处下面的原样返回。
 */
export function areaToProjectPath(path: string): string {
  // 只认下面接着 UE 工程目录的，别的库里恰好叫 reference 的文件夹不动
  const match = /^(?:reference|delivery\/\d+)\/((?:Content|Config|Source|Plugins)\/.+)$/.exec(path)
  return match ? match[1] : path
}

/** 本机记着的：这个库是哪个团队工程、你在里面是什么身份、工程在你电脑上的哪里 */
export interface CatalogTeamLink {
  projectId: string
  projectName: string
  role: TeamRole
  company: TeamCompanyRef | null
  /** 工程在这台电脑上的位置（同步到本机 / 放入之后才有） */
  localPath?: string | null
  /** 没同步到本机的顶层文件夹（工程内路径） */
  unsynced?: string[]
}

/** 主进程推给渲染层的团队事件 */
export type TeamEvent =
  | { kind: 'notification'; serverId: string; notification: TeamNotification }
  | { kind: 'project'; serverId: string; project: string; what: string[] }
  | { kind: 'stream'; serverId: string; connected: boolean }
  | { kind: 'open'; serverId: string; project: string; path: string }
  | { kind: 'join-link'; link: TeamJoinLink }

/** `unrealbox://join?server=…&p=…&ca=sha256:…` 或网页上的邀请链接 */
export interface TeamJoinLink {
  server: string
  project: string | null
  caFingerprint: string | null
}

/**
 * `unrealbox://open?server=<成员面地址>&path=/p/xinghai/submits/1532`（契约 4.14）：
 * UE 里点提交号、[在虚幻盒子里看]、「选同步哪些文件夹…」都走它。path 只认 `/p/<工程>/…`。
 */
export function parseTeamOpenLink(
  raw: string
): { server: string; project: string; path: string } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'unrealbox:') return null
  const action = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0]
  if (action !== 'open') return null
  const server = url.searchParams.get('server')
  const path = url.searchParams.get('path') ?? ''
  const match = /^\/p\/([a-z0-9-]+)(\/.*)?$/.exec(path.split('?')[0])
  if (!server || !match) return null
  try {
    const parsed = new URL(server)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return { server: `${parsed.protocol}//${parsed.host}`, project: match[1], path }
  } catch {
    return null
  }
}

/**
 * 解析邀请链接。认两种：盒子自己的 `unrealbox://join?server=&p=&ca=`，
 * 和网页上复制的 `https://host:8084/join?p=xinghai#ca=sha256:<hex>`。
 * 认不出来回 null（界面说「这个链接打不开」）。
 */
export function parseTeamJoinLink(raw: string): TeamJoinLink | null {
  const text = raw.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const ca = (value: string | null): string | null => {
    if (!value) return null
    const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value.trim())
    return match ? match[1].toLowerCase() : null
  }
  if (url.protocol === 'unrealbox:') {
    // unrealbox://join?... —— 主机名位置是动作
    const action = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0]
    if (action !== 'join') return null
    const server = url.searchParams.get('server')
    if (!server) return null
    try {
      const parsed = new URL(server)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
      return {
        server: `${parsed.protocol}//${parsed.host}`,
        project: url.searchParams.get('p'),
        caFingerprint: ca(url.searchParams.get('ca'))
      }
    } catch {
      return null
    }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!/^\/join\/?$/.test(url.pathname)) return null
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  return {
    server: `${url.protocol}//${url.host}`,
    project: url.searchParams.get('p'),
    caFingerprint: ca(hash.get('ca'))
  }
}
