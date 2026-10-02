/**
 * 「启动中」跟踪：点了托盘里的工程到插件连上来之间的那一整段。
 *
 * 分两段记在一张 Map 里：点了到 `openUprojectFile` 落定是一段 —— 里面装着
 * 「装插件」这种可能拖很久的 await，这段不吃 TTL；若仍按两分钟超时，会把
 * 还在进行的打开当成没这回事，再点就是第二个编辑器进程。落定成功到插件连上是另一段，
 * `shell.openPath` 到 UnrealAgentLink 握手要几十秒，这期间 `projectManager`
 * 还报不出它在跑 —— 这段才有 TTL 兜底：真连上了会被 `withProjectState`
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
  ttlMs?: number
}

export interface LaunchTracker {
  /** 记下「这个工程刚被点去启动」 */
  begin: (projectKey: string) => void
  complete: (projectKey: string, success: boolean) => void
  /** 它已经连上时调用：摘掉「等连接」的计时标记 */
  clearIfRunning: (projectKey: string) => void
  /** 还在启动链路里吗；过期的「等连接」标记顺手删掉 */
  isLaunching: (projectKey: string) => boolean
  nextExpiryDelay: () => number | null
}

export function createLaunchTracker(deps: LaunchTrackerDeps = {}): LaunchTracker {
  const { now = Date.now, ttlMs = LAUNCH_TTL_MS } = deps
  const marks = new Map<string, number | null>()

  const isLaunching = (projectKey: string): boolean => {
    const at = marks.get(projectKey)
    if (at === null) return true
    if (at === undefined) return false
    if (now() - at > ttlMs) {
      marks.delete(projectKey)
      return false
    }
    return true
  }

  const nextExpiryDelay = (): number | null => {
    const nowAt = now()
    let earliest: number | null = null
    for (const [key, at] of marks) {
      if (at === null) continue
      const remaining = at + ttlMs + 1 - nowAt
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
    complete: (projectKey, success) => {
      if (success) marks.set(projectKey, now())
      else marks.delete(projectKey)
    },
    clearIfRunning: (projectKey) => {
      if (typeof marks.get(projectKey) === 'number') marks.delete(projectKey)
    },
    isLaunching,
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
export function withProjectState(
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
