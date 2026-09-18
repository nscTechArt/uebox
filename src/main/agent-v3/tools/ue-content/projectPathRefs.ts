/**
 * ue_project_path_refs —— 工程文本里的资产路径引用扫描。
 *
 * 资产注册表只知道资产之间的引用。C++ 里 `ConstructorHelpers::FClassFinder`
 * 写死的 `/Game/...`、ini 里的 `GameDefaultMap=`、DataTable 导入用的 csv、
 * 编辑器 Python 脚本 —— 这些引用注册表看不见，`RenameAssets` 也不会改。
 * 搬完资产之后它们就断了，而且要到打包或运行时才炸出来。
 *
 * ## 为什么是纯 TS，不进插件
 *
 * 给的三条理由：
 *   - 纯文本处理，不需要编辑器开着，不占游戏线程；
 *   - 盒子已经知道目标工程在哪（`getTargetProjectPath()`）；
 *   - 用 vitest 就能测，不用编九个引擎。
 *
 * ## 边界（§3.5）
 *
 * 这是一份**候选清单**：运行时拼出来的路径、蓝图图表里改过的软引用、从数据表读出来的
 * 动态路径都扫不到。响应里的 note 写死这句话，调用方不许把它当完备清单用。
 * 另一头也不装完美：`/Game/Textures/T_Foo.png` 这种文件路径会被当作候选报出来，
 * 宁可多报让人看一眼，也不漏。
 *
 * **不改文件。** 只给出「这次搬迁执行了应该改成什么」的建议文本，改用户源码不是这一批的事。
 *
 * ## 编码
 *
 * 虚幻自己保存的 ini 常常是 UTF-16 LE 带 BOM（`FFileHelper::SaveStringToFile` 遇到非 ASCII
 * 就切过去）。按 utf8 读会得到一串夹着 NUL 的碎字符，正则一个都对不上，扫描静默变成
 * 「没有引用」—— 这比报错更糟。所以先看 BOM，再按 NUL 分布猜没 BOM 的 UTF-16。
 */

import { readFile, stat } from 'fs/promises'
import * as path from 'path'
import { glob } from 'tinyglobby'
import { z } from 'zod'

import { getTargetProjectPath } from '../../core/projectTargetContext'
import { defineTool, type ToolOutcome, type UnrealAgentTool } from '../defineTool'
import { NAMESPACE } from './namingAudit'

/** 同 builtin/localSearch.ts：引擎生成物 + 版本控制 / 包管理目录，内容全是机器生成的 */
const ALWAYS_IGNORE = [
  '**/DerivedDataCache/**',
  '**/Intermediate/**',
  '**/Binaries/**',
  '**/Saved/**',
  '**/.git/**',
  '**/node_modules/**'
]

/** 默认扫描范围，照抄设计 §3.4；相对工程根 */
export const DEFAULT_SCOPE = [
  'Source/**/*.{h,cpp,cs}',
  'Config/**/*.ini',
  'Plugins/*/Source/**/*.{h,cpp,cs}',
  'Plugins/*/Config/**/*.ini',
  'Content/**/*.csv',
  'Script/**/*.py',
  '*.uproject'
]

/** 内容不依赖插件、也不靠工程配置就一定存在的两个挂载根 */
const BUILTIN_MOUNT_ROOTS = ['Game', 'Engine']

const DEFAULT_MAX_FILES = 20_000
const DEFAULT_MAX_HITS = 500
/** 单文件上限，同 localSearch：再大的多半是日志或数据转储 */
const DEFAULT_MAX_FILE_BYTES = 2_000_000
/** 命中行超长时截断，一行压缩过的 JSON 不该占满上下文 */
const MAX_LINE_CHARS = 300
/** 没 BOM 时只看开头这么多字节猜编码 */
const SNIFF_BYTES = 1024

export const CANDIDATE_NOTE =
  '这是一份候选清单，不是完备清单。扫不到的引用仍然存在（运行时拼接的路径、数据表里的软引用等）。'

export interface PathRefTarget {
  /** 归一化后的包路径：无对象后缀、无尾斜杠、无 _C */
  package: string
  /** 目录目标：以它为前缀的包也算命中 */
  isFolder: boolean
  /** 这次搬迁执行后应该变成的包路径 / 目录；没有就只报命中不给建议 */
  replacement?: string
}

export interface PathRefHit {
  /** 相对工程根，正斜杠 */
  file: string
  /** 1 起 */
  line: number
  /** 整行（已 trim，超 300 字符截断） */
  text: string
  /** 原文里的 token，含对象后缀 / 尾斜杠 / _C */
  token: string
  /** token 归一化后的包路径 */
  package: string
  /** 命中的目标包路径 */
  target: string
  /** exact：就是这个资产 / 目录本身；folder：目录目标底下的东西 */
  kind: 'exact' | 'folder'
  /** 目标带 replacement 时，token 应该改成什么 */
  suggested_token?: string
  /** 整行改完之后的样子（同一行所有能改的 token 一起改） */
  suggested_line?: string
}

export interface PathRefScanResult {
  hits: PathRefHit[]
  scanned_files: number
  /** 二进制或超过单文件上限而跳过的 */
  skipped_files: number
  /** 命中数或文件数撞了上限，结果不全 */
  truncated: boolean
  mount_roots: string[]
  note: string
}

export interface PathRefScanOptions {
  /** 覆盖默认扫描范围（glob，相对工程根） */
  scope?: string[]
  maxFiles?: number
  maxHits?: number
  maxFileBytes?: number
  /** 不给就从工程推 */
  mountRoots?: string[]
  signal?: AbortSignal
}

export interface PathRefInput {
  paths?: string[]
  moves?: { source: string; destination: string }[]
  folder_moves?: { source_folder: string; destination_folder: string }[]
}

/**
 * 包路径归一化：去首尾空白、尾斜杠、`.Object` 后缀（第一个点之后全去掉）、尾部 `_C`。
 *
 * `_C` 要去是因为 `ConstructorHelpers::FClassFinder` 内部会自己给包路径补 `_C` 再找类
 * （`ConstructorHelpers.h` 的 `StripObjectClass` + `FindOrLoadClass`），代码里带不带都有人写。
 */
export function normalizePackage(raw: string): string {
  let out = raw.trim()
  const dot = out.indexOf('.')
  if (dot >= 0) out = out.slice(0, dot)
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  if (out.endsWith('_C')) out = out.slice(0, -2)
  return out
}

function basename(pkg: string): string {
  return pkg.slice(pkg.lastIndexOf('/') + 1)
}

/**
 * 把工具入参变成扫描目标。
 *
 * `paths` 里没有注册表就分不清资产和目录，约定：**以 `/` 结尾的当目录，其余当资产**。
 * `moves` 直接吃 `ue_content_move` 的入参：目标以 `/` 结尾表示「保留原名搬进去」。
 */
export function buildTargets(input: PathRefInput): PathRefTarget[] {
  const out: PathRefTarget[] = []
  const seen = new Set<string>()
  const push = (target: PathRefTarget): void => {
    if (!target.package || target.package === '/') return
    const key = `${target.isFolder ? 'd' : 'f'}:${target.package.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(target)
  }

  for (const raw of input.paths ?? []) {
    const trimmed = raw.trim()
    push({ package: normalizePackage(trimmed), isFolder: trimmed.endsWith('/') })
  }
  for (const move of input.moves ?? []) {
    const source = normalizePackage(move.source)
    const dest = move.destination.trim()
    const replacement = dest.endsWith('/')
      ? `${normalizePackage(dest)}/${basename(source)}`
      : normalizePackage(dest)
    push({ package: source, isFolder: false, replacement })
  }
  for (const move of input.folder_moves ?? []) {
    push({
      package: normalizePackage(move.source_folder),
      isFolder: true,
      replacement: normalizePackage(move.destination_folder)
    })
  }
  return out
}

/** 工程根目录：给的是 .uproject 就取所在目录 */
export function resolveProjectDir(project: string): string {
  const trimmed = project.trim()
  return trimmed.toLowerCase().endsWith('.uproject') ? path.dirname(trimmed) : trimmed
}

async function globProject(
  projectDir: string,
  patterns: string[],
  signal?: AbortSignal
): Promise<string[]> {
  const files = await glob(patterns, {
    cwd: projectDir,
    ignore: ALWAYS_IGNORE,
    onlyFiles: true,
    dot: false,
    // 跟随符号链接会在某些工程布局里绕回自身
    followSymbolicLinks: false,
    absolute: false,
    ...(signal ? { signal } : {})
  })
  // 结果顺序不保证；排一下让两次扫描的输出可比
  return files.map((file) => file.replace(/\\/g, '/')).sort()
}

/** `.uproject` 里启用的插件名。解析失败就当没有 —— 挂载根少一个只是少一类候选 */
async function pluginsFromUproject(projectDir: string, uprojects: string[]): Promise<string[]> {
  const names: string[] = []
  for (const file of uprojects) {
    try {
      const parsed = JSON.parse(await readFile(path.join(projectDir, file), 'utf8')) as {
        Plugins?: { Name?: unknown }[]
      }
      for (const plugin of parsed.Plugins ?? []) {
        if (typeof plugin.Name === 'string' && plugin.Name) names.push(plugin.Name)
      }
    } catch {
      // 不是合法 JSON 或读不了：跳过
    }
  }
  return names
}

/**
 * 挂载根：`Game`、`Engine`，加上工程自带插件（`Plugins/**\/*.uplugin` 的文件名）
 * 和 `.uproject` 里启用的插件。插件内容挂在 `/<插件名>/` 下。
 */
export async function deriveMountRoots(projectDir: string): Promise<string[]> {
  const [uplugins, uprojects] = await Promise.all([
    globProject(projectDir, ['Plugins/**/*.uplugin']),
    globProject(projectDir, ['*.uproject'])
  ])
  const fromFiles = uplugins.map((file) => path.basename(file, '.uplugin'))
  const fromProject = await pluginsFromUproject(projectDir, uprojects)

  const out: string[] = []
  const seen = new Set<string>()
  for (const root of [...BUILTIN_MOUNT_ROOTS, ...fromFiles, ...fromProject]) {
    const key = root.toLowerCase()
    if (!root || seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

function swapBytePairs(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length - (buf.length % 2))
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1]
    out[i + 1] = buf[i]
  }
  return out
}

/**
 * 按 BOM / NUL 分布解码。返回 undefined 表示二进制，跳过。
 *
 * 没 BOM 时：UTF-16 LE 的 ASCII 字符高字节是 0，NUL 集中在奇数位；
 * 二进制的 NUL 两边都有。中文 UTF-16 里偶数位偶尔也有 NUL（如「一」U+4E00），
 * 所以看的是比例不是绝对。
 */
export function decodeProjectText(buf: Buffer): string | undefined {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return swapBytePairs(buf.subarray(2)).toString('utf16le')
  }

  const head = buf.subarray(0, SNIFF_BYTES)
  let nulOdd = 0
  let nulEven = 0
  for (let i = 0; i < head.length; i++) {
    if (head[i] !== 0) continue
    if (i % 2 === 1) nulOdd++
    else nulEven++
  }
  const nuls = nulOdd + nulEven
  if (nuls === 0) return buf.toString('utf8')
  if (nuls >= head.length / 16 && nulOdd >= nuls * 0.9) return buf.toString('utf16le')
  return undefined
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 抓 `/<挂载根>/...` 形状的 token。
 *
 * 前面不能紧挨着路径字符：`C:/Projects/Game/Foo` 里的 `/Game/Foo` 是磁盘目录不是包路径，
 * `../Game/` 同理。引号、等号、括号、行首都放行。
 */
function buildTokenRegex(mountRoots: string[]): RegExp {
  const roots = mountRoots.map(escapeRegex).join('|')
  return new RegExp(`(?<![A-Za-z0-9_./-])/(?:${roots})/[A-Za-z0-9_./-]+`, 'gi')
}

interface TokenParts {
  /** 归一化包路径 */
  pkg: string
  hadClassSuffix: boolean
  trailingSlash: string
  /** 从第一个点开始的对象后缀，含点；没有就是空串 */
  objectSuffix: string
}

function splitToken(token: string): TokenParts {
  const dot = token.indexOf('.')
  let base = dot >= 0 ? token.slice(0, dot) : token
  const objectSuffix = dot >= 0 ? token.slice(dot) : ''
  let trailingSlash = ''
  while (base.length > 1 && base.endsWith('/')) {
    base = base.slice(0, -1)
    trailingSlash += '/'
  }
  const hadClassSuffix = base.endsWith('_C')
  return {
    pkg: hadClassSuffix ? base.slice(0, -2) : base,
    hadClassSuffix,
    trailingSlash,
    objectSuffix
  }
}

interface Match {
  target: PathRefTarget
  kind: PathRefHit['kind']
}

function matchTarget(pkg: string, targets: PathRefTarget[]): Match | undefined {
  const lower = pkg.toLowerCase()
  for (const target of targets) {
    const wanted = target.package.toLowerCase()
    if (lower === wanted) return { target, kind: 'exact' }
    if (target.isFolder && lower.startsWith(`${wanted}/`)) return { target, kind: 'folder' }
  }
  return undefined
}

/**
 * 按建议的新包路径重建 token。
 *
 * 资产本身命中（exact）且改了名：对象后缀 `.OldName` 跟着换成 `.NewName`，
 * `_C` 原来有就保留。目录底下的东西（folder）只换前缀，名字不动。
 */
function rebuildToken(parts: TokenParts, match: Match): string | undefined {
  const { target, kind } = match
  if (!target.replacement) return undefined

  const classSuffix = parts.hadClassSuffix ? '_C' : ''
  if (kind === 'folder') {
    const rest = parts.pkg.slice(target.package.length)
    return `${target.replacement}${rest}${classSuffix}${parts.trailingSlash}${parts.objectSuffix}`
  }

  let objectSuffix = parts.objectSuffix
  if (objectSuffix) {
    // `.BP_X_C.Foo` → 第一段是对象名，后面的原样保留
    const segments = objectSuffix.slice(1).split('.')
    const first = segments[0]
    const firstHadClass = first.endsWith('_C')
    segments[0] = `${basename(target.replacement)}${firstHadClass ? '_C' : ''}`
    objectSuffix = `.${segments.join('.')}`
  }
  return `${target.replacement}${classSuffix}${parts.trailingSlash}${objectSuffix}`
}

function clip(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed
}

interface LineMatch {
  index: number
  token: string
  pkg: string
  match: Match
  suggested?: string
}

function scanLine(line: string, regex: RegExp, targets: PathRefTarget[]): LineMatch[] {
  const out: LineMatch[] = []
  regex.lastIndex = 0
  for (let m = regex.exec(line); m; m = regex.exec(line)) {
    let token = m[0]
    // 句尾的点会被吃进来（「见 /Game/Maps.」）
    while (token.endsWith('.')) token = token.slice(0, -1)
    const parts = splitToken(token)
    const match = matchTarget(parts.pkg, targets)
    if (!match) continue
    out.push({
      index: m.index,
      token,
      pkg: parts.pkg,
      match,
      suggested: rebuildToken(parts, match)
    })
  }
  return out
}

/** 同一行所有有建议的 token 一起替换，得到「搬完之后这行该长什么样」 */
function rewriteLine(line: string, matches: LineMatch[]): string | undefined {
  if (!matches.some((m) => m.suggested)) return undefined
  let out = ''
  let cursor = 0
  for (const m of matches) {
    out += line.slice(cursor, m.index) + (m.suggested ?? m.token)
    cursor = m.index + m.token.length
  }
  return out + line.slice(cursor)
}

function hitsInText(
  file: string,
  content: string,
  regex: RegExp,
  targets: PathRefTarget[],
  remaining: number
): PathRefHit[] {
  const hits: PathRefHit[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length && hits.length < remaining; i++) {
    const matches = scanLine(lines[i], regex, targets)
    if (matches.length === 0) continue
    const text = clip(lines[i])
    const rewritten = rewriteLine(lines[i], matches)
    const suggestedLine = rewritten === undefined ? undefined : clip(rewritten)
    const seenTokens = new Set<string>()
    for (const m of matches) {
      if (hits.length >= remaining) break
      if (seenTokens.has(m.token)) continue
      seenTokens.add(m.token)
      hits.push({
        file,
        line: i + 1,
        text,
        token: m.token,
        package: m.pkg,
        target: m.match.target.package,
        kind: m.match.kind,
        ...(m.suggested ? { suggested_token: m.suggested } : {}),
        ...(suggestedLine !== undefined ? { suggested_line: suggestedLine } : {})
      })
    }
  }
  return hits
}

/**
 * 扫工程文本文件，找指向 targets 的路径 token。
 *
 * 读不了的文件（无权限、消失了）当跳过，不中断整次扫描。
 */
export async function scanProjectPathRefs(
  projectDir: string,
  targets: PathRefTarget[],
  options: PathRefScanOptions = {}
): Promise<PathRefScanResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxHits = options.maxHits ?? DEFAULT_MAX_HITS
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const mountRoots = options.mountRoots ?? (await deriveMountRoots(projectDir))
  const regex = buildTokenRegex(mountRoots)

  const result: PathRefScanResult = {
    hits: [],
    scanned_files: 0,
    skipped_files: 0,
    truncated: false,
    mount_roots: mountRoots,
    note: CANDIDATE_NOTE
  }
  if (targets.length === 0) return result

  const files = await globProject(projectDir, options.scope ?? DEFAULT_SCOPE, options.signal)
  if (files.length > maxFiles) result.truncated = true

  for (const file of files.slice(0, maxFiles)) {
    if (options.signal?.aborted) {
      result.truncated = true
      break
    }
    if (result.hits.length >= maxHits) {
      result.truncated = true
      break
    }
    const absolute = path.join(projectDir, file)
    try {
      const info = await stat(absolute)
      if (info.size > maxFileBytes) {
        result.skipped_files++
        continue
      }
      const content = decodeProjectText(await readFile(absolute))
      if (content === undefined) {
        result.skipped_files++
        continue
      }
      result.scanned_files++
      result.hits.push(...hitsInText(file, content, regex, targets, maxHits - result.hits.length))
    } catch {
      result.skipped_files++
    }
  }
  if (result.hits.length >= maxHits) result.truncated = true
  return result
}

/**
 * 摘要里最多列多少条命中。
 *
 * 超出的部分**不能**说「在 details 里」—— details 不进模型上下文
 * （见 summaries.ts 顶部那段），指过去等于让它扑个空。给能执行的下一步。
 */
const SUMMARY_HITS = 20

export function summarizePathRefs(result: PathRefScanResult, projectDir: string): string {
  const skipped =
    result.skipped_files > 0 ? `，跳过 ${result.skipped_files} 个二进制或超大文件` : ''
  const lines: string[] = []
  if (result.hits.length === 0) {
    lines.push(
      `在 ${projectDir} 扫了 ${result.scanned_files} 个文本文件${skipped}，没有发现指向这些路径的文本引用。`
    )
  } else {
    lines.push(
      `在 ${projectDir} 扫了 ${result.scanned_files} 个文本文件${skipped}，命中 ${result.hits.length} 处：`
    )
    for (const hit of result.hits.slice(0, SUMMARY_HITS)) {
      const suggestion = hit.suggested_token ? `  → 建议 ${hit.suggested_token}` : ''
      lines.push(`- ${hit.file}:${hit.line}  ${hit.token}${suggestion}`)
    }
    if (result.hits.length > SUMMARY_HITS) {
      lines.push(
        `（只列了前 ${SUMMARY_HITS} 处，一共 ${result.hits.length} 处。` +
          '要看全的话用 scope 只扫一类文件（scope 是 glob 列表，' +
          '如 ["Config/**/*.ini"] 或 ["Source/**/*.cpp"]），或者把 paths 拆小分几次扫。）'
      )
    }
  }
  if (result.truncated) {
    lines.push('（命中数或文件数已达上限，结果不全；可以用 scope 收窄范围或调大 limit 再扫一次）')
  }
  lines.push(result.note)
  return lines.join('\n')
}

const PathRefsInput = z.object({
  project: z
    .string()
    .optional()
    .describe('工程的 .uproject 绝对路径或工程根目录。不给就用当前绑定的工程'),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      '要查引用的包路径。资产写 /Game/A/BP_X（对象路径 /Game/A/BP_X.BP_X 也行）；' +
        '目录必须以 / 结尾（/Game/Maps/），否则会被当成资产'
    ),
  moves: z
    .array(
      z.object({
        source: z.string().describe('资产当前路径，同 ue_content_move'),
        destination: z.string().describe('目标：以 / 结尾表示保留原名搬进去，否则最后一段是新名字')
      })
    )
    .optional()
    .describe('直接把 ue_content_move 的 moves 传进来，结果会附带建议替换文本'),
  folder_moves: z
    .array(
      z.object({
        source_folder: z.string().describe('要整个搬走的目录，如 /Game/Temp/Props'),
        destination_folder: z.string().describe('搬到哪，如 /Game/Props')
      })
    )
    .optional()
    .describe('直接把 ue_content_move 的 folder_moves 传进来，目录底下的引用都会查'),
  scope: z
    .array(z.string())
    .optional()
    .describe(
      '覆盖默认扫描范围的 glob 列表（相对工程根）。默认：Source、Config、Plugins/*/Source、' +
        'Plugins/*/Config、Content/**/*.csv、Script/**/*.py、*.uproject'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(`最多返回多少条命中，默认 ${DEFAULT_MAX_HITS}`)
})

export interface PathRefToolDetails extends PathRefScanResult {
  project_dir: string
  targets: PathRefTarget[]
}

export const projectPathRefsTool = defineTool<typeof PathRefsInput, PathRefToolDetails>({
  name: 'ue_project_path_refs',
  namespace: NAMESPACE,
  risk: 'safe',
  description: `在工程的文本文件里找写死的资产路径引用 —— 搬迁 / 改名之后会断掉、而资产注册表看不见的那些。

扫 C++（Source/、Plugins/*/Source/）、ini（Config/、Plugins/*/Config/）、Content 下的 csv、
Script 下的 py 和 .uproject，抓 /Game/…、/Engine/…、/<插件名>/… 形状的路径。
典型命中：ConstructorHelpers::FClassFinder(TEXT("/Game/…"))、GameDefaultMap=/Game/…、
PrimaryAssetTypesToScan 的 Directories。带不带 .Name 后缀、带不带 _C 都认。

【什么时候用】ue_content_move 之前（dry_run 会自动跑一次）；或者用户问「改这个名字会不会有代码写死了它」。
不需要引擎连接，不加载资产。

【怎么给】直接把 ue_content_move 的 moves / folder_moves 传进来，每条命中会附带
suggested_token / suggested_line —— 搬完之后这一行该改成什么。只想查、不搬的话给 paths。

【不改文件】只报候选和建议，改用户源码要另外走文件工具、而且要先问过用户。

【这是候选清单，不是完备清单】运行时拼出来的路径、蓝图图表里改过的软引用、
数据表里读出来的动态路径都扫不到。没命中不等于没人引用。`,
  input: PathRefsInput,
  execute: async (args, ctx): Promise<ToolOutcome<PathRefToolDetails>> => {
    const targets = buildTargets(args)
    if (targets.length === 0) {
      return { text: '至少要给 paths、moves、folder_moves 之一', isError: true }
    }

    const project = args.project?.trim() || getTargetProjectPath()
    if (!project) {
      return { text: '没有绑定工程，也没给 project 参数', isError: true }
    }
    const projectDir = resolveProjectDir(project)
    try {
      if (!(await stat(projectDir)).isDirectory()) {
        return { text: `不是目录：${projectDir}`, isError: true }
      }
    } catch {
      return { text: `工程目录不存在：${projectDir}`, isError: true }
    }

    const result = await scanProjectPathRefs(projectDir, targets, {
      scope: args.scope,
      maxHits: args.limit,
      signal: ctx.signal
    })
    if (ctx.signal?.aborted) return { text: '扫描已取消' }

    return {
      text: summarizePathRefs(result, projectDir),
      details: { ...result, project_dir: projectDir, targets }
    }
  }
}) as UnrealAgentTool<PathRefToolDetails>
