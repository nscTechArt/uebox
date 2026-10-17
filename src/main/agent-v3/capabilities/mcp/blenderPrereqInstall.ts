/**
 * 替用户装 Blender 接入缺的 Python（以及没有随包源码时的 Git）。
 *
 * ## 为什么盒子自己装，而不是交给 AI
 *
 * 这件事没有任何需要判断的地方：两条固定的 winget 命令。交给模型只会多花钱、
 * 多等，还可能走偏（去网上下安装包、装进 WSL）。而且缺 Git 的机器上 AI 连
 * shell 工具都没有（见 `tools/builtin/localShell.ts` 的 `isShellAvailable`）。
 * AI 只在这里失败之后接手 —— 那时候它拿到的是 winget 的原话，比用户会描述得准。
 *
 * ## 装哪个
 *
 * - Git：`Git.Git`，官方安装器默认把 `git` 放进 PATH。装进 Program Files，
 *   会弹一次管理员确认 —— 那个框只能用户自己点，界面上要先说。
 *   随包带了官方源码时用不上 Git（见 `scripts/fetch-blender-mcp.mjs`），这条只剩开发环境会走。
 * - Python：钉 3.12。官方服务要 3.11+，3.13 上个别依赖还没有现成的 wheel。
 *   python.org 安装器默认**不**加 PATH，所以显式打开；
 *   就算没加上，`blenderSetupRuntime` 也会去用户目录下的标准位置找。
 *
 * ## Python 先走国内镜像
 *
 * winget 不能给单个包换下载源，Python 安装包从 python.org 下。国内直连实测还行，
 * 但网络差的机器上就是整次失败。所以先从 npmmirror 下**同一个**官方安装包，
 * 按锁定的 SHA-256 逐字节核对（和 python.org 上的那份一致，签名是 Python Software
 * Foundation），对不上就扔掉；镜像不通或核对失败再退回 winget。
 * 按用户安装、不装全用户的启动器，所以不弹管理员确认。
 */

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { net } from 'electron'

const execFileAsync = promisify(execFile)

export type InstallablePrerequisite = 'git' | 'python'

interface WingetPackage {
  id: string
  name: string
  /** 替换安装器默认参数。只有需要改默认行为的包才给 */
  override?: string
}

export const WINGET_PACKAGES: Record<InstallablePrerequisite, WingetPackage> = {
  git: { id: 'Git.Git', name: 'Git' },
  python: {
    id: 'Python.Python.3.12',
    name: 'Python 3.12',
    override: '/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 InstallLauncherAllUsers=0'
  }
}

/** python.org 安装器的静默参数：按用户装、加 PATH、带 `py` 启动器，都不需要管理员 */
export const PYTHON_INSTALLER_ARGS = [
  '/quiet',
  'InstallAllUsers=0',
  'PrependPath=1',
  'Include_launcher=1',
  'InstallLauncherAllUsers=0'
]

const PYTHON_VERSION = '3.12.10'

/**
 * 镜像上的官方安装包。SHA-256 是从 python.org 和 npmmirror 各下一份比对过的。
 * 升版本时两边都要重新下来核对，不能只抄镜像的。
 */
export const PYTHON_MIRROR_INSTALLERS: Partial<Record<string, { url: string; sha256: string }>> = {
  x64: {
    url: `https://registry.npmmirror.com/-/binary/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe`,
    sha256: '67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb'
  },
  arm64: {
    url: `https://registry.npmmirror.com/-/binary/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-arm64.exe`,
    sha256: '377ac8fd478987940088e879441e702a71b53164d2a1e6f1d51ff77a7e470258'
  }
}

/** 下载 + 安装的上限。27MB 的安装包，慢网也够了 */
const MIRROR_TIMEOUT_MS = 10 * 60_000

/** 一个包的上限。Git 安装包 60MB 上下，慢网要好几分钟 */
const WINGET_TIMEOUT_MS = 10 * 60_000

/**
 * 这几个退出码对「装上了没有」来说就是成功：
 * 已经装了（`PACKAGE_ALREADY_INSTALLED`），或装了且没有可用升级（`UPDATE_NOT_APPLICABLE`）。
 * 用户在别处已经装好、只是盒子之前没看见 PATH 的情况下会走到这里。
 */
const ALREADY_INSTALLED_CODES = new Set([0x8a150061, 0x8a15002b])

export function wingetArgs(pkg: WingetPackage): string[] {
  return [
    'install',
    '--id',
    pkg.id,
    '--exact',
    '--source',
    'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
    '--silent',
    ...(pkg.override ? ['--override', pkg.override] : [])
  ]
}

/** winget 的退出码是 HRESULT，Node 给的是有符号数。统一成无符号再比 */
export function normalizeExitCode(code: unknown): number | undefined {
  return typeof code === 'number' ? code >>> 0 : undefined
}

export interface WingetOutcome {
  ok: boolean
  /** 失败时给用户看的一句话 */
  message?: string
  /** 失败时原样交给 AI 的东西：退出码 + winget 最后几行输出 */
  detail?: string
}

/**
 * 把一次 `execFile` 的失败翻成人话。
 *
 * 成功的退出码（0 和「已经装了」）在调用方就判掉了，这里只处理失败。
 */
export function describeWingetFailure(pkg: WingetPackage, error: unknown): WingetOutcome {
  const failure = error as {
    code?: unknown
    killed?: boolean
    signal?: string | null
    stdout?: string
    stderr?: string
  }

  if (failure.code === 'ENOENT') {
    return {
      ok: false,
      message: `本机没有 winget（Windows 应用安装程序），无法自动安装 ${pkg.name}。`,
      detail: 'winget not found (ENOENT)'
    }
  }
  if (failure.killed || failure.signal) {
    return {
      ok: false,
      message: `安装 ${pkg.name} 超过 ${WINGET_TIMEOUT_MS / 60_000} 分钟仍未结束，已中止。`,
      detail: `winget install ${pkg.id} timed out`
    }
  }

  const code = normalizeExitCode(failure.code)
  const hex = code === undefined ? String(failure.code) : `0x${code.toString(16).toUpperCase()}`
  // winget 的进度条用 \r 刷同一行，按行切之前先把它们也当换行
  const tail = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    // 进度条和转圈字符那几行对排查没有用
    .filter((line) => line && !/^[-\\|/█▒\s]+$/.test(line) && !/\d+%$/.test(line))
    .slice(-6)
    .join('\n')

  // 不按退出码翻成人话：winget 的错误码表很长，猜错一条比不翻更误导人。
  // 退出码和原话原样交给 AI，它认得
  return {
    ok: false,
    message: `安装 ${pkg.name} 未完成（winget 退出码 ${hex}）。`,
    detail: `winget install ${pkg.id} exited with ${hex}\n${tail}`.trim()
  }
}

export interface MirrorDeps {
  /** 下载一个 URL 的全部字节。默认走 Electron 的 net（认系统代理） */
  download?: (url: string, signal: AbortSignal) => Promise<Buffer>
  /** 运行安装器 */
  run?: (exe: string, args: string[]) => Promise<void>
  arch?: string
}

async function netDownload(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await net.fetch(url, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function runInstallerExe(exe: string, args: string[]): Promise<void> {
  await execFileAsync(exe, args, { timeout: MIRROR_TIMEOUT_MS, windowsHide: true })
}

/**
 * 从国内镜像下 Python 官方安装包、核对、静默安装。
 *
 * 失败不抛：返回原因，调用方据此退回 winget，并把这段原因一起交给 AI。
 */
export async function installPythonFromMirror(deps: MirrorDeps = {}): Promise<WingetOutcome> {
  const pin = PYTHON_MIRROR_INSTALLERS[deps.arch ?? process.arch]
  if (!pin) return { ok: false, detail: `no mirror installer for ${deps.arch ?? process.arch}` }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MIRROR_TIMEOUT_MS)
  const dir = await fs.mkdtemp(join(tmpdir(), 'uebox-python-'))
  try {
    let bytes: Buffer
    try {
      bytes = await (deps.download ?? netDownload)(pin.url, controller.signal)
    } catch (error) {
      return { ok: false, detail: `mirror download failed: ${(error as Error).message}` }
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== pin.sha256) {
      return { ok: false, detail: `mirror installer SHA-256 ${actual}, expected ${pin.sha256}` }
    }

    const exe = join(dir, pin.url.split('/').pop() ?? 'python-installer.exe')
    await fs.writeFile(exe, bytes)
    try {
      await (deps.run ?? runInstallerExe)(exe, PYTHON_INSTALLER_ARGS)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return {
        ok: false,
        detail: `python installer exited with ${String(code ?? (error as Error).message)}`
      }
    }
    return { ok: true }
  } finally {
    clearTimeout(timer)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 装一项前置。Python 先镜像、再 winget；Git 只有 winget。
 *
 * 两条都失败时，两段原因都留着 —— 交给 AI 时它要知道镜像那条也试过了。
 */
export async function installPrerequisite(
  prerequisite: InstallablePrerequisite,
  deps: { mirror?: () => Promise<WingetOutcome>; winget?: typeof runWinget } = {}
): Promise<WingetOutcome> {
  const winget = deps.winget ?? runWinget
  if (prerequisite !== 'python') return winget(prerequisite)

  const mirror = await (deps.mirror ?? installPythonFromMirror)()
  if (mirror.ok) return mirror
  const fallback = await winget('python')
  if (fallback.ok) return fallback
  return { ...fallback, detail: `${mirror.detail ?? ''}\n${fallback.detail ?? ''}`.trim() }
}

/** 跑一个包的 winget 安装。抽成可替换的一项，测试才不会真去装软件 */
export async function runWinget(prerequisite: InstallablePrerequisite): Promise<WingetOutcome> {
  const pkg = WINGET_PACKAGES[prerequisite]
  try {
    await execFileAsync('winget', wingetArgs(pkg), {
      timeout: WINGET_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
    return { ok: true }
  } catch (error) {
    const code = normalizeExitCode((error as { code?: unknown }).code)
    if (code !== undefined && ALREADY_INSTALLED_CODES.has(code)) return { ok: true }
    return describeWingetFailure(pkg, error)
  }
}
