/**
 * 什么时候叫整理员：会话真的空出来之后（`released`），排队，一次一个，不急。
 *
 * ## 为什么等、为什么一次一个
 *
 * 用户就在这台机器上干活。整理是后台的事，不该和用户的下一句话抢模型、抢磁盘。
 * 所以会话结束后先等一会儿，再按顺序一个一个整理；同一条会话连着结束好几轮，
 * 只在最后一轮之后整理一次（原始账是追加的，最后那次能看到全部）。
 *
 * ## 用哪个模型
 *
 * 用户当前的默认模型（设计稿 13.1，2026-09-30 定），不新增设置。
 * 走 `resolveBinding` + `completeText`，和应用里别的一问一答同一条路。
 */

import { app } from 'electron'
import { join } from 'path'

import { observeAgentRuns } from '../host/runObserver'
import { curateSession, type CurateResult } from './curator'
import { markCurated, pruneTrails, readTrail, TRAIL_SUBDIR } from './trail'

/** 会话结束后等多久再整理。用户常常紧接着再发一句，那一轮结束再说 */
export const CURATE_DELAY_MS = 60_000

/**
 * 经验的「家」：通用层目录，原始账在它的 `.trail/` 下。
 *
 * 拿不到 userData（测试里 electron 是桩）就回 undefined —— 那时经验系统退化成
 * 「只有本工程一层、不记账」，不该让会话因此失败。
 */
export function experienceHome(): string | undefined {
  try {
    return join(app.getPath('userData'), 'experience')
  } catch {
    return undefined
  }
}

/** 给宿主摊进 `SessionContext` 用：拿不到目录时不带这个键 */
export function experienceHomeContext(): { experienceHome?: string } {
  const home = experienceHome()
  return home ? { experienceHome: home } : {}
}

async function defaultComplete(system: string, user: string): Promise<string> {
  // 懒加载：模型配置这一串依赖不该在应用启动时就拉进来
  const { resolveBinding, completeText, userMessage } = await import('../../ai/piCompletion')
  const binding = await resolveBinding({})
  return completeText(binding.provider, binding.modelId, {
    system,
    messages: [userMessage(user)],
    temperature: 0.2,
    maxTokens: 2000
  })
}

export interface CuratorSchedulerDeps {
  home?: string
  delayMs?: number
  complete?: (system: string, user: string) => Promise<string>
  onResult?: (sessionId: string, result: CurateResult) => void
}

export function startExperienceCurator(deps: CuratorSchedulerDeps = {}): () => void {
  const home = deps.home ?? experienceHome()
  if (!home) return () => {}
  const trailDir = join(home, TRAIL_SUBDIR)
  const delay = deps.delayMs ?? CURATE_DELAY_MS
  const complete = deps.complete ?? defaultComplete
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let chain: Promise<unknown> = Promise.resolve()

  const curate = async (sessionId: string): Promise<void> => {
    const trail = await readTrail(trailDir, sessionId)
    if (!trail || trail.calls.length <= trail.curatedThrough) return
    const calls = trail.calls.slice(trail.curatedThrough)
    const result = await curateSession({
      header: trail.header,
      calls,
      complete,
      globalDir: home,
      // 期望动作里的工具必须是这次会话真的调过的，原始账本身就是那份名单
      knownTools: new Set(calls.map((call) => call.tool))
    })
    await markCurated(trailDir, sessionId, trail.calls.length)
    if (result.written.length > 0) {
      console.log(`[Experience] 会话 ${sessionId} 整理出 ${result.written.length} 条经验`)
    }
    deps.onResult?.(sessionId, result)
    await pruneTrails(trailDir)
  }

  const unsubscribe = observeAgentRuns((signal) => {
    if (signal.type === 'started') {
      // 又开了一轮：等它结束再整理
      clearTimeout(timers.get(signal.sessionId))
      timers.delete(signal.sessionId)
      return
    }
    if (signal.type !== 'released' || signal.sessionId.includes(':')) return
    clearTimeout(timers.get(signal.sessionId))
    timers.set(
      signal.sessionId,
      setTimeout(() => {
        timers.delete(signal.sessionId)
        chain = chain
          .then(() => curate(signal.sessionId))
          .catch((error) => console.warn('[Experience] 整理失败，已忽略:', error))
      }, delay)
    )
  })

  return () => {
    unsubscribe()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }
}
