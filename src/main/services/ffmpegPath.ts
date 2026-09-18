import { execFile } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

/**
 * FFmpeg 解析：**用用户自己安装的那一份**，不再随包分发。
 *
 * 为什么不打进安装包：
 *
 * 1. FFmpeg 是 GPL-3.0。随包分发就要一直背着「附带许可证 + 提供对应源码」
 *    的义务，而本应用是 Apache-2.0。不分发，这条义务就不存在
 * 2. 那份二进制约 80MB，而依赖它的是几个可选功能，不是主线
 *
 * 代价是没装 FFmpeg 的用户用不了录屏导出、音频提取、视频压缩。所以这里
 * **不做「回退到裸 ffmpeg 名字让它 spawn 时才失败」那种假装可用** ——
 * 找不到就返回 null，由调用方给出明确的「请先安装 FFmpeg」，
 * 而不是抛一句用户看不懂的 ENOENT。
 *
 * 视频缩略图已改用 Chromium 自带解码，不再依赖这里。
 */

/** 探测结果缓存。undefined = 还没探测过，null = 探测过且没有 */
let cached: string | null | undefined

const BINARY = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

/**
 * 常见安装位置。
 *
 * 光靠 PATH 不够：Windows 上用 winget / choco 装完，**已经在运行的进程拿不到
 * 新的 PATH**（环境变量变更不广播给已启动的进程），用户装完切回应用仍然显示
 * 「未检测到」，只能重启。直接查这些目录可以省掉那次重启。
 */
function commonInstallPaths(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || ''

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [
      // winget（Gyan.FFmpeg / BtbN 构建都会在这里留 shim）
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links', BINARY),
      path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin', BINARY),
      path.join(home, 'scoop', 'shims', BINARY),
      'C:\\ffmpeg\\bin\\ffmpeg.exe'
    ]
  }

  return [
    // Homebrew 在 Apple Silicon 与 Intel 上路径不同
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/snap/bin/ffmpeg',
    path.join(home, '.local', 'bin', 'ffmpeg')
  ]
}

/** 用户手动指定的路径，优先级最高 */
function configuredPath(): string {
  return String(process.env.UNREAL_BOX_FFMPEG_PATH || '').trim()
}

/** 跑一次 `-version` 确认真能执行 —— 文件存在不等于能跑（架构不符、缺动态库） */
function canExecute(candidate: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(candidate, ['-version'], { timeout: 5000, windowsHide: true }, (error) => {
      resolve(!error)
    })
  })
}

export class FFmpegNotInstalledError extends Error {
  constructor() {
    super(
      '此功能需要 FFmpeg，但系统里没有检测到。安装后无需重启应用即可使用：' +
        'Windows 执行 winget install Gyan.FFmpeg，' +
        'macOS 执行 brew install ffmpeg，' +
        'Linux 用发行版包管理器安装 ffmpeg。'
    )
    this.name = 'FFmpegNotInstalledError'
  }
}

/**
 * 找出可用的 FFmpeg，找不到返回 null。结果会缓存，重复调用不会反复起进程。
 */
export async function findFFmpeg(): Promise<string | null> {
  if (cached !== undefined) return cached

  const candidates = [configuredPath(), BINARY, ...commonInstallPaths()].filter(Boolean)

  for (const candidate of candidates) {
    // 裸命令名要交给 PATH 解析，不能拿 existsSync 判断
    const isBareCommand = candidate === BINARY
    if (!isBareCommand && !existsSync(candidate)) continue
    if (await canExecute(candidate)) {
      cached = candidate
      console.log('[FFmpeg] 已找到:', candidate)
      return cached
    }
  }

  console.warn('[FFmpeg] 未检测到可用的 FFmpeg，相关功能不可用')
  cached = null
  return cached
}

export async function isFFmpegAvailable(): Promise<boolean> {
  return (await findFFmpeg()) !== null
}

/**
 * 取路径，取不到就抛一句用户看得懂的话。
 *
 * 适合「点了才需要」的场景；想提前把按钮置灰请用 isFFmpegAvailable。
 */
export async function requireFFmpeg(): Promise<string> {
  const found = await findFFmpeg()
  if (found) return found
  throw new FFmpegNotInstalledError()
}

/** 用户新装了 FFmpeg 之后重新探测，免得他必须重启应用 */
export function resetFFmpegCache(): void {
  cached = undefined
}

export interface FFmpegStatus {
  available: boolean
  /** 探测到的路径。available 为 false 时是 null */
  path: string | null
  /** 当前平台的安装命令，界面上可以直接给「复制」按钮 */
  installCommand: string
  /** 官方下载页，给不用包管理器的人 */
  downloadUrl: string
}

/**
 * 给界面用的完整状态。
 *
 * 安装命令按平台给具体那一条，而不是笼统的「请安装 FFmpeg」——
 * 用户看到一条能直接粘贴的命令，和看到一句建议，完成率差很远。
 */
export async function getFFmpegStatus(): Promise<FFmpegStatus> {
  const found = await findFFmpeg()

  const installCommand =
    process.platform === 'win32'
      ? 'winget install Gyan.FFmpeg'
      : process.platform === 'darwin'
        ? 'brew install ffmpeg'
        : 'sudo apt install ffmpeg'

  return {
    available: found !== null,
    path: found,
    installCommand,
    downloadUrl: 'https://ffmpeg.org/download.html'
  }
}
