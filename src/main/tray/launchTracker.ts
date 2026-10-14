/**
 * 「启动中」跟踪：点了托盘里的工程到插件连上来之间的那一整段。
 *
 * 分两段记在一张 Map 里：点了到 `openUprojectFile` 落定是一段 —— 里面装着
 * 「装插件」这种可能拖很久的 await，这段不吃 TTL；若仍按两分钟超时，会把
 * 还在进行的打开当成没这回事，再点就是第二个编辑器进程。落定成功到插件连上是另一段，
 * `shell.openPath` 到 UnrealAgentLink 握手要几十秒，这期间 `projectManager`
 * 还报不出它在跑 —— 这段才有 TTL 兜底：真连上了由调用方 `clearIfRunning`
 * 摘掉（running 优先），两分钟都没起来（崩溃、UAC 被按掉）就当作没这回事，
 * 恢复成可点。
 *
 * 纯模块：不引 Electron，状态就在一张 Map 里，时间可注入。
 */
import type { TrayProjectCandidate } from './recentProjects'
import type { TrayRecentProject } from './trayMenu'

/** 「等引擎连上」最多留这么久 */
export const LAUNCH_TTL_MS = 2 * 60 * 1000

export interface LaunchTrackerDeps {
  now?: () => number
}

export interface LaunchTracker {
  /** 记下「这个工程刚被点去启动」 */
  begin: (projectKey: string) => void
  complete: (projectKey: string, waitForConnect: boolean) => void
  /** 它已经连上时调用：摘掉「等连接」的计时标记 */
  clearIfRunning: (projectKey: string) => void
  /** 还在启动链路里吗；过期的「等连接」标记顺手删掉 */
  isLaunching: (projectKey: string) => boolean
  /**
   * 「等连接」标记立起来的时刻（complete 成功那刻）。
   * 进行中的打开（null）、没标过的、刚过期的都回 undefined —— 过期的顺手删掉。
   * 给「引擎进程其实已经没了」的对账用：调用方拿它决定要不要查一次进程表。
   */
  waitingSince: (projectKey: string) => number | undefined
  /** 无条件摘掉标记 —— 对账发现引擎进程已经没了时调用 */
  drop: (projectKey: string) => void
  nextExpiryDelay: () => number | null
}

export function createLaunchTracker(deps: LaunchTrackerDeps = {}): LaunchTracker {
  const { now = Date.now } = deps
  const marks = new Map<string, number | null>()

  /** 没过期的「等连接」时刻；进行中的（null）、没标过的、过期的都回 undefined —— 过期的顺手删掉 */
  const freshTimestamp = (projectKey: string): number | undefined => {
    const at = marks.get(projectKey)
    if (at === undefined || at === null) return undefined
    if (now() - at > LAUNCH_TTL_MS) {
      marks.delete(projectKey)
      return undefined
    }
    return at
  }

  const isLaunching = (projectKey: string): boolean =>
    marks.get(projectKey) === null || freshTimestamp(projectKey) !== undefined

  const nextExpiryDelay = (): number | null => {
    const nowAt = now()
    let earliest: number | null = null
    for (const [key, at] of marks) {
      if (at === null) continue
      const remaining = at + LAUNCH_TTL_MS + 1 - nowAt
      if (remaining <= 0) {
        marks.delete(key)
        continue
      }
      if (earliest === null || remaining < earliest) earliest = remaining
    }
    return earliest
  }

  return {
    begin: (projectKey) => {
      marks.set(projectKey, null)
    },
    complete: (projectKey, waitForConnect) => {
      if (waitForConnect) marks.set(projectKey, now())
      else marks.delete(projectKey)
    },
    clearIfRunning: (projectKey) => {
      if (typeof marks.get(projectKey) === 'number') marks.delete(projectKey)
    },
    isLaunching,
    waitingSince: freshTimestamp,
    drop: (projectKey) => {
      marks.delete(projectKey)
    },
    nextExpiryDelay
  }
}

/**
 * 把「运行中 / 启动中」一起叠到候选名单上 —— 每次建菜单现算，
 * 不走候选名单那份 TTL 缓存。
 *
 * running 优先于 launching：它都连上了，「等连接」标记的使命结束，顺手清掉 —
 * 不然中间有个「既运行中又启动中」的怪胎状态。还没落定的打开不摘。
 */
export function applyProjectState(
  candidates: TrayProjectCandidate[],
  runningKeys: Set<string>,
  tracker: LaunchTracker
): TrayRecentProject[] {
  return candidates.map((candidate) => {
    const running = runningKeys.has(candidate.projectKey)
    if (running) tracker.clearIfRunning(candidate.projectKey)
    return {
      ...candidate,
      running,
      launching: !running && tracker.isLaunching(candidate.projectKey)
    }
  })
}
