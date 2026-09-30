/**
 * 连接配置：CLI 每次运行都去读盒子自己那份配置，自己不存任何东西。
 *
 * ## 为什么不需要 setup
 *
 * 以前要先跑一次 `uebox setup`，把盒子配置的路径记进 CLI 自己的配置文件。
 * 可那份文件只可能在两个固定位置之一，每次现找也来得及；而装机版的 CLI 是
 * 用盒子自己的 exe 启动的，天生知道自己属于哪个盒子。多一步「关联」只是
 * 多一道第一次用就可能卡住的门（Claude Code 的 App 和 CLI 读同一处配置，
 * 也没有这一步）。
 *
 * ## 为什么不存令牌副本
 *
 * 多一份副本就是**多一个会过期的真相**：用户在盒子里点了「重置令牌」，
 * CLI 还拿着旧的那把，报出来的是「认证失败」，而他刚刚明明什么都没动。
 *
 * CLI 从不修改盒子的配置：不改令牌、不改端口、不动服务开关、不动写权限。
 */

import { promises as fs } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'

import { UeboxError } from './errors.js'

/** 盒子写在 userData 下的那份配置文件名（见主仓库 `capabilities/mcp/hostStore.ts`） */
const HOST_CONFIG_FILE = 'mcp-server.json'

/** CLI 自己的配置目录名 */
const CLI_DIR = 'unreal-box-cli'

/**
 * Electron `app.getPath('appData')` 在各平台的落点。
 *
 * 抄的是 Electron 的规则，不是猜的：Windows 用 `%APPDATA%`，macOS 用
 * `~/Library/Application Support`，Linux 用 `$XDG_CONFIG_HOME` 或 `~/.config`。
 */
export function appDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === 'win32') {
    return env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support')
  }
  return env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

/**
 * 盒子配置的候选位置。
 *
 * 两个候选对应两种安装：
 *   - `unreal-box` —— 开发版。`app.getName()` 取的是 package.json 的 `name`
 *   - `虚幻盒子`   —— 正式安装包。electron-builder 的 `productName`
 *
 * **只查这两个明确候选，不扫用户目录。** 一个「帮你找找」的全盘扫描会读到
 * 用户所有应用的配置文件，而它要找的东西本来就只可能在这两处之一。
 *
 * 两处都没有时让用户用 `--config` / `UEBOX_HOST_CONFIG` 指定，不能挑一个
 * 看着像的就报成功。
 */
export function hostConfigCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = appDataDir(env)
  return [join(base, 'unreal-box', HOST_CONFIG_FILE), join(base, '虚幻盒子', HOST_CONFIG_FILE)]
}

/**
 * 旧版 `uebox setup` 写下的那份文件。
 *
 * 只剩兼容用途：开发版和正式版同时装着的机器上，它记着用户当初选的是哪一个。
 * 没有它不影响任何事，CLI 不再写它。
 */
export function legacyCliConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appDataDir(env), CLI_DIR, 'config.json')
}

/** 从盒子配置里读出来的、这次连接要用的东西 */
export interface HostConnection {
  url: string
  token: string
  /** 配置从哪儿来的，`doctor` 要报给用户看。env 来源不打印路径 */
  source: string
}

// ── 盒子配置 ────────────────────────────────────────────────────────────────

interface HostSettings {
  port: number
  token: string
}

/**
 * 读一份盒子配置。
 *
 * 坏了就明确报错 —— **不自行重建盒子的配置**。那个文件是盒子的，CLI 越权去
 * 写它，最坏的情况是把用户正在用的令牌换掉，而他不知道是谁干的。
 */
export async function readHostConfig(path: string): Promise<HostConnection> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    throw describeReadFailure(error, path)
  }

  let parsed: unknown
  try {
    // 带 BOM 的 JSON 用 JSON.parse 会直接抛，先摘掉
    parsed = JSON.parse(stripBom(text))
  } catch (error) {
    throw new UeboxError(
      'CONFIG_INVALID',
      `盒子配置不是合法 JSON：${path}（${(error as Error).message}）`,
      // 「重开一次服务」在服务默认开着之后就不再是个动作了。改设置才一定触发重写
      '去虚幻盒子的「MCP」设置页动一下设置（比如重置令牌），盒子会重写这个文件。'
    )
  }

  // 旧版 setup 写的 CLI 配置只记着一个路径。有人把 --config 指到它上面时，顺着找过去
  const legacy = (parsed as { hostConfigPath?: unknown } | null)?.hostConfigPath
  if (typeof legacy === 'string' && legacy) return readHostConfig(legacy)

  const settings = parsed as Partial<HostSettings> | null
  const port = Number(settings?.port)
  const token = typeof settings?.token === 'string' ? settings.token.trim() : ''

  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new UeboxError('CONFIG_INVALID', `盒子配置里的端口无效：${path}`)
  }
  if (!token) {
    throw new UeboxError(
      'CONFIG_INVALID',
      `盒子配置里没有访问令牌：${path}`,
      '在虚幻盒子的 MCP 设置里开一次对外服务，令牌会在那时生成。'
    )
  }

  // 地址由端口拼出来，和盒子那侧 `hostUrl()` 保持一致（只绑回环）
  return { url: `http://127.0.0.1:${port}/`, token, source: path }
}

/**
 * 环境变量入口，给自动化用。
 *
 * 三条约束，每一条都是为了不让凭据流到不该去的地方：
 *   - **必须成对**。从一个来源取地址、另一个来源取令牌，等于把令牌发给一个
 *     没人核对过的地址。
 *   - **只认回环**。这个服务本来就只监听 127.0.0.1，出现别的地址只可能是配错
 *     或者被人改过。
 *   - 只在进程内用，不落盘。
 */
export function connectionFromEnv(
  env: NodeJS.ProcessEnv = process.env
): HostConnection | undefined {
  const url = env.UEBOX_URL?.trim()
  const token = env.UEBOX_TOKEN?.trim()

  if (!url && !token) return undefined
  if (!url || !token) {
    throw new UeboxError(
      'CONFIG_INVALID',
      'UEBOX_URL 和 UEBOX_TOKEN 必须同时提供。',
      '只设置其中一个是配置错误，不会退回去读配置文件。'
    )
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UeboxError('CONFIG_INVALID', `UEBOX_URL 不是合法的 URL：${url}`)
  }

  if (!isLoopbackHost(parsed.hostname)) {
    throw new UeboxError(
      'CONFIG_INVALID',
      `UEBOX_URL 只能指向本机回环地址，收到 ${parsed.hostname}。`,
      '虚幻盒子的对外服务只监听 127.0.0.1，往别的地址发令牌没有正当用途。'
    )
  }

  return { url: parsed.toString(), token, source: 'UEBOX_URL / UEBOX_TOKEN' }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * 摘掉 UTF-8 BOM。
 *
 * Windows 上用记事本、`Set-Content`、`Out-File` 存出来的 JSON 默认带 BOM，
 * 而 `JSON.parse` 见到它直接抛「Unexpected token」—— 用户看着一个肉眼完全正常
 * 的文件被说成语法错误，无从下手。
 *
 * 用 `charCodeAt` 而不是把 BOM 字符直接写进正则：源码里的裸 BOM 是不可见的，
 * 编辑器一保存、git 一转换就可能悄悄没了，而那时候这个函数会静默失效。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 读配置文件失败时，把「不存在」和「读不了」分开。
 *
 * ## 为什么这件事值得单开一个错误码
 *
 * 一个外部 Agent（Codex）在真机上试用时，它的沙箱不允许读 `%APPDATA%` 下的
 * 盒子配置。当时这里一律报 `CONFIG_MISSING` +「先去配置」——
 * 于是它照着提示反复怀疑「盒子没装/没启动」，绕了一大圈才自己 stat 出来
 * 文件其实在、只是没权限。
 *
 * 「文件不在」和「我不许看」需要完全不同的下一步：前者去装、去指定路径，
 * 后者去解决权限。把后者说成前者，就是在报一件我们没确认的事 ——
 * 和这套 CLI 别处坚持的「说不准就别说」是同一条规矩。
 *
 * 退出码两者都是 3：对只看退出码的脚本来说都是「配置这一环没搞定」。
 */
function describeReadFailure(error: unknown, path: string): UeboxError {
  const code = (error as NodeJS.ErrnoException)?.code

  if (code === 'ENOENT') {
    return new UeboxError(
      'CONFIG_MISSING',
      `读不到盒子配置：${path}`,
      '确认虚幻盒子已安装并至少启动过一次；装在别处就用 --config <路径> 或 UEBOX_HOST_CONFIG 指定。'
    )
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return new UeboxError(
      'CONFIG_UNREADABLE',
      `没有读取权限，打不开配置文件：${path}`,
      '文件是在的，缺的是权限 —— 不用重装盒子。' +
        '在沙箱或受限环境里跑时，把这个路径加进可读范围；或者改用 UEBOX_URL / UEBOX_TOKEN 环境变量。'
    )
  }

  if (code === 'EISDIR') {
    return new UeboxError(
      'CONFIG_UNREADABLE',
      `这是一个目录，不是配置文件：${path}`,
      '指到具体的 .json 文件上。'
    )
  }

  // 认不出来的错误保留系统原文，不猜。猜错会把人支到另一个方向去
  return new UeboxError(
    'CONFIG_UNREADABLE',
    `打不开配置文件：${path}（${(error as Error)?.message ?? String(error)}）`
  )
}

// ── 这次用哪份配置 ──────────────────────────────────────────────────────────

/**
 * 这次运行用哪个连接。
 *
 * 顺序：
 *   1. `UEBOX_URL` / `UEBOX_TOKEN` —— 自动化在不碰任何文件的前提下跑起来
 *   2. `--config` / `UEBOX_HOST_CONFIG` —— 盒子装在非常规位置
 *   3. 旧版 setup 留下的记录 —— 两个盒子都装着的机器上，它记着当初选的哪个
 *   4. 在两个固定位置里找（见 `discoverHostConfig`）
 */
export async function resolveConnection(options: {
  configPath?: string
  env?: NodeJS.ProcessEnv
  /** 是不是随盒子安装包发的那一份。默认看是不是跑在盒子自带的 Electron 里 */
  bundled?: boolean
}): Promise<HostConnection> {
  const env = options.env ?? process.env

  const fromEnv = connectionFromEnv(env)
  if (fromEnv) return fromEnv

  const explicit = options.configPath ?? env.UEBOX_HOST_CONFIG?.trim()
  if (explicit) return readHostConfig(resolve(explicit))

  const remembered = await legacyTarget(legacyCliConfigPath(env))
  if (remembered) return readHostConfig(remembered)

  return readHostConfig(
    await discoverHostConfig(env, options.bundled ?? Boolean(process.versions.electron))
  )
}

/**
 * 在两个固定位置里找盒子配置。
 *
 * 恰好一个就用它。两个都在（开发版和正式版同时装着）时**不替用户挑** ——
 * 两个是不同的安装，各有各的令牌和端口，挑错了表现是「连上了但工程对不上」。
 * 唯一的例外是装机版 CLI：它是用正式版的 exe 启动的，属于哪个盒子没有疑问。
 */
export async function discoverHostConfig(
  env: NodeJS.ProcessEnv,
  bundled: boolean
): Promise<string> {
  const [dev, installed] = hostConfigCandidates(env)
  if (bundled && (await isFile(installed))) return installed

  const found: string[] = []
  for (const candidate of [dev, installed]) {
    if (await isFile(candidate)) found.push(candidate)
  }
  if (found.length === 1) return found[0]

  if (found.length === 0) {
    throw new UeboxError(
      'CONFIG_MISSING',
      `在已知位置找不到虚幻盒子的配置。查过这些：\n  ${dev}\n  ${installed}`,
      // 对外服务默认开着，所以「启动过一次」就足以写下这份配置
      '先启动一次虚幻盒子，它会写下这份配置；装在别处就用 --config <路径> 或 UEBOX_HOST_CONFIG 指定。'
    )
  }

  throw new UeboxError(
    'CONFIG_INVALID',
    `找到 ${found.length} 份虚幻盒子配置，无法确定用哪一份：\n  ${found.join('\n  ')}`,
    '用 --config <路径> 或 UEBOX_HOST_CONFIG 明确指定一份。'
  )
}

/**
 * 旧版记录指向的那份盒子配置 —— 只在它还在的时候。
 *
 * 记录坏了、指向的盒子已经卸载了，都当没有这份记录，接着往下找：它只是个
 * 偏好，不该因为它过期就让本来找得到的盒子连不上。
 */
async function legacyTarget(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(stripBom(await fs.readFile(path, 'utf8'))) as {
      hostConfigPath?: unknown
    }
    const target = parsed?.hostConfigPath
    return typeof target === 'string' && (await isFile(target)) ? target : undefined
  } catch {
    return undefined
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}
