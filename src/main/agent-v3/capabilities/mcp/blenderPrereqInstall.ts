/**
 * 用 winget 替用户装 Blender 接入缺的 Git / Python。
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
 * - Python：钉 3.12。官方服务要 3.11+，3.13 上个别依赖还没有现成的 wheel。
 *   python.org 安装器默认**不**加 PATH，所以用 `--override` 显式打开；
 *   就算没加上，`blenderSetupRuntime` 也会去用户目录下的标准位置找。
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

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
    override: '/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1'
  }
}

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
