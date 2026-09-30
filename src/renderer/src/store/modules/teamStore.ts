/**
 * 团队工程：资产库当前打开的那个团队工程的状态，和全局的团队通知。
 *
 * 团队工程在资产库里就是一个服务器库（数据源不变，树、网格、详情照旧），多出来的东西都在这里：
 * 工程本身（冻结、里程碑、外包公司）、谁签出了什么、哪些文件夹「只有这些人能提交」、
 * 等你处理的数字、工程在不在这台电脑上，以及中间区域此刻在看哪一页（动态 / 对比 / 签出中……）。
 *
 * 通知流的事件在这里分两路：该重新取的（`project`）只刷新当前工程；给人看的（`notification`）
 * 窗口在前台时弹一条轻提示，不在前台时走托盘（界面方案 1.5、4.14：同一件事只弹一处）。
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import type {
  CatalogTeamLink,
  TeamAsk,
  Person,
  TeamEvent,
  TeamJoinLink,
  TeamProject,
  TeamReference,
  TeamRestrictedFolder
} from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import i18n from '@renderer/i18n'
import { message } from '@renderer/utils/messageManager'
import { onTeamJob, useAssetLibraryStore } from './assetLibraryStore'
import { notificationText } from '@renderer/views/AssetManagement/team/teamFormat'

export type TeamView =
  | 'grid'
  | 'activity'
  | 'compare'
  | 'bisect'
  | 'checkouts'
  | 'inbox'
  | 'deleted'
  | 'delivery'
  | 'reference'

export interface TeamViewParams {
  /** 动态：展开这一条；只看在等的 */
  expand?: number | null
  pendingOnly?: boolean
  /** 对比：从 / 到（号或 latest） */
  from?: number | 'latest' | null
  to?: number | 'latest' | null
  /** 找坏提交 */
  bisectId?: string | null
  good?: number | null
  bad?: number | null
  /** 收交付 */
  deliveryId?: string | null
  /** 外包 › 某某外包 › 参考 */
  companyId?: string | null
}

export interface CheckoutInfo {
  holder: Person
  since: number
  pending: number | null
  rejected: { number: number; reason: string } | null
}

export interface LocalInfo {
  localPath: string | null
  exists: boolean
  uproject: string | null
  unsynced: string[]
}

export const useTeamStore = defineStore('teamProject', () => {
  const libraryStore = useAssetLibraryStore()

  const project = shallowRef<TeamProject | null>(null)
  const projectError = ref<string | null>(null)
  const restricted = ref<TeamRestrictedFolder[]>([])
  const checkouts = shallowRef<Map<string, CheckoutInfo>>(new Map())
  const inboxCount = ref(0)
  const local = ref<LocalInfo | null>(null)
  const references = ref<TeamReference[]>([])
  const view = ref<TeamView>('grid')
  const params = ref<TeamViewParams>({})
  /** 通知流连着的服务器 */
  const connected = ref<Record<string, boolean>>({})
  /** 连不上团队的起点（横幅「连不上团队（9:52 起）」） */
  const offlineSince = ref<number | null>(null)
  /** 在看旧版（面包屑「最新 ▾」选了里程碑或某次提交） */
  const viewingOld = ref<{ name: string | null; number: number } | null>(null)
  /** 同步到本机 / 放入刚完成：横幅变成「好了。」[在 UE 里打开] */
  const justSynced = ref(false)
  /** 等你处理：处理完离开这一页后左栏这一项消失 */
  const inboxDismissed = ref(false)
  /** 这一轮会话里「看过」的参考（红点） */
  const seenReferences = ref<Set<string>>(new Set())
  /** 刚加入、还没打开的邀请链接（冷启动、第二实例、托盘都可能带来） */
  const joinLink = ref<TeamJoinLink | null>(null)
  const joinOpen = ref(false)
  /** 每个视图变化 +1：各页据此重取 */
  const revision = ref(0)
  /** 动态页的搜索（用工具栏现有的搜索框，占位换成「提交号、说明、人名或文件名」） */
  const query = ref('')
  /** 别人问你改完没（ask.received）：按路径记着，详情「历史」段里就地回答（方案 2.16） */
  const receivedAsks = ref<Record<string, TeamAsk>>({})

  let unsubscribe: (() => void) | null = null

  const activeLibrary = computed(() => libraryStore.activeServer)
  const link = computed<CatalogTeamLink | null>(() => activeLibrary.value?.team ?? null)
  const key = computed(() => (link.value ? (activeLibrary.value?.key ?? null) : null))
  const serverId = computed(() => activeLibrary.value?.serverId ?? null)
  const isTeam = computed(() => link.value !== null)
  const me = computed(() => activeLibrary.value?.server.member ?? null)
  const role = computed(() => project.value?.role ?? link.value?.role ?? null)
  const isAdmin = computed(() => role.value === 'admin')
  const isOutsourcer = computed(() => role.value === 'outsourcer')
  const companies = computed(() => (isAdmin.value ? (project.value?.companies ?? []) : []))
  /** 有外包公司、而且外包区建好了的才进左栏「外包」分组 */
  const outsourceCompanies = computed(() => companies.value.filter((c) => c.area?.library))
  const frozen = computed(() => project.value?.freeze ?? null)
  const milestones = computed(() => project.value?.milestones ?? [])
  const isEmpty = computed(() => project.value?.empty === true)
  const showInbox = computed(
    () => isTeam.value && !isOutsourcer.value && (inboxCount.value > 0 || view.value === 'inbox')
  )
  const isLocal = computed(() => Boolean(local.value?.exists))

  /** 状态点：绿「已连接」、灰「连不上团队」、黄「需要重新登录」 */
  function stateOf(libraryKey: string): 'online' | 'offline' | 'signedOut' {
    const library = libraryStore.serverLibraries.find((candidate) => candidate.key === libraryKey)
    if (!library) return 'offline'
    if (!library.server.signedIn) return 'signedOut'
    const status = libraryStore.statuses[libraryKey]
    if (status?.signedOut) return 'signedOut'
    if (connected.value[library.serverId] === true) return 'online'
    if (status?.online === false) return 'offline'
    return connected.value[library.serverId] === false ? 'offline' : 'online'
  }

  // ---------------------------------------------------------------- 取数

  async function loadProject(): Promise<void> {
    const current = key.value
    if (!current) return
    try {
      const next = await teamAPI.project(current)
      if (key.value !== current) return
      project.value = next
      projectError.value = null
      inboxCount.value = next.counts?.inbox ?? 0
      if (inboxCount.value > 0) inboxDismissed.value = false
      offlineSince.value = null
    } catch (error) {
      if (key.value !== current) return
      const code = (error as { code?: string }).code ?? 'unknown'
      projectError.value = code
      if (code === 'unreachable' || code === 'lore-unavailable')
        offlineSince.value = offlineSince.value ?? Date.now()
    }
  }

  async function loadRestricted(): Promise<void> {
    const current = key.value
    if (!current || isOutsourcer.value) return
    const result = await teamAPI.restricted(current).catch(() => null)
    if (result && key.value === current) restricted.value = result.items
  }

  async function loadCheckouts(): Promise<void> {
    const current = key.value
    if (!current || isOutsourcer.value) return
    const result = await teamAPI.checkouts(current).catch(() => null)
    if (!result || key.value !== current) return
    const next = new Map<string, CheckoutInfo>()
    for (const group of result.groups)
      for (const item of group.items)
        next.set(item.path, {
          holder: group.holder,
          since: item.since,
          pending: item.pending,
          rejected: item.rejected
        })
    checkouts.value = next
  }

  async function loadLocal(): Promise<void> {
    const current = key.value
    if (!current) return
    const info = await teamAPI.localInfo(current).catch(() => null)
    if (key.value === current) local.value = info
  }

  async function loadReferences(): Promise<void> {
    const current = key.value
    if (!current || !isOutsourcer.value) return
    const result = await teamAPI.references(current).catch(() => null)
    if (result && key.value === current) references.value = result.items
  }

  async function refresh(what?: string[]): Promise<void> {
    const all = !what || what.length === 0
    const jobs: Array<Promise<void>> = []
    if (all || what.some((w) => ['freeze', 'milestones', 'inbox', 'submits'].includes(w)))
      jobs.push(loadProject())
    if (all || what.includes('rules')) jobs.push(loadRestricted())
    if (all || what.includes('checkouts')) jobs.push(loadCheckouts())
    if (all) jobs.push(loadLocal(), loadReferences())
    await Promise.all(jobs)
    revision.value += 1
  }

  /** 打开了另一个库：团队的就重取一遍，不是的清空 */
  async function onLibraryChanged(): Promise<void> {
    project.value = null
    projectError.value = null
    restricted.value = []
    checkouts.value = new Map()
    inboxCount.value = 0
    local.value = null
    references.value = []
    viewingOld.value = null
    justSynced.value = false
    inboxDismissed.value = false
    view.value = 'grid'
    params.value = {}
    if (!key.value) return
    await loadProject()
    await Promise.all([loadRestricted(), loadCheckouts(), loadLocal(), loadReferences()])
    revision.value += 1
  }

  // ---------------------------------------------------------------- 中间区域在看哪一页

  function openView(next: TeamView, nextParams: TeamViewParams = {}): void {
    if (view.value === 'inbox' && next !== 'inbox' && inboxCount.value === 0)
      inboxDismissed.value = true
    if (next !== view.value) query.value = ''
    view.value = next
    params.value = nextParams
    revision.value += 1
  }

  function backToGrid(): void {
    openView('grid')
  }

  /**
   * 可以分享的链接（契约 4.14）→ 盒子里的那一页：
   * `/p/{p}` 动态、`/p/{p}/submits/{n}` 动态里展开这一条、`/p/{p}/compare?from=&to=` 对比、
   * `/p/{p}/bisect/{id}` 找坏提交、`/p/{p}/inbox` 等你处理、`/p/{p}/folders` 网格和文件夹树
   * （UE 的「选同步哪些文件夹…」和磁盘不够的通知跳到这里，方案 3.2、4.3）
   */
  function openPath(path: string): void {
    const [pathname, search = ''] = path.split('?')
    const rest = pathname.replace(/^\/p\/[^/]+/, '')
    const query = new URLSearchParams(search)
    const numberOrLatest = (value: string | null): number | 'latest' | null =>
      value === 'latest' ? 'latest' : value && /^\d+$/.test(value) ? Number(value) : null
    const submit = /^\/submits\/(\d+)/.exec(rest)
    const bisect = /^\/bisect\/([^/]+)/.exec(rest)
    if (submit) openView('activity', { expand: Number(submit[1]) })
    else if (rest.startsWith('/compare'))
      openView('compare', {
        from: numberOrLatest(query.get('from')),
        to: numberOrLatest(query.get('to')) ?? 'latest'
      })
    else if (bisect) openView('bisect', { bisectId: bisect[1] })
    else if (rest.startsWith('/inbox')) openView('inbox')
    else if (rest.startsWith('/folders')) openView('grid')
    else openView('activity')
  }

  // ---------------------------------------------------------------- 查询

  function checkoutOf(path: string | null | undefined): CheckoutInfo | null {
    if (!path) return null
    return checkouts.value.get(path) ?? null
  }

  /** 这个文件夹（或它的上级）设了「只有这些人能提交」 */
  function restrictionOf(path: string): TeamRestrictedFolder | null {
    let best: TeamRestrictedFolder | null = null
    for (const folder of restricted.value) {
      if (path === folder.path || path.startsWith(`${folder.path}/`)) {
        if (!best || folder.path.length > best.path.length) best = folder
      }
    }
    return best
  }

  /**
   * 文件夹树上的「人 + 勾」（方案 4.4）：普通成员看自己不能直接提交的；
   * 管理员看所有设过「谁能提交」的。只标在设规则的那一层，不往下传。
   */
  function restrictionIconOf(path: string): TeamRestrictedFolder | null {
    const folder = restricted.value.find((candidate) => candidate.path === path) ?? null
    if (!folder) return null
    if (isAdmin.value) return folder
    return folder.youCanSubmit ? null : folder
  }

  function isUnsynced(path: string): boolean {
    if (!isLocal.value) return false
    const top = path.split('/')[0]
    return (local.value?.unsynced ?? []).includes(top)
  }

  /** 参考里管理员新发来或更新过的（红点） */
  function isNewReference(path: string): boolean {
    const plain = path.replace(/^reference\//, '')
    return references.value.some(
      (reference) => !seenReferences.value.has(reference.id) && reference.paths.includes(plain)
    )
  }

  function markReferencesSeen(): void {
    seenReferences.value = new Set([...seenReferences.value, ...references.value.map((r) => r.id)])
  }

  /** 可以分享的链接（契约 4.14）：团队网页和盒子认同一套路径 */
  function webLink(path: string): string {
    const base = (activeLibrary.value?.server.memberUrl ?? '').replace(/\/+$/, '')
    const projectId = link.value?.projectId ?? ''
    return `${base}/p/${encodeURIComponent(projectId)}${path}`
  }

  // ---------------------------------------------------------------- 事件

  function trayOrToast(title: string, body: string, notificationKey: string, open: unknown): void {
    if (typeof document !== 'undefined' && document.hasFocus()) {
      message.info({ content: body, key: notificationKey, duration: 8 })
      return
    }
    void teamAPI.notify({
      key: notificationKey,
      title,
      body,
      open: open as { serverId: string; project: string; path?: string } | null
    })
  }

  function onEvent(event: TeamEvent): void {
    if (event.kind === 'stream') {
      connected.value = { ...connected.value, [event.serverId]: event.connected }
      if (event.serverId === serverId.value) {
        if (!event.connected) offlineSince.value = offlineSince.value ?? Date.now()
        else {
          offlineSince.value = null
          void refresh()
        }
      }
      return
    }
    if (event.kind === 'join-link') {
      joinLink.value = event.link
      joinOpen.value = true
      return
    }
    if (event.kind === 'open') {
      const target = libraryStore.serverLibraries.find(
        (library) =>
          library.serverId === event.serverId && library.team?.projectId === event.project
      )
      const go = (): void => openPath(event.path)
      if (target && target.key !== libraryStore.activeServerKey)
        void libraryStore.activateServer(target.key).then(() => setTimeout(go, 300))
      else go()
      return
    }
    if (event.kind === 'project') {
      if (event.serverId === serverId.value && event.project === link.value?.projectId)
        void refresh(event.what)
      return
    }
    if (event.kind === 'notification') {
      const notification = event.notification
      const ask = notification.data?.ask as TeamAsk | undefined
      if (notification.kind === 'ask.received' && ask?.paths) {
        const next = { ...receivedAsks.value }
        for (const path of ask.paths) next[path] = ask
        receivedAsks.value = next
      }
      const text = notificationText(notification, i18n.global.t as never)
      if (event.serverId === serverId.value && notification.project === link.value?.projectId)
        void refresh(['inbox', 'checkouts', 'freeze'])
      if (!text) return
      const library = libraryStore.serverLibraries.find(
        (candidate) =>
          candidate.serverId === event.serverId &&
          candidate.team?.projectId === notification.project
      )
      const title = library?.team?.projectName ?? library?.name ?? ''
      const path =
        text.action === 'open-inbox'
          ? `/p/${notification.project}/inbox`
          : text.action === 'open-submit'
            ? `/p/${notification.project}/submits/${String(
                (notification.data.bisect as { result?: { number?: number } } | undefined)?.result
                  ?.number ?? ''
              )}`
            : `/p/${notification.project}`
      trayOrToast(title, text.body, notification.key || notification.id, {
        serverId: event.serverId,
        project: notification.project,
        path
      })
    }
  }

  /** App 启动时调一次：通知流的事件从这里进；冷启动带进来的邀请链接也在这里接住 */
  function init(): void {
    if (unsubscribe) return
    unsubscribe = teamAPI.onEvent(onEvent)
    // 托盘通知要知道是哪个工程（标题写工程名）：本机的列表，不发请求
    if (!libraryStore.loaded) void libraryStore.loadServerLibraries()
    // 同步到本机 / 放入做完：横幅变成「好了。」[在 UE 里打开]；窗口不在前台时托盘也说一声（4.14）
    onTeamJob((job) => {
      if (job.phase !== 'done') return
      if (job.type === 'sync' || job.type === 'put-in') {
        justSynced.value = true
        void libraryStore.loadServerLibraries().then(() => refresh())
        if (typeof document !== 'undefined' && !document.hasFocus())
          void teamAPI.notify({
            key: `sync:${job.jobId}`,
            title: job.label ?? '',
            body: i18n.global.t('teamProject.notify.syncDone')
          })
        return
      }
      revision.value += 1
    })
    void teamAPI
      .pendingJoinLink()
      .then((pending) => {
        if (pending) {
          joinLink.value = pending
          joinOpen.value = true
        }
      })
      .catch(() => undefined)
  }

  watch(key, () => void onLibraryChanged())

  return {
    project,
    projectError,
    restricted,
    checkouts,
    inboxCount,
    local,
    references,
    view,
    params,
    connected,
    offlineSince,
    viewingOld,
    justSynced,
    inboxDismissed,
    joinLink,
    joinOpen,
    revision,
    query,
    receivedAsks,
    link,
    key,
    serverId,
    isTeam,
    me,
    role,
    isAdmin,
    isOutsourcer,
    companies,
    outsourceCompanies,
    frozen,
    milestones,
    isEmpty,
    showInbox,
    isLocal,
    stateOf,
    loadProject,
    loadCheckouts,
    loadLocal,
    loadRestricted,
    refresh,
    openView,
    backToGrid,
    openPath,
    checkoutOf,
    restrictionOf,
    restrictionIconOf,
    isUnsynced,
    isNewReference,
    markReferencesSeen,
    webLink,
    onEvent,
    init
  }
})
