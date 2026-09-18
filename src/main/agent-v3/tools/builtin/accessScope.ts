/**
 * 文件访问范围 —— 用户在「设置 → AI 助手」里选的那一档。
 *
 * ## 和 `pathBoundary` 是两回事，别合并
 *
 * `pathBoundary` 是一份**黑名单**：凭据、密钥、浏览器数据，两档都挡，用户
 * 关不掉。它挡的是被注入的提示词。
 *
 * 这个模块是一份**白名单**，而且是用户自己开关的：
 *
 *   - `full`（默认）：这一层完全不参与判断，直接放行，连引擎清单都不去扫。
 *   - `ue-only`：只剩装好的引擎、导入盒子的工程、素材库。用户主动选了才收窄。
 *
 * 两层是「与」的关系 —— 白名单里的位置照样要过黑名单（工程目录里摆一个
 * `.ssh/` 一样碰不到），所以调用方两个都要问，顺序无所谓。
 *
 * ## 拒绝的话必须能自解
 *
 * 收窄档挡住的第一件事很可能是「把 D:/素材 这个文件夹导进来」—— 一件完全
 * 正当的事。所以 `refusal()` 里不只说「不许」，还要说清**现在允许哪些位置**、
 * **怎么放开**，并且告诉模型什么时候该把这句话转达给用户。少了这一段，
 * 用户看到的就是一次没有下文的失败。
 *
 * 默认档改成 `full` 之后这段话更要留着：走到这里的用户是**自己选过**收窄的，
 * 他更需要知道当初那一下选的是什么、现在挡的是哪儿。
 *
 * ## 这一层挡不住 shell（重要）
 *
 * 白名单判的是**路径参数**：`read_local_file` / `list_local_dir` /
 * `write_local_file` / `edit_local_file` / `find_local_files` /
 * `grep_local_files`，加上 `run_shell_command` 的工作目录。
 * 命令**字符串里**写的路径不判 —— 一条命令里可以出现任意多个路径，还能拼、
 * 能编码，在字符串里做白名单只会得到一个到处漏的假边界（同样的道理见
 * `pathBoundary.ts` 头部）。`run_shell_command` 标着 destructive，
 * 兜底的是审批门。
 *
 * 所以这一档的准确说法是「**让 agent 不在盘里乱翻**」，不是「沙箱」。
 */

import { app } from 'electron'
import { join } from 'path'

import { appSettingsManager, type AgentFileAccessScope } from '../../../appSettingsManager'
import { getPublicDatabase } from '../../../sqliteDataBase'
import { getAllProjects } from '../../../sqliteDataBase/models/project'
import UnrealPathManagerUtil from '../../../utils/UnrealPathManager'
import { canonicalDir } from './pathBoundary'

/** 一个允许访问的位置。`label` 是拒绝时说给模型听的，别用内部术语 */
interface AllowedRoot {
  /** 已经过 `canonicalDir` 的路径，结尾带 `/` */
  root: string
  /**
   * 这个位置叫什么。**说给模型听的，不是界面文案** —— 只出现在 `refusal()`
   * 拼给模型的那段话里（见下面那个函数）。所以不走语言包：模型读哪种语言
   * 由它自己的上下文决定，跟用户把界面切成什么语言无关。
   */
  label: string
}

/**
 * 两份清单都缓存 30 秒。这个判定挂在**每一次读文件、列目录**上，
 * 不缓存的话，模型翻二十个目录就要把两份清单各算二十遍。
 *
 * ## 但两份的代价差着几个数量级，所以过期的处理方式也不一样
 *
 * - **引擎清单**贵：`findUnrealEnginePaths()` 读 Epic 的 manifest 目录，
 *   再对每个引擎做几次 `fs.access`。过期了就等 30 秒，不额外重算 ——
 *   会话中途装一个新引擎本来就不是常见事。
 * - **工程清单**便宜：一次本地 sqlite `SELECT`，比它保护的那次磁盘读还快。
 *   所以在**真要拒绝之前**会无条件重查一遍，见 `assertInAccessScope`。
 *
 * 这么分是因为缓存唯一会造成的错误是**误拒**，而误拒里唯一真会发生的
 * 是「刚导入的工程还没进缓存」—— 用户导完工程立刻让 agent 去看一眼，
 * 是最自然不过的下一步。花一次 SELECT 把这种错消掉，很划算。
 */
const CACHE_MS = 30_000

let engineCache: { at: number; roots: string[] } | undefined
let projectCache: { at: number; roots: string[] } | undefined

function fresh<T>(entry: { at: number; roots: T } | undefined): T | undefined {
  return entry && Date.now() - entry.at < CACHE_MS ? entry.roots : undefined
}

async function getEngineRoots(): Promise<string[]> {
  const cached = fresh(engineCache)
  if (cached) return cached

  // 用 scanEngines：`findUnrealEnginePaths()` 把「这趟没读到」吞成空数组，
  // 而空数组在这里的含义是「一个引擎目录都不许碰」。
  const { engines, degraded } = await UnrealPathManagerUtil.scanEngines()
  const roots = engines.map((engine) => engine.rootPath).filter(Boolean)

  // 读失败的结果不进缓存。缓存住的话，一次读不到会让 agent 在接下来 30 秒里
  // 拒绝每一次引擎目录访问，而拒绝理由说的是「不在允许范围内」—— 把用户支到
  // 一个根本没错的设置项上去。不缓存最多是下次再读一遍。
  if (!degraded) engineCache = { at: Date.now(), roots }
  return roots
}

/** 用户导入盒子的工程目录。`force` 用在拒绝前那一次重查上 */
function getProjectRoots(force: boolean): string[] {
  const cached = force ? undefined : fresh(projectCache)
  if (cached) return cached

  const roots = getAllProjects(getPublicDatabase())
    .map((project) => project.projectPath ?? '')
    .filter(Boolean)
  projectCache = { at: Date.now(), roots }
  return roots
}

/**
 * 算出当前允许的位置。
 *
 * 每个来源单独 try —— 数据库还没初始化、引擎扫描失败，都只该让**那一类**
 * 位置缺席，不该让整份白名单塌成空的（空白名单等于什么都不让碰）。
 */
async function collectAllowedRoots(forceProjects = false): Promise<AllowedRoot[]> {
  const allowed: AllowedRoot[] = []

  try {
    for (const root of await getEngineRoots()) {
      allowed.push({ root: canonicalDir(root), label: `引擎目录 ${root}` })
    }
  } catch {
    // 扫不出引擎不代表工程和素材库也不能用
  }

  try {
    for (const root of getProjectRoots(forceProjects)) {
      allowed.push({ root: canonicalDir(root), label: `工程 ${root}` })
    }
  } catch {
    // 同上：数据库没起来时，引擎目录照样该放行
  }

  // 素材库和 skills 目录都在 userData 底下，路径是拼出来的，不会失败。
  // 这两条要和 `pathBoundary` 的 `USER_DATA_EXCEPTION_SUBPATHS` 对齐 ——
  // 那边开了口子而这边不开，等于口子白开
  try {
    const userData = app.getPath('userData')
    allowed.push({
      root: canonicalDir(join(userData, 'database', 'vaults')),
      label: '素材库'
    })
    allowed.push({ root: canonicalDir(join(userData, 'skills')), label: '技能目录' })
  } catch {
    // 测试环境里没有 app
  }

  return allowed
}

/** 把允许的位置说给模型听。全列出来太长（九个引擎 + 一堆工程），列前几个够它明白了 */
const MAX_LISTED_ROOTS = 6

function refusal(target: string, allowed: AllowedRoot[]): string {
  const listed = allowed.slice(0, MAX_LISTED_ROOTS).map((entry) => entry.label)
  const rest = allowed.length - listed.length
  const places =
    allowed.length === 0
      ? '（这台机器上暂时没扫到引擎，也没有导入过工程）'
      : `${listed.join('、')}${rest > 0 ? `，等 ${allowed.length} 个位置` : ''}`

  return (
    `${target} 不在允许访问的范围里。用户把「文件访问范围」设成了「仅虚幻相关」` +
    `，只能碰：${places}。\n` +
    '不要换一种路径写法再试，也不要绕去 run_shell_command —— 换个写法一样会被挡。\n' +
    '要放开有两条路，**都得用户点头**：\n' +
    '1. 如果那是个虚幻工程，让他把工程导入盒子（project_manage 的 import_project），' +
    '导完这个目录就在范围内了；\n' +
    '2. 如果那只是个普通文件夹（素材、参考图、下载目录），请他打开' +
    '「设置 → AI 助手 → 隐私 → 文件访问范围」，改成「整台电脑」。\n' +
    '这不是故障，是用户自己设的。**要不要把上面这段告诉他，你自己判断**：' +
    '他明确要求的就是这个目录 —— 原样转达，别自己在那儿反复试；' +
    '只是你顺手想看一眼 —— 换个在范围内的做法，别拿这件事打扰他。'
  )
}

function currentScope(): AgentFileAccessScope {
  try {
    return appSettingsManager.getAgentFileAccessScope()
  } catch {
    // 设置整个读不出来（不是「没选过」，是抛异常）时仍然按收窄的那一档走。
    // 这是兜底不是默认：窄了用户当场看到一句写明原因的拒绝，自己就能放开；
    // 宽了他什么都看不到。默认档是 `full`，由 appSettingsManager 决定
    return 'ue-only'
  }
}

/**
 * 路径超出用户设定的访问范围时返回说明，允许则返回 undefined。
 *
 * `full` 档直接返回 undefined，**不会**去扫引擎、查数据库 —— 默认档上
 * 这个函数的开销必须是零，否则每读一个文件都要付一次代价。
 */
export async function assertInAccessScope(path: string): Promise<string | undefined> {
  if (currentScope() === 'full') return undefined

  const target = canonicalDir(path)

  // 前缀比对成立的前提是两边同一套归一化，而且结尾都带 `/`——
  // 少了那个斜杠，`…/MyGame` 会匹配上 `…/MyGameBackup`
  const inScope = (roots: AllowedRoot[]): boolean =>
    roots.some((entry) => target.startsWith(entry.root))

  if (inScope(await collectAllowedRoots())) return undefined

  // 要拒绝之前把工程清单重查一遍。缓存唯一会造成的错误就是误拒 ——
  // 刚导入的工程还没进缓存，而「导完就让它去看一眼」正是最自然的下一步。
  // 只重查工程（一次 sqlite SELECT），引擎照旧吃缓存：贵的那份不为
  // 「会话中途装了个新引擎」这种罕见情况买单
  const latest = await collectAllowedRoots(true)
  if (inScope(latest)) return undefined

  return refusal(path, latest)
}

export const __testing = {
  CACHE_MS,
  MAX_LISTED_ROOTS,
  collectAllowedRoots,
  resetCache: (): void => {
    engineCache = undefined
    projectCache = undefined
  }
}
