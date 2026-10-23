/**
 * 团队工程（版本控制与资产协作）的渲染层封装。
 *
 * 两种返回风格（AGENTS.md 硬规则 5）：
 *
 * - **读取类**（动态、签出中、等你处理、历史、对比……）用 `read()`：拿不到数据界面也画不下去，
 *   抛 `TeamApiError`（带契约 1.2 的 `code`），由各屏按 2.18「出错」显示一句话加 [重试]。
 * - **用户动作类**（通过、打回、收回、冻结、问他改完没、加入团队……）用 `act()`：
 *   回 `{ success, data?, errorCode? }`，每个按钮自己按码选文案（「已问过」「冻结中」……）。
 */
import type {
  TeamActivitySummary,
  TeamBisect,
  TeamCheckouts,
  TeamCompare,
  TeamDeletedItem,
  TeamDelivery,
  TeamDeliveryItem,
  TeamEvent,
  TeamFact,
  TeamFolderRules,
  TeamHistory,
  TeamInbox,
  TeamJoinLink,
  TeamPage,
  TeamProject,
  TeamReference,
  TeamRestrictedFolder,
  TeamSubmit,
  TeamSubmitFile,
  TeamSubmitQuery,
  TeamAsk,
  TeamCheck
} from '@core/shared/teamProject'

export class TeamApiError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'TeamApiError'
    this.code = code
  }
}

export interface TeamActionResult<T> {
  success: boolean
  data?: T
  error?: string
  errorCode?: string
}

type Raw<T> = { success: boolean; data?: T; error?: string; errorCode?: string }

function bridge(): NonNullable<typeof window.api.team> {
  const api = window.api?.team
  if (!api) throw new TeamApiError('team bridge is not available', 'no-bridge')
  return api
}

async function read<T>(call: () => Promise<Raw<unknown>>): Promise<T> {
  const result = await call()
  if (!result || result.success !== true)
    throw new TeamApiError(result?.error || 'Request failed', result?.errorCode || 'unknown')
  return result.data as T
}

async function act<T>(call: () => Promise<Raw<unknown>>): Promise<TeamActionResult<T>> {
  try {
    const result = await call()
    return result.success
      ? { success: true, data: result.data as T }
      : { success: false, error: result.error, errorCode: result.errorCode || 'unknown' }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error instanceof TeamApiError ? error.code : 'no-bridge'
    }
  }
}

/** IPC 的结构化克隆不认 Vue 的响应式代理（弹窗状态、store 里的数组）：先拍平成普通对象 */
function plain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

const call = (key: string, op: string, args?: unknown) => (): Promise<Raw<unknown>> =>
  bridge().call(key, op, plain(args))

export const teamAPI = {
  // ---- 读取
  project: (key: string) => read<TeamProject>(call(key, 'project')),
  submits: (key: string, query: TeamSubmitQuery = {}) =>
    read<TeamPage<TeamSubmit>>(call(key, 'submits', query)),
  submit: (key: string, number: number) =>
    read<TeamSubmit & { files: TeamSubmitFile[] }>(call(key, 'submit', { number })),
  summary: (key: string, since?: number, until?: number) =>
    read<TeamActivitySummary>(call(key, 'summary', { since, until })),
  checkouts: (key: string, paths?: string[]) =>
    read<TeamCheckouts>(call(key, 'checkouts', { paths })),
  asked: (key: string, paths: string[]) =>
    read<{ items: Array<{ path: string; askedAt: number; ask: TeamAsk }> }>(
      call(key, 'asked', { paths })
    ),
  inbox: (key: string) => read<TeamInbox>(call(key, 'inbox')),
  folderRules: (key: string, path: string) =>
    read<TeamFolderRules>(call(key, 'folderRules', { path })),
  restricted: (key: string) => read<{ items: TeamRestrictedFolder[] }>(call(key, 'restricted')),
  compare: (key: string, from: number | 'latest', to: number | 'latest', folder?: string) =>
    read<TeamCompare>(call(key, 'compare', { from, to, folder })),
  history: (key: string, path: string) => read<TeamHistory>(call(key, 'history', { path })),
  deleted: (key: string, days = 30) =>
    read<{ items: TeamDeletedItem[] }>(call(key, 'deleted', { days })),
  bisects: (key: string) => read<{ items: TeamBisect[] }>(call(key, 'bisects')),
  bisect: (key: string, id: string) => read<TeamBisect>(call(key, 'bisect', { id })),
  deliveries: (key: string, company?: string) =>
    read<{ items: TeamDelivery[] }>(call(key, 'deliveries', { company })),
  delivery: (key: string, id: string) =>
    read<{ delivery: TeamDelivery; items: TeamDeliveryItem[] }>(call(key, 'delivery', { id })),
  references: (key: string) => read<{ items: TeamReference[] }>(call(key, 'references')),
  deliveryChecks: (key: string, files: Array<{ path: string; size?: number }>) =>
    read<{ checks: TeamCheck[] }>(call(key, 'submitPlan', { purpose: 'delivery', files })),
  facts: (key: string, hashes: string[], library?: string | null) =>
    read<Record<string, TeamFact | null>>(() => bridge().facts(key, hashes, library ?? null)),
  localInfo: (key: string) =>
    read<{
      localPath: string | null
      exists: boolean
      uproject: string | null
      unsynced: string[]
    }>(() => bridge().localInfo(key)),
  freeSpace: (path: string) => read<number | null>(() => bridge().freeSpace(path)),
  inspectFolder: (path: string) =>
    read<{ hasLore: boolean; uproject: string | null; empty: boolean }>(() =>
      bridge().inspectFolder(path)
    ),
  streamState: (serverId: string) =>
    read<{ connected: boolean; signedOut: boolean }>(() => bridge().streamState(serverId)),
  parseLink: (raw: string) => read<TeamJoinLink | null>(() => bridge().parseLink(raw)),
  pendingJoinLink: () => read<TeamJoinLink | null>(() => bridge().pendingJoinLink()),

  // ---- 动作
  join: (input: {
    server: string
    caFingerprint?: string | null
    project?: string | null
    member: string
    password: string
  }) =>
    act<{
      member: string
      displayName: string
      keys: string[]
      openKey: string | null
      noProjects: boolean
    }>(() => bridge().join(plain(input))),
  // IPC 的结构化克隆不认 Vue 的响应式代理：先拍平
  peek: (link: TeamJoinLink) =>
    act<{ projectName: string | null }>(() =>
      bridge().peek({
        server: link.server,
        project: link.project,
        caFingerprint: link.caFingerprint
      })
    ),
  inviteLink: (key: string) => act<string | null>(() => bridge().inviteLink(key)),
  approve: (key: string, number: number) =>
    act<{ submit: TeamSubmit }>(call(key, 'approve', { number })),
  reject: (key: string, number: number, reason: string) =>
    act<{ submit: TeamSubmit }>(call(key, 'reject', { number, reason })),
  setMilestone: (key: string, number: number, name: string) =>
    act<{ submit: TeamSubmit }>(call(key, 'setMilestone', { number, name })),
  removeMilestone: (key: string, number: number) =>
    act<void>(call(key, 'removeMilestone', { number })),
  freeze: (key: string, note: string) => act<unknown>(call(key, 'freeze', { note })),
  unfreeze: (key: string) => act<{ waiting: number }>(call(key, 'unfreeze')),
  ask: (key: string, paths: string[]) =>
    act<{ ask: TeamAsk; holderOnline: boolean; holderSeenToday: boolean }>(
      call(key, 'ask', { paths })
    ),
  answerAsk: (
    key: string,
    id: string,
    answer: { kind: 'submitted' | 'released' | 'still-editing'; eta?: string; number?: number }
  ) => act<unknown>(call(key, 'answerAsk', { id, ...answer })),
  escalate: (key: string, id: string) => act<{ ask: TeamAsk }>(call(key, 'escalate', { id })),
  takeBack: (
    key: string,
    input: { holder: string; paths?: string[]; reason?: string; askId?: string }
  ) => act<{ released: string[]; assigned: string[] }>(call(key, 'takeBack', input)),
  putFolderRules: (
    key: string,
    input: { path: string; submit?: unknown; checks?: Record<string, unknown> }
  ) => act<TeamFolderRules>(call(key, 'putFolderRules', input)),
  startBisect: (key: string, good: number, bad: number) =>
    act<TeamBisect>(call(key, 'startBisect', { good, bad })),
  bisectVerdict: (key: string, id: string, number: number, verdict: 'good' | 'bad' | 'skip') =>
    act<TeamBisect>(call(key, 'bisectVerdict', { id, number, verdict })),
  bisectUndo: (key: string, id: string) => act<TeamBisect>(call(key, 'bisectUndo', { id })),
  stopBisect: (key: string, id: string) => act<unknown>(call(key, 'stopBisect', { id })),
  rejectDelivery: (key: string, id: string, paths: string[], reason: string) =>
    act<{ delivery: TeamDelivery; items: TeamDeliveryItem[] }>(
      call(key, 'rejectDelivery', { id, paths, reason })
    ),
  syncToLocal: (key: string, input: { targetDir: string; existing?: boolean }) =>
    act<string>(() => bridge().syncToLocal(key, input)),
  putIn: (key: string, sourceDir: string) => act<string>(() => bridge().putIn(key, { sourceDir })),
  setFolderSynced: (key: string, folder: string, synced: boolean) =>
    act<{ ok: boolean; pending: number }>(() => bridge().setFolderSynced(key, folder, synced)),
  restore: (key: string, path: string, number: number) =>
    act<{ ok: boolean }>(() => bridge().restore(key, { path, number })),
  isModified: (key: string, path: string) => act<boolean>(() => bridge().isModified(key, path)),
  cancelCheckout: (key: string, path: string, discard: boolean) =>
    act<{ kept: string | null }>(() => bridge().cancelCheckout(key, { path, discard })),
  deliver: (key: string, input: { files: string[]; message: string; facts?: unknown[] }) =>
    act<string>(() => bridge().deliver(key, plain(input))),
  approveDelivery: (key: string, input: { id: string; paths: string[]; message: string }) =>
    act<string>(() => bridge().approveDelivery(key, plain(input))),
  sendReference: (key: string, input: { company: string; paths: string[]; note: string }) =>
    act<string>(() => bridge().sendReference(key, plain(input))),
  openPath: (path: string) => act<boolean>(() => bridge().openPath(path)),
  notify: (input: {
    key?: string
    title: string
    body: string
    open?: { serverId: string; project: string; path?: string } | null
  }) => act<boolean>(() => bridge().notify(input)),
  startStreams: () => act<void>(() => bridge().startStreams()),
  restartStream: (serverId: string) => act<void>(() => bridge().restartStream(serverId)),

  onEvent(listener: (event: TeamEvent) => void): () => void {
    const api = window.api?.team
    if (!api) return () => undefined
    return api.onEvent(listener)
  }
}
