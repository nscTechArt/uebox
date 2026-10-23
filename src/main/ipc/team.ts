/**
 * 团队工程的 IPC（通道全部是 team:*）。
 *
 * 每个处理器回 `{ success, data?, error?, errorCode? }`，errorCode 是契约 1.2 的码
 * （signed-out、not-allowed、frozen、asked-recently …）或本机的（lore-missing、not-local …），
 * 渲染层按码选界面方案里的文案。令牌从不出主进程。
 */
import { BrowserWindow, Notification, ipcMain, shell } from 'electron'
import { getCatalogService, getTeamService, TEAM_EVENT_CHANNEL } from '../libraryV3'
import { CatalogServiceError } from '../libraryV3/catalogService'
import { TeamApiError } from '../libraryV3/team/teamClient'
import { TeamOpError } from '../libraryV3/team/teamOps'
import { findMainWindow, sendToAppWindows } from '../appWindows'
import {
  parseTeamJoinLink,
  parseTeamOpenLink,
  type TeamEvent,
  type TeamJoinLink
} from '../../shared/teamProject'

type Result<T> = { success: true; data: T } | { success: false; error: string; errorCode: string }

async function run<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { success: true, data: await work() }
  } catch (error) {
    const code =
      error instanceof TeamApiError ||
      error instanceof CatalogServiceError ||
      error instanceof TeamOpError
        ? error.code
        : 'unknown'
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: code
    }
  }
}

const text = (value: unknown, max = 4000): string =>
  typeof value === 'string' ? value.slice(0, max) : ''
const list = (value: unknown, max = 5000): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, max)
    : []

/** 盒子还没准备好时收到的邀请链接（冷启动带着 unrealbox://join 进来） */
let pendingJoinLink: TeamJoinLink | null = null

function bringMainWindowForward(): void {
  const window = findMainWindow()
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}

/**
 * 主进程拿到 `unrealbox://…`：
 * - `join`：交给渲染层打开「加入团队」（冷启动时先记着，渲染层起来再取）；
 * - `open`：UE 里点提交号、[在虚幻盒子里看]、「选同步哪些文件夹…」—— 打开那个工程的那一页。
 */
export function handleTeamDeepLink(raw: string): boolean {
  const link = parseTeamJoinLink(raw)
  if (link) {
    pendingJoinLink = link
    const event: TeamEvent = { kind: 'join-link', link }
    sendToAppWindows(TEAM_EVENT_CHANNEL, event)
    bringMainWindowForward()
    return true
  }
  const open = parseTeamOpenLink(raw)
  if (!open) return false
  void getCatalogService()
    .listServers()
    .then((servers) => {
      const server = servers.find(
        (candidate) => candidate.memberUrl?.replace(/\/+$/, '') === open.server
      )
      if (!server) return
      const event: TeamEvent = {
        kind: 'open',
        serverId: server.id,
        project: open.project,
        path: open.path
      }
      sendToAppWindows(TEAM_EVENT_CHANNEL, event)
      bringMainWindowForward()
    })
    .catch(() => undefined)
  return true
}

/** 命令行参数里找 `unrealbox://`（Windows 第二实例、冷启动都这样传进来） */
export function teamDeepLinkFromArgv(argv: string[]): string | null {
  return argv.find((arg) => /^unrealbox:\/\//i.test(arg)) ?? null
}

export function registerTeamIPC(): void {
  const team = (): ReturnType<typeof getTeamService> => getTeamService()

  ipcMain.handle('team:join', (_event, input: Record<string, unknown>) =>
    run(async () => {
      const result = await team().join({
        server: text(input?.server, 500),
        caFingerprint: text(input?.caFingerprint, 200) || null,
        project: text(input?.project, 200) || null,
        member: text(input?.member, 200).trim(),
        password: text(input?.password, 500)
      })
      pendingJoinLink = null
      return result
    })
  )
  ipcMain.handle('team:peek', (_event, link: Record<string, unknown>) =>
    run(() =>
      team().peek({
        server: text(link?.server, 500),
        caFingerprint: text(link?.caFingerprint, 200) || null,
        project: text(link?.project, 200) || null
      })
    )
  )
  ipcMain.handle('team:parseLink', (_event, raw: string) =>
    run(async () => parseTeamJoinLink(text(raw, 2000)))
  )
  ipcMain.handle('team:pendingJoinLink', () =>
    run(async () => {
      const link = pendingJoinLink
      pendingJoinLink = null
      return link
    })
  )
  ipcMain.handle('team:call', (_event, key: string, op: string, args: unknown) =>
    run(() => team().call(text(key, 500), text(op, 60), args))
  )
  ipcMain.handle('team:facts', (_event, key: string, hashes: unknown, library?: string | null) =>
    run(() => team().facts(text(key, 500), list(hashes, 500), library ? text(library, 200) : null))
  )
  ipcMain.handle('team:inviteLink', (_event, key: string) =>
    run(() => team().inviteLink(text(key, 500)))
  )
  ipcMain.handle('team:startStreams', () => run(() => team().startAll()))
  // 重新登录之后：通知流重连，交给 UE 的登录也换新
  ipcMain.handle('team:restartStream', (_event, serverId: string) =>
    run(async () => {
      team().startStream(text(serverId, 200))
      void team()
        .renewCredential(text(serverId, 200), true)
        .catch(() => undefined)
    })
  )
  ipcMain.handle('team:streamState', (_event, serverId: string) =>
    run(async () => team().streamState(text(serverId, 200)))
  )
  ipcMain.handle('team:localInfo', (_event, key: string) =>
    run(() => team().localInfo(text(key, 500)))
  )
  ipcMain.handle('team:freeSpace', (_event, path: string) =>
    run(() => team().freeSpace(text(path, 2000)))
  )
  ipcMain.handle('team:inspectFolder', (_event, path: string) =>
    run(() => team().inspectFolder(text(path, 2000)))
  )
  ipcMain.handle('team:syncToLocal', (_event, key: string, input: Record<string, unknown>) =>
    run(() =>
      team().syncToLocal(text(key, 500), {
        targetDir: text(input?.targetDir, 2000),
        existing: input?.existing === true
      })
    )
  )
  ipcMain.handle('team:putIn', (_event, key: string, input: Record<string, unknown>) =>
    run(() => team().putIn(text(key, 500), { sourceDir: text(input?.sourceDir, 2000) }))
  )
  ipcMain.handle('team:setFolderSynced', (_event, key: string, folder: string, synced: boolean) =>
    run(() => team().setFolderSynced(text(key, 500), text(folder, 2000), synced === true))
  )
  ipcMain.handle('team:restore', (_event, key: string, input: Record<string, unknown>) =>
    run(() =>
      team().restore(text(key, 500), {
        path: text(input?.path, 2000),
        number: Number(input?.number) || 0
      })
    )
  )
  ipcMain.handle('team:isModified', (_event, key: string, path: string) =>
    run(() => team().isModified(text(key, 500), text(path, 2000)))
  )
  ipcMain.handle('team:cancelCheckout', (_event, key: string, input: Record<string, unknown>) =>
    run(() =>
      team().cancelCheckout(text(key, 500), {
        path: text(input?.path, 2000),
        discard: input?.discard === true
      })
    )
  )
  ipcMain.handle('team:deliver', (_event, key: string, input: Record<string, unknown>) =>
    run(() =>
      team().deliver(text(key, 500), {
        files: list(input?.files, 5000),
        message: text(input?.message, 500),
        facts: Array.isArray(input?.facts) ? input.facts.slice(0, 5000) : []
      })
    )
  )
  ipcMain.handle('team:approveDelivery', (_event, key: string, input: Record<string, unknown>) =>
    run(() =>
      team().approveDelivery(text(key, 500), {
        id: text(input?.id, 100),
        paths: list(input?.paths, 5000),
        message: text(input?.message, 500)
      })
    )
  )
  ipcMain.handle('team:sendReference', (_event, key: string, input: Record<string, unknown>) =>
    run(() =>
      team().sendReference(text(key, 500), {
        company: text(input?.company, 100),
        paths: list(input?.paths, 5000),
        note: text(input?.note, 500)
      })
    )
  )
  ipcMain.handle('team:openPath', (_event, path: string) =>
    run(async () => {
      const target = text(path, 2000)
      if (!/\.uproject$/i.test(target)) throw new Error('Only .uproject files can be opened')
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
      return true
    })
  )
  /**
   * 托盘通知（界面方案 4.14）：文案由渲染层按 i18n 拼好传进来；点了把主窗口拿到前面，
   * 再告诉渲染层打开哪里。同一个 key 只留最新的一条（1.5「合并成一条，不叠加」）。
   */
  const shown = new Map<string, Notification>()
  ipcMain.handle(
    'team:notify',
    (_event, input: { key?: string; title?: string; body?: string; open?: unknown }) =>
      run(async () => {
        if (!Notification.isSupported()) return false
        const key = text(input?.key, 300) || String(Date.now())
        shown.get(key)?.close()
        const notification = new Notification({
          title: text(input?.title, 200),
          body: text(input?.body, 500),
          silent: false
        })
        const open =
          input?.open && typeof input.open === 'object'
            ? (input.open as { serverId?: string; project?: string; path?: string })
            : null
        notification.on('click', () => {
          const window = findMainWindow() ?? BrowserWindow.getAllWindows()[0]
          if (window && !window.isDestroyed()) {
            if (window.isMinimized()) window.restore()
            window.show()
            window.focus()
          }
          if (open?.serverId && open.project) {
            const event: TeamEvent = {
              kind: 'open',
              serverId: text(open.serverId, 200),
              project: text(open.project, 200),
              path: text(open.path, 500) || '/'
            }
            sendToAppWindows(TEAM_EVENT_CHANNEL, event)
          }
        })
        notification.on('close', () => shown.delete(key))
        shown.set(key, notification)
        notification.show()
        return true
      })
  )
}
