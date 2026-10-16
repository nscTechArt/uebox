/**
 * 让盒子看到「刚装好的程序」：从注册表重新读一遍 PATH，刷进本进程。
 *
 * ## 为什么需要
 *
 * 进程的环境变量是启动那一刻从父进程抄来的，之后谁改了注册表里的 PATH，
 * 已经在跑的进程都看不见。盒子常驻托盘，一开就是几天 —— 用户照着提示装好
 * Git / Python 回来，盒子仍然说「未找到」，只有退出重开才好。用户不会想到
 * 要重启，只会觉得「我装了，它不认」。
 *
 * 刷的是 `process.env.PATH`，所以盒子之后拉起的所有子进程（安装脚本里的
 * `git`、Agent 跑的命令）都跟着看得见。
 *
 * ## 只读，不写
 *
 * 和 `cli/userPath.ts` 不同，这里一个字都不往注册表写。用
 * `[Environment]::GetEnvironmentVariable` 读的是**展开后**的值 —— 那正是一个
 * 新开的进程会拿到的样子，在这里恰好是要的。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { isSameDir, splitPath } from './cli/userPath'

const run = promisify(execFile)

const TIMEOUT_MS = 15_000

/**
 * 新 PATH = 系统级 + 用户级（和新开进程的顺序一致），再把本进程独有的段补在后面。
 *
 * 补回来的那些是启动后有人往 `process.env.PATH` 里加的（或者父进程带进来的），
 * 直接覆盖会把它们弄丢。
 */
export function mergeFreshPath(current: string, machine: string, user: string): string {
  const merged: string[] = []
  for (const entry of [...splitPath(machine), ...splitPath(user), ...splitPath(current)]) {
    if (!merged.some((kept) => isSameDir(kept, entry))) merged.push(entry)
  }
  return merged.join(';')
}

/**
 * 从注册表刷新本进程的 PATH。只在 Windows 上做事；读失败就保持原样。
 *
 * 起一次 PowerShell，几百毫秒 —— 只在用户点了按钮、或进了需要探测的页面时调。
 */
export async function refreshProcessPath(): Promise<void> {
  if (process.platform !== 'win32') return

  // 输出改 UTF-8：用户名是中文的机器上，PATH 里全是中文路径，
  // PowerShell 5.1 默认按 GBK 吐出来，按 UTF-8 解就是一串乱码。
  // 两段之间用换行分隔 —— PATH 里不可能有换行
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$m = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "$u = [Environment]::GetEnvironmentVariable('Path', 'User')",
    '[Console]::Out.Write("$m`n$u")'
  ].join('; ')

  let stdout: string
  try {
    ;({ stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        timeout: TIMEOUT_MS,
        windowsHide: true
      }
    ))
  } catch (error) {
    console.warn('[systemPath] 读取注册表 PATH 失败，保持原样:', error)
    return
  }

  const [machine = '', user = ''] = stdout.split('\n')
  // 两段都读空多半是脚本没跑对，不拿空值覆盖
  if (!machine.trim() && !user.trim()) return
  process.env.PATH = mergeFreshPath(process.env.PATH ?? '', machine, user)
}
