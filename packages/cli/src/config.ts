/**
 * 两份配置：CLI 自己的，和它引用的那份盒子配置。
 *
 * ## 为什么 CLI 只存一个路径引用
 *
 * CLI 配置里**只有**盒子配置文件的路径，不复制端口，更不复制令牌。每次运行
 * 重新去读那份文件 —— 盒子换端口、重置令牌之后，CLI 不需要跟着改任何东西。
 *
 * 存一份令牌副本的代价不是「多写几行」，是**多一个会过期的真相**：
 * 用户在盒子里点了「重置令牌」，CLI 还拿着旧的那把，报出来的是
 * 「认证失败」，而他刚刚明明什么都没动。
 *
 * 这个引用表示「我信任本机这个固定路径的文件」。CLI 从不修改盒子的配置：
 * 不改令牌、不改端口、不动服务开关、不动写权限。
 */

import { promises as fs } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
 * 两处都没有时 `setup` 必须让用户传 `--host-config`，不能挑一个看着像的
 * 就报成功。
 */
export function hostConfigCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = appDataDir(env)
  return [join(base, 'unreal-box', HOST_CONFIG_FILE), join(base, '虚幻盒子', HOST_CONFIG_FILE)]
}

/** CLI 自己的配置文件路径 */
export function cliConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appDataDir(env), CLI_DIR, 'config.json')
}

export interface CliConfig {
  version: 1
  hostConfigPath: string
  language?: 'zh-CN' | 'en-US'
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
    throw describeReadFailure(error, path, 'host')
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
 * 盒子配置。当时这里一律报 `CONFIG_MISSING` +「先运行 uebox setup」——
 * 于是它照着提示反复怀疑「盒子没装/没启动」，绕了一大圈才自己 stat 出来
 * 文件其实在、只是没权限。
 *
 * 「文件不在」和「我不许看」需要完全不同的下一步：前者去装去 setup，
 * 后者去解决权限。把后者说成前者，就是在报一件我们没确认的事 ——
 * 和这套 CLI 别处坚持的「说不准就别说」是同一条规矩。
 *
 * 退出码两者都是 3：对只看退出码的脚本来说都是「配置这一环没搞定」。
 */
function describeReadFailure(error: unknown, path: string, what: string): UeboxError {
  const code = (error as NodeJS.ErrnoException)?.code

  if (code === 'ENOENT') {
    return new UeboxError(
      'CONFIG_MISSING',
      what === 'cli' ? `还没有配置过：${path}` : `读不到盒子配置：${path}`,
      what === 'cli'
        ? '先运行 uebox setup（会引导你关联虚幻盒子的配置）。'
        : '确认虚幻盒子已安装并至少启动过一次；或用 uebox setup --host-config <路径> 指定。'
    )
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return new UeboxError(
      'CONFIG_UNREADABLE',
      `没有读取权限，打不开配置文件：${path}`,
      '文件是在的，缺的是权限 —— 不用重装盒子，也不用重跑 setup。' +
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

// ── CLI 自己的配置 ──────────────────────────────────────────────────────────

export async function readCliConfig(path: string): Promise<CliConfig> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    throw describeReadFailure(error, path, 'cli')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(text))
  } catch (error) {
    throw new UeboxError(
      'CONFIG_INVALID',
      `CLI 配置不是合法 JSON：${path}（${(error as Error).message}）`,
      '删掉这个文件再运行一次 uebox setup。'
    )
  }

  const config = parsed as Partial<CliConfig> | null
  if (!config?.hostConfigPath || typeof config.hostConfigPath !== 'string') {
    throw new UeboxError(
      'CONFIG_INVALID',
      `CLI 配置里没有 hostConfigPath：${path}`,
      '重新运行 uebox setup。'
    )
  }

  return {
    version: 1,
    hostConfigPath: config.hostConfigPath,
    ...(config.language === 'en-US' || config.language === 'zh-CN'
      ? { language: config.language }
      : {})
  }
}

/**
 * 原子写：先写临时文件再改名。
 *
 * `setup` 只在连接验证成功之后才调它。写到一半断电留下半个 JSON 的话，
 * 用户下一次运行看到的是「配置损坏」，而他上一次明明是好的 —— 那比
 * 「这次没配成，上次的还能用」糟糕得多。
 */
export async function writeCliConfig(path: string, config: CliConfig): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  try {
    await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await fs.rename(temp, path)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw new UeboxError('CONFIG_INVALID', `写入 CLI 配置失败：${(error as Error).message}`)
  }
}

/**
 * 这次运行用哪个连接。
 *
 * 顺序：环境变量 → CLI 配置指向的盒子配置。环境变量优先是为了让自动化能在
 * 不碰用户配置的前提下跑起来。
 */
export async function resolveConnection(options: {
  configPath?: string
  env?: NodeJS.ProcessEnv
}): Promise<HostConnection> {
  const env = options.env ?? process.env

  const fromEnv = connectionFromEnv(env)
  if (fromEnv) return fromEnv

  const path = options.configPath ? resolve(options.configPath) : cliConfigPath(env)
  const cli = await readCliConfig(path)
  return readHostConfig(cli.hostConfigPath)
}
