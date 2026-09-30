/**
 * 工程经验升为通用：同一条经验在 2 个以上工程里各自转正。
 *
 * ## 为什么靠证据，不只靠整理员一句话
 *
 * 整理员写经验时会判一次层级（`curator.ts` 的 `decideLayer`），但判断会错 ——
 * 尤其是往「工程」那边错：拿不准的一律放工程，这是故意的（冻结的经验换个环境
 * 几乎不再起作用，研究里测过）。代价是一条其实通用的经验，换个工程得重新学。
 * 这里把它补回来：在两个工程里都被照着做并且成了，就不是巧合了。
 *
 * ## 登记在哪
 *
 * 通用层目录里的 `.promotions.json`：钥匙（工具 + 报错片段）→ 在哪些工程里转正过、
 * 当时的引擎版本。只记工程路径的指纹，不记路径本身之外的任何东西。
 */

import { randomBytes } from 'crypto'

import { admit, patternCovered } from './admission'
import type { ExperienceEntry } from './experienceFile'
import type { ExperienceStore } from './store'

export const PROMOTE_MIN_PROJECTS = 2
const PROMOTIONS_FILE = '.promotions.json'

interface PromotionFile {
  version: 1
  keys: Record<string, { projects: string[]; engines: string[] }>
}

function keyOf(entry: Pick<ExperienceEntry, 'tool' | 'errorPattern'>): string {
  return `${entry.tool}::${entry.errorPattern.toLowerCase()}`
}

/**
 * 一条工程经验刚转正：登记，攒够工程数就在通用层放一条。
 *
 * 回新写进通用层的那条；没升级回 undefined。
 */
export async function recordProvenInProject(
  global: ExperienceStore,
  projectKey: string,
  entry: ExperienceEntry,
  engine: string | undefined
): Promise<ExperienceEntry | undefined> {
  const key = keyOf(entry)
  const file = await global.updateJson<PromotionFile>(
    PROMOTIONS_FILE,
    { version: 1, keys: {} },
    (current) => {
      const record = current.keys[key] ?? { projects: [], engines: [] }
      const projects = record.projects.includes(projectKey)
        ? record.projects
        : [...record.projects, projectKey]
      const engines =
        engine && !record.engines.includes(engine) ? [...record.engines, engine] : record.engines
      return { version: 1, keys: { ...current.keys, [key]: { projects, engines } } }
    }
  )

  const record = file.keys[key]
  if (!record || record.projects.length < PROMOTE_MIN_PROJECTS) return undefined

  const promoted: ExperienceEntry = {
    id: `e-${randomBytes(4).toString('hex')}`,
    title: entry.title,
    tool: entry.tool,
    errorPattern: entry.errorPattern,
    advice: entry.advice,
    expect: entry.expect,
    source: `proven in ${record.projects.length} projects`,
    status: 'proven',
    ...(record.engines.length ? { engines: record.engines } : {})
  }

  let added = false
  const ledger = await global.readLedger()
  await global.updateTool(entry.tool, (list) => {
    if (patternCovered(list, entry.tool, entry.errorPattern)) return undefined
    const next = admit(list, promoted, ledger)
    if (next) added = true
    return next
  })
  return added ? promoted : undefined
}
