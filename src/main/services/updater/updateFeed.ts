import fs from 'fs'
import path from 'path'

/**
 * 更新源解析。
 *
 * ## 为什么这里不写死任何地址
 *
 * 公开核心是社区版：README 第一句就是「完全离线运行，不依赖官方服务器」。
 * 这里以前写着 `DEFAULT_UPDATE_BASE_URL = 'https://ue5box.com'`，于是**任何**
 * 打出来的包开机就往那个域名发一次请求、之后定时再发 —— 那句「完全离线」
 * 在打包版里不成立。
 *
 * 更糟的是第三方自己编译的社区版：更新源仍然指向官方域名，他们的用户会被
 * 推送官方二进制。
 *
 * 所以规则是：**没配置就没有更新源，没有更新源就一次网络请求都不发**。
 *
 * ## 为什么只剩一个通道
 *
 * 以前分 personal / enterprise 两条渠道，源地址按 `<base>/updates/<channel>` 拼，
 * 出包时要选渠道、写渠道标记文件、同步到对应目录，还有一条「渠道对不上就拒绝
 * 同步」的校验 —— 一整套机制服务的是同一个二进制发两个地方。
 *
 * 现在只有一条线：更新走**公开的 GitHub Releases**，谁编的包都指向同一个 Release，
 * 版本从哪来一眼可查。渠道连同它的构建脚本、发布目录、标记文件一起删掉了。
 *
 *   · `UEBOX_UPDATE_GITHUB_REPO=owner/repo`  → 从该仓库的 GitHub Releases 拉
 *   · `UEBOX_UPDATE_FEED_URL=https://…`      → 自己架静态源的人用这个
 *
 * 两者都能写进 `package.json`（`updateGithubRepo` / `updateFeedUrl`），打包时会被
 * 带进 asar；环境变量优先，方便在本机验证。
 */

export interface ResolveUpdateFeedInput {
  env?: Record<string, string | undefined>
  appMetadata?: Record<string, unknown> | null
}

/** GitHub Releases 源。electron-updater 的 `provider: 'github'` 直接吃这两个字段 */
export interface GithubUpdateFeed {
  provider: 'github'
  owner: string
  repo: string
}

/** 任意 HTTP 静态源。electron-updater 的 `provider: 'generic'` */
export interface GenericUpdateFeed {
  provider: 'generic'
  url: string
}

export type UpdateFeed = GithubUpdateFeed | GenericUpdateFeed

function getString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

function normalizeUrl(value: unknown): string | undefined {
  const normalized = getString(value)
  return normalized ? normalized.replace(/\/+$/, '') : undefined
}

/**
 * 解析 `owner/repo`。
 *
 * 只认这一种写法，不去猜完整的 GitHub URL —— 猜错的代价是往一个陌生域名发请求。
 */
export function parseGithubRepo(value: unknown): GithubUpdateFeed | undefined {
  const raw = getString(value)
  if (!raw) return undefined

  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(raw)
  if (!match) return undefined

  return { provider: 'github', owner: match[1], repo: match[2] }
}

/** 没有配置更新源时返回 null —— 此时整个更新服务不启动，不发任何请求 */
export function resolveUpdateFeed(input: ResolveUpdateFeedInput = {}): UpdateFeed | null {
  // GitHub 优先：发布走公开 Releases，是最省事也最透明的一条
  const github =
    parseGithubRepo(input.env?.UEBOX_UPDATE_GITHUB_REPO) ??
    parseGithubRepo(input.appMetadata?.updateGithubRepo)
  if (github) return github

  const explicitUrl =
    normalizeUrl(input.env?.UEBOX_UPDATE_FEED_URL) ?? normalizeUrl(input.appMetadata?.updateFeedUrl)
  if (explicitUrl) return { provider: 'generic', url: explicitUrl }

  // 一个都没配 —— 这台机器上不存在更新源，更新服务整个不启动
  return null
}

/** 日志里只留来源，不留完整地址 */
export function describeUpdateFeed(feed: UpdateFeed | null): string {
  if (!feed) return '[not configured]'
  if (feed.provider === 'github') return `github:${feed.owner}/${feed.repo}`
  try {
    return `${new URL(feed.url).origin}/...`
  } catch {
    return '[configured]'
  }
}

export function readAppMetadata(appPath: string): Record<string, unknown> | null {
  try {
    const packageJsonPath = path.join(appPath, 'package.json')
    const raw = fs.readFileSync(packageJsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
