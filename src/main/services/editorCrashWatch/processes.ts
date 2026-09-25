/**
 * 崩溃看门人要看的两类进程：编辑器本体，和它身边那个崩溃报告程序。
 *
 * ## 崩溃报告程序是怎么回事
 *
 * UE5 的编辑器一启动就在旁边拉起一个 `CrashReportClientEditor.exe -MONITOR=<编辑器 pid>`
 * （`WindowsPlatformCrashContext.cpp` 的 `LaunchCrashReportClient`，5.0–5.8 一致），
 * 平时静悄悄地在后台待着。编辑器崩了，由它写 minidump、回话让编辑器退出，
 * **然后它自己留下来弹那个「An Unreal process has crashed」的窗口**，等人点。
 *
 * 所以「它监视的那个 pid 已经没了、它还活着」就是那个窗口 —— 关掉它不丢任何东西：
 * 崩溃目录（`Saved/Crashes/<GUID>`）在窗口弹出来之前就写完了，关掉只是不上报给 Epic。
 * 编辑器正常退出时它也跟着走，不会误伤。
 *
 * 只在 Windows 上实现。别的平台返回空表，看门人退化成「只认崩溃目录」。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface UnrealProcessRow {
  pid: number
  name: string
  commandLine: string
  executablePath: string
}

/** `-MONITOR=1234` 里的编辑器 pid。不是崩溃报告程序、或者没带这个参数，返回 null */
export function monitoredPid(row: UnrealProcessRow): number | null {
  if (!/^CrashReportClient/i.test(row.name)) return null
  const match = /-MONITOR=(\d+)/i.exec(row.commandLine)
  const pid = match ? Number(match[1]) : NaN
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** PowerShell 单个结果时给的是对象不是数组，字段也可能是 null */
export function parseProcessRows(stdout: string): UnrealProcessRow[] {
  const text = stdout.trim()
  if (!text || text === 'null') return []
  const parsed: unknown = JSON.parse(text)
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const rows: UnrealProcessRow[] = []
  for (const item of list) {
    const raw = item as Record<string, unknown>
    const pid = Number(raw.ProcessId)
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    rows.push({
      pid,
      name: String(raw.Name ?? ''),
      commandLine: String(raw.CommandLine ?? ''),
      executablePath: String(raw.ExecutablePath ?? '')
    })
  }
  return rows
}

/** 编辑器和崩溃报告程序（各版本、Development/Debug 变体都在 LIKE 里） */
export async function listUnrealProcesses(): Promise<UnrealProcessRow[]> {
  if (process.platform !== 'win32') return []
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    `Get-CimInstance Win32_Process -Filter "Name LIKE 'UnrealEditor%' OR Name LIKE 'CrashReportClient%'"` +
    '|Select-Object ProcessId,Name,CommandLine,ExecutablePath|ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
  )
  return parseProcessRows(stdout)
}

/** Windows 上 `process.kill` 就是 TerminateProcess。进程已经没了算成功 */
export function killProcess(pid: number): boolean {
  try {
    process.kill(pid)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
