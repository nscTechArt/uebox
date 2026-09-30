/**
 * 团队服务成员面的路由表：渲染层只能按名字调这里列出的动作，参数在这里逐个校验。
 *
 * 为什么是一张表而不是几十个 IPC 通道：每条路由的形状都在契约（vcs-collab-contract.md 第 4 节）
 * 里定好了，这里只做「名字 → 方法、路径、查询、请求体」的翻译；新增一条就是加一行，
 * 预加载桥和类型声明不用跟着长。渲染层拿不到任意路径 —— `{p}` 永远是这个库绑定的工程。
 */

export interface TeamRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

type Args = Record<string, unknown>

const str = (value: unknown, max = 500): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined
const int = (value: unknown, name: string): number => {
  const n = num(value)
  if (n === undefined || n < 0) throw new TeamOpError(`${name} must be a number`)
  return n
}
const req = (value: unknown, name: string, max = 500): string => {
  const s = str(value, max)
  if (s === undefined) throw new TeamOpError(`${name} is required`)
  return s
}
const paths = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .slice(0, 5000)
    : []
const seg = (value: string): string => encodeURIComponent(value)

export class TeamOpError extends Error {
  readonly code = 'bad-request'
  constructor(message: string) {
    super(message)
    this.name = 'TeamOpError'
  }
}

/**
 * 每个动作：给定工程 id 和渲染层的参数，拼出请求。
 * 参数不对抛 TeamOpError（渲染层按 bad-request 处理）。
 */
export const TEAM_OPS = {
  project: (p: string): TeamRoute => ({ method: 'GET', path: `/v1/projects/${seg(p)}` }),
  submits: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/submits`,
    query: {
      limit: num(a.limit),
      cursor: str(a.cursor),
      author: str(a.author),
      group: str(a.group),
      folder: str(a.folder, 2000),
      milestones: a.milestones === true ? 1 : undefined,
      state: a.state === 'pending' ? 'pending' : undefined,
      q: str(a.q, 200),
      from: num(a.from),
      to: num(a.to)
    } as TeamRoute['query']
  }),
  submit: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/submits/${int(a.number, 'number')}`
  }),
  submitFiles: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/submits/${int(a.number, 'number')}/files`,
    query: { cursor: str(a.cursor), limit: num(a.limit), folder: str(a.folder, 2000) }
  }),
  approve: (p: string, a: Args): TeamRoute => ({
    method: 'POST',
    path: `/v1/projects/${seg(p)}/submits/${int(a.number, 'number')}/approve`,
    body: {}
  }),
  reject: (p: string, a: Args): TeamRoute => ({
    method: 'POST',
    path: `/v1/projects/${seg(p)}/submits/${int(a.number, 'number')}/reject`,
    body: { reason: req(a.reason, 'reason', 1000) }
  }),
  setMilestone: (p: string, a: Args): TeamRoute => ({
    method: 'PUT',
    path: `/v1/projects/${seg(p)}/submits/${int(a.number, 'number')}/milestone`,
    body: { name: req(a.name, 'name', 100) }
  }),
  removeMilestone: (p: string, a: Args): TeamRoute => ({
    method: 'DELETE',
    path: `/v1/projects/${seg(p)}/submits/${int(a.number, 'number')}/milestone`
  }),
  freeze: (p: string, a: Args): TeamRoute => ({
    method: 'PUT',
    path: `/v1/projects/${seg(p)}/freeze`,
    body: { note: req(a.note, 'note', 300) }
  }),
  unfreeze: (p: string): TeamRoute => ({ method: 'DELETE', path: `/v1/projects/${seg(p)}/freeze` }),
  summary: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/activity/summary`,
    query: { since: num(a.since), until: num(a.until) }
  }),
  checkouts: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/checkouts`,
    query: {
      paths: paths(a.paths).length ? paths(a.paths).join(',') : undefined,
      holder: str(a.holder)
    }
  }),
  asked: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/asks`,
    query: { paths: paths(a.paths).join(',') || undefined }
  }),
  ask: (p: string, a: Args): TeamRoute => {
    const list = paths(a.paths)
    if (list.length === 0) throw new TeamOpError('paths is required')
    return { method: 'POST', path: `/v1/projects/${seg(p)}/asks`, body: { paths: list } }
  },
  answerAsk: (p: string, a: Args): TeamRoute => {
    const kind = a.kind
    if (kind !== 'submitted' && kind !== 'released' && kind !== 'still-editing')
      throw new TeamOpError('kind')
    const eta = ['30m', '1h', 'today', 'tomorrow'].includes(String(a.eta)) ? a.eta : undefined
    return {
      method: 'POST',
      path: `/v1/projects/${seg(p)}/asks/${seg(req(a.id, 'id', 100))}/answer`,
      body: { kind, eta, number: num(a.number) }
    }
  },
  escalate: (p: string, a: Args): TeamRoute => ({
    method: 'POST',
    path: `/v1/projects/${seg(p)}/asks/${seg(req(a.id, 'id', 100))}/escalate`,
    body: {}
  }),
  takeBack: (p: string, a: Args): TeamRoute => {
    const list = paths(a.paths)
    return {
      method: 'POST',
      path: `/v1/projects/${seg(p)}/checkouts/take-back`,
      body: {
        holder: req(a.holder, 'holder', 200),
        paths: list.length ? list : undefined,
        reason: str(a.reason, 500),
        askId: str(a.askId, 100)
      }
    }
  },
  inbox: (p: string): TeamRoute => ({ method: 'GET', path: `/v1/projects/${seg(p)}/inbox` }),
  folderRules: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/folders/rules`,
    query: { path: typeof a.path === 'string' ? a.path.slice(0, 2000) : '' }
  }),
  putFolderRules: (p: string, a: Args): TeamRoute => {
    const body: Record<string, unknown> = {
      path: typeof a.path === 'string' ? a.path.slice(0, 2000) : ''
    }
    if (a.submit && typeof a.submit === 'object') body.submit = a.submit
    if (a.checks && typeof a.checks === 'object') body.checks = a.checks
    return { method: 'PUT', path: `/v1/projects/${seg(p)}/folders/rules`, body }
  },
  restricted: (p: string): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/folders/restricted`
  }),
  compare: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/compare`,
    query: {
      from: a.from === 'latest' ? 'latest' : num(a.from),
      to: a.to === 'latest' || a.to === undefined ? 'latest' : num(a.to),
      folder: str(a.folder, 2000)
    }
  }),
  history: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/history`,
    query: { path: req(a.path, 'path', 2000) }
  }),
  deleted: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/deleted`,
    query: { days: num(a.days) ?? 30, folder: str(a.folder, 2000) }
  }),
  bisects: (p: string): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/bisects`,
    query: { state: 'running' }
  }),
  bisect: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/bisects/${seg(req(a.id, 'id', 100))}`
  }),
  startBisect: (p: string, a: Args): TeamRoute => ({
    method: 'POST',
    path: `/v1/projects/${seg(p)}/bisects`,
    body: { good: int(a.good, 'good'), bad: int(a.bad, 'bad') }
  }),
  bisectVerdict: (p: string, a: Args): TeamRoute => {
    if (a.verdict !== 'good' && a.verdict !== 'bad' && a.verdict !== 'skip')
      throw new TeamOpError('verdict')
    return {
      method: 'POST',
      path: `/v1/projects/${seg(p)}/bisects/${seg(req(a.id, 'id', 100))}/verdicts`,
      body: { number: int(a.number, 'number'), verdict: a.verdict }
    }
  },
  bisectUndo: (p: string, a: Args): TeamRoute => ({
    method: 'POST',
    path: `/v1/projects/${seg(p)}/bisects/${seg(req(a.id, 'id', 100))}/undo`,
    body: {}
  }),
  stopBisect: (p: string, a: Args): TeamRoute => ({
    method: 'DELETE',
    path: `/v1/projects/${seg(p)}/bisects/${seg(req(a.id, 'id', 100))}`
  }),
  deliveries: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/deliveries`,
    query: { company: str(a.company), state: str(a.state) }
  }),
  delivery: (p: string, a: Args): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/deliveries/${seg(req(a.id, 'id', 100))}`
  }),
  rejectDelivery: (p: string, a: Args): TeamRoute => {
    const list = paths(a.paths)
    if (list.length === 0) throw new TeamOpError('paths is required')
    return {
      method: 'POST',
      path: `/v1/projects/${seg(p)}/deliveries/${seg(req(a.id, 'id', 100))}/reject`,
      body: { paths: list, reason: req(a.reason, 'reason', 1000) }
    }
  },
  references: (p: string): TeamRoute => ({
    method: 'GET',
    path: `/v1/projects/${seg(p)}/references`
  }),
  /** 交付确认窗的检查（purpose: delivery 只回 checks，契约 4.3） */
  submitPlan: (p: string, a: Args): TeamRoute => {
    const files = Array.isArray(a.files)
      ? a.files
          .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
          .slice(0, 5000)
          .map((f) => ({
            path: req(f.path, 'path', 2000),
            action: f.action === 'modified' || f.action === 'deleted' ? f.action : 'added',
            size: num(f.size),
            class: str(f.class, 200)
          }))
      : []
    return {
      method: 'POST',
      path: `/v1/projects/${seg(p)}/submit-plan`,
      body: { purpose: a.purpose === 'submit' ? 'submit' : 'delivery', files }
    }
  }
} satisfies Record<string, (p: string, a: Args) => TeamRoute>

export type TeamOpName = keyof typeof TEAM_OPS

export function isTeamOp(name: unknown): name is TeamOpName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(TEAM_OPS, name)
}

export function buildTeamRoute(name: TeamOpName, project: string, args: unknown): TeamRoute {
  const a = args && typeof args === 'object' ? (args as Args) : {}
  return TEAM_OPS[name](project, a)
}
