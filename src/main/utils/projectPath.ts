/**
 * 项目路径的规范化。
 *
 * 单独一个文件是为了能脱离 electron 测试 —— `appSettingsManager` 会拉起
 * `app.getPath()`，在 vitest 里跑不起来，而这段逻辑恰恰是最需要测的：
 * 用户在 `D:\Games\My.uproject` 上点了「移除 UnrealAgentLink」，下次盒子
 * 拿到的可能是 `d:/games/my.uproject`，比不上就等于黑名单没生效，插件又被
 * 装回去，正好复现要修的那个投诉。
 */

import * as path from 'path'
import { realpathSync } from 'node:fs'

/**
 * 把项目路径规范成可比较的形式。
 *
 * Windows 下大小写不敏感、两种分隔符都认，直接拿原始字符串比会漏。
 */
export function normalizeProjectPath(projectPath: string): string {
  return projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Windows 写法的路径（盘符或 UNC），在 POSIX 宿主上也可能从旧记录里读到。 */
function isWindowsShapedPath(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' || /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')
}

/**
 * 只按字符串算的比较键：规则和 `projectComparisonKey` 一致，但不碰文件系统。
 *
 * 用来先筛一遍 —— `realpath` 是同步系统调用，掉线的网络盘要卡到超时才返回，
 * 而主进程正等在那儿。字符串就能判定的，不必付这笔钱。
 * 注意 POSIX 分支**不能**转小写：离线盘上大小写不同就是两个工程。
 */
export function projectComparisonKeyWithoutFs(
  projectPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const value = projectPath.trim()
  if (!value) return ''
  if (isWindowsShapedPath(value, platform)) return normalizeProjectPath(value)
  return path.posix.normalize(value).replace(/\/+$/, '') || '/'
}

/**
 * 比较工程身份时遵循实际文件系统；旧账本的持久化键继续使用上面的历史格式。
 * Windows 路径保持原来的大小写 / 分隔符兼容（包括从 Windows 导入的记录）。
 * POSIX 路径由 realpath 统一符号链接和不区分大小写磁盘上的别名；离线磁盘或
 * 不存在的工程保留大小写，不能猜测后合并掉用户的另一条记录。
 */
export function projectComparisonKey(
  projectPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const value = projectPath.trim()
  if (!value) return ''
  if (isWindowsShapedPath(value, platform)) return normalizeProjectPath(value)
  try {
    return realpathSync.native(value)
  } catch {
    return projectComparisonKeyWithoutFs(value, platform)
  }
}

/**
 * 把项目路径整成本机的书写形式，用于**存进数据库**。
 *
 * 和 `normalizeProjectPath` 分工不同：那个是压扁了给机器比较用的（全小写），
 * 存库要的是人看得懂、打得开的原样路径，只统一分隔符。
 *
 * 为什么需要：同一个工程进库的路子不止一条，各自给的写法也不一样 ——
 * 用户在首页点导入，文件对话框给的是 `I:\UE Project\X`；UE 插件上报的是
 * 虚幻内部写法 `I:/UE Project/X`。两种写法都往库里存，库里就长期躺着
 * 两种斜杠，任何一处忘了规范化就当场变成「同一个工程出现两张卡片」。
 */
export function toNativeProjectPath(projectPath: string): string {
  const trimmed = String(projectPath ?? '').trim()
  return trimmed ? path.normalize(trimmed) : ''
}

/**
 * 工程封面的候选图片，按优先级排列，与 UE 项目浏览器一致：工程根目录下的
 * `<Name>.png` 是在编辑器里显式设置的缩略图，优先于编辑器自动截的
 * `Saved/AutoScreenshot.png`。导入和封面自动同步共用这一份，免得两边漂开。
 */
export function projectThumbnailCandidates(
  projectDir: string,
  uprojectPath?: string | null
): string[] {
  const candidates = uprojectPath
    ? [path.join(projectDir, `${path.parse(uprojectPath).name}.png`)]
    : []
  candidates.push(path.join(projectDir, 'Saved', 'AutoScreenshot.png'))
  return candidates
}
