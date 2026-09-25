/**
 * 服务端资产库（asset-catalog 后端）的主进程门面。
 *
 * 渲染层经 IPC 调这里；这里再向用户自己配置的服务器发请求。每个方法做的工作都与
 * 一页同量级（≤200 行、≤1000 个子文件夹），库有多大都一样 —— 翻页、计数、筛选、分面、
 * 搜索全在服务端做（ADR 0008）。本机只有有上限的缓存：内存里的页、磁盘上看过的页和图。
 *
 * 与旧网络库（networkV2 / SyncClient）完全分开：不建本地镜像库、不切换 vault、不碰
 * vault-data.db。
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  catalogLibraryKey,
  normalizeFingerprint,
  normalizeListQuery,
  type CatalogAssetDetail,
  type CatalogAssetSummary,
  type CatalogCapabilities,
  type CatalogConnectInput,
  type CatalogConnectResult,
  type CatalogFacetField,
  type CatalogFacets,
  type CatalogFolder,
  type CatalogJobProgress,
  type CatalogLibraryEvent,
  type CatalogLibraryRecord,
  type CatalogLibraryStatus,
  type CatalogLibraryView,
  type CatalogListQuery,
  type CatalogProbeResult,
  type CatalogRemoteLibrary,
  type CatalogServerRecord,
  type CatalogServerView,
  type CatalogTotal,
  type CatalogTrust,
  type CatalogWindow
} from '../../shared/catalogLibrary'
import { CatalogConfigStore } from './configStore'
import { DiskLru } from './diskLru'
import { CatalogHttp, CatalogHttpError, isLoopbackHost } from './http'
import { PageCache, type DirtySet, type PageScope } from './pageCache'
import { ASSET_PAGE_LIMIT, SEARCH_REACH, cursorKey, planListRequest } from './listRequest'
import { PreviewService, previewProtocolUrl } from './previews'
import { SecretStore, type SecretCodec } from './secrets'
import { CatalogSession, SignedOutError, decodeJwtClaims, type WellKnownAuth } from './session'
import { ServerEvents } from './serverEvents'
import type { CatalogEvent } from './sse'
import { ShadowCopies, type ShadowContext, type ShadowTarget } from './shadowCopy'
import {
  caFileName,
  isCaPem,
  pemFingerprint,
  probeCertificateChain,
  selectPinnedCa
} from './tlsTrust'
import type { LoreBinary } from './loreCli'

export interface CatalogServiceOptions {
  userDataDir: string
  /** 影子副本根目录（%LOCALAPPDATA% 下） */
  shadowRoot: string
  codec: SecretCodec
  emit: (event: CatalogLibraryEvent) => void
  resolveLore: () => Promise<{ binary: LoreBinary | null; problem: string | null }>
  /** 把一个包（含 .uexp/.ubulk 分片）复制到目标位置；复用工程导入的实现 */
  copyPackage: (sourceSeed: string, targetSeed: string) => Promise<number>
  sessionLabel: string
  now?: () => number
}

interface ServerRuntime {
  record: CatalogServerRecord
  catalog: CatalogHttp
  member: CatalogHttp | null
  session: CatalogSession
  events: ServerEvents | null
}

interface LibraryRuntime {
  record: CatalogLibraryRecord
  generation: number | null
  epoch: number | null
  state: string | null
  online: boolean
  lastError: string | null
  role: string | null
  members: CatalogRemoteLibrary['members']
  capabilities: CatalogCapabilities
  dirPaths: Map<number, string>
  cursors: Map<string, string>
  advancing: Promise<void>
  watchers: number
  lastSearchInvalidate: number
  signedOut: boolean
}

export class CatalogServiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CatalogServiceError'
  }
}

const MAX_FOLDER_CHILDREN = 5000
const MAX_CURSORS = 4000
const MAX_DIR_PATHS = 50_000
const DEPENDENCY_DEPTH = 5
const MAX_CLOSURE = 2000
const FACET_FIELDS: CatalogFacetField[] = ['class', 'ext', 'engine', 'tags']

type InvalidateReason = Extract<CatalogLibraryEvent, { kind: 'invalidate' }>['reason']

type WellKnown = NonNullable<CatalogProbeResult['wellKnown']> & { lore?: { caPem?: string } }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function normalizeAddress(address: string): string {
  const raw = address.trim()
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`
  const url = new URL(withScheme)
  return `${url.protocol}//${url.host}`
}

export class CatalogService {
  private readonly config: CatalogConfigStore
  private readonly secrets: SecretStore
  private readonly pages: PageCache
  readonly previews: PreviewService
  private readonly shadows: ShadowCopies
  private readonly servers = new Map<string, ServerRuntime>()
  private readonly libraries = new Map<string, LibraryRuntime>()
  private readonly jobs = new Map<string, AbortController>()
  private readonly now: () => number

  constructor(private readonly options: CatalogServiceOptions) {
    const root = join(options.userDataDir, 'catalog-cache')
    this.config = new CatalogConfigStore(join(options.userDataDir, 'catalog-libraries.json'))
    this.secrets = new SecretStore(
      join(options.userDataDir, 'catalog-library-secrets.bin'),
      options.codec
    )
    this.pages = new PageCache({
      maxMemoryBytes: 64 * 1024 * 1024,
      disk: new DiskLru({ root: join(root, 'pages'), maxBytes: 256 * 1024 * 1024 })
    })
    const previewDisk = new DiskLru({
      root: join(root, 'previews'),
      maxBytes: 2 * 1024 * 1024 * 1024
    })
    this.previews = new PreviewService(previewDisk, {
      httpFor: (key) => {
        const library = this.libraries.get(key)
        return library ? (this.servers.get(library.record.serverId)?.catalog ?? null) : null
      },
      onRouteMissing: (key) => {
        const library = this.libraries.get(key)
        if (library && library.capabilities.previews !== false) {
          library.capabilities.previews = false
          this.emitStatus(library)
        }
      }
    })
    this.shadows = new ShadowCopies(options.shadowRoot)
    this.now = options.now ?? Date.now
  }

  // ---------------------------------------------------------------- configuration

  private async ensureLoaded(): Promise<void> {
    const config = await this.config.read()
    for (const server of config.servers) {
      if (!this.servers.has(server.id))
        this.servers.set(server.id, this.createServerRuntime(server, null))
    }
    for (const record of config.libraries) {
      if (!this.libraries.has(record.key))
        this.libraries.set(record.key, this.createLibraryRuntime(record))
    }
  }

  private createServerRuntime(
    record: CatalogServerRecord,
    auth: WellKnownAuth | null
  ): ServerRuntime {
    const member = record.memberUrl ? new CatalogHttp(record.memberUrl, record.trust) : null
    const session = new CatalogSession(
      record.id,
      record.authMode,
      member,
      auth ?? {},
      this.secrets,
      this.options.sessionLabel,
      this.options.now
    )
    const catalog = new CatalogHttp(
      record.catalogUrl,
      record.trust,
      async () => await session.identityToken()
    )
    return { record, catalog, member, session, events: null }
  }

  private createLibraryRuntime(record: CatalogLibraryRecord): LibraryRuntime {
    return {
      record,
      generation: null,
      epoch: null,
      state: null,
      online: false,
      lastError: null,
      role: null,
      members: [],
      capabilities: {
        previews: null,
        annotations: null,
        events: null,
        changes: null,
        closure: null,
        lore: false
      },
      dirPaths: new Map([[0, '']]),
      cursors: new Map(),
      advancing: Promise.resolve(),
      watchers: 0,
      lastSearchInvalidate: 0,
      signedOut: false
    }
  }

  private async serverView(runtime: ServerRuntime): Promise<CatalogServerView> {
    const record = runtime.record
    return {
      id: record.id,
      label: record.label,
      catalogUrl: record.catalogUrl,
      memberUrl: record.memberUrl,
      loreRemote: record.loreRemote,
      trustKind: record.trust.kind,
      caFingerprint: record.trust.kind === 'pinned-ca' ? record.trust.fingerprint256 : null,
      authMode: record.authMode,
      member: record.member,
      signedIn: await runtime.session.signedIn()
    }
  }

  async listLibraries(): Promise<CatalogLibraryView[]> {
    await this.ensureLoaded()
    const config = await this.config.read()
    const out: CatalogLibraryView[] = []
    for (const record of config.libraries) {
      const server = this.servers.get(record.serverId)
      if (!server) continue
      out.push({ ...record, server: await this.serverView(server) })
    }
    return out
  }

  async listServers(): Promise<CatalogServerView[]> {
    await this.ensureLoaded()
    return await Promise.all([...this.servers.values()].map((server) => this.serverView(server)))
  }

  // ---------------------------------------------------------------- adding a server

  /**
   * 探测一个地址：https 的话先把证书链拿回来（不信任任何东西），再按给定指纹 / CA 文件
   * 决定信任谁，最后试 `/.well-known/unreal-box`（新服务器的成员面）。
   */
  async probe(
    address: string,
    caFingerprint?: string | null,
    caPem?: string | null
  ): Promise<CatalogProbeResult & { trust?: CatalogTrust | null; caPem?: string }> {
    let url: string
    try {
      url = normalizeAddress(address)
    } catch {
      return {
        url: address,
        kind: 'unknown',
        chain: [],
        pinnedFingerprint: null,
        systemTrusted: false,
        wellKnown: null,
        error: 'invalid-address',
        trust: null
      }
    }
    const parsed = new URL(url)
    const result: CatalogProbeResult & { trust: CatalogTrust | null; caPem?: string } = {
      url,
      kind: 'unknown',
      chain: [],
      pinnedFingerprint: null,
      systemTrusted: false,
      wellKnown: null,
      error: null,
      trust: null
    }
    if (parsed.protocol === 'http:') {
      if (!isLoopbackHost(parsed.hostname)) {
        result.error = 'insecure-http'
        return result
      }
      result.trust = { kind: 'loopback-http' }
    } else {
      let probe
      try {
        probe = await probeCertificateChain(url)
      } catch (error) {
        result.error = `unreachable: ${errorText(error)}`
        return result
      }
      result.chain = probe.chain.map((certificate) => ({
        subject: certificate.subject,
        issuer: certificate.issuer,
        fingerprint256: certificate.fingerprint256,
        isCA: certificate.isCA
      }))
      result.systemTrusted = probe.systemTrusted
      const wanted = normalizeFingerprint(caFingerprint ?? (caPem ? pemFingerprint(caPem) : null))
      if (caPem && !isCaPem(caPem)) {
        result.error = 'ca-file-not-ca'
        return result
      }
      if (wanted) {
        // 先用链里的；链里没有根 CA 时，退到 CA 文件或 well-known 给的 caPem（同样比指纹）
        let pinned = selectPinnedCa(probe.chain, wanted, caPem ?? null)
        if (!pinned) {
          const unverified = await this.fetchWellKnownUnverified(url).catch(() => null)
          pinned = selectPinnedCa(probe.chain, wanted, unverified?.lore?.caPem ?? null)
        }
        if (!pinned) {
          result.error = 'fingerprint-mismatch'
          return result
        }
        result.pinnedFingerprint = pinned.fingerprint256
        result.trust = {
          kind: 'pinned-ca',
          caPem: pinned.pem,
          fingerprint256: pinned.fingerprint256
        }
        result.caPem = pinned.pem
      } else if (probe.systemTrusted) {
        result.trust = { kind: 'system' }
      } else {
        result.error = 'untrusted-certificate'
        return result
      }
    }
    // 信任定下来之后，再按这个信任去问 well-known —— 这次是校验过证书的
    const http = new CatalogHttp(url, result.trust)
    try {
      const wellKnown = await http.json<WellKnown>('/.well-known/unreal-box', {
        anonymous: true,
        timeoutMs: 8000
      })
      result.wellKnown = wellKnown
      result.kind = 'member'
    } catch (error) {
      if (
        error instanceof CatalogHttpError &&
        (error.code === 'route-missing' || error.code === 'not-found')
      ) {
        // 没有成员面：可能直接就是目录服务（实验环境、第一切片），看 /health 认一下
        try {
          const health = await http.json<{ libraries?: unknown }>('/health', {
            anonymous: true,
            timeoutMs: 8000
          })
          result.kind = health && Array.isArray(health.libraries) ? 'catalog' : 'unknown'
        } catch {
          result.kind = 'unknown'
        }
      } else {
        result.error = `unreachable: ${errorText(error)}`
      }
    } finally {
      http.destroy()
    }
    return result
  }

  /** 只在"有指纹要比对、链里又没有根 CA"时用：拿回来的 caPem 只拿来比指纹，不直接信 */
  private async fetchWellKnownUnverified(url: string): Promise<WellKnown | null> {
    const https = await import('node:https')
    return await new Promise((resolve) => {
      const request = https.request(
        `${url}/.well-known/unreal-box`,
        { rejectUnauthorized: false, timeout: 8000 },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as WellKnown)
            } catch {
              resolve(null)
            }
          })
        }
      )
      request.on('error', () => resolve(null))
      request.on('timeout', () => request.destroy())
      request.end()
    })
  }

  /** 添加一台服务器（或更新它的登录），并列出这个账号能看到的库 */
  async connect(input: CatalogConnectInput): Promise<CatalogConnectResult> {
    await this.ensureLoaded()
    const probe = await this.probe(input.address, input.caFingerprint, input.caPem)
    if (probe.error || !probe.trust)
      throw new CatalogServiceError(
        probe.error ?? 'untrusted-certificate',
        probe.error ?? 'untrusted'
      )
    const wellKnown = probe.wellKnown
    let catalogUrl = probe.url
    let memberUrl: string | null = null
    let loreRemote = input.loreRemote?.trim() || null
    if (probe.kind === 'member' && wellKnown) {
      memberUrl = probe.url
      if (wellKnown.catalog) catalogUrl = trimSlash(normalizeAddress(wellKnown.catalog))
      loreRemote = loreRemote ?? wellKnown.lore?.remote ?? null
    } else if (probe.kind !== 'catalog') {
      throw new CatalogServiceError(
        'not-a-catalog',
        'This address is neither an Unreal Box server nor an asset catalog'
      )
    }
    if (input.authMode === 'password' && !memberUrl) {
      throw new CatalogServiceError(
        'no-member-surface',
        'This server has no member sign-in; paste an identity token instead'
      )
    }
    // 目录服务和成员面在同一台主机上时共用固定的 CA；不同主机时目录服务必须也能被同一张 CA 验证
    const trust = probe.trust
    const config = await this.config.read()
    const existing = config.servers.find((server) => server.catalogUrl === catalogUrl)
    const id = existing?.id ?? randomUUID()
    const record: CatalogServerRecord = {
      id,
      label: input.label?.trim() || new URL(catalogUrl).host,
      memberUrl,
      catalogUrl,
      loreRemote,
      loreCliVersion: wellKnown?.lore?.cliVersion ?? null,
      loreCliSha256: wellKnown?.lore?.cliSha256 ?? null,
      trust,
      authMode: input.authMode,
      member: input.member?.trim() || null,
      addedAt: existing?.addedAt ?? this.now()
    }
    const previous = this.servers.get(id)
    previous?.events?.stop()
    previous?.catalog.destroy()
    const runtime = this.createServerRuntime(
      record,
      (wellKnown?.auth as WellKnownAuth | undefined) ?? null
    )
    this.servers.set(id, runtime)
    try {
      if (input.authMode === 'password') {
        if (!input.password)
          throw new CatalogServiceError('missing-password', 'Password is required')
        const who = await runtime.session.signIn({
          member: input.member,
          password: input.password,
          inviteCode: input.inviteCode
        })
        record.member = who ?? record.member
      } else {
        if (!input.identityToken)
          throw new CatalogServiceError('missing-token', 'Identity token is required')
        const who = await runtime.session.useIdentityToken(input.identityToken)
        record.member = who ?? record.member
      }
      const remote = await this.fetchRemoteLibraries(runtime)
      await this.config.update((next) => {
        next.servers = next.servers.filter((server) => server.id !== id)
        next.servers.push(record)
      })
      return { server: await this.serverView(runtime), libraries: remote }
    } catch (error) {
      if (!existing) {
        this.servers.delete(id)
        await this.secrets.set(id, null).catch(() => undefined)
      }
      throw this.wrap(error)
    }
  }

  private async fetchRemoteLibraries(runtime: ServerRuntime): Promise<CatalogRemoteLibrary[]> {
    const body = await runtime.catalog.json<
      { items?: CatalogRemoteLibrary[] } | CatalogRemoteLibrary[]
    >('/v1/libraries')
    const items = Array.isArray(body) ? body : (body.items ?? [])
    for (const item of items) {
      const library = this.libraries.get(catalogLibraryKey(runtime.record.id, item.id))
      if (library) {
        library.members = item.members ?? []
        library.role = item.role ?? null
        library.state = item.state ?? null
        void this.noteGeneration(library, item.generation, item.epoch, null, 'poll')
      }
    }
    return items
  }

  async remoteLibraries(serverId: string): Promise<CatalogRemoteLibrary[]> {
    const runtime = await this.server(serverId)
    try {
      return await this.fetchRemoteLibraries(runtime)
    } catch (error) {
      throw this.wrap(error)
    }
  }

  async addLibraries(
    serverId: string,
    libraries: Array<{ id: string; name: string }>
  ): Promise<CatalogLibraryView[]> {
    await this.ensureLoaded()
    if (!this.servers.has(serverId))
      throw new CatalogServiceError('unknown-server', 'Unknown server')
    await this.config.update((next) => {
      for (const library of libraries) {
        const key = catalogLibraryKey(serverId, library.id)
        if (next.libraries.some((existing) => existing.key === key)) continue
        next.libraries.push({
          key,
          serverId,
          libraryId: library.id,
          name: library.name || library.id,
          addedAt: this.now()
        })
      }
    })
    await this.ensureLoaded()
    return await this.listLibraries()
  }

  async removeLibrary(key: string): Promise<void> {
    await this.ensureLoaded()
    const library = this.libraries.get(key)
    await this.config.update((next) => {
      next.libraries = next.libraries.filter((existing) => existing.key !== key)
    })
    this.libraries.delete(key)
    this.pages.dropLibrary(key)
    if (library) {
      const stillUsed = [...this.libraries.values()].some(
        (other) => other.record.serverId === library.record.serverId
      )
      if (!stillUsed) await this.removeServer(library.record.serverId)
      else
        this.servers
          .get(library.record.serverId)
          ?.events?.setLibraries(this.watchedLibraryIds(library.record.serverId))
    }
  }

  async removeServer(serverId: string): Promise<void> {
    const runtime = this.servers.get(serverId)
    if (runtime) {
      runtime.events?.stop()
      await runtime.session.signOut().catch(() => undefined)
      runtime.catalog.destroy()
      this.servers.delete(serverId)
    }
    await this.config.update((next) => {
      next.servers = next.servers.filter((server) => server.id !== serverId)
      next.libraries = next.libraries.filter((library) => library.serverId !== serverId)
    })
    await this.secrets.set(serverId, null)
  }

  async signIn(
    serverId: string,
    input: {
      member?: string | null
      password?: string | null
      inviteCode?: string | null
      identityToken?: string | null
    }
  ): Promise<CatalogServerView> {
    const runtime = await this.server(serverId)
    try {
      if (runtime.record.authMode === 'token') {
        const who = await runtime.session.useIdentityToken(input.identityToken ?? '')
        if (who) runtime.record.member = who
      } else {
        const who = await runtime.session.signIn({
          member: input.member ?? runtime.record.member,
          password: input.password ?? '',
          inviteCode: input.inviteCode
        })
        if (who) runtime.record.member = who
      }
      await this.config.update((next) => {
        const server = next.servers.find((candidate) => candidate.id === serverId)
        if (server) server.member = runtime.record.member
      })
      for (const library of this.libraries.values()) {
        if (library.record.serverId === serverId) {
          library.lastError = null
          this.emitStatus(library)
        }
      }
      return await this.serverView(runtime)
    } catch (error) {
      throw this.wrap(error)
    }
  }

  async signOut(serverId: string): Promise<void> {
    const runtime = await this.server(serverId)
    await runtime.session.signOut()
  }

  async setLoreRemote(serverId: string, remote: string | null): Promise<void> {
    const runtime = await this.server(serverId)
    const value = remote?.trim() || null
    if (value && !/^lores?:\/\//i.test(value))
      throw new CatalogServiceError('bad-remote', 'A Lore remote starts with lores://')
    if (
      value?.startsWith('lore://') &&
      !isLoopbackHost(new URL(value.replace(/^lore/, 'http')).hostname)
    ) {
      throw new CatalogServiceError(
        'bad-remote',
        'Plaintext lore:// is only allowed on this machine'
      )
    }
    runtime.record.loreRemote = value
    await this.config.update((next) => {
      const server = next.servers.find((candidate) => candidate.id === serverId)
      if (server) server.loreRemote = value
    })
  }

  private async server(serverId: string): Promise<ServerRuntime> {
    await this.ensureLoaded()
    const runtime = this.servers.get(serverId)
    if (!runtime) throw new CatalogServiceError('unknown-server', 'Unknown server')
    return runtime
  }

  private async library(key: string): Promise<{ library: LibraryRuntime; server: ServerRuntime }> {
    await this.ensureLoaded()
    const library = this.libraries.get(key)
    if (!library) throw new CatalogServiceError('unknown-library', 'Unknown library')
    const server = this.servers.get(library.record.serverId)
    if (!server) throw new CatalogServiceError('unknown-server', 'Unknown server')
    return { library, server }
  }

  private wrap(error: unknown): Error {
    if (error instanceof CatalogServiceError) return error
    if (error instanceof SignedOutError) return new CatalogServiceError('signed-out', error.message)
    if (error instanceof CatalogHttpError) return new CatalogServiceError(error.code, error.message)
    return new CatalogServiceError('unknown', errorText(error))
  }

  // ---------------------------------------------------------------- status and live refresh

  private statusOf(library: LibraryRuntime): CatalogLibraryStatus {
    return {
      key: library.record.key,
      online: library.online,
      generation: library.generation,
      epoch: library.epoch,
      state: library.state,
      lastError: library.lastError,
      signedOut: library.signedOut,
      capabilities: { ...library.capabilities }
    }
  }

  private emitStatus(library: LibraryRuntime): void {
    this.options.emit({ kind: 'status', key: library.record.key, status: this.statusOf(library) })
  }

  async status(key: string): Promise<CatalogLibraryStatus> {
    const { library } = await this.library(key)
    const lore = await this.options.resolveLore().catch(() => ({ binary: null, problem: null }))
    const server = this.servers.get(library.record.serverId)
    library.capabilities.lore = Boolean(lore.binary && server?.record.loreRemote)
    return this.statusOf(library)
  }

  private markOnline(library: LibraryRuntime, online: boolean, error: string | null): void {
    const signedOut = online && error === null ? false : library.signedOut
    const changed =
      library.online !== online || library.lastError !== error || library.signedOut !== signedOut
    library.online = online
    library.lastError = error
    library.signedOut = signedOut
    if (changed) this.emitStatus(library)
  }

  private watchedLibraryIds(serverId: string): string[] {
    return [...this.libraries.values()]
      .filter((library) => library.record.serverId === serverId && library.watchers > 0)
      .map((library) => library.record.libraryId)
  }

  /** 渲染层打开了这个库的视图：开始收变化通知（SSE，拦掉了就 30 秒轮询） */
  async watch(key: string): Promise<CatalogLibraryStatus> {
    const { library, server } = await this.library(key)
    library.watchers += 1
    if (!server.events) {
      server.events = new ServerEvents({
        http: server.catalog,
        onEvent: (event) => this.onServerEvent(server, event),
        onStreamState: (available) => {
          for (const candidate of this.libraries.values()) {
            if (candidate.record.serverId !== server.record.id) continue
            if (candidate.capabilities.events !== available) {
              candidate.capabilities.events = available
              this.emitStatus(candidate)
            }
          }
        },
        poll: async () => {
          await this.fetchRemoteLibraries(server).then(
            () => {
              for (const candidate of this.libraries.values()) {
                if (candidate.record.serverId === server.record.id)
                  this.markOnline(candidate, true, null)
              }
            },
            (error) => {
              for (const candidate of this.libraries.values()) {
                if (candidate.record.serverId === server.record.id)
                  this.markOnline(candidate, false, errorText(error))
              }
            }
          )
        }
      })
    }
    server.events.setLibraries(this.watchedLibraryIds(server.record.id))
    return await this.status(key)
  }

  async unwatch(key: string): Promise<void> {
    const { library, server } = await this.library(key)
    library.watchers = Math.max(0, library.watchers - 1)
    const ids = this.watchedLibraryIds(server.record.id)
    if (ids.length === 0) {
      server.events?.stop()
      server.events = null
    } else {
      server.events?.setLibraries(ids)
    }
  }

  private onServerEvent(server: ServerRuntime, event: CatalogEvent): void {
    const libraryId = 'library' in event ? event.library : null
    const targets = [...this.libraries.values()].filter(
      (library) =>
        library.record.serverId === server.record.id &&
        (libraryId === null || library.record.libraryId === libraryId)
    )
    for (const library of targets) {
      switch (event.type) {
        case 'generation': {
          const dirty: DirtySet | null =
            event.dirs === 'broad'
              ? null
              : {
                  dirIds: event.dirs.filter((dir): dir is number => typeof dir === 'number'),
                  paths: event.dirs.filter((dir): dir is string => typeof dir === 'string'),
                  subtree: event.subtree
                }
          void this.noteGeneration(
            library,
            event.generation,
            event.epoch ?? library.epoch ?? 0,
            dirty ?? 'all',
            'sse'
          )
          break
        }
        case 'annotations': {
          const dirty: DirtySet | 'all' =
            event.paths === 'bulk'
              ? 'all'
              : { dirIds: [], paths: event.paths.map((path) => posix.dirname(path)) }
          this.invalidate(library, dirty, 'annotations')
          break
        }
        case 'previews':
          // 有新图了：之前"无预览"的格子要重取一次列表才知道新地址
          this.invalidateSearchLike(library, 'annotations')
          break
        case 'state':
          library.state = event.state
          if (event.epoch !== null && library.epoch !== null && event.epoch !== library.epoch) {
            void this.noteGeneration(
              library,
              event.generation ?? library.generation ?? 0,
              event.epoch,
              'all',
              'epoch'
            )
          } else if (event.generation !== null && event.epoch !== null) {
            // 连上时的基线：比我们知道的新，就用 /changes 补上中间漏掉的
            void this.noteGeneration(library, event.generation, event.epoch, null, 'sse')
          }
          this.emitStatus(library)
          break
        case 'reset':
          this.pages.dropLibrary(library.record.key)
          library.cursors.clear()
          this.options.emit({
            kind: 'invalidate',
            key: library.record.key,
            scope: 'all',
            generation: library.generation,
            epoch: library.epoch,
            reason: 'reset'
          })
          break
        case 'access':
          void this.fetchRemoteLibraries(server).catch(() => undefined)
          this.pages.dropLibrary(library.record.key)
          this.options.emit({
            kind: 'invalidate',
            key: library.record.key,
            scope: 'all',
            generation: library.generation,
            epoch: library.epoch,
            reason: 'reset'
          })
          break
        default:
          break
      }
    }
  }

  /** 代号没变、但我们知道某些页旧了（自己刚写过、注释事件）：只丢受影响的页 */
  private invalidate(
    library: LibraryRuntime,
    dirty: DirtySet | 'all',
    reason: 'annotations' | 'local-write'
  ): void {
    this.pages.drop(library.record.key, dirty)
    this.options.emit({
      kind: 'invalidate',
      key: library.record.key,
      scope: dirty === 'all' ? 'all' : dirty,
      generation: library.generation,
      epoch: library.epoch,
      reason
    })
  }

  private invalidateSearchLike(library: LibraryRuntime, reason: 'annotations'): void {
    const now = this.now()
    // 搜索结果页最多每 5 秒按新代号重取一次（设计 2.1）
    if (now - library.lastSearchInvalidate < 5000) return
    library.lastSearchInvalidate = now
    this.invalidate(library, 'all', reason)
  }

  /**
   * 库的代号前进了。dirty：
   * - DirtySet：SSE 告诉了哪些文件夹变了；
   * - 'all'：明确整库作废；
   * - null：不知道哪里变了（响应里看到新代号、轮询看到新代号）——先问 /changes，
   *   没有这条路由就整库作废。
   */
  private async noteGeneration(
    library: LibraryRuntime,
    generation: number | null | undefined,
    epoch: number | null | undefined,
    dirty: DirtySet | 'all' | null,
    reason: 'sse' | 'poll' | 'changes' | 'epoch'
  ): Promise<void> {
    if (typeof generation !== 'number' || typeof epoch !== 'number') return
    const work = async (): Promise<void> => {
      const knownGeneration = library.generation
      const knownEpoch = library.epoch
      if (knownGeneration === null || knownEpoch === null) {
        library.generation = generation
        library.epoch = epoch
        return
      }
      if (epoch !== knownEpoch) {
        library.generation = generation
        library.epoch = epoch
        library.cursors.clear()
        this.pages.advance(library.record.key, 'all', generation, epoch)
        this.options.emit({
          kind: 'invalidate',
          key: library.record.key,
          scope: 'all',
          generation,
          epoch,
          reason: 'epoch'
        })
        this.emitStatus(library)
        return
      }
      if (generation <= knownGeneration) return
      let scope: DirtySet | 'all' = dirty ?? 'all'
      let why: InvalidateReason = reason
      if (dirty === null) {
        const changes = await this.fetchChanges(library, knownGeneration)
        scope = changes
        why = changes === 'all' ? reason : 'changes'
      }
      library.generation = generation
      this.pages.advance(library.record.key, scope, generation, epoch)
      if (scope === 'all') library.cursors.clear()
      this.options.emit({
        kind: 'invalidate',
        key: library.record.key,
        scope,
        generation,
        epoch,
        reason: why
      })
      this.emitStatus(library)
    }
    library.advancing = library.advancing.catch(() => undefined).then(work)
    await library.advancing
  }

  /** `/changes?since=` 补课（设计 3.6）；410 = 超出保留窗口，整库作废 */
  private async fetchChanges(library: LibraryRuntime, since: number): Promise<DirtySet | 'all'> {
    if (library.capabilities.changes === false) return 'all'
    const server = this.servers.get(library.record.serverId)
    if (!server) return 'all'
    const paths = new Set<string>()
    let from = since
    try {
      for (let round = 0; round < 5; round += 1) {
        const body = await server.catalog.json<{
          items?: Array<{ path: string; pathFrom?: string | null; op?: string }>
          more?: boolean
          to?: number
        }>(`/v1/libraries/${encodeURIComponent(library.record.libraryId)}/changes`, {
          query: { since: from, limit: 10_000, epoch: library.epoch ?? undefined }
        })
        library.capabilities.changes = true
        for (const item of body.items ?? []) {
          paths.add(posix.dirname(item.path.replace(/\\/g, '/')))
          // 移动：原来所在的文件夹也少了一项
          if (item.pathFrom) paths.add(posix.dirname(item.pathFrom.replace(/\\/g, '/')))
        }
        if (!body.more || typeof body.to !== 'number') break
        from = body.to
        if (paths.size > 2000) return 'all'
      }
      return { dirIds: [], paths: [...paths].map((path) => (path === '.' ? '' : path)) }
    } catch (error) {
      if (error instanceof CatalogHttpError && error.code === 'route-missing') {
        library.capabilities.changes = false
        this.emitStatus(library)
      }
      return 'all'
    }
  }

  // ---------------------------------------------------------------- browse

  private rememberPath(library: LibraryRuntime, dirId: number, path: string): void {
    if (library.dirPaths.size > MAX_DIR_PATHS) {
      library.dirPaths.clear()
      library.dirPaths.set(0, '')
    }
    library.dirPaths.set(dirId, path)
  }

  private decorate(library: LibraryRuntime, item: CatalogAssetSummary): CatalogAssetSummary {
    const signed = item.preview?.s256 ?? item.preview?.s128 ?? null
    if (item.preview && library.capabilities.previews !== true) {
      library.capabilities.previews = true
      this.emitStatus(library)
    }
    return {
      ...item,
      tags: Array.isArray(item.tags) ? item.tags : [],
      previewUrl: previewProtocolUrl(library.record.key, signed)
    }
  }

  /** 每个响应都带 {generation, epoch}：比已知的新就走一次"代号前进" */
  private observe(library: LibraryRuntime, body: { generation?: unknown; epoch?: unknown }): void {
    this.markOnline(library, true, null)
    const generation = typeof body.generation === 'number' ? body.generation : null
    const epoch = typeof body.epoch === 'number' ? body.epoch : null
    if (generation === null || epoch === null) return
    if (library.generation === null || library.epoch === null) {
      library.generation = generation
      library.epoch = epoch
      return
    }
    if (epoch !== library.epoch || generation > library.generation)
      void this.noteGeneration(library, generation, epoch, null, 'poll')
  }

  private async request<T extends object>(
    library: LibraryRuntime,
    server: ServerRuntime,
    path: string,
    options: Parameters<CatalogHttp['json']>[1] = {}
  ): Promise<T> {
    try {
      const body = await server.catalog.json<T>(path, options)
      this.observe(library, body as { generation?: unknown; epoch?: unknown })
      return body
    } catch (error) {
      if (error instanceof CatalogHttpError) {
        if (error.code === 'unauthorized') {
          server.session.invalidate()
          library.signedOut = true
          this.markOnline(library, true, error.message)
        }
        if (error.offline || error.code === 'tls') this.markOnline(library, false, error.message)
      } else if (error instanceof SignedOutError) {
        library.signedOut = true
        this.markOnline(library, true, error.message)
      }
      throw error
    }
  }

  /** 缓存优先：在线且代号对得上就命中；请求失败且是离线类错误时给看过的旧页 */
  private async cached<T>(
    library: LibraryRuntime,
    key: string,
    scope: PageScope | ((data: T) => PageScope),
    fetcher: () => Promise<{ data: T; generation: number; epoch: number }>
  ): Promise<{ data: T; fromCache: boolean; stale: boolean; generation: number; epoch: number }> {
    const libraryKey = library.record.key
    if (library.generation !== null && library.epoch !== null) {
      const hit = this.pages.getFresh<T>(libraryKey, key, library.generation, library.epoch)
      if (hit)
        return {
          data: hit.data,
          fromCache: true,
          stale: false,
          generation: hit.generation,
          epoch: hit.epoch
        }
    }
    try {
      const fresh = await fetcher()
      const resolved = typeof scope === 'function' ? scope(fresh.data) : scope
      this.pages.put<T>(libraryKey, key, {
        generation: fresh.generation,
        epoch: fresh.epoch,
        scope: resolved,
        data: fresh.data
      })
      return { ...fresh, fromCache: false, stale: false }
    } catch (error) {
      if (error instanceof CatalogHttpError && (error.offline || error.code === 'tls')) {
        const old = await this.pages.getAny<T>(libraryKey, key)
        if (old)
          return {
            data: old.data,
            fromCache: true,
            stale: true,
            generation: old.generation,
            epoch: old.epoch
          }
      }
      throw this.wrap(error)
    }
  }

  async folders(
    key: string,
    parent: number
  ): Promise<{ folder: CatalogFolder | null; items: CatalogFolder[]; stale: boolean }> {
    const { library, server } = await this.library(key)
    const libraryPath = `/v1/libraries/${encodeURIComponent(library.record.libraryId)}/folders`
    const result = await this.cached<{ folder: CatalogFolder | null; items: CatalogFolder[] }>(
      library,
      `folders|${parent}`,
      { dir: parent, path: library.dirPaths.get(parent) ?? null, recursive: true, search: false },
      async () => {
        const items: CatalogFolder[] = []
        let folder: CatalogFolder | null = null
        let cursor: string | null = null
        let generation = library.generation ?? 0
        let epoch = library.epoch ?? 0
        do {
          const body: {
            folder?: CatalogFolder
            items?: CatalogFolder[]
            nextCursor?: string | null
            generation?: number
            epoch?: number
          } = await this.request(library, server, libraryPath, {
            query: { parent, limit: 1000, cursor }
          })
          folder = body.folder ?? folder
          items.push(...(body.items ?? []))
          cursor = body.nextCursor ?? null
          generation = body.generation ?? generation
          epoch = body.epoch ?? epoch
        } while (cursor && items.length < MAX_FOLDER_CHILDREN)
        return { data: { folder, items }, generation, epoch }
      }
    )
    const { folder, items } = result.data
    if (folder) this.rememberPath(library, folder.dirId, folder.path)
    for (const item of items) this.rememberPath(library, item.dirId, item.path)
    return { folder, items, stale: result.stale }
  }

  async folderByPath(key: string, path: string): Promise<CatalogFolder> {
    const { library, server } = await this.library(key)
    try {
      const folder = await this.request<CatalogFolder>(
        library,
        server,
        `/v1/libraries/${encodeURIComponent(library.record.libraryId)}/folders/by-path`,
        { query: { path } }
      )
      this.rememberPath(library, folder.dirId, folder.path)
      return folder
    } catch (error) {
      throw this.wrap(error)
    }
  }

  async listWindow(
    key: string,
    query: CatalogListQuery,
    start: number,
    limit: number
  ): Promise<CatalogWindow> {
    const { library, server } = await this.library(key)
    const normalized = normalizeListQuery(query)
    const isSearch = Boolean(query.q?.trim())
    const size = Math.max(1, Math.min(limit || 100, isSearch ? 100 : ASSET_PAGE_LIMIT))
    if (isSearch && start >= SEARCH_REACH) {
      return {
        start,
        items: [],
        total: { value: 0, exact: true },
        generation: library.generation ?? 0,
        epoch: library.epoch ?? 0,
        fromCache: false,
        stale: false,
        reachable: SEARCH_REACH
      }
    }
    // 搜索只有游标：跳着要的窗先把前面的游标链补齐（每窗一页，最多到第 1000 条）
    if (isSearch && start > 0 && !library.cursors.has(cursorKey(normalized, start))) {
      for (let previous = 0; previous < start; previous += size) {
        if (previous > 0 && !library.cursors.has(cursorKey(normalized, previous))) break
        if (library.cursors.has(cursorKey(normalized, previous + size))) continue
        await this.listWindow(key, query, previous, size)
      }
    }
    const result = await this.cached<{ items: CatalogAssetSummary[]; total: CatalogTotal }>(
      library,
      `list|${normalized}|${start}|${size}`,
      {
        dir: query.dir,
        path: library.dirPaths.get(query.dir) ?? null,
        recursive: query.recursive,
        search: isSearch
      },
      async () => {
        const cursor =
          start === 0 ? null : (library.cursors.get(cursorKey(normalized, start)) ?? null)
        if (isSearch && start > 0 && !cursor) {
          return {
            data: { items: [], total: { value: 0, exact: true } },
            generation: library.generation ?? 0,
            epoch: library.epoch ?? 0
          }
        }
        const plan = planListRequest(library.record.libraryId, query, start, size, cursor)
        const body = await this.request<{
          items?: CatalogAssetSummary[]
          total?: CatalogTotal
          nextCursor?: string | null
          generation?: number
          epoch?: number
        }>(library, server, plan.path, { query: plan.query })
        const items = (body.items ?? []).map((item) => this.decorate(library, item))
        if (body.nextCursor) {
          if (library.cursors.size > MAX_CURSORS) library.cursors.clear()
          library.cursors.set(cursorKey(normalized, start + items.length), body.nextCursor)
        }
        return {
          data: { items, total: body.total ?? { value: start + items.length, exact: false } },
          generation: body.generation ?? library.generation ?? 0,
          epoch: body.epoch ?? library.epoch ?? 0
        }
      }
    )
    return {
      start,
      items: result.data.items,
      total: result.data.total,
      generation: result.generation,
      epoch: result.epoch,
      fromCache: result.fromCache,
      stale: result.stale,
      reachable: isSearch
        ? Math.min(result.data.total.value, SEARCH_REACH)
        : result.data.total.value
    }
  }

  async facets(
    key: string,
    query: CatalogListQuery,
    fields: CatalogFacetField[] = FACET_FIELDS,
    limit = 50
  ): Promise<CatalogFacets> {
    const { library, server } = await this.library(key)
    const normalized = normalizeListQuery(query)
    const wanted = fields.filter((field) => FACET_FIELDS.includes(field))
    const result = await this.cached<CatalogFacets>(
      library,
      `facets|${normalized}|${wanted.join(',')}|${limit}`,
      {
        dir: query.dir,
        path: library.dirPaths.get(query.dir) ?? null,
        recursive: query.recursive,
        search: Boolean(query.q?.trim())
      },
      async () => {
        const filters: Record<string, string[]> = {}
        for (const field of ['class', 'ext', 'engine', 'tag'] as const) {
          const values = query[field]
          if (values && values.length > 0) filters[field === 'tag' ? 'tags' : field] = values
        }
        const body = await this.request<CatalogFacets & { generation?: number; epoch?: number }>(
          library,
          server,
          `/v1/libraries/${encodeURIComponent(library.record.libraryId)}/facets`,
          {
            method: 'POST',
            body: {
              scope: { dir: query.dir, recursive: query.recursive },
              ...(query.q?.trim() ? { q: query.q.trim() } : {}),
              ...(Object.keys(filters).length > 0 ? { filters } : {}),
              fields: wanted,
              limit
            }
          }
        )
        return {
          data: { total: body.total, facets: body.facets ?? {} },
          generation: body.generation ?? library.generation ?? 0,
          epoch: body.epoch ?? library.epoch ?? 0
        }
      }
    )
    return result.data
  }

  async detail(key: string, id: number): Promise<CatalogAssetDetail> {
    const { library, server } = await this.library(key)
    const result = await this.cached<CatalogAssetDetail>(
      library,
      `detail|${id}`,
      (data) => ({
        dir: data.dirId ?? null,
        path: data.path ? posix.dirname(data.path) : null,
        recursive: false,
        search: false
      }),
      async () => {
        const body = await this.request<
          CatalogAssetDetail & { generation?: number; epoch?: number }
        >(
          library,
          server,
          `/v1/libraries/${encodeURIComponent(library.record.libraryId)}/assets/${id}`
        )
        const decorated = this.decorate(library, body) as CatalogAssetDetail
        decorated.dependencies = Array.isArray(body.dependencies) ? body.dependencies : []
        decorated.largePreviewUrl = previewProtocolUrl(
          library.record.key,
          body.previews?.s512 ?? body.preview?.s256 ?? null
        )
        return {
          data: decorated,
          generation: body.generation ?? library.generation ?? 0,
          epoch: body.epoch ?? library.epoch ?? 0
        }
      }
    )
    // 详情的范围是它所在的文件夹：SSE 说这个文件夹变了才作废
    return result.data
  }

  // ---------------------------------------------------------------- annotations

  /** 服务端有没有注释路由：发一个空的 ops 探一下（空操作不改任何东西） */
  /**
   * 能不能改注释：先看服务端有没有注释路由（`GET …/annotations/status`，只读、不改任何东西），
   * 再看这个成员在库的成员仓库上是不是 writer / admin / owner（成员面 `GET /v1/auth/me`）。
   * 没有成员面（粘贴令牌）时拿不到角色，按可写处理；真改时服务端回 403 再收回。
   */
  async probeAnnotations(key: string): Promise<boolean> {
    const { library, server } = await this.library(key)
    if (library.capabilities.annotations !== null) return library.capabilities.annotations
    let routePresent = false
    try {
      await server.catalog.json(
        `/v1/libraries/${encodeURIComponent(library.record.libraryId)}/annotations/status`,
        { timeoutMs: 8000 }
      )
      routePresent = true
    } catch (error) {
      // 403 = 路由在，但这个账号在这里只读
      if (error instanceof CatalogHttpError && error.code === 'forbidden') routePresent = true
      else if (!(error instanceof CatalogHttpError && error.code === 'route-missing')) return false
    }
    let writable = routePresent
    if (routePresent) {
      const role = await this.roleIn(server, library).catch(() => null)
      if (role !== null) writable = ['writer', 'admin', 'owner'].includes(role)
    }
    library.capabilities.annotations = writable
    this.emitStatus(library)
    return writable
  }

  /** 这个成员在库的成员仓库上的最高角色；没有成员面或查不到时 null */
  private async roleIn(server: ServerRuntime, library: LibraryRuntime): Promise<string | null> {
    if (library.role) return library.role
    if (!server.member) return null
    const token = await server.session.identityToken()
    const me = await server.member.json<{
      repositories?: Record<string, string>
      wildcard?: string | null
    }>(server.session.route('me', '/v1/auth/me'), {
      anonymous: true,
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 8000
    })
    const rank = ['reader', 'writer', 'admin', 'owner']
    let best: string | null = typeof me.wildcard === 'string' ? me.wildcard : null
    for (const member of library.members) {
      const role = me.repositories?.[member.repositoryId]
      if (role && rank.indexOf(role) > rank.indexOf(best ?? '')) best = role
    }
    library.role = best
    return best
  }

  async editAnnotations(
    key: string,
    ops: Array<{
      path?: string
      folderPath?: string
      set?: Record<string, unknown>
      addTags?: string[]
      removeTags?: string[]
    }>
  ): Promise<{ accepted: number; journalSeq: number | null }> {
    const { library, server } = await this.library(key)
    if (ops.length === 0 || ops.length > 10_000)
      throw new CatalogServiceError('bad-request', 'Between 1 and 10000 edits')
    try {
      const body = await this.request<{ accepted?: number; journalSeq?: number }>(
        library,
        server,
        `/v1/libraries/${encodeURIComponent(library.record.libraryId)}/annotations`,
        { method: 'PATCH', body: { ops } }
      )
      library.capabilities.annotations = true
      const paths = ops.map((op) => op.path ?? op.folderPath ?? '').filter(Boolean)
      this.invalidate(
        library,
        { dirIds: [], paths: paths.map((path) => posix.dirname(path)) },
        'local-write'
      )
      return { accepted: body.accepted ?? ops.length, journalSeq: body.journalSeq ?? null }
    } catch (error) {
      if (
        error instanceof CatalogHttpError &&
        (error.code === 'route-missing' || error.code === 'forbidden')
      ) {
        library.capabilities.annotations = false
        this.emitStatus(library)
      }
      throw this.wrap(error)
    }
  }

  // ---------------------------------------------------------------- lore: download and import

  private async loreContext(server: ServerRuntime, signal: AbortSignal): Promise<ShadowContext> {
    const lore = await this.options.resolveLore()
    if (!lore.binary)
      throw new CatalogServiceError('lore-missing', lore.problem ?? 'lore.exe is not available')
    let caFile: string | null = null
    if (server.record.trust.kind === 'pinned-ca') {
      const dir = join(this.options.shadowRoot, 'ca')
      await fs.mkdir(dir, { recursive: true })
      caFile = join(dir, caFileName(server.record.trust.fingerprint256))
      await fs.writeFile(caFile, server.record.trust.caPem, 'utf8')
    }
    return {
      binary: lore.binary.path,
      identityToken: async () => await server.session.identityToken(),
      caFile,
      signal
    }
  }

  private shadowTarget(
    library: LibraryRuntime,
    server: ServerRuntime,
    repositoryId: string
  ): ShadowTarget {
    if (!server.record.loreRemote)
      throw new CatalogServiceError('no-lore-remote', 'This server has no Lore address configured')
    const member = library.members.find((candidate) => candidate.repositoryId === repositoryId)
    return {
      serverId: server.record.id,
      repositoryId,
      branch: member?.branch ?? 'main',
      remote: `${trimSlash(server.record.loreRemote)}/${repositoryId}`
    }
  }

  private emitJob(key: string, job: CatalogJobProgress): void {
    this.options.emit({ kind: 'job', key, job })
  }

  cancelJob(jobId: string): void {
    this.jobs.get(jobId)?.abort()
  }

  /**
   * 依赖闭包。服务端有 `POST /closure` 且每项带仓库时直接用；没有就按详情里的一跳依赖
   * 做有上限的广度优先（深度 ≤5、≤2000 个），每一步都是一次有界请求。
   */
  private async closure(
    key: string,
    ids: number[],
    withDependencies: boolean,
    signal: AbortSignal
  ): Promise<Array<{ id: number; path: string; repository: string; dirId: number }>> {
    const out = new Map<number, { id: number; path: string; repository: string; dirId: number }>()
    let frontier = [...new Set(ids)]
    for (
      let depth = 0;
      frontier.length > 0 && depth <= (withDependencies ? DEPENDENCY_DEPTH : 0);
      depth += 1
    ) {
      const next: number[] = []
      for (const id of frontier) {
        signal.throwIfAborted()
        if (out.has(id)) continue
        const detail = await this.detail(key, id)
        out.set(id, { id, path: detail.path, repository: detail.repository, dirId: detail.dirId })
        if (out.size >= MAX_CLOSURE) return [...out.values()]
        if (withDependencies)
          for (const dependency of detail.dependencies)
            if (!out.has(dependency.id)) next.push(dependency.id)
      }
      frontier = next
    }
    return [...out.values()]
  }

  /** 同一文件夹里同名不同扩展名的分片（.uexp / .ubulk …），从目录服务的列表里找 */
  private async siblings(
    key: string,
    asset: { dirId: number; path: string },
    listing: Map<number, string[]>
  ): Promise<string[]> {
    const ext = extname(asset.path).toLowerCase()
    if (ext !== '.uasset' && ext !== '.umap') return []
    let names = listing.get(asset.dirId)
    if (!names) {
      names = []
      for (let start = 0; start < 2000; start += ASSET_PAGE_LIMIT) {
        const window = await this.listWindow(
          key,
          { dir: asset.dirId, recursive: false, sort: 'name', order: 'asc' },
          start,
          ASSET_PAGE_LIMIT
        )
        names.push(...window.items.map((item) => item.path))
        if (
          window.items.length < ASSET_PAGE_LIMIT ||
          start + window.items.length >= window.total.value
        )
          break
      }
      listing.set(asset.dirId, names)
    }
    const stem = asset.path.slice(0, -ext.length)
    return names.filter(
      (path) =>
        path !== asset.path &&
        path.startsWith(`${stem}.`) &&
        !path.slice(stem.length + 1).includes('/')
    )
  }

  /**
   * 下载 / 放进 UE 工程：闭包 → 影子副本扩视图物化 → **复制**进目标目录。
   * 库的根就是 UE 工程根（Content/… ↔ /Game/…），所以目标路径 = 目标根 + 库内路径。
   */
  async startDownload(
    key: string,
    input: { ids: number[]; targetRoot: string; withDependencies: boolean }
  ): Promise<string> {
    const { library, server } = await this.library(key)
    const jobId = randomUUID()
    const controller = new AbortController()
    this.jobs.set(jobId, controller)
    const progress = (patch: Partial<CatalogJobProgress>): void =>
      this.emitJob(key, {
        jobId,
        type: 'download',
        phase: 'preparing',
        done: 0,
        total: 0,
        ...patch
      })
    void (async () => {
      try {
        const root = input.targetRoot.toLowerCase().endsWith('.uproject')
          ? dirname(input.targetRoot)
          : input.targetRoot
        progress({ phase: 'preparing' })
        const context = await this.loreContext(server, controller.signal)
        const assets = await this.closure(key, input.ids, input.withDependencies, controller.signal)
        const listing = new Map<number, string[]>()
        const byRepository = new Map<string, Set<string>>()
        for (const asset of assets) {
          const set = byRepository.get(asset.repository) ?? new Set<string>()
          set.add(asset.path)
          for (const sibling of await this.siblings(key, asset, listing)) set.add(sibling)
          byRepository.set(asset.repository, set)
        }
        const total = [...byRepository.values()].reduce((sum, set) => sum + set.size, 0)
        let done = 0
        const outputs: string[] = []
        for (const [repositoryId, set] of byRepository) {
          const paths = [...set]
          progress({ phase: 'materialising', done, total, message: repositoryId })
          const target = this.shadowTarget(library, server, repositoryId)
          const locals = await this.shadows.materialise(target, paths, context)
          progress({ phase: 'copying', done, total })
          for (let index = 0; index < paths.length; index += 1) {
            controller.signal.throwIfAborted()
            const local = locals[index]
            if (!local) continue
            const destination = join(root, ...paths[index].split('/'))
            const ext = extname(paths[index]).toLowerCase()
            if (ext === '.uasset' || ext === '.umap') {
              await this.options.copyPackage(local, destination)
            } else if (!set.has(paths[index].slice(0, -ext.length) + '.uasset')) {
              await fs.mkdir(dirname(destination), { recursive: true })
              await fs.copyFile(local, destination)
            }
            outputs.push(destination)
            done += 1
            progress({ phase: 'copying', done, total })
          }
        }
        progress({ phase: 'done', done, total, outputPaths: outputs })
      } catch (error) {
        progress({ phase: 'failed', error: errorText(this.wrap(error)) })
      } finally {
        this.jobs.delete(jobId)
      }
    })()
    return jobId
  }

  /** 这个文件夹下的东西在哪个成员仓库里（联邦库里一个文件夹由某个仓库挂载） */
  async resolveRepository(
    key: string,
    folder: { dirId: number; path: string }
  ): Promise<{ repositoryId: string | null; candidates: string[] }> {
    const { library } = await this.library(key)
    if (library.members.length === 0) {
      const server = this.servers.get(library.record.serverId)
      if (server) await this.fetchRemoteLibraries(server).catch(() => undefined)
    }
    const candidates = library.members.map((member) => member.repositoryId)
    if (candidates.length === 1) return { repositoryId: candidates[0], candidates }
    const window = await this.listWindow(
      key,
      { dir: folder.dirId, recursive: true, sort: 'name' },
      0,
      20
    ).catch(() => null)
    const seen = new Set((window?.items ?? []).map((item) => item.repository))
    return { repositoryId: seen.size === 1 ? [...seen][0] : null, candidates }
  }

  /**
   * 导入：以美术本人身份提交推送到某个成员仓库的 `<文件夹>/<文件名>`。
   * .uasset/.umap 的同名分片（.uexp/.ubulk…）一起带上。
   */
  async startImport(
    key: string,
    input: { files: string[]; folderPath: string; repositoryId: string; message?: string | null }
  ): Promise<string> {
    const { library, server } = await this.library(key)
    const jobId = randomUUID()
    const controller = new AbortController()
    this.jobs.set(jobId, controller)
    const progress = (patch: Partial<CatalogJobProgress>): void =>
      this.emitJob(key, {
        jobId,
        type: 'import',
        phase: 'preparing',
        done: 0,
        total: input.files.length,
        ...patch
      })
    void (async () => {
      try {
        const files = await expandPackageSiblings(input.files)
        const folder = input.folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const mapped = files.map((source) => ({
          source,
          target: folder ? `${folder}/${basename(source)}` : basename(source)
        }))
        progress({ phase: 'preparing', total: mapped.length })
        const context = await this.loreContext(server, controller.signal)
        const advisory = await this.importPlan(library, server, mapped).catch(() => null)
        const target = this.shadowTarget(library, server, input.repositoryId)
        const message = input.message?.trim() || `Import ${mapped.length} file(s) from Unreal Box`
        const result = await this.shadows.importFiles(
          target,
          mapped,
          message,
          context,
          (phase, done, total) => progress({ phase, done, total, message: advisory })
        )
        this.invalidate(library, { dirIds: [], paths: [folder] }, 'local-write')
        progress({
          phase: 'done',
          done: mapped.length,
          total: mapped.length,
          message: result.signature,
          outputPaths: result.paths
        })
      } catch (error) {
        progress({ phase: 'failed', error: errorText(this.wrap(error)) })
      } finally {
        this.jobs.delete(jobId)
      }
    })()
    return jobId
  }

  /** `POST /import-plans`：只做提示（已有的、撞路径的、被锁的），真正的强制在推送时 */
  private async importPlan(
    library: LibraryRuntime,
    server: ServerRuntime,
    files: Array<{ source: string; target: string }>
  ): Promise<string | null> {
    try {
      const stats = await Promise.all(
        files.map(async (file) => ({ path: file.target, size: (await fs.stat(file.source)).size }))
      )
      const body = await server.catalog.json<{
        existing?: unknown[]
        collisions?: unknown[]
        locks?: unknown[]
      }>(`/v1/libraries/${encodeURIComponent(library.record.libraryId)}/import-plans`, {
        method: 'POST',
        body: { files: stats }
      })
      const parts: string[] = []
      if (body.collisions?.length) parts.push(`collisions: ${body.collisions.length}`)
      if (body.locks?.length) parts.push(`locked: ${body.locks.length}`)
      if (body.existing?.length) parts.push(`already in library: ${body.existing.length}`)
      return parts.join(', ') || null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- active library (UI preference)

  async getActive(): Promise<string | null> {
    const config = await this.config.read()
    const key = config.activeKey ?? null
    return key && config.libraries.some((library) => library.key === key) ? key : null
  }

  async setActive(key: string | null): Promise<void> {
    await this.config.update((next) => {
      next.activeKey = key && next.libraries.some((library) => library.key === key) ? key : null
    })
  }

  // ---------------------------------------------------------------- housekeeping

  async clearCache(key?: string | null): Promise<void> {
    if (key) {
      this.pages.dropLibrary(key)
      const library = this.libraries.get(key)
      library?.cursors.clear()
    } else {
      for (const library of this.libraries.values()) {
        this.pages.dropLibrary(library.record.key)
        library.cursors.clear()
      }
    }
  }

  dispose(): void {
    for (const controller of this.jobs.values()) controller.abort()
    for (const server of this.servers.values()) {
      server.events?.stop()
      server.catalog.destroy()
    }
  }
}

/** 选中的 .uasset/.umap 旁边的同名分片也要一起提交 */
export async function expandPackageSiblings(files: string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const file of files) {
    out.add(file)
    const ext = extname(file).toLowerCase()
    if (ext !== '.uasset' && ext !== '.umap') continue
    const stem = basename(file, extname(file))
    try {
      for (const name of await fs.readdir(dirname(file))) {
        if (
          name !== basename(file) &&
          name.startsWith(`${stem}.`) &&
          basename(name, extname(name)) === stem
        ) {
          out.add(join(dirname(file), name))
        }
      }
    } catch {
      // 读不了目录就只带选中的
    }
  }
  return [...out]
}

/** 令牌里的 subject（给界面显示"以谁的身份"） */
export function tokenSubject(token: string): string | null {
  return decodeJwtClaims(token).sub
}
