/**
 * 外部团队：大脑在外部客户端（Claude Code 等），盒子只当工作室。
 *
 * 设计稿：docs/外部大脑跑团队设计-2026-10-17.md。
 *
 * ## 和盒子里的团队怎么分开
 *
 * 落盘格式完全一样（`teamDirsFor` 那两个目录、`TeamStore` 那几本账），只是团队 id
 * 以 `ext-` 开头，并且多一份 `external.json` 记目标、工程和交付闸状态。
 * 盒子里的团队把这些存在会话的执行记录里（`options.team`）—— 外部团队没有盒子侧的会话，
 * 所以单独存一份。盒子里那条路上的代码一行都不读这份文件，两边互不影响。
 */

import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'

import type { GoalVerdict } from '../goalLoop'
import { sessionsDir } from '../transcriptStore'
import { applyVerdict, newTeamState, noteWrite, teamDirsFor, type TeamState } from './teamSession'
import type { TeamDirs } from './teamStore'

export const EXTERNAL_TEAM_PREFIX = 'ext-'

const RECORD_FILE = 'external.json'

export interface ExternalTeamRecord {
  id: string
  objective: string
  /** 团队在哪个工程里干。立项时可能还没有，建好工程后用 `team_open` 补上 */
  projectPath?: string
  createdAt: number
  /** 用户或制作人宣布结束的时刻。结束的团队交付闸一律放行 */
  endedAt?: number
  /** 交付闸状态：验收结论、最近一次写工程的时刻。和盒子里的团队同一个形状 */
  state: TeamState
}

export function isExternalTeamId(id: string): boolean {
  return id.startsWith(EXTERNAL_TEAM_PREFIX) && /^[a-zA-Z0-9_-]+$/.test(id)
}

/**
 * 交付闸要的事实，给 `team_gate` 和 CLI 用。
 *
 * `passed` 的口径：验收 PASS，并且之后没人再写过工程。PASS 之后又改了，改动没人验过。
 */
export interface ExternalGateFacts {
  teamId: string
  objective: string
  verdict: TeamState['verdict']
  verdictAt: number | null
  lastWriteAt: number | null
  deliveries: number
  passed: boolean
  ended: boolean
}

export function gateFacts(record: ExternalTeamRecord): ExternalGateFacts {
  const { state } = record
  const changedSince =
    state.lastWriteAt !== undefined &&
    state.verdictAt !== undefined &&
    state.lastWriteAt > state.verdictAt
  return {
    teamId: record.id,
    objective: record.objective,
    verdict: state.verdict,
    verdictAt: state.verdictAt ?? null,
    lastWriteAt: state.lastWriteAt ?? null,
    deliveries: state.deliveries,
    passed: state.verdict === 'pass' && !changedSince,
    ended: record.endedAt !== undefined
  }
}

export interface ExternalTeamRegistry {
  dirsFor(id: string): TeamDirs
  create(input: { objective: string; projectPath?: string }): Promise<ExternalTeamRecord>
  get(id: string): Promise<ExternalTeamRecord | undefined>
  /** 改一份记录。`change` 回 null = 不用改（不落盘） */
  update(
    id: string,
    change: (record: ExternalTeamRecord) => ExternalTeamRecord | null
  ): Promise<ExternalTeamRecord>
  /** 有队员写了工程。只在跨过「上次验收」那条线时落盘，见 `noteWrite` */
  noteWrite(id: string): Promise<void>
  recordVerdict(id: string, verdict: GoalVerdict | null): Promise<ExternalTeamRecord>
  /** 最近的在前 */
  list(): Promise<ExternalTeamRecord[]>
}

export interface ExternalTeamRegistryDeps {
  dirsFor: (id: string) => TeamDirs
  /** 所有团队状态目录的上一级（会话目录）。列团队时扫它 */
  stateRoot: () => string
  now?: () => number
  newId?: () => string
}

export function createExternalTeamRegistry(deps: ExternalTeamRegistryDeps): ExternalTeamRegistry {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => `${EXTERNAL_TEAM_PREFIX}${randomUUID()}`)
  // 同一个团队的读改写排成一条：几个队员同时写工程时，`noteWrite` 不能互相覆盖
  const chains = new Map<string, Promise<unknown>>()

  const fileFor = (id: string): string => join(deps.dirsFor(id).stateDir, RECORD_FILE)

  async function read(id: string): Promise<ExternalTeamRecord | undefined> {
    if (!isExternalTeamId(id)) return undefined
    try {
      const raw = JSON.parse(await fs.readFile(fileFor(id), 'utf8')) as ExternalTeamRecord
      return raw && raw.id === id && raw.state ? raw : undefined
    } catch {
      return undefined
    }
  }

  async function write(record: ExternalTeamRecord): Promise<void> {
    const file = fileFor(record.id)
    await fs.mkdir(deps.dirsFor(record.id).stateDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
    await fs.rename(tmp, file)
  }

  function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    chains.set(
      id,
      next.catch(() => undefined)
    )
    return next
  }

  const registry: ExternalTeamRegistry = {
    dirsFor: deps.dirsFor,

    async create({ objective, projectPath }) {
      const record: ExternalTeamRecord = {
        id: newId(),
        objective,
        ...(projectPath ? { projectPath } : {}),
        createdAt: now(),
        state: newTeamState(objective)
      }
      await write(record)
      return record
    },

    get: read,

    update(id, change) {
      return serial(id, async () => {
        const record = await read(id)
        if (!record) throw new Error(`没有这个外部团队：${id}`)
        const next = change(record)
        if (!next) return record
        await write(next)
        return next
      })
    },

    async noteWrite(id) {
      await registry.update(id, (record) => {
        const state = noteWrite(record.state, now())
        return state ? { ...record, state } : null
      })
    },

    recordVerdict(id, verdict) {
      return registry.update(id, (record) => ({
        ...record,
        state: applyVerdict(record.state, verdict, now())
      }))
    },

    async list() {
      let names: string[]
      try {
        names = await fs.readdir(deps.stateRoot())
      } catch {
        return []
      }
      const ids = names
        .filter((name) => name.startsWith(EXTERNAL_TEAM_PREFIX) && name.endsWith('.team'))
        .map((name) => name.slice(0, -'.team'.length))
      const records = await Promise.all(ids.map((id) => read(id)))
      return records
        .filter((record): record is ExternalTeamRecord => record !== undefined)
        .sort((a, b) => b.createdAt - a.createdAt)
    }
  }
  return registry
}

let shared: ExternalTeamRegistry | undefined

/**
 * 盒子里只用这一份：MCP 那头（队员写工程、记验收）和界面这头（结束团队）改的是同一个文件，
 * 共用一份才共用同一条读改写的串行链
 */
export function sharedExternalTeamRegistry(): ExternalTeamRegistry {
  shared ??= createExternalTeamRegistry({ dirsFor: teamDirsFor, stateRoot: sessionsDir })
  return shared
}
