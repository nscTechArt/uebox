/**
 * 托盘菜单「最近项目」那三条怎么挑。
 *
 * ## 为什么不是「项目库里最近的三条」
 *
 * 托盘菜单的开销按「用户此刻想接着干活」算 —— 他最可能想重开的是**引擎最近
 * 开过**的工程（Epic Launcher 那份 `EditorSettings.ini` 名单，和首页最近列表
 * 同源）。项目库自己的排序是给首页看的，会把他上周手动理过的顺序搬上来，
 * 不等于「最近用过」。
 *
 * 但**只**列引擎名单里 `isImported` 的那些：菜单里点开走 `openUprojectFile`，
 * 那是盒子管理的工程的入口，没进库的点开也接不上「插件装没装上」那套反馈。
 *
 * ## 路径看哪条
 *
 * 显示名和打开路径一律用**库记录**的（`projectName` / `originPath`），不用
 * UE 名单里的 `projectPath` —— 后者是从 ini 里读的原始写法，首页双击开的
 * 是 `originPath`，两边不一致就会出现「首页能开、托盘点了报找不到」。
 * 找记录也按目录比（`getProjectByPath` 内部会做规范化），不重写一套比较。
 *
 * ## 两段式：候选名单 vs 运行状态
 *
 * `getTrayRecentCandidates` 只算「名单里该有谁」（读 ini、查库、确认文件还在）：
 * 这一整段全是 IO，但变化极慢，调用方拿十秒 TTL 缓存包着。
 * `withProjectState` 把「谁在跑 / 谁在启动」叠上去 —— 那是一瞬的事，每次建菜单都现算，
 * 不经过缓存。混在一起的话，要么 running 跟着名单旧十秒，要么 IO 跟着
 * running 每趟重跑 —— 两头都不该。
 */
import { dirname, extname } from 'path'

import type { TrayRecentProject } from './trayMenu'
import { TRAY_RECENT_LIMIT } from '../../shared/trayActions'

/** `getRecentProjectsFromAllEngines` 的返回里，这里用得上的部分 */
export interface RecentEntry {
  /** `.uproject` 文件完整路径 */
  projectPath: string
  projectName: string
  lastOpenTime: string
  isImported: boolean
}

/** `getProjectByPath` 的返回里，这里用得上的部分 */
export interface ProjectRecordLike {
  projectKey: string
  projectName?: string | null
  originPath?: string | null
}

/**
 * 「哪些工程正在跑」需要的两个查询 —— 菜单标 running 和点开旧菜单的
 * 复查（`openTrayProject` 的 `isRunning`）共用同一份映射。
 */
export interface RunningProjectsDeps {
  /** 按项目目录查库记录（`getProjectByPath`，内部已做路径规范化） */
  findRecord: (projectDir: string) => ProjectRecordLike | undefined
  /** 插件报上来的正在运行的工程路径（`projectManager.getInteractiveProjects`） */
  interactiveProjectPaths: () => string[]
}

export interface TrayRecentCandidatesDeps {
  /** Epic 各引擎版本的最近打开名单（`getRecentProjectsFromAllEngines`） */
  listRecent: () => Promise<RecentEntry[]>
  /** 按项目目录查库记录（`getProjectByPath`，内部已做路径规范化） */
  findRecord: (projectDir: string) => ProjectRecordLike | undefined
  fileExists: (path: string) => boolean
}

export type TrayProjectCandidate = Pick<TrayRecentProject, 'projectKey' | 'name' | 'originPath'>

/** 插件报的路径可能是项目目录，也可能直接是 `.uproject` 文件 —— 统一成目录再比 */
function projectDirOf(reportedPath: string): string {
  return extname(reportedPath).toLowerCase() === '.uproject' ? dirname(reportedPath) : reportedPath
}

/**
 * 此刻引擎连着的那些 projectKey。
 *
 * 「running 认的是 projectKey、插件报的是路径」这层翻译有两个消费者：
 * 菜单标「运行中」是一份，`openTrayProject` 点开**旧菜单**时的复查是另一份。
 * 两边走同一个函数 —— 各写一遍的话，菜单灰掉的和放行点开的迟早判岔。
 */
export function runningProjectKeys(deps: RunningProjectsDeps): Set<string> {
  const runningKeys = new Set<string>()
  for (const reported of deps.interactiveProjectPaths()) {
    const record = deps.findRecord(projectDirOf(reported))
    if (record) runningKeys.add(record.projectKey)
  }
  return runningKeys
}

/**
 * 「名单里该有谁」：不含 running/launching —— 那层是点开菜单那一刻的瞬时状态，
 * 由 `withProjectState` 在缓存之外现叠上去。
 */
export async function getTrayRecentCandidates(
  deps: TrayRecentCandidatesDeps
): Promise<TrayProjectCandidate[]> {
  /*
   * 同一个工程可能被多个引擎版本各记了一条（5.3 开过、5.5 也开过）——
   * 按 projectKey 去重，留 `lastOpenTime` 最新的那条。
   */
  const picked = new Map<string, TrayProjectCandidate & { lastOpenTime: string }>()

  for (const entry of await deps.listRecent()) {
    if (!entry.isImported) continue

    const record = deps.findRecord(projectDirOf(entry.projectPath))
    if (!record?.originPath) continue
    // 库里的 .uproject 已经不在盘上：菜单里列出来点了必败，不列
    if (!deps.fileExists(record.originPath)) continue

    const existing = picked.get(record.projectKey)
    if (
      existing &&
      new Date(existing.lastOpenTime).getTime() >= new Date(entry.lastOpenTime).getTime()
    ) {
      continue
    }

    // 「运行中 / 启动中」不归这里管：那是瞬时状态，
    // 由 withProjectState 在缓存之外每次建菜单现叠
    picked.set(record.projectKey, {
      projectKey: record.projectKey,
      name: record.projectName || entry.projectName,
      originPath: record.originPath,
      lastOpenTime: entry.lastOpenTime
    })
  }

  return [...picked.values()]
    .sort((a, b) => new Date(b.lastOpenTime).getTime() - new Date(a.lastOpenTime).getTime())
    .slice(0, TRAY_RECENT_LIMIT)
    .map((item) => ({
      projectKey: item.projectKey,
      name: item.name,
      originPath: item.originPath
    }))
}
