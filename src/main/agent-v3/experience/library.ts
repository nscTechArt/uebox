/**
 * 技能页「经验」分组背后的读写：列出两层经验、固定保留、删除、撤销上次整理。
 *
 * ## 工程从哪来
 *
 * 只认项目库里登记过的工程（首页导入/新建时写进的那张表），路径由宿主传进来。
 * 渲染层回传的工程路径必须在这份名单里 —— 它会被拼进写文件的路径，
 * 不能让界面随手递一个任意目录过来。
 *
 * ## 撤销上次整理
 *
 * 整理员写入前给每个要动的目录拍一张快照，同一次整理的快照名相同（同一个时间戳）。
 * 所以「上次整理」= 所有目录里最新的那个快照名；撤销 = 在每个有它的目录里恢复它，
 * 然后删掉它 —— 下一次撤销就回到更早的那次。
 */

import type { ExperienceEntry } from './experienceFile'
import { emptyStats, lift, type EntryStats } from './lifecycle'
import type { ExperienceLayer } from './recall'
import { ExperienceStore, experienceDir } from './store'

export interface LibraryProject {
  name: string
  path: string
}

export interface ExperienceView extends ExperienceEntry {
  layer: ExperienceLayer
  /** 本工程层才有 */
  projectName?: string
  projectPath?: string
  stats: EntryStats & { lift?: number }
}

export interface CurationSummary {
  id: string
  /** 快照名是 ISO 时间去掉冒号和点，这里还原成 ISO 给界面格式化 */
  at: string
  added: number
  retired: number
}

export interface ExperienceRef {
  layer: ExperienceLayer
  projectPath?: string
  tool: string
  id: string
}

interface Located {
  layer: ExperienceLayer
  store: ExperienceStore
  project?: LibraryProject
}

function locations(home: string | undefined, projects: LibraryProject[]): Located[] {
  const list: Located[] = []
  if (home) list.push({ layer: 'global', store: new ExperienceStore(home) })
  for (const project of projects) {
    const dir = experienceDir(project.path)
    if (dir) list.push({ layer: 'project', store: new ExperienceStore(dir), project })
  }
  return list
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 引用 → 它所在的那个目录。工程不在项目库里就不认 */
function resolve(
  home: string | undefined,
  projects: LibraryProject[],
  ref: ExperienceRef
): ExperienceStore | undefined {
  if (ref.layer === 'global') return home ? new ExperienceStore(home) : undefined
  const project = projects.find((p) => ref.projectPath && sameDir(p.path, ref.projectPath))
  const dir = project ? experienceDir(project.path) : undefined
  return dir ? new ExperienceStore(dir) : undefined
}

function snapshotTime(id: string): string {
  // 2026-09-30T14-02-11-123Z → 2026-09-30T14:02:11.123Z
  const match = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/)
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : id
}

async function latestCuration(
  places: Located[]
): Promise<{ id: string; stores: ExperienceStore[] } | undefined> {
  let latest: string | undefined
  const byId = new Map<string, ExperienceStore[]>()
  for (const { store } of places) {
    const [newest] = await store.listSnapshots()
    if (!newest) continue
    byId.set(newest, [...(byId.get(newest) ?? []), store])
    if (!latest || newest > latest) latest = newest
  }
  return latest ? { id: latest, stores: byId.get(latest) ?? [] } : undefined
}

async function summarize(
  curation: { id: string; stores: ExperienceStore[] } | undefined
): Promise<CurationSummary | undefined> {
  if (!curation) return undefined
  let added = 0
  let retired = 0
  for (const store of curation.stores) {
    const before = new Map((await store.readSnapshot(curation.id)).map((e) => [e.id, e]))
    const now = await store.readAll()
    added += now.filter((e) => !before.has(e.id) && e.status !== 'retired').length
    retired += now.filter(
      (e) => e.status === 'retired' && before.get(e.id)?.status !== 'retired' && before.has(e.id)
    ).length
  }
  return { id: curation.id, at: snapshotTime(curation.id), added, retired }
}

export async function listExperiences(
  home: string | undefined,
  projects: LibraryProject[]
): Promise<{ entries: ExperienceView[]; lastCuration?: CurationSummary }> {
  const places = locations(home, projects)
  const entries: ExperienceView[] = []
  for (const { layer, store, project } of places) {
    const ledger = await store.readLedger()
    for (const entry of await store.readAll()) {
      const stats = ledger[entry.id] ?? emptyStats()
      const measured = lift(stats)
      entries.push({
        ...entry,
        layer,
        ...(project ? { projectName: project.name, projectPath: project.path } : {}),
        stats: { ...stats, ...(measured !== undefined ? { lift: measured } : {}) }
      })
    }
  }
  const lastCuration = await summarize(await latestCuration(places))
  return { entries, ...(lastCuration ? { lastCuration } : {}) }
}

export async function setExperiencePinned(
  home: string | undefined,
  projects: LibraryProject[],
  ref: ExperienceRef,
  pinned: boolean
): Promise<boolean> {
  const store = resolve(home, projects, ref)
  if (!store) return false
  let found = false
  await store.updateTool(ref.tool, (list) => {
    if (!list.some((e) => e.id === ref.id)) return undefined
    found = true
    return list.map((e) => {
      if (e.id !== ref.id) return e
      const next = { ...e }
      if (pinned) next.pinned = true
      else delete next.pinned
      return next
    })
  })
  return found
}

export async function deleteExperience(
  home: string | undefined,
  projects: LibraryProject[],
  ref: ExperienceRef
): Promise<boolean> {
  const store = resolve(home, projects, ref)
  if (!store) return false
  let found = false
  await store.updateTool(ref.tool, (list) => {
    if (!list.some((e) => e.id === ref.id)) return undefined
    found = true
    return list.filter((e) => e.id !== ref.id)
  })
  if (found) {
    await store.updateLedger((all) => {
      const rest = { ...all }
      delete rest[ref.id]
      return rest
    })
  }
  return found
}

/** 撤销上次整理。回被撤销的那次；没有可撤销的回 undefined */
export async function undoLastCuration(
  home: string | undefined,
  projects: LibraryProject[]
): Promise<CurationSummary | undefined> {
  const places = locations(home, projects)
  const curation = await latestCuration(places)
  const summary = await summarize(curation)
  if (!curation) return undefined
  for (const store of curation.stores) {
    await store.restore(curation.id)
    await store.removeSnapshot(curation.id)
  }
  return summary
}

/** 渲染层传来的引用：字段类型不对就不认 */
export function parseExperienceRef(raw: unknown): ExperienceRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const ref = raw as Record<string, unknown>
  if (ref.layer !== 'global' && ref.layer !== 'project') return undefined
  if (typeof ref.tool !== 'string' || typeof ref.id !== 'string') return undefined
  if (ref.layer === 'project' && typeof ref.projectPath !== 'string') return undefined
  return {
    layer: ref.layer,
    tool: ref.tool,
    id: ref.id,
    ...(typeof ref.projectPath === 'string' ? { projectPath: ref.projectPath } : {})
  }
}
