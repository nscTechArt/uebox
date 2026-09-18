/**
 * 改用户级 PATH（`HKCU\Environment`）。
 *
 * ## 这是这个仓库里少数「改坏了很难恢复」的操作，所以规矩写在最前面
 *
 * 1. **只碰 HKCU，永远不碰 HKLM。** 安装包是 per-user 的
 *    （`electron-builder.yml` 里 `perMachine: false`、`asInvoker`），
 *    本来也没有管理员权限。系统级 PATH 一旦写坏，影响的是整台机器上所有用户。
 * 2. **必须按 `REG_EXPAND_SZ` 原样读写。** 这是最容易毁掉别人 PATH 的一步：
 *    `[Environment]::GetEnvironmentVariable('Path','User')` 返回的是**展开后**的
 *    字符串，把它写回去，用户原来写的 `%USERPROFILE%\bin` 就被烧死成了当时的
 *    绝对路径 —— 换个机器、改个用户名就全断，而且他根本不知道是谁干的。
 *    所以这里走 `Microsoft.Win32.Registry` 并显式要求 `DoNotExpandEnvironmentNames`，
 *    写回时也保持原来的 value kind。
 * 3. **读不到就不写。** 任何一步失败都直接放弃，绝不用一个残缺的值覆盖。
 * 4. **发 WM_SETTINGCHANGE。** 绕过 `[Environment]` 之后广播不会自动发，
 *    不补这一下，用户得注销重登才能在新终端里看到效果。
 *
 * ## 为什么用 PowerShell 而不是 reg.exe
 *
 * `reg add` 不广播 WM_SETTINGCHANGE，而且要自己拼转义，分号和引号很容易出错。
 * PowerShell 能直接用 .NET 的注册表 API，上面第 2、4 条都能表达清楚。
 *
 * **脚本必须是纯 ASCII**：PowerShell 5.1 按系统代码页读脚本，中文注释和
 * here-string 会让它直接语法报错（仓库里已经踩过）。所以下面的脚本一个中文都没有，
 * 解释全留在这份 TS 注释里。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** PowerShell 调用的上限。注册表读写是毫秒级，超过这个多半是卡住了 */
const TIMEOUT_MS = 15_000

/**
 * PATH 里的一段是不是指向同一个目录。
 *
 * Windows 不区分大小写，结尾反斜杠可有可无，还可能带引号。
 * 逐字符比较会把 `C:\Box\` 和 `C:\Box` 当成两个 —— 于是「加入」按钮点两次
 * 就真的加了两条。
 */
export function isSameDir(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    value
      .trim()
      .replace(/^"+|"+$/g, '')
      .replace(/[\\/]+$/, '')
      .replace(/\//g, '\\')
      .toLowerCase()
  return normalize(a) === normalize(b) && normalize(a) !== ''
}

/** PATH 字符串拆成段。空段丢掉 —— 它们只会变成「当前目录」，是个安全隐患 */
export function splitPath(raw: string): string[] {
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * 把目录加进 PATH 字符串。已经在里面就原样返回。
 *
 * 追加在末尾而不是开头：抢在用户自己的条目前面，等于让盒子的目录去影响
 * 他所有命令的解析顺序 —— 那不是一个「加个命令行工具」该有的副作用。
 */
export function withDir(raw: string, dir: string): { value: string; changed: boolean } {
  const entries = splitPath(raw)
  if (entries.some((entry) => isSameDir(entry, dir))) return { value: raw, changed: false }
  return { value: [...entries, dir].join(';'), changed: true }
}

/** 把目录从 PATH 字符串里摘掉。只摘指向同一个目录的那些，别的一律不动 */
export function withoutDir(raw: string, dir: string): { value: string; changed: boolean } {
  const entries = splitPath(raw)
  const kept = entries.filter((entry) => !isSameDir(entry, dir))
  if (kept.length === entries.length) return { value: raw, changed: false }
  return { value: kept.join(';'), changed: true }
}

/** 目录在不在用户 PATH 里 */
export function containsDir(raw: string, dir: string): boolean {
  return splitPath(raw).some((entry) => isSameDir(entry, dir))
}

// ── 注册表读写 ──────────────────────────────────────────────────────────────

/**
 * 读用户级 PATH 的**原始值**（不展开 `%VAR%`）。
 *
 * @returns 原始字符串；没有这个值时是空串
 */
export async function readUserPath(): Promise<string> {
  const script = [
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
    "if ($null -eq $key) { Write-Output ''; exit 0 }",
    "$value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    '$key.Close()',
    '[Console]::Out.Write($value)'
  ].join('; ')

  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeout: TIMEOUT_MS,
      windowsHide: true
    }
  )
  return stdout
}

/**
 * 写回用户级 PATH，保持原来的 value kind，并广播变更。
 *
 * 没有这个值时按 `REG_EXPAND_SZ` 新建 —— 那是 Windows 自己给 PATH 用的类型。
 */
export async function writeUserPath(value: string): Promise<void> {
  // 值通过环境变量传进去，不拼进脚本 —— PATH 里有分号、引号、括号，
  // 拼字符串迟早会撞上一个能改变脚本语义的字符
  const script = [
    '$value = $env:UEBOX_NEW_PATH',
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
    '$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString',
    "try { $kind = $key.GetValueKind('Path') } catch { }",
    "$key.SetValue('Path', $value, $kind)",
    '$key.Close()',
    // 不广播的话，新开的终端也读不到 —— 用户得注销重登
    'Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition \'[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\'',
    '$out = [UIntPtr]::Zero',
    "[void][Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$out)"
  ].join('; ')

  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, UEBOX_NEW_PATH: value }
  })
}
