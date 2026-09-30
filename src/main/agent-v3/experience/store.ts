/**
 * 一层经验的目录。两层用同一个类：本工程 `<工程>/.uebox/experience/`，
 * 通用 `<userData>/experience/`（见 `session.ts`）。下面以本工程为例。
 *
 * ```
 * experience/
 *   ue_run_python_script.md   按工具分文件（见 experienceFile.ts）
 *   .ledger.json              统计（出场/采纳/对照），删了只会让试用期重来
 *   .history/<时间>/          每次整理前的快照，回滚就是拷回来
 * ```
 *
 * ## 并发
 *
 * 同一个工程可能同时有几条会话在跑（工作室模式的队员、两个窗口）。写操作按目录
 * 排成一条队 —— 只在本进程内有效，而盒子就是一个进程，够用。
 * 写文件先写临时文件再改名，写到一半断电也不会留下半个 markdown。
 */

import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'

import {
  fileNameForTool,
  parseExperienceFile,
  serializeExperienceFile,
  type ExperienceEntry
} from './experienceFile'
import { emptyStats, type EntryStats } from './lifecycle'

const LEDGER_FILE = '.ledger.json'
const HISTORY_DIR = '.history'
/** 快照留几份。整理一次写一份，十份够回到「最近几天」 */
const HISTORY_KEEP = 10

/**
 * 工程根 → 经验目录。和 `projectSkillsDir` 同一套判据：给的可以是 `.uproject` 路径。
 */
export function experienceDir(projectRoot?: string): string | undefined {
  if (!projectRoot) return undefined
  const root = projectRoot.toLowerCase().endsWith('.uproject') ? dirname(projectRoot) : projectRoot
  if (!root || basename(root) === '') return undefined
  return join(root, '.uebox', 'experience')
}

interface LedgerFile {
  version: 1
  entries: Record<string, EntryStats>
}

const queues = new Map<string, Promise<unknown>>()

/** 同一个目录的写操作排队执行 */
function serialized<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(dir) ?? Promise.resolve()
  const next = previous.then(task, task)
  queues.set(
    dir,
    next.catch(() => undefined)
  )
  return next
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, path)
}

export class ExperienceStore {
  constructor(readonly dir: string) {}

  async readTool(tool: string): Promise<ExperienceEntry[]> {
    try {
      return parseExperienceFile(await fs.readFile(join(this.dir, fileNameForTool(tool)), 'utf8'))
    } catch {
      return []
    }
  }

  async readAll(): Promise<ExperienceEntry[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.dir)
    } catch {
      return []
    }
    const all: ExperienceEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.md') || name.startsWith('_')) continue
      try {
        all.push(...parseExperienceFile(await fs.readFile(join(this.dir, name), 'utf8')))
      } catch {
        // 读不了的文件跳过，别拖垮其余的
      }
    }
    return all
  }

  /** 改一个工具文件里的条目。`update` 收当前条目、回新条目；回 undefined 表示不改 */
  updateTool(
    tool: string,
    update: (entries: ExperienceEntry[]) => ExperienceEntry[] | undefined
  ): Promise<void> {
    return serialized(this.dir, async () => {
      const next = update(await this.readTool(tool))
      if (!next) return
      const path = join(this.dir, fileNameForTool(tool))
      if (next.length === 0) {
        await fs.rm(path, { force: true })
        return
      }
      await writeAtomic(path, serializeExperienceFile(tool, next))
    })
  }

  async readLedger(): Promise<Record<string, EntryStats>> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(join(this.dir, LEDGER_FILE), 'utf8')
      ) as LedgerFile
      return parsed.entries ?? {}
    } catch {
      return {}
    }
  }

  async statsFor(id: string): Promise<EntryStats> {
    return (await this.readLedger())[id] ?? emptyStats()
  }

  updateLedger(
    update: (entries: Record<string, EntryStats>) => Record<string, EntryStats>
  ): Promise<void> {
    return serialized(this.dir, async () => {
      const next = update(await this.readLedger())
      const file: LedgerFile = { version: 1, entries: next }
      await writeAtomic(join(this.dir, LEDGER_FILE), `${JSON.stringify(file, null, 1)}\n`)
    })
  }

  /** 目录里一份小 JSON 的读改写（和账本同一条队）。升级登记用它 */
  updateJson<T>(name: string, fallback: T, update: (current: T) => T): Promise<T> {
    return serialized(this.dir, async () => {
      const path = join(this.dir, name)
      let current = fallback
      try {
        current = JSON.parse(await fs.readFile(path, 'utf8')) as T
      } catch {
        // 没有或读坏了就从头来
      }
      const next = update(current)
      await writeAtomic(path, `${JSON.stringify(next, null, 1)}\n`)
      return next
    })
  }

  /** 把当前的 markdown 和账本拷一份进 `.history/`。回快照名；目录是空的回 undefined */
  snapshot(now: Date = new Date()): Promise<string | undefined> {
    return serialized(this.dir, async () => {
      let names: string[]
      try {
        names = (await fs.readdir(this.dir)).filter(
          (name) => name.endsWith('.md') || name === LEDGER_FILE
        )
      } catch {
        return undefined
      }
      if (names.length === 0) return undefined

      const id = now.toISOString().replace(/[:.]/g, '-')
      const target = join(this.dir, HISTORY_DIR, id)
      await fs.mkdir(target, { recursive: true })
      for (const name of names) await fs.copyFile(join(this.dir, name), join(target, name))

      const all = (await fs.readdir(join(this.dir, HISTORY_DIR))).sort()
      for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) {
        await fs.rm(join(this.dir, HISTORY_DIR, old), { recursive: true, force: true })
      }
      return id
    })
  }

  async listSnapshots(): Promise<string[]> {
    try {
      return (await fs.readdir(join(this.dir, HISTORY_DIR))).sort().reverse()
    } catch {
      return []
    }
  }

  /** 某份快照里的经验。快照不存在回空 */
  async readSnapshot(id: string): Promise<ExperienceEntry[]> {
    if (!/^[\w-]+$/.test(id)) return []
    const source = join(this.dir, HISTORY_DIR, id)
    let names: string[]
    try {
      names = await fs.readdir(source)
    } catch {
      return []
    }
    const all: ExperienceEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      all.push(...parseExperienceFile(await fs.readFile(join(source, name), 'utf8')))
    }
    return all
  }

  /** 删掉一份快照。撤销用过之后删，下一次撤销就回到更早那次 */
  removeSnapshot(id: string): Promise<void> {
    return serialized(this.dir, async () => {
      if (!/^[\w-]+$/.test(id)) return
      await fs.rm(join(this.dir, HISTORY_DIR, id), { recursive: true, force: true })
    })
  }

  /** 回到某份快照：当前的 markdown 和账本整个换成快照里的 */
  restore(id: string): Promise<void> {
    return serialized(this.dir, async () => {
      if (!/^[\w-]+$/.test(id)) throw new Error(`快照名不合法：${id}`)
      const source = join(this.dir, HISTORY_DIR, id)
      const saved = await fs.readdir(source)
      for (const name of await fs.readdir(this.dir)) {
        if (name.endsWith('.md') || name === LEDGER_FILE) await fs.rm(join(this.dir, name))
      }
      for (const name of saved) await fs.copyFile(join(source, name), join(this.dir, name))
    })
  }
}
