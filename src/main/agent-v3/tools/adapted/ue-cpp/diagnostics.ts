/**
 * 从 UBT 的 stdout 里捞出编译错误。
 *
 * 规则**不是自己发明的**，抄的是 UBT 自己那份：
 * `Engine/Source/Programs/UnrealBuildTool/Matchers/MicrosoftEventMatcher.cs`
 *
 *   s_warningCodePattern = @"(?<severity>(?:error|warning)) (?<code>[a-zA-Z]+[0-9]+)\s*:"
 *   s_fileLinePattern    = @"^\s*(?<file>.*)\((?<line>\d+)(?:, (?<column>\d+))?\)\s*:$"
 *
 * 先定位 `error CXXXX:`，再看它前面那截是文件位置还是工具名 —— 这一手是关键，
 * 因为 Windows 路径里的 `C:` 会让任何「按第一个冒号切」的写法从一开始就错。
 *
 * ## 只做 MSVC 一种
 *
 * UBT 同目录还有 Clang/GCC 和链接器的 matcher。不移植：这条路只在 Windows 上
 * 跑得到（热重载编译走的是 MSVC），而 MSVC 的 `error`/`warning` 行同时覆盖了
 * 编译错误和链接错误（LNK 系列走的是同一个「工具名 : error LNKxxxx:」形状）。
 * 真有人在 mac 上用上了再加，那时候也只是多一个正则。
 */

export interface CppDiagnostic {
  severity: 'error' | 'warning'
  /** MSVC 错误码，如 C2039 / LNK2019 */
  code: string
  message: string
  /** 有文件位置时才有；链接器那种「工具名开头」的没有 */
  file?: string
  line?: number
  column?: number
  /** 没有文件位置时，报错的是哪个工具（LINK、cl 之类） */
  tool?: string
}

/** 一次编译能刷出上千条重复错误。超过这个数就截断，够模型定位第一个问题了 */
const MAX_DIAGNOSTICS = 50

const CODE = /(?<severity>error|warning)\s+(?<code>[a-zA-Z]+[0-9]+)\s*:/
const FILE_LINE = /^\s*(?<file>.*)\((?<line>\d+)(?:,\s*(?<column>\d+))?\)\s*:?\s*$/

/** 解析 UBT/MSVC 的输出。认不出来的行直接忽略 —— 原文由调用方另行保留 */
export function parseDiagnostics(output: string): CppDiagnostic[] {
  const out: CppDiagnostic[] = []

  for (const raw of output.split(/\r?\n/)) {
    const m = CODE.exec(raw)
    if (!m?.groups) continue

    // `LINK : fatal error LNK1104:` —— UBT 的正则只认 `error`，`fatal` 会留在
    // 前缀尾巴上，不摘掉的话工具名会变成 "LINK : fatal"
    const prefix = raw
      .slice(0, m.index)
      .replace(/\s*fatal\s*$/i, '')
      .replace(/\s*:\s*$/, '')
    const message = raw.slice(m.index + m[0].length).trim()

    const diagnostic: CppDiagnostic = {
      severity: m.groups.severity.toLowerCase() === 'error' ? 'error' : 'warning',
      code: m.groups.code,
      message
    }

    const loc = FILE_LINE.exec(prefix)
    if (loc?.groups) {
      diagnostic.file = loc.groups.file.trim()
      diagnostic.line = Number(loc.groups.line)
      if (loc.groups.column) diagnostic.column = Number(loc.groups.column)
    } else if (prefix.trim()) {
      diagnostic.tool = prefix.trim()
    }

    out.push(diagnostic)
    if (out.length >= MAX_DIAGNOSTICS) break
  }

  return out
}

/** 给模型看的一行。文件在前，因为它下一步要去 edit 那个文件 */
export function formatDiagnostic(d: CppDiagnostic): string {
  const where = d.file
    ? `${d.file}:${d.line}${d.column ? `:${d.column}` : ''}`
    : (d.tool ?? '(未知位置)')
  return `${d.severity === 'error' ? '✗' : '⚠'} ${where}  ${d.code}: ${d.message}`
}
