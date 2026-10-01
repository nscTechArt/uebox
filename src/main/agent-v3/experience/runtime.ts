/**
 * 会话里的经验运行时：挂在 `afterToolCall` 上，做三件事。
 *
 * 1. **记原始账**：每次引擎工具调用写一行（见 `trail.ts`），给会话结束后的整理员。
 * 2. **报错时出场**：本工程和通用两层里对得上的经验挂在错误结果后面（见 `recall.ts`），
 *    一部分随机留作对照组。
 * 3. **记功**：出场（或对照）之后盯住接下来几步，看有没有照着做、随后成没成，
 *    结论交给 `lifecycle.ts` 决定去留。
 *
 * 它**不写经验内容**。经验只由整理员写（`curator.ts`），这里只改统计、状态和
 * 通用经验的适用版本 —— 都是确定性的代码判断，没有模型参与，一句聊天改变不了它们。
 *
 * 所有入口都不抛异常：经验系统自己出问题，不能让一次工具调用失败。
 */

import { errorFingerprint, isEnvironmentalError, normalizeError } from './errorSignature'
import type { ExpectedAction, ExperienceEntry } from './experienceFile'
import { applyOutcome, emptyStats, type Outcome } from './lifecycle'
import { codeDigest, codeOf, findAvoided, formatPrecheck } from './precheck'
import { recordProvenInProject } from './promotion'
import {
  formatExperienceNote,
  HOLDOUT_RATE,
  matchEntries,
  type ExperienceLayer,
  type LayeredEntry
} from './recall'
import { STRICT_TOOLS, symbolOf } from './specificity'
import type { ExperienceStore } from './store'
import { CODE_LIMIT, digestArgs, type TrailWriter } from './trail'

/** 出场后盯几步。超过还没再调同一个工具，就按「没有结论」收掉 */
export const OBSERVE_WINDOW = 5

interface Pending {
  entry: LayeredEntry
  arm: Outcome['arm']
  tool: string
  fingerprint: string
  failArgs: string
  expect: ExpectedAction
  startStep: number
  adopted: boolean
}

export interface ExperienceRuntimeDeps {
  /** 本工程的经验目录 */
  project: ExperienceStore
  /** 通用层。没给就只有本工程这一层 */
  global?: ExperienceStore
  /** 工程的指纹，升级登记用（见 `promotion.ts`） */
  projectKey: string
  /** 当前引擎版本（major.minor）。通用经验按它判断适不适用 */
  engine?: string
  trail?: TrailWriter
  /** 写进原始账的调用方标识（会话 id，子任务是带后缀的那个） */
  agentId: string
  /** 这个工具的结果值不值得学 / 能不能挂经验：引擎工具、且不是破坏性操作 */
  isLearnableTool: (tool: string, args: unknown) => boolean
  random?: () => number
  now?: () => string
}

export interface ToolCallReport {
  tool: string
  args: unknown
  isError: boolean
  text: string
}

export interface ExperienceRuntime {
  /**
   * 执行前提醒（只对上帝工具）：代码里用了已验证的错误写法，回拦下的理由；放行回 undefined。
   * 见 `precheck.ts`
   */
  before: (call: { tool: string; args: unknown }) => Promise<string | undefined>
  /** 回要挂在工具结果后面的文字；没有就回 undefined */
  after: (call: ToolCallReport) => Promise<string | undefined>
  /** 等所有在途的写入落盘。测试和会话收尾用 */
  flush: () => Promise<void>
}

function paramValue(argsDigest: string, param: string): unknown {
  try {
    return (JSON.parse(argsDigest) as Record<string, unknown>)?.[param]
  } catch {
    return undefined
  }
}

/** 这一步算不算照着经验做了 */
function followsExpect(pending: Pending, tool: string, argsDigest: string): boolean {
  const { expect } = pending
  if (expect.tool && expect.tool !== pending.tool && tool === expect.tool) return true
  if (tool !== pending.tool) return false
  if (expect.param) {
    return (
      JSON.stringify(paramValue(argsDigest, expect.param)) !==
      JSON.stringify(paramValue(pending.failArgs, expect.param))
    )
  }
  // 期望动作就是「换个参数重试同一个工具」
  return expect.tool === pending.tool && argsDigest !== pending.failArgs
}

/**
 * 通用经验在当前引擎版本上的结论改的是「适用版本」，不一定改去留。
 *
 * - 照着做并且成了，而这个版本还没在 `engines` 里：加进去。
 * - 照着做了还是同一个错，而这个版本**没**验证过：这是版本不适用，不是经验错了 ——
 *   记进 `notFor`，这条结论不拿去扣它的分。验证过的版本上又错了，才按经验错了算。
 */
function engineVerdict(
  entry: ExperienceEntry,
  engine: string | undefined,
  adopted: boolean,
  ok: boolean | undefined
): { entry: ExperienceEntry; countAsFailure: boolean } {
  if (!engine || !adopted || ok === undefined) return { entry, countAsFailure: ok === false }
  const engines = entry.engines ?? []
  if (ok) {
    if (engines.includes(engine)) return { entry, countAsFailure: false }
    return {
      entry: {
        ...entry,
        engines: [...engines, engine],
        ...(entry.notFor ? { notFor: entry.notFor.filter((v) => v !== engine) } : {})
      },
      countAsFailure: false
    }
  }
  if (engines.includes(engine)) return { entry, countAsFailure: true }
  const notFor = entry.notFor ?? []
  return {
    entry: notFor.includes(engine) ? entry : { ...entry, notFor: [...notFor, engine] },
    countAsFailure: false
  }
}

export function createExperienceRuntime(deps: ExperienceRuntimeDeps): ExperienceRuntime {
  const random = deps.random ?? Math.random
  const now = deps.now ?? ((): string => new Date().toISOString())
  let step = 0
  let pending: Pending[] = []
  /** 执行前拦过的代码（指纹 → 拦它的经验）。同一段再发一次就放行，跑成了说明拦错了 */
  const blocked = new Map<string, LayeredEntry[]>()
  const writes = new Set<Promise<void>>()

  const storeOf = (layer: ExperienceLayer): ExperienceStore | undefined =>
    layer === 'project' ? deps.project : deps.global

  const track = (work: Promise<unknown>): void => {
    const guarded = work
      .then(() => undefined)
      .catch((error) => {
        console.warn('[Experience] 记功写入失败，已忽略:', error)
      })
    writes.add(guarded)
    void guarded.finally(() => writes.delete(guarded))
  }

  const settle = (item: Pending, ok: boolean | undefined): void => {
    const store = storeOf(item.entry.layer)
    if (!store) return
    track(
      (async () => {
        // 状态按盘上现在的算：同一会话里它可能刚被上一次结论降过级，
        // 用户也可能在界面上删了它（删了就不再记账）
        const current = (await store.readTool(item.tool)).find((e) => e.id === item.entry.id)
        if (!current) return
        const adopted = item.arm === 'shown' && item.adopted

        let next: ExperienceEntry = current
        let outcomeOk = ok
        if (item.entry.layer === 'global') {
          const verdict = engineVerdict(current, deps.engine, adopted, ok)
          next = verdict.entry
          // 版本不适用不算经验错了：这一次既不加分也不扣分
          if (ok === false && !verdict.countAsFailure) outcomeOk = undefined
        }

        // 读和改放在同一次排队的更新里：同一条经验的两次结论同时落地时，分开读写会丢掉一次
        let status = current.status
        await store.updateLedger((all) => {
          const result = applyOutcome(
            current,
            all[item.entry.id] ?? emptyStats(),
            { arm: item.arm, adopted, ok: outcomeOk },
            now()
          )
          status = result.status
          return { ...all, [item.entry.id]: result.stats }
        })
        next = { ...next, status }

        if (JSON.stringify(next) !== JSON.stringify(current)) {
          await store.updateTool(item.tool, (entries) =>
            entries.map((e) => (e.id === next.id ? next : e))
          )
        }
        // 工程经验刚转正：登记一下，两个工程都转正了就升为通用
        if (
          item.entry.layer === 'project' &&
          current.status !== 'proven' &&
          status === 'proven' &&
          deps.global
        ) {
          await recordProvenInProject(deps.global, deps.projectKey, next, deps.engine)
        }
      })()
    )
  }

  const observe = (
    call: ToolCallReport,
    argsDigest: string,
    fingerprint: string | undefined
  ): void => {
    const still: Pending[] = []
    for (const item of pending) {
      if (!item.adopted && followsExpect(item, call.tool, argsDigest)) item.adopted = true

      if (call.tool === item.tool && !call.isError) {
        settle(item, true)
      } else if (call.tool === item.tool && fingerprint === item.fingerprint) {
        settle(item, false)
      } else if (step - item.startStep >= OBSERVE_WINDOW) {
        settle(item, undefined)
      } else {
        still.push(item)
      }
    }
    pending = still
  }

  const readLayers = async (tool: string): Promise<LayeredEntry[]> => {
    const own = (await deps.project.readTool(tool)).map((e) => ({
      ...e,
      layer: 'project' as const
    }))
    const shared = deps.global
      ? (await deps.global.readTool(tool)).map((e) => ({ ...e, layer: 'global' as const }))
      : []
    return [...own, ...shared]
  }

  const after = async (call: ToolCallReport): Promise<string | undefined> => {
    try {
      if (!deps.isLearnableTool(call.tool, call.args)) return undefined
      step += 1
      const argsDigest = digestArgs(call.args)
      const environmental = call.isError && isEnvironmentalError(call.text)
      const normalized = call.isError ? normalizeError(call.text) : undefined
      const fingerprint = call.isError ? errorFingerprint(call.text) : undefined

      observe(call, argsDigest, fingerprint)

      const code = STRICT_TOOLS.has(call.tool) ? codeOf(call.tool, call.args) : undefined
      const resent = code ? blocked.get(codeDigest(code)) : undefined
      if (code && resent) {
        blocked.delete(codeDigest(code))
        // 拦下后原样再发、真跑成了：这次拦错了。从已验证降回试用，它就不再拦路
        if (!call.isError) for (const entry of resent) demote(entry)
      }

      const shown: LayeredEntry[] = []
      const held: LayeredEntry[] = []
      if (call.isError && !environmental && normalized) {
        const alreadyWatching = new Set(pending.map((item) => item.entry.id))
        const matches = matchEntries(
          await readLayers(call.tool),
          call.tool,
          normalized,
          deps.engine,
          symbolOf(call.tool, normalized, call.args)
        )
        for (const entry of matches) {
          if (alreadyWatching.has(entry.id)) continue
          const arm: Outcome['arm'] =
            random() < HOLDOUT_RATE[entry.status === 'proven' ? 'proven' : 'trial']
              ? 'holdout'
              : 'shown'
          ;(arm === 'shown' ? shown : held).push(entry)
          pending.push({
            entry,
            arm,
            tool: call.tool,
            fingerprint: fingerprint ?? '',
            failArgs: argsDigest,
            expect: entry.expect,
            startStep: step,
            adopted: false
          })
        }
      }

      if (deps.trail) {
        track(
          deps.trail.record({
            agent: deps.agentId,
            i: step,
            tool: call.tool,
            ok: !call.isError,
            args: argsDigest,
            ...(normalized ? { error: normalized.slice(0, 400), fp: fingerprint } : {}),
            ...(environmental ? { env: true } : {}),
            ...(shown.length ? { shown: shown.map((e) => e.id) } : {}),
            ...(held.length ? { held: held.map((e) => e.id) } : {}),
            ...(code ? { code: code.slice(0, CODE_LIMIT) } : {})
          })
        )
      }

      return shown.length ? formatExperienceNote(shown, deps.engine) : undefined
    } catch (error) {
      console.warn('[Experience] 运行时出错，已忽略:', error)
      return undefined
    }
  }

  /** 已验证的降回试用（执行前提醒拦错了） */
  const demote = (entry: LayeredEntry): void => {
    const store = storeOf(entry.layer)
    if (!store) return
    track(
      store.updateTool(entry.tool, (entries) =>
        entries.some((e) => e.id === entry.id && e.status === 'proven')
          ? entries.map((e) => (e.id === entry.id ? { ...e, status: 'trial' as const } : e))
          : undefined
      )
    )
  }

  const before = async (call: { tool: string; args: unknown }): Promise<string | undefined> => {
    try {
      if (!STRICT_TOOLS.has(call.tool) || !deps.isLearnableTool(call.tool, call.args))
        return undefined
      const code = codeOf(call.tool, call.args)
      if (!code) return undefined
      const digest = codeDigest(code)
      // 拦过一次的原样再发：放行，结果在 after 里看
      if (blocked.has(digest)) return undefined
      const hits = findAvoided(code, await readLayers(call.tool), deps.engine)
      if (hits.length === 0) return undefined

      blocked.set(digest, hits)
      // 拦下也算一次出场：之后改了代码并且成了，记一次采纳成功
      step += 1
      const watching = new Set(pending.map((item) => item.entry.id))
      for (const entry of hits) {
        if (watching.has(entry.id)) continue
        pending.push({
          entry,
          arm: 'shown',
          tool: call.tool,
          fingerprint: '',
          failArgs: digestArgs(call.args),
          expect: { param: call.tool === 'ue_run_python_script' ? 'script' : 'command' },
          startStep: step,
          adopted: false
        })
      }
      return formatPrecheck(hits, deps.engine)
    } catch (error) {
      console.warn('[Experience] 执行前提醒出错，已放行:', error)
      return undefined
    }
  }

  return {
    before,
    after,
    flush: async () => {
      while (writes.size > 0) await Promise.all([...writes])
    }
  }
}
