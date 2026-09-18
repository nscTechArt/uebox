/**
 * 这一条命令发给哪个 UE 工程。
 *
 * ## 三级顺序，一级都不能跳
 *
 *   1. 显式 `--project`
 *   2. 从当前目录逐层往上找最近的 `.uproject`
 *   3. 都没有时，**只有恰好一个**已注册的交互式工程才自动采用
 *
 * ## 为什么第 1、2 级定出来的工程没在线时不许回退
 *
 * 用户说了「这个工程」，那就是这个工程。旁边另一个工程在线不是改发给它的
 * 理由 —— 那一幕的表现是：命令返回成功，用户回到编辑器发现什么都没变，
 * 而他另一个项目的关卡被动了。报一个错的代价远小于这个。
 *
 * 第 3 级的自动采用之所以安全，是因为「恰好一个」意味着没有别的选项，
 * 猜不错。有两个就一律报歧义。
 */

import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, parse, resolve } from 'node:path'

import { UeboxError } from './errors.js'

/** 已注册且在线的工程，来自 `ue_session_health` 的公共结果 */
export interface RegisteredProject {
  connectionId: string
  name: string
  path: string
}

export interface ResolvedProject {
  name: string
  path: string
  /** 定下来的依据，`doctor` 要说清楚是怎么定的 */
  source: 'explicit' | 'cwd' | 'single'
}

/** 路径归一：斜杠方向、结尾斜杠、平台大小写。规则与服务端 `externalTarget.ts` 一致 */
export function normalize(value: string): string {
  const unified = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/**
 * 把用户给的路径规整成工程根目录。
 *
 * 接受 `.uproject` 文件，也接受它所在的目录 —— 用户手上有哪个就给哪个，
 * 让他先想清楚该给哪种是没必要的负担。
 */
export async function canonicalizeProjectPath(input: string): Promise<string> {
  const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input)

  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(absolute)
  } catch {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      `--project 指向的路径不存在：${absolute}`,
      '给 .uproject 文件或它所在的目录都可以。'
    )
  }

  if (stats.isFile()) {
    if (!/\.uproject$/i.test(absolute)) {
      throw new UeboxError('INVALID_ARGUMENT', `--project 指向的不是 .uproject 文件：${absolute}`)
    }
    return dirname(absolute).replace(/\\/g, '/')
  }

  const found = await uprojectsIn(absolute)
  if (found.length === 0) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      `这个目录里没有 .uproject 文件：${absolute}`,
      '确认路径指向 UE 工程的根目录。'
    )
  }
  if (found.length > 1) {
    throw new UeboxError(
      'PROJECT_AMBIGUOUS',
      `目录里有 ${found.length} 个 .uproject 文件：${absolute}`,
      `用 --project 直接指到具体那个文件，例如 --project "${absolute}/${found[0]}"。`
    )
  }
  return absolute.replace(/\\/g, '/')
}

async function uprojectsIn(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && /\.uproject$/i.test(e.name)).map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * 从一个目录逐层往上找最近的 `.uproject`。
 *
 * 找到根目录还没有就返回 undefined —— 那不是错误，只是「这次没有本地线索」，
 * 会落到第 3 级。
 */
export async function findProjectUpwards(from: string): Promise<string | undefined> {
  let current = resolve(from)
  const root = parse(current).root

  for (;;) {
    const found = await uprojectsIn(current)
    if (found.length > 1) {
      throw new UeboxError(
        'PROJECT_AMBIGUOUS',
        `当前目录往上找到的这一层有 ${found.length} 个 .uproject：${current}`,
        '用 --project 指定要操作哪一个。'
      )
    }
    if (found.length === 1) return current.replace(/\\/g, '/')

    if (current === root) return undefined
    const parent = dirname(current)
    // 保险：`dirname` 在极少数畸形路径上可能不动，避免死循环
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * 定下这一次的目标工程。
 *
 * @param explicit `--project` 的值
 * @param registered 盒子当前注册着的交互式工程
 * @param cwd 从哪个目录开始往上找
 */
export async function resolveProject(
  explicit: string | undefined,
  registered: RegisteredProject[],
  cwd: string = process.cwd()
): Promise<ResolvedProject> {
  if (explicit) {
    const path = await canonicalizeProjectPath(explicit)
    return { ...matchRegistered(path, registered, 'explicit'), source: 'explicit' }
  }

  const nearby = await findProjectUpwards(cwd)
  if (nearby) {
    return { ...matchRegistered(nearby, registered, 'cwd'), source: 'cwd' }
  }

  if (registered.length === 1) {
    return { name: registered[0].name, path: registered[0].path, source: 'single' }
  }

  if (registered.length === 0) {
    throw new UeboxError(
      'PROJECT_NOT_CONNECTED',
      '没有已连接的虚幻引擎工程。',
      '打开一个装了 UnrealAgentLink 插件的 UE 工程；或者在工程目录里运行本命令。'
    )
  }

  throw new UeboxError(
    'PROJECT_AMBIGUOUS',
    `有 ${registered.length} 个已连接的 UE 工程，无法确定目标。`,
    '运行 uebox projects list，再通过 --project 指定工程路径。'
  )
}

/**
 * 拿定下来的路径去对已注册的工程。
 *
 * 对不上就报「这个工程没连」，**绝不改发给别的工程** —— 见文件头。
 */
function matchRegistered(
  path: string,
  registered: RegisteredProject[],
  source: 'explicit' | 'cwd'
): { name: string; path: string } {
  const wanted = normalize(path)
  const hits = registered.filter((project) => normalize(project.path) === wanted)

  if (hits.length === 1) return { name: hits[0].name, path: hits[0].path }

  if (hits.length > 1) {
    throw new UeboxError(
      'PROJECT_AMBIGUOUS',
      `工程 ${path} 匹配到 ${hits.length} 条连接，无法确定目标。`,
      '关掉重复打开的编辑器实例后重试。'
    )
  }

  const how = source === 'explicit' ? '--project 指定的' : '从当前目录找到的'
  const others = registered.length
    ? `当前在线的是：${registered.map((p) => p.path).join('、')}。`
    : '当前没有任何工程连着。'

  throw new UeboxError(
    'PROJECT_NOT_CONNECTED',
    `${how}工程没有连接到虚幻盒子：${path}`,
    `${others}命令不会改发给别的工程 —— 请打开这个工程的编辑器，或用 --project 换一个。`
  )
}
