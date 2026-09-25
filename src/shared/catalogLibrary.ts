/**
 * 服务端资产库（新后端 asset-catalog，"在线分页"那一种）在主进程与渲染层之间共用的形状。
 *
 * 与旧的网络库（networkV2 / SyncClient 行镜像）是两套东西：旧的把整库抄到本机，
 * 这里一行也不抄 —— 每个列表、计数、筛选、搜索、详情都是向服务端要一页，
 * 本机只缓存看过的页和图（设计：unreal-box-assets-server docs/design/million-asset-catalog.md
 * 2.1 节，ADR 0008）。
 *
 * 这里的字段名跟服务端 API 原样对齐（docs/integration/asset-catalog-api.md），
 * 只有 `previewUrl` 是主进程加的：把服务端的签名预览地址改写成本机
 * `uebox-preview://` 协议地址，渲染层不直接连服务端。
 */

/** 连接服务端时信任谁的证书 */
export type CatalogTrust =
  /** 只允许回环地址上的明文 http（实验环境、第一切片的目录服务就是这样） */
  | { kind: 'loopback-http' }
  /** https，证书由系统信任库验证（公网证书或已装进系统的企业 CA） */
  | { kind: 'system' }
  /**
   * https，只信这一张部署 CA，而且只对这台主机生效。
   * 指纹来自邀请链接或管理员给的 CA 文件，不是"第一次见到就信"。
   */
  | { kind: 'pinned-ca'; caPem: string; fingerprint256: string }

export type CatalogAuthMode =
  /** 成员账号密码登录：存刷新令牌，身份令牌到寿命 80% 时自动换新 */
  | 'password'
  /** 直接粘贴身份令牌（实验环境打印的那种，或 /login/cli 领到的 CLI 令牌） */
  | 'token'

export interface CatalogServerRecord {
  id: string
  label: string
  /** team-service 成员面（默认 8084），token 模式下可能没有 */
  memberUrl: string | null
  /** asset-catalog 地址（默认 8083） */
  catalogUrl: string
  /** Lore 远端，例如 lores://host:8441。没有它就不能导入和下载 */
  loreRemote: string | null
  /** 服务端声明的 lore CLI 版本和哈希（/.well-known/unreal-box），用来比对本机随包的那份 */
  loreCliVersion: string | null
  loreCliSha256: string | null
  trust: CatalogTrust
  /**
   * lore.exe 用的部署 CA（SSL_CERT_FILE）。成员面走回环 HTTP 时它不同于 trust；
   * 取自 well-known 的 caPem，有邀请指纹时必须对得上。
   */
  loreCa?: { caPem: string; fingerprint256: string } | null
  authMode: CatalogAuthMode
  /** password 模式下的成员名；token 模式下是令牌里的 subject（能解出来的话） */
  member: string | null
  addedAt: number
}

export interface CatalogLibraryRecord {
  /** 本机键：`<serverId>:<libraryId>` */
  key: string
  serverId: string
  libraryId: string
  name: string
  addedAt: number
}

/** 渲染层看到的服务器信息 —— 不含任何令牌 */
export interface CatalogServerView {
  id: string
  label: string
  catalogUrl: string
  memberUrl: string | null
  loreRemote: string | null
  trustKind: CatalogTrust['kind']
  caFingerprint: string | null
  authMode: CatalogAuthMode
  member: string | null
  /** 本机有没有可用的凭据（刷新令牌或粘贴的身份令牌） */
  signedIn: boolean
}

export interface CatalogLibraryView extends CatalogLibraryRecord {
  server: CatalogServerView
}

export interface CatalogTotal {
  value: number
  exact: boolean
}

export interface CatalogFolder {
  dirId: number
  path: string
  name: string
  nDirect: number
  nSubtree: number
  bytes: number
  nDirs: number
  color?: string | null
  cover?: string | null
}

export interface CatalogAssetSummary {
  id: number
  path: string
  name: string
  dirId: number
  repository: string
  ext: string
  class: string | null
  engine: string | null
  size: number
  modifiedMs: number
  tags: string[]
  hidden?: boolean
  modifiedBy?: string | null
  classCn?: string | null
  classColor?: string | null
  color?: string | null
  role?: string | null
  hasNote?: boolean
  /** 服务端的签名预览地址（设计 2.3）；第一切片没有 */
  preview?: { s128?: string; s256?: string } | null
  previewHint?: string | null
  enrich?: 'pending' | 'ok' | 'failed' | 'unsupported'
  score?: number
  /** 主进程改写后的本机协议地址；null 表示没有预览，渲染层画类图标 */
  previewUrl?: string | null
}

export interface CatalogAnnotations {
  note?: string | null
  color?: string | null
  role?: string | null
  poster?: string | null
  tags?: string[]
  updatedBy?: string | null
  updatedMs?: number | null
  flushed?: boolean
}

export interface CatalogAssetDetail extends CatalogAssetSummary {
  hash: string
  branch?: string
  revision?: string | null
  packageName?: string | null
  dependencies: Array<{ id: number; path: string }>
  dependenciesTruncated: boolean
  dependentsCount: number
  annotations?: CatalogAnnotations | null
  previews?: { s512?: string; poster?: string; media?: string[] } | null
  /** 主进程改写的大图地址 */
  largePreviewUrl?: string | null
}

export type CatalogSort = 'name' | 'modified' | 'size' | 'relevance'

export interface CatalogFilters {
  class?: string[]
  ext?: string[]
  engine?: string[]
  tag?: string[]
}

export interface CatalogListQuery extends CatalogFilters {
  dir: number
  recursive: boolean
  /** 有值时走 /search（按相关度排序，服务端最多翻到第 1000 条） */
  q?: string
  sort?: CatalogSort
  order?: 'asc' | 'desc'
}

export interface CatalogWindow {
  start: number
  items: CatalogAssetSummary[]
  total: CatalogTotal
  generation: number
  epoch: number
  /** 这一窗来自本机缓存（在线且代号一致时，或离线时的旧页） */
  fromCache: boolean
  /** 离线兜底给出的旧页：可能已经不是最新 */
  stale: boolean
  /** 搜索结果只能按游标往后翻到这么多条 */
  reachable: number
}

export type CatalogFacetField = 'class' | 'ext' | 'engine' | 'tags'

export interface CatalogFacetValue {
  value: string
  n: number
}

export interface CatalogFacets {
  total: CatalogTotal
  facets: Partial<Record<CatalogFacetField, CatalogFacetValue[]>>
}

export interface CatalogRemoteLibrary {
  id: string
  name: string
  state: string
  epoch: number
  generation: number
  counts: { assets: number; bytes: number; dirs: number }
  members: Array<{ memberId: number; repositoryId: string; branch: string }>
  complete?: boolean
  role?: string | null
}

/** 服务端这项能力在不在（路由不存在 = 404/405 且不是 JSON 错误体） */
export interface CatalogCapabilities {
  previews: boolean | null
  annotations: boolean | null
  events: boolean | null
  changes: boolean | null
  closure: boolean | null
  lore: boolean
}

export interface CatalogLibraryStatus {
  key: string
  online: boolean
  generation: number | null
  epoch: number | null
  state: string | null
  /** 最近一次失败的原因（给界面一句话） */
  lastError: string | null
  /** 登录失效（刷新令牌被吊销 / 过期、粘贴的令牌过期）：界面给"重新登录" */
  signedOut: boolean
  capabilities: CatalogCapabilities
}

export type CatalogLibraryEvent =
  | {
      kind: 'invalidate'
      key: string
      /** 'all'：整个库都要重取；否则只有这些文件夹（及其祖先的递归视图）受影响 */
      scope: 'all' | { dirIds: number[]; paths: string[] }
      generation: number | null
      epoch: number | null
      reason: 'sse' | 'poll' | 'changes' | 'epoch' | 'reset' | 'annotations' | 'local-write'
    }
  | { kind: 'status'; key: string; status: CatalogLibraryStatus }
  | { kind: 'job'; key: string; job: CatalogJobProgress }

export interface CatalogJobProgress {
  jobId: string
  type: 'import' | 'download'
  phase:
    | 'preparing'
    | 'syncing'
    | 'copying'
    | 'staging'
    | 'committing'
    | 'pushing'
    | 'materialising'
    | 'done'
    | 'failed'
  done: number
  total: number
  message?: string | null
  /** 失败时的原文（lore 的输出尾部或服务端错误） */
  error?: string | null
  /** 下载完成后本机文件的位置 */
  outputPaths?: string[]
}

/** 探测一个地址的结果：给"添加库"对话框用 */
export interface CatalogProbeResult {
  /** 规范化后的地址 */
  url: string
  kind: 'member' | 'catalog' | 'unknown'
  /** https 时服务端出示的证书链（叶子在前），用于显示和比对指纹 */
  chain: Array<{ subject: string; issuer: string; fingerprint256: string; isCA: boolean }>
  /** 与邀请链接 / CA 文件给的指纹比对后选中的 CA（没有给指纹时为 null） */
  pinnedFingerprint: string | null
  /** 系统信任库是否已经能验证这张证书 */
  systemTrusted: boolean
  wellKnown: {
    serverVersion?: string
    catalog?: string
    lore?: { remote?: string; cliVersion?: string; cliSha256?: string; caSha256?: string }
    auth?: { login?: string; refresh?: string; cliTokenPage?: string }
  } | null
  error: string | null
}

export interface CatalogConnectInput {
  address: string
  /** 邀请链接或 CA 文件给出的部署 CA SHA-256 指纹 */
  caFingerprint?: string | null
  /** 管理员给的 CA 文件内容（PEM） */
  caPem?: string | null
  authMode: CatalogAuthMode
  member?: string | null
  password?: string | null
  inviteCode?: string | null
  identityToken?: string | null
  /** token 模式下手填的 Lore 远端（没有成员面时拿不到） */
  loreRemote?: string | null
  label?: string | null
}

export interface CatalogConnectResult {
  server: CatalogServerView
  libraries: CatalogRemoteLibrary[]
}

/** 解析邀请链接：服务器地址 + 部署 CA 指纹 + 一次性邀请码（设计 3.8） */
export interface CatalogInvite {
  server: string
  caFingerprint: string | null
  code: string | null
}

const HEX64 = /^[0-9a-f]{64}$/

/** 把各种写法的 SHA-256 指纹（带冒号、大写、sha256: 前缀）规范成 64 位小写十六进制 */
export function normalizeFingerprint(input: string | null | undefined): string | null {
  if (!input) return null
  const cleaned = input
    .trim()
    .replace(/^sha-?256[:=]?/i, '')
    .replace(/[\s:]/g, '')
    .toLowerCase()
  return HEX64.test(cleaned) ? cleaned : null
}

/**
 * 解析邀请链接。team-service 发的是（client.md "Member sign-in"）：
 *
 *   https://<host>:8084/enroll#code=<邀请码>&ca=sha256:<部署 CA 的 SHA-256>
 *
 * `#` 之后的部分不会发给任何服务器。另外也宽松地接受：
 * - `unrealbox://join?server=<url>&ca=<指纹>&code=<邀请码>`（也认 fp / fingerprint / invite）
 * - 空白分隔的三段：地址、指纹、邀请码（从聊天软件里复制出来常常是这样）
 */
export function parseInvite(text: string): CatalogInvite | null {
  const raw = text.trim()
  if (!raw) return null
  const pick = (params: URLSearchParams, names: string[]): string | null => {
    for (const name of names) {
      const value = params.get(name)
      if (value && value.trim()) return value.trim()
    }
    return null
  }
  try {
    const url = new URL(raw)
    const params = new URLSearchParams(url.search)
    for (const [key, value] of new URLSearchParams(url.hash.replace(/^#/, '')))
      params.set(key, value)
    const server = pick(params, ['server', 's', 'host'])
    const fp = normalizeFingerprint(pick(params, ['ca', 'fp', 'fingerprint', 'caFingerprint']))
    const code = pick(params, ['code', 'invite', 'inviteCode'])
    if (server) return { server, caFingerprint: fp, code }
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return { server: `${url.protocol}//${url.host}`, caFingerprint: fp, code }
    }
  } catch {
    // 不是 URL，按空白分隔的三段试
  }
  const parts = raw.split(/\s+/)
  const server = parts.find((part) => /^https?:\/\//i.test(part))
  if (!server) return null
  const fp = parts.map((part) => normalizeFingerprint(part)).find((value) => value !== null) ?? null
  const code = parts.find((part) => part !== server && normalizeFingerprint(part) === null) ?? null
  return { server: server.replace(/\/+$/, ''), caFingerprint: fp, code }
}

/** 本机库键 */
export function catalogLibraryKey(serverId: string, libraryId: string): string {
  return `${serverId}:${libraryId}`
}

/** 列表查询规范化成稳定字符串：缓存键、游标表都靠它 */
export function normalizeListQuery(query: CatalogListQuery): string {
  const list = (values?: string[]): string =>
    values && values.length > 0 ? [...new Set(values)].sort().join(',') : ''
  const q = query.q?.trim() ?? ''
  const sort = q ? 'relevance' : (query.sort ?? 'name')
  const order = query.order ?? (sort === 'name' ? 'asc' : 'desc')
  return [
    `d=${query.dir}`,
    `r=${query.recursive ? 1 : 0}`,
    `q=${q}`,
    `s=${sort}`,
    `o=${order}`,
    `c=${list(query.class)}`,
    `x=${list(query.ext)}`,
    `e=${list(query.engine)}`,
    `t=${list(query.tag)}`
  ].join('&')
}
