/**
 * 团队工程的主进程门面（界面方案第 4 节「虚幻盒子」，契约 3.2）。
 *
 * 团队工程在盒子里就是一个服务器资产库（目录服务里的那个库）加上一条「团队」链接：
 * 浏览、搜索、缩略图照旧走 CatalogService；这里只管团队服务成员面上的事 ——
 * 加入、动态、签出、等你处理、谁能提交、检查、对比、找坏提交、外包 —— 和几件要在本机
 * 动文件的事：同步到本机、放入、回到这一版 / 恢复、交付、发参考、收交付。
 *
 * 规则一律在服务端判断（契约第 0 节）：这里不替服务端决定谁能做什么，只转发、只搬文件。
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CatalogConnectInput,
  CatalogConnectResult,
  CatalogJobProgress,
  CatalogLibraryRecord,
  CatalogRemoteLibrary
} from '../../../shared/catalogLibrary'
import type {
  CatalogTeamLink,
  TeamEvent,
  TeamFact,
  TeamMe,
  TeamNotification,
  TeamProject
} from '../../../shared/teamProject'
import type { CatalogHttp } from '../http'
import { runLoreChecked, runLore } from '../loreCli'
import type { ShadowContext, ShadowCopies, ShadowTarget } from '../shadowCopy'
import { TeamApiError, teamRequest } from './teamClient'
import { TeamStream } from './teamEvents'
import { needsRenewal, readTeamCredential, writeTeamCredential } from './teamCredentials'
import { buildTeamRoute, isTeamOp, type TeamRoute } from './teamOps'

/** CatalogService 交给团队门面的那几样东西（不把整个服务端运行时暴露出来） */
export interface TeamHost {
  libraries(): Promise<CatalogLibraryRecord[]>
  record(key: string): Promise<CatalogLibraryRecord>
  memberHttp(serverId: string): Promise<CatalogHttp>
  catalogJson<T>(
    serverId: string,
    path: string,
    options?: { method?: string; body?: unknown }
  ): Promise<T>
  previewUrl(key: string, signed: string | null | undefined): string | null
  loreRemote(serverId: string): Promise<string | null>
  loreContext(serverId: string, signal: AbortSignal): Promise<ShadowContext>
  shadows: ShadowCopies
  emitJob(key: string, job: CatalogJobProgress): void
  emitTeam(event: TeamEvent): void
  connect(input: CatalogConnectInput): Promise<CatalogConnectResult>
  addLibraries(
    serverId: string,
    libraries: Array<{ id: string; name: string; team?: CatalogTeamLink | null }>
  ): Promise<void>
  updateTeamLink(key: string, patch: Partial<CatalogTeamLink>): Promise<void>
  invalidate(key: string): void
  rootFolders(key: string): Promise<string[]>
  signedIn(serverId: string): Promise<boolean>
  /** 登录前用的：按邀请链接的指纹信任这台主机，不带令牌 */
  anonymousHttp(server: string, caFingerprint: string | null): Promise<CatalogHttp>
  /** 成员面地址（交给 UE 插件的登录文件里写它） */
  memberUrl(serverId: string): Promise<string | null>
}

export interface TeamJoinInput {
  server: string
  caFingerprint?: string | null
  project?: string | null
  member: string
  password: string
}

export interface TeamJoinResult {
  member: string
  displayName: string
  /** 进了切换器的库（工程 + 团队上的资产库） */
  keys: string[]
  /** 链接指的那个工程的库键；没有就是第一个工程的 */
  openKey: string | null
  /** 你还没被加进任何工程 */
  noProjects: boolean
}

/** 同步到本机默认不带的：Content 以外放源文件的文件夹（界面方案 4.3） */
const UE_TOP_FOLDERS = new Set([
  'config',
  'content',
  'source',
  'plugins',
  'build',
  'binaries',
  'platforms'
])

export function defaultUnsynced(topFolders: string[]): string[] {
  return topFolders.filter((name) => !UE_TOP_FOLDERS.has(name.toLowerCase()))
}

/** 放入时不传的：UE 自己生成的（界面方案 4.3） */
const PUT_IN_SKIP = new Set(['saved', 'intermediate', 'deriveddatacache', '.lore', '.vs', '.git'])

export function shouldSkipOnPutIn(relativePath: string): boolean {
  const first = relativePath.replace(/\\/g, '/').split('/')[0].toLowerCase()
  return PUT_IN_SKIP.has(first)
}

/** 工作副本的视图文件：排除没同步的顶层文件夹 */
export function renderWorkingView(unsynced: string[]): string {
  return unsynced.length === 0 ? '' : `${unsynced.map((folder) => `${folder}/**`).join('\n')}\n`
}

/**
 * 从外包的 UE 工程里拖进来的文件 → 工程内路径（「路径保持和参考里一致」）：
 * 从路径里最后一个 Content / Config / Source 段开始算；没有就只用文件名。
 */
export function projectRelativeOf(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/')
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (['content', 'config', 'source'].includes(parts[index].toLowerCase()))
      return parts.slice(index).join('/')
  }
  return parts[parts.length - 1]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TeamService {
  private readonly streams = new Map<string, TeamStream>()
  private readonly projectCache = new Map<string, { at: number; project: TeamProject }>()
  private readonly jobs = new Map<string, AbortController>()
  private renewTimer: NodeJS.Timeout | null = null

  constructor(private readonly host: TeamHost) {}

  // ---------------------------------------------------------------- 加入团队

  /**
   * 加入团队（界面方案 4.1 B、契约 2.2）：登录 → 读 me → 账号所在的工程和团队上的资产库
   * 全部进切换器。没有「选择工程」这一步。
   */
  async join(input: TeamJoinInput): Promise<TeamJoinResult> {
    const connected = await this.host.connect({
      address: input.server,
      caFingerprint: input.caFingerprint ?? null,
      authMode: 'password',
      member: input.member,
      password: input.password
    } as CatalogConnectInput)
    const serverId = connected.server.id
    const http = await this.host.memberHttp(serverId)
    const me = await teamRequest<TeamMe>(http, { method: 'GET', path: '/v1/auth/me' })
    const projects = Array.isArray(me.projects) ? me.projects : []
    const toAdd: Array<{ id: string; name: string; team: CatalogTeamLink | null }> = []
    const projectLibraries = new Set<string>()
    const areaLibraries = new Set<string>()
    let openLibrary: string | null = null
    for (const summary of projects) {
      const project = await teamRequest<TeamProject>(
        http,
        buildTeamRoute('project', summary.id, {})
      )
      for (const company of project.companies ?? [])
        if (company.area?.library) areaLibraries.add(company.area.library)
      const library = project.library ?? project.area?.library ?? null
      if (!library) continue
      projectLibraries.add(library)
      toAdd.push({
        id: library,
        name: project.name,
        team: {
          projectId: project.id,
          projectName: project.name,
          role: project.role,
          company: project.company ?? null
        }
      })
      if (!openLibrary || project.id === input.project) openLibrary = library
    }
    // 团队上的资产库（原来的服务器资产库）也一起进切换器；外包区只在「外包」分组里出现
    if (me.kind !== 'outsourcer') {
      for (const remote of connected.libraries as CatalogRemoteLibrary[]) {
        if (projectLibraries.has(remote.id) || areaLibraries.has(remote.id)) continue
        toAdd.push({ id: remote.id, name: remote.name || remote.id, team: null })
      }
    }
    await this.host.addLibraries(serverId, toAdd)
    this.startStream(serverId)
    // 这台电脑上的 UE 从此不用再登录（契约 2.5）
    void this.renewCredential(serverId, true).catch(() => undefined)
    return {
      member: me.member,
      displayName: me.displayName,
      keys: toAdd.map((item) => `${serverId}:${item.id}`),
      openKey: openLibrary ? `${serverId}:${openLibrary}` : null,
      noProjects: projects.length === 0
    }
  }

  /** 登录前：链接指的工程叫什么（免凭据，契约 2.2）。连不上、链接不对都回 null */
  async peek(link: {
    server: string
    caFingerprint?: string | null
    project?: string | null
  }): Promise<{
    projectName: string | null
  }> {
    if (!link.project) return { projectName: null }
    const http = await this.host
      .anonymousHttp(link.server, link.caFingerprint ?? null)
      .catch(() => null)
    if (!http) return { projectName: null }
    try {
      const body = await teamRequest<{ project?: { name?: string } }>(http, {
        method: 'GET',
        path: `/v1/invites/project/${encodeURIComponent(link.project)}`
      })
      return { projectName: body.project?.name ?? null }
    } catch {
      return { projectName: null }
    } finally {
      http.destroy()
    }
  }

  // ---------------------------------------------------------------- 成员面调用

  private async link(
    key: string
  ): Promise<{ record: CatalogLibraryRecord; team: CatalogTeamLink }> {
    const record = await this.host.record(key)
    if (!record.team) throw new TeamApiError('not-a-team-project', 0, 'Not a team project')
    return { record, team: record.team }
  }

  async call<T = unknown>(key: string, op: string, args: unknown): Promise<T> {
    if (!isTeamOp(op)) throw new TeamApiError('bad-request', 400, `Unknown team op ${String(op)}`)
    const { record, team } = await this.link(key)
    const http = await this.host.memberHttp(record.serverId)
    const route = buildTeamRoute(op, team.projectId, args)
    const result = await teamRequest<T>(http, route)
    if (op === 'project')
      this.projectCache.set(key, { at: Date.now(), project: result as TeamProject })
    return result
  }

  private async request<T>(key: string, route: TeamRoute): Promise<T> {
    const { record } = await this.link(key)
    return await teamRequest<T>(await this.host.memberHttp(record.serverId), route)
  }

  private async project(key: string, maxAgeMs = 30_000): Promise<TeamProject> {
    const cached = this.projectCache.get(key)
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.project
    return await this.call<TeamProject>(key, 'project', {})
  }

  /**
   * 内容哈希 → 缩略图和类型（目录服务 facts，契约 4.8）。
   * `library` 省略时用这个工程的库；外包区的资产要传外包区的库 id。
   */
  async facts(
    key: string,
    hashes: string[],
    library?: string | null
  ): Promise<Record<string, TeamFact | null>> {
    const record = await this.host.record(key)
    const unique = [...new Set(hashes.filter((hash) => /^[0-9a-f]{16,128}$/.test(hash)))].slice(
      0,
      500
    )
    if (unique.length === 0) return {}
    const lib = library || record.libraryId
    let body: { items?: Record<string, Record<string, unknown> | null> }
    try {
      body = await this.host.catalogJson(
        record.serverId,
        `/v1/libraries/${encodeURIComponent(lib)}/facts`,
        { method: 'POST', body: { hashes: unique } }
      )
    } catch {
      return {}
    }
    const out: Record<string, TeamFact | null> = {}
    for (const hash of unique) {
      const item = body.items?.[hash]
      if (!item) {
        out[hash] = null
        continue
      }
      const preview = item.preview as { s128?: string; s256?: string } | null | undefined
      out[hash] = {
        class: typeof item.class === 'string' ? item.class : null,
        classCn: typeof item.classCn === 'string' ? item.classCn : null,
        classColor: typeof item.classColor === 'string' ? item.classColor : null,
        preview: this.host.previewUrl(key, preview?.s128 ?? null),
        previewLarge: this.host.previewUrl(key, preview?.s256 ?? preview?.s128 ?? null)
      }
    }
    return out
  }

  async inviteLink(key: string): Promise<string | null> {
    return (await this.project(key, 0)).inviteLink ?? null
  }

  // ---------------------------------------------------------------- 通知流

  startStream(serverId: string): void {
    const existing = this.streams.get(serverId)
    if (existing) {
      existing.restart()
      return
    }
    const stream = new TeamStream({
      onNotification: (notification: TeamNotification) =>
        this.host.emitTeam({ kind: 'notification', serverId, notification }),
      onProject: (project, what) => {
        for (const key of [...this.projectCache.keys()])
          if (key.startsWith(`${serverId}:`)) this.projectCache.delete(key)
        this.host.emitTeam({ kind: 'project', serverId, project, what })
      },
      onState: (connected) => this.host.emitTeam({ kind: 'stream', serverId, connected })
    })
    this.streams.set(serverId, stream)
    void this.host
      .memberHttp(serverId)
      .then((http) => {
        stream.attach(http)
        stream.start()
      })
      .catch(() => undefined)
  }

  /** 有团队工程就连上（托盘常驻，契约 2.4）；不打开资产库也会连 —— 这是用户自己加的团队 */
  async startAll(): Promise<void> {
    const servers = new Set(
      (await this.host.libraries()).filter((record) => record.team).map((record) => record.serverId)
    )
    for (const serverId of servers) {
      if (!(await this.host.signedIn(serverId).catch(() => false))) continue
      this.startStream(serverId)
      void this.renewCredential(serverId).catch(() => undefined)
    }
    // 交给 UE 的长令牌：每 6 小时看一眼，剩不到五分之一寿命就重领
    if (!this.renewTimer && servers.size > 0) {
      this.renewTimer = setInterval(
        () => {
          for (const serverId of servers) void this.renewCredential(serverId).catch(() => undefined)
        },
        6 * 60 * 60 * 1000
      )
      this.renewTimer.unref?.()
    }
  }

  /**
   * 把这台电脑的登录交给 UE 插件：领一个长令牌（`POST /v1/auth/cli-token`，最长 30 天），
   * DPAPI 保护后写进 `%LOCALAPPDATA%\UnrealBox\team\<主机_端口>.json`（见 teamCredentials.ts）。
   * `force` 为假时，文件里的令牌还有五分之一以上寿命就不动。
   */
  async renewCredential(serverId: string, force = false): Promise<string | null> {
    const memberUrl = await this.host.memberUrl(serverId)
    if (!memberUrl) return null
    if (!force && !needsRenewal(await readTeamCredential(memberUrl), Date.now())) return null
    const http = await this.host.memberHttp(serverId)
    const grant = await teamRequest<{ member?: string; identityToken?: string; expires?: number }>(
      http,
      { method: 'POST', path: '/v1/auth/cli-token', body: {} }
    )
    if (!grant.identityToken) return null
    return await writeTeamCredential({
      memberUrl,
      account: grant.member ?? null,
      identityToken: grant.identityToken,
      expires: typeof grant.expires === 'number' ? grant.expires : null
    })
  }

  streamState(serverId: string): { connected: boolean; signedOut: boolean } {
    const stream = this.streams.get(serverId)
    return { connected: stream?.connected ?? false, signedOut: stream?.signedOut ?? false }
  }

  stopStream(serverId: string): void {
    this.streams.get(serverId)?.stop()
    this.streams.delete(serverId)
  }

  dispose(): void {
    if (this.renewTimer) clearInterval(this.renewTimer)
    this.renewTimer = null
    for (const stream of this.streams.values()) stream.stop()
    this.streams.clear()
    for (const controller of this.jobs.values()) controller.abort()
  }

  // ---------------------------------------------------------------- 本机：工程在不在、盘够不够

  async localInfo(key: string): Promise<{
    localPath: string | null
    exists: boolean
    uproject: string | null
    unsynced: string[]
  }> {
    const { team } = await this.link(key)
    const localPath = team.localPath ?? null
    if (!localPath) return { localPath: null, exists: false, uproject: null, unsynced: [] }
    let exists = false
    let uproject: string | null = null
    try {
      const entries = await fs.readdir(localPath)
      exists = entries.includes('.lore')
      const found = entries.find((name) => name.toLowerCase().endsWith('.uproject'))
      uproject = found ? join(localPath, found) : null
    } catch {
      exists = false
    }
    return { localPath, exists, uproject, unsynced: team.unsynced ?? [] }
  }

  /** 选的位置所在的盘还剩多少（字节）；读不出来 null */
  async freeSpace(path: string): Promise<number | null> {
    let probe = localDir(path)
    for (let depth = 0; depth < 32; depth += 1) {
      try {
        const stats = await fs.statfs(probe)
        return Number(stats.bavail) * Number(stats.bsize)
      } catch {
        const parent = dirname(probe)
        if (parent === probe) return null
        probe = parent
      }
    }
    return null
  }

  /** 选的文件夹里是不是已经有这个工程（「电脑上已经有这个工程？[选它]」） */
  async inspectFolder(
    path: string
  ): Promise<{ hasLore: boolean; uproject: string | null; empty: boolean }> {
    try {
      const entries = await fs.readdir(path)
      const found = entries.find((name) => name.toLowerCase().endsWith('.uproject'))
      return {
        hasLore: entries.includes('.lore'),
        uproject: found ? join(path, found) : null,
        empty: entries.length === 0
      }
    } catch {
      return { hasLore: false, uproject: null, empty: true }
    }
  }

  // ---------------------------------------------------------------- 本机动作（作业，进度走导入挂件）

  private startJob(
    key: string,
    type: CatalogJobProgress['type'],
    label: string,
    work: (
      progress: (patch: Partial<CatalogJobProgress>) => void,
      signal: AbortSignal
    ) => Promise<Partial<CatalogJobProgress> | void>
  ): string {
    const jobId = randomUUID()
    const controller = new AbortController()
    this.jobs.set(jobId, controller)
    const progress = (patch: Partial<CatalogJobProgress>): void =>
      this.host.emitJob(key, {
        jobId,
        type,
        phase: 'preparing',
        done: 0,
        total: 0,
        label,
        ...patch
      })
    void (async () => {
      try {
        progress({ phase: 'preparing' })
        const final = await work(progress, controller.signal)
        progress({ phase: 'done', done: 1, total: 1, ...(final ?? {}) })
      } catch (error) {
        progress({ phase: 'failed', error: errorText(error) })
      } finally {
        this.jobs.delete(jobId)
      }
    })()
    return jobId
  }

  private async lore(
    serverId: string,
    cwd: string,
    args: string[],
    signal: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    const context = await this.host.loreContext(serverId, signal)
    return await runLoreChecked(context.binary, args, {
      cwd,
      identityToken: await context.identityToken(),
      caFile: context.caFile,
      signal
    })
  }

  private async loreTry(
    serverId: string,
    cwd: string,
    args: string[],
    signal: AbortSignal
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const context = await this.host.loreContext(serverId, signal)
    return await runLore(context.binary, args, {
      cwd,
      identityToken: await context.identityToken(),
      caFile: context.caFile,
      signal
    })
  }

  /** 同步 星海 到本机（界面方案 4.3）：整个工程克隆到选的位置，源文件夹默认不带 */
  async syncToLocal(
    key: string,
    input: { targetDir: string; existing?: boolean }
  ): Promise<string> {
    const { record, team } = await this.link(key)
    const project = await this.project(key, 0)
    const remote = project.loreRemote
    if (!remote) throw new TeamApiError('no-remote', 0, 'Project has no Lore remote')
    const target = localDir(input.targetDir)
    return this.startJob(key, 'sync', team.projectName, async (progress, signal) => {
      const unsynced = defaultUnsynced(await this.host.rootFolders(key).catch(() => []))
      const inspected = await this.inspectFolder(target)
      if (inspected.hasLore) {
        // 已经是这个工程的工作副本：只同步不一样的
        progress({ phase: 'syncing' })
        await this.lore(record.serverId, target, ['sync'], signal)
      } else if (input.existing && !inspected.empty) {
        // 「电脑上已经有这个工程？」：先在旁边克隆出版本信息，再挪进来，只下载不一样的
        progress({ phase: 'syncing' })
        const temp = `${target}.uebox-${randomUUID().slice(0, 8)}`
        await this.cloneInto(record.serverId, remote, temp, unsynced, signal, ['--bare'])
        await fs.rename(join(temp, '.lore'), join(target, '.lore'))
        await fs.rm(temp, { recursive: true, force: true })
        await this.lore(record.serverId, target, ['sync'], signal)
      } else {
        progress({ phase: 'syncing' })
        await fs.mkdir(dirname(target), { recursive: true })
        await this.cloneInto(record.serverId, remote, target, unsynced, signal)
      }
      await this.host.updateTeamLink(key, { localPath: target, unsynced })
      return { outputPaths: [target] }
    })
  }

  private async cloneInto(
    serverId: string,
    remote: string,
    dir: string,
    unsynced: string[],
    signal: AbortSignal,
    extra: string[] = []
  ): Promise<void> {
    const args = ['clone', remote, dir, '--branch', 'main', ...extra]
    let viewFile: string | null = null
    if (unsynced.length > 0) {
      viewFile = `${dir}.view-${randomUUID().slice(0, 8)}.txt`
      await fs.writeFile(viewFile, renderWorkingView(unsynced), 'utf8')
      args.push('--view', viewFile)
    }
    try {
      await this.lore(serverId, dirname(dir), args, signal)
    } finally {
      if (viewFile) await fs.rm(viewFile, { force: true })
    }
  }

  /**
   * 文件夹树右键「同步到本机」/「不同步到本机」。文件夹里有没提交的改动时不执行，
   * 回 `{ pending: n }`（界面说「这个文件夹里有 3 个改动还没提交，先在 UE 里提交。」）。
   */
  async setFolderSynced(
    key: string,
    folder: string,
    synced: boolean
  ): Promise<{ ok: boolean; pending: number }> {
    const { record, team } = await this.link(key)
    const localPath = team.localPath
    if (!localPath) throw new TeamApiError('not-local', 0, 'Project is not on this computer')
    const top = folder
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .split('/')[0]
    const controller = new AbortController()
    const current = new Set(team.unsynced ?? [])
    if (!synced) {
      const status = await this.loreTry(
        record.serverId,
        localPath,
        ['status', '--scan', top],
        controller.signal
      )
      const pending = status.stdout
        .split(/\r?\n/)
        .filter((line) => line.replace(/\\/g, '/').includes(`${top}/`)).length
      if (pending > 0) return { ok: false, pending }
      current.add(top)
    } else {
      current.delete(top)
    }
    const next = [...current].sort()
    await fs.writeFile(join(localPath, '.lore', 'view'), renderWorkingView(next), 'utf8')
    await this.lore(record.serverId, localPath, ['sync'], controller.signal)
    if (synced) await this.loreTry(record.serverId, localPath, ['reset', top], controller.signal)
    await this.host.updateTeamLink(key, { unsynced: next })
    return { ok: true, pending: 0 }
  }

  /**
   * 放入电脑上的工程（空工程，只有管理员，界面方案 4.3）：这个文件夹就是本机同步好的那一份。
   * UE 自己生成的 Saved、Intermediate、DerivedDataCache 不传。完成后拿到「#1」。
   */
  async putIn(key: string, input: { sourceDir: string }): Promise<string> {
    const { record, team } = await this.link(key)
    const project = await this.project(key, 0)
    const remote = project.loreRemote
    if (!remote) throw new TeamApiError('no-remote', 0, 'Project has no Lore remote')
    const source = resolve(input.sourceDir)
    return this.startJob(key, 'put-in', team.projectName, async (progress, signal) => {
      const temp = `${source}.uebox-${randomUUID().slice(0, 8)}`
      // 不带 --branch main：仓库还是空的，main 还没有修订，带上它 clone 会报
      // 「revision not found: main@latest」；不带时落在 main 上
      try {
        await this.lore(record.serverId, dirname(source), ['clone', remote, temp], signal)
        await fs.rename(join(temp, '.lore'), join(source, '.lore'))
      } finally {
        await fs.rm(temp, { recursive: true, force: true })
      }
      const files = await listFiles(source, (rel) => shouldSkipOnPutIn(rel))
      progress({ phase: 'staging', done: 0, total: files.length })
      const targets = join(source, '.lore', `put-in-${randomUUID().slice(0, 8)}.txt`)
      await fs.writeFile(targets, `${files.join('\n')}\n`, 'utf8')
      try {
        await this.lore(record.serverId, source, ['stage', '--targets', targets], signal)
      } finally {
        await fs.rm(targets, { force: true })
      }
      progress({ phase: 'committing', done: files.length, total: files.length })
      const committed = await this.lore(
        record.serverId,
        source,
        ['commit', `放入 ${team.projectName}`],
        signal
      )
      progress({ phase: 'pushing', done: files.length, total: files.length })
      await this.lore(record.serverId, source, ['push'], signal)
      const revision = /Signature\s*:\s*([0-9a-f]{64})/i.exec(committed.stdout)?.[1] ?? null
      let number: number | null = null
      if (revision) {
        const resolved = await this.request<{ submit?: { number?: number } }>(key, {
          method: 'POST',
          path: `/v1/projects/${encodeURIComponent(team.projectId)}/submits/resolve`,
          body: { revision }
        }).catch(() => null)
        number = resolved?.submit?.number ?? null
      }
      await this.host.updateTeamLink(key, { localPath: source, unsynced: [] })
      this.host.invalidate(key)
      return { message: number !== null ? String(number) : null, outputPaths: [source] }
    })
  }

  /**
   * 回到这一版 / 恢复（界面方案 4.6、4.10）：在你电脑上把这个文件换成那次提交里的样子，
   * 先签出；提交在 UE 里做，提交后别人才拿到。别人签出了由 Lore 拒绝。
   */
  async restore(key: string, input: { path: string; number: number }): Promise<{ ok: boolean }> {
    const { record, team } = await this.link(key)
    if (!team.localPath) throw new TeamApiError('not-local', 0, 'Project is not on this computer')
    const submit = await this.call<{ revision: string }>(key, 'submit', { number: input.number })
    const controller = new AbortController()
    const path = input.path.replace(/\\/g, '/')
    await this.loreTry(
      record.serverId,
      team.localPath,
      ['lock', 'acquire', path],
      controller.signal
    )
    await this.lore(
      record.serverId,
      team.localPath,
      ['reset', path, '--revision', submit.revision],
      controller.signal
    )
    return { ok: true }
  }

  /** 这个文件在你电脑上改过没有（取消签出时要不要问，方案 3.7） */
  async isModified(key: string, path: string): Promise<boolean> {
    const { record, team } = await this.link(key)
    if (!team.localPath) return false
    // 不加 --scan 时 lore 只报标过 dirty 的文件：在 UE 外改的、回到某一版换的都看不见
    const status = await this.loreTry(
      record.serverId,
      team.localPath,
      ['status', '--scan', path.replace(/\\/g, '/')],
      new AbortController().signal
    )
    const wanted = path.replace(/\\/g, '/')
    return status.stdout.split(/\r?\n/).some((line) => line.replace(/\\/g, '/').includes(wanted))
  }

  /**
   * 取消签出（方案 3.7、4.6「你签出」）：[留着改动] 只放掉签出；[不要改动] 先在你电脑上留一份
   * （`.lore/uebox-kept/<时刻>/<路径>`，历史里能找回），再丢掉改动。
   */
  async cancelCheckout(
    key: string,
    input: { path: string; discard: boolean }
  ): Promise<{ kept: string | null }> {
    const { record, team } = await this.link(key)
    if (!team.localPath) throw new TeamApiError('not-local', 0, 'Project is not on this computer')
    const path = input.path.replace(/\\/g, '/')
    const signal = new AbortController().signal
    let kept: string | null = null
    if (input.discard) {
      const source = join(team.localPath, ...path.split('/'))
      const target = join(
        team.localPath,
        '.lore',
        'uebox-kept',
        String(Date.now()),
        ...path.split('/')
      )
      try {
        await fs.mkdir(dirname(target), { recursive: true })
        await fs.copyFile(source, target)
        kept = target
      } catch {
        kept = null
      }
      await this.lore(record.serverId, team.localPath, ['reset', path], signal)
    }
    await this.lore(record.serverId, team.localPath, ['lock', 'release', path], signal)
    return { kept }
  }

  // ---------------------------------------------------------------- 外包

  /** 外包区的影子副本目标（契约 4.10：`<工程仓库名>.<公司 id>`） */
  private async areaTarget(serverId: string, repository: string): Promise<ShadowTarget> {
    const remote = await this.host.loreRemote(serverId)
    if (!remote) throw new TeamApiError('no-remote', 0, 'Server has no Lore remote')
    return {
      serverId,
      repositoryId: repository,
      branch: 'main',
      remote: `${remote.replace(/\/+$/, '')}/${repository}`
    }
  }

  /**
   * 外包交付（界面方案 4.12）：登记一批 → 文件放进外包区 `delivery/<n>/…` 推上去 → 告诉服务端传完了。
   * 进度「交付 7 · 上传中 42%」。
   */
  async deliver(
    key: string,
    input: { files: string[]; message: string; facts?: unknown[] }
  ): Promise<string> {
    const { record, team } = await this.link(key)
    const project = await this.project(key, 0)
    const area = project.area
    if (!area) throw new TeamApiError('no-area', 0, 'No delivery area yet')
    const created = await this.request<{ delivery: { id: string; n: number; folder: string } }>(
      key,
      {
        method: 'POST',
        path: `/v1/projects/${encodeURIComponent(team.projectId)}/deliveries`,
        body: { message: input.message }
      }
    )
    const delivery = created.delivery
    return this.startJob(key, 'deliver', String(delivery.n), async (progress, signal) => {
      const context = await this.host.loreContext(record.serverId, signal)
      const target = await this.areaTarget(record.serverId, area.repository)
      const mapped = input.files.map((source) => ({
        source,
        target: `${delivery.folder}/${projectRelativeOf(source)}`
      }))
      const result = await this.host.shadows.importFiles(
        target,
        mapped,
        input.message || `delivery ${delivery.n}`,
        context,
        (phase, done, total) => progress({ phase, done, total })
      )
      await this.request(key, {
        method: 'POST',
        path: `/v1/projects/${encodeURIComponent(team.projectId)}/deliveries/${encodeURIComponent(delivery.id)}/uploaded`,
        body: { revision: result.signature, facts: input.facts ?? [] }
      })
      this.host.invalidate(key)
      return { message: String(delivery.n) }
    })
  }

  /**
   * 管理员通过交付（界面方案 4.13）：选中的文件从外包区取出来，放进团队工程的相同路径，
   * 以管理员身份提交一次（说明「来自 某某外包 · 交付 7」），再告诉服务端通过了哪些。
   */
  async approveDelivery(
    key: string,
    input: { id: string; paths: string[]; message: string }
  ): Promise<string> {
    const { record, team } = await this.link(key)
    const project = await this.project(key, 0)
    const detail = await this.call<{
      delivery: { id: string; n: number; company: { id: string } }
      items: Array<{ path: string; deliveredPath: string }>
    }>(key, 'delivery', { id: input.id })
    const company = (project.companies ?? []).find((c) => c.id === detail.delivery.company.id)
    if (!company?.area) throw new TeamApiError('no-area', 0, 'No delivery area')
    const repository = project.repository
    if (!repository) throw new TeamApiError('no-remote', 0, 'Project has no repository')
    const wanted = new Set(input.paths)
    const items = detail.items.filter((item) => wanted.has(item.path))
    return this.startJob(key, 'approve', String(detail.delivery.n), async (progress, signal) => {
      const context = await this.host.loreContext(record.serverId, signal)
      const areaTarget = await this.areaTarget(record.serverId, company.area!.repository)
      progress({ phase: 'materialising', done: 0, total: items.length })
      const locals = await this.host.shadows.materialise(
        areaTarget,
        items.map((item) => item.deliveredPath),
        context
      )
      const mapped = items
        .map((item, index) => ({ source: locals[index], target: item.path }))
        .filter((entry): entry is { source: string; target: string } => Boolean(entry.source))
      const projectTarget = await this.areaTarget(record.serverId, repository)
      const result = await this.host.shadows.importFiles(
        projectTarget,
        mapped,
        input.message,
        context,
        (phase, done, total) => progress({ phase, done, total })
      )
      const approved = await this.request<{ delivery?: { submit?: number | null } }>(key, {
        method: 'POST',
        path: `/v1/projects/${encodeURIComponent(team.projectId)}/deliveries/${encodeURIComponent(input.id)}/approve`,
        body: { paths: mapped.map((entry) => entry.target), revision: result.signature }
      })
      this.host.invalidate(key)
      return {
        done: mapped.length,
        total: mapped.length,
        message: approved.delivery?.submit != null ? String(approved.delivery.submit) : null
      }
    })
  }

  /**
   * 发给外包（界面方案 4.13）：选中的资产从团队工程取出来，放进这家公司外包区的 `reference/…`，
   * 推上去后登记一句「改了什么」。
   */
  async sendReference(
    key: string,
    input: { company: string; paths: string[]; note: string }
  ): Promise<string> {
    const { record, team } = await this.link(key)
    const project = await this.project(key, 0)
    const company = (project.companies ?? []).find((c) => c.id === input.company)
    if (!company?.area) throw new TeamApiError('no-area', 0, 'No delivery area')
    const repository = project.repository
    if (!repository) throw new TeamApiError('no-remote', 0, 'Project has no repository')
    return this.startJob(key, 'reference', company.name, async (progress, signal) => {
      const context = await this.host.loreContext(record.serverId, signal)
      const projectTarget = await this.areaTarget(record.serverId, repository)
      progress({ phase: 'materialising', done: 0, total: input.paths.length })
      const locals = await this.host.shadows.materialise(projectTarget, input.paths, context)
      const mapped = input.paths
        .map((path, index) => ({ source: locals[index], target: `reference/${path}` }))
        .filter((entry): entry is { source: string; target: string } => Boolean(entry.source))
      const areaTarget = await this.areaTarget(record.serverId, company.area!.repository)
      const result = await this.host.shadows.importFiles(
        areaTarget,
        mapped,
        input.note || 'reference',
        context,
        (phase, done, total) => progress({ phase, done, total })
      )
      await this.request(key, {
        method: 'POST',
        path: `/v1/projects/${encodeURIComponent(team.projectId)}/references`,
        body: {
          company: input.company,
          paths: input.paths,
          note: input.note,
          revision: result.signature
        }
      })
      return { message: company.name }
    })
  }
}

/** 列出一个目录下的文件（工程内相对路径，正斜杠），跳过 skip 说不要的 */
export async function listFiles(
  root: string,
  skip: (relative: string) => boolean
): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (skip(rel)) continue
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(rel)
    }
  }
  await walk(root)
  return out
}

/** 本机文件夹：macOS / Linux 上默认位置写成 `~/UEProjects/星海`，这里展开成绝对路径 */
export function localDir(path: string): string {
  return resolve(/^~(?=$|[\\/])/.test(path) ? homedir() + path.slice(1) : path)
}
