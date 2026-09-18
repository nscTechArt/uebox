/**
 * 搬迁账本 —— 每次真实执行 `ue_content_move` 之后落一份 JSON，`ue_content_rollback` 凭它反向搬回去。
 *
 * 设计。
 *
 * ## 为什么存 userData 而不是工程的 Saved/（§4.4）
 *
 * 「删掉 Saved/ 再开编辑器」是用户修各种编辑器怪病的常规操作，安全网不能放在一个
 * 大家习惯清空的目录里。`userData/organize-ledger/<工程 key>/` 和 transcriptStore、
 * MCP store、插件注册表是同一套惯例；代价是换机器就没了 —— 「导出账本」这一批不做，
 * JSON 可读，先手工拷。要换到 Saved/ 只改 `ledgerDir()` 一个函数。
 *
 * ## 为什么指纹是字节数 + mtime（§4.3）
 *
 * 跨 5.0–5.8 没有稳定的包 id：`PackageGuid` 4.27 就弃用、5.8 删了换 `PackageSavedHash`，
 * 而 5.0 没有后者。字节数 + 修改时间足够回答「这条资产在搬完之后被人动过没有」，
 * 误判方向是保守的 —— 宁可多报「动过」让用户看一眼，也不把别人的改动搬回去。
 * 指纹由插件在 `moved` 条目上回（`file` / `bytes` / `mtime`），只有落盘（`save=true`）
 * 才有；`save=false` 的账本记 `saved:false`，不可自动回滚。
 *
 * ## 保留期
 *
 * 每个工程最多 200 份、30 天，超了删旧的。裁剪失败只 warn 不抛 —— 账本已经写成了，
 * 不能因为清旧文件出错让搬迁本身报失败。
 *
 * 这个文件不引 `../../services` / logger：那条链会拉起原生模块，账本要能在 vitest 里
 * 只 mock `electron` 就跑起来。
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

import { normalizeProjectPath } from '../../../utils/projectPath'
import type { BatchMoveItem } from './types'

const DIR = 'organize-ledger'
const VERSION = 1
const DEFAULT_MAX_COUNT = 200
const DEFAULT_MAX_AGE_DAYS = 30

export interface LedgerFingerprint {
  /** 搬完落盘后的 .uasset / .umap 绝对路径 */
  file: string
  bytes: number
  /** ISO 8601 */
  mtime: string
}

export interface LedgerEntry {
  from: string
  to: string
  status: 'moved'
  auto_renamed: boolean
  /** `save=false` 或旧版插件没回时缺省 */
  fingerprint?: LedgerFingerprint
}

export interface LedgerIrreversible {
  kind: string
  path: string
  note: string
}

export type LedgerTool = 'ue_content_move' | 'ue_content_rollback'

/**
 * 账本的三种状态。
 *
 * - `pending` —— 已经发给引擎、还没回来。**发之前就写**，这是关键：
 *   引擎在执行途中崩掉时 RPC 只会抛一个异常，原来那条路上一份账本都不会留下，
 *   于是「搬到哪一步了」除了翻磁盘没有第二种查法（真机三次都是这么恢复的）。
 * - `interrupted` —— 发出去了，连接断了或超时了，结果**未知**。
 *   `ue_content_rollback action=verify` 拿 `planned` 逐条查磁盘就能定论。
 * - `done` —— 引擎回了，`entries` 是逐条回读过的结果。
 *
 * 老账本没有这个字段，一律当 `done`。
 */
export type LedgerStatus = 'pending' | 'interrupted' | 'done'

/**
 * 计划要搬的一条。崩了之后靠它去磁盘上对账。
 *
 * `kind` 必须记：整目录搬迁的 from / to 是**目录**不是包，拿查资产那套去查
 * 一律查不到，于是一次成功的目录搬迁会被核对成「两边都没有」—— 比不查还糟。
 * 缺省（老账本）按 `asset` 处理，那时还没有 folder_moves 的账本。
 */
export interface LedgerPlannedEntry {
  from: string
  to: string
  kind?: 'asset' | 'folder'
}

export interface MoveLedger {
  version: 1
  /** `<本地时间戳>-<move|rollback>-<4 位随机>`，按名字排序即按时间排序 */
  id: string
  /** ISO */
  created_at: string
  /** `normalizeProjectPath` 后的工程路径 */
  project: string
  project_key: string
  tool: LedgerTool
  /** on_conflict / save / rollback_of … 只记模型给的那几个开关 */
  args_summary: Record<string, unknown>
  /** false = 这次搬迁 save=false，没有指纹，不能自动回滚 */
  saved: boolean
  entries: LedgerEntry[]
  /** 只有 `delete_broken` 删掉的重定向器、migrate 拷出去的文件这类才进这里 */
  irreversible: LedgerIrreversible[]
  /** saved && entries.length > 0 && irreversible.length === 0 */
  reversible: boolean
  notes: string[]
  /** 老账本没有这个字段，读出来当 'done' */
  status?: LedgerStatus
  /** 发给引擎之前记下的计划。`status !== 'done'` 时它是唯一的线索 */
  planned?: LedgerPlannedEntry[]
  /** interrupted 时记下断在哪：超时？连接断了？第几批？ */
  interrupted_reason?: string
}

/** 老账本没写 status，那是引擎正常回过话的，按 done 算 */
export function ledgerStatus(ledger: MoveLedger): LedgerStatus {
  return ledger.status ?? 'done'
}

/** `listLedgers` 的一行：不把 entries 整份读进上下文 */
export type LedgerSummary = Pick<
  MoveLedger,
  'id' | 'created_at' | 'tool' | 'reversible' | 'saved'
> & {
  /** entries.length */
  count: number
  status: LedgerStatus
  /** planned.length —— pending / interrupted 的账本只有这个数有意义 */
  planned_count: number
}

// ────────────────────────────────────────────────────────────────────────────
// 路径
// ────────────────────────────────────────────────────────────────────────────

/**
 * 工程 → 目录名。
 *
 * 规范化后的路径做文件名安全化再截到 80 字符，尾巴加规范化路径的 sha1 前 8 位：
 * 两个只在第 81 个字符之后才不同的工程，或者只差一个被替换成 `_` 的字符的工程，
 * 不会写进同一个目录。
 */
export function projectKey(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath)
  const safe = normalized.replace(/[^a-z0-9_-]/g, '_').slice(0, 80) || 'project'
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 8)
  return `${safe}-${hash}`
}

export function ledgerRoot(): string {
  return join(app.getPath('userData'), DIR)
}

export function ledgerDir(key: string): string {
  return join(ledgerRoot(), key)
}

/** 只认 `[A-Za-z0-9_-]`：id 会拼进路径，别让 `../` 之类的东西走出账本目录 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 本地时间 `YYYY-MM-DDTHH-mm-ss`：给人看的，冒号换成横杠才能当文件名 */
function localStamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`
  )
}

function newLedgerId(tool: LedgerTool, date: Date): string {
  const kind = tool === 'ue_content_rollback' ? 'rollback' : 'move'
  return `${localStamp(date)}-${kind}-${randomBytes(2).toString('hex')}`
}

// ────────────────────────────────────────────────────────────────────────────
// 写
// ────────────────────────────────────────────────────────────────────────────

export interface RecordMoveLedgerInput {
  projectPath: string
  tool: LedgerTool
  args_summary: Record<string, unknown>
  saved: boolean
  entries: LedgerEntry[]
  irreversible?: LedgerIrreversible[]
  notes?: string[]
  status?: LedgerStatus
  planned?: LedgerPlannedEntry[]
}

/**
 * 落一份账本。先写 `.tmp` 再改名：进程在写到一半时被杀，目录里不会留下半份 JSON
 * 让 `listLedgers` 解析失败。写完顺手裁剪旧账本，裁剪出错不影响返回。
 */
export async function recordMoveLedger(input: RecordMoveLedgerInput): Promise<MoveLedger> {
  const now = new Date()
  const key = projectKey(input.projectPath)
  const irreversible = input.irreversible ?? []
  const ledger: MoveLedger = {
    version: VERSION,
    id: newLedgerId(input.tool, now),
    created_at: now.toISOString(),
    project: normalizeProjectPath(input.projectPath),
    project_key: key,
    tool: input.tool,
    args_summary: input.args_summary,
    saved: input.saved,
    entries: input.entries,
    irreversible,
    // 只有跑完的账本谈得上「能不能回滚」；pending / interrupted 的结果还不知道
    reversible:
      (input.status ?? 'done') === 'done' &&
      input.saved &&
      input.entries.length > 0 &&
      irreversible.length === 0,
    notes: input.notes ?? [],
    status: input.status ?? 'done',
    ...(input.planned ? { planned: input.planned } : {})
  }

  await writeLedgerFile(ledger)

  try {
    await pruneLedgers(ledgerDir(key), {
      maxCount: DEFAULT_MAX_COUNT,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
      now: now.getTime()
    })
  } catch (error) {
    console.warn('[organize-ledger] 裁剪旧账本失败：', error)
  }

  return ledger
}

/** 落盘：先写 `.tmp` 再改名，进程被杀时目录里不会留下半份 JSON */
async function writeLedgerFile(ledger: MoveLedger): Promise<void> {
  const dir = ledgerDir(ledger.project_key)
  await fs.mkdir(dir, { recursive: true })
  const finalPath = join(dir, `${ledger.id}.json`)
  const tmpPath = `${finalPath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(ledger, null, 2), 'utf8')
  await fs.rename(tmpPath, finalPath)
}

/**
 * 把一份 `pending` 账本改写成最终状态。
 *
 * 写账本这件事本身不能让搬迁报失败（原来那条约定不变），所以出错只 warn。
 * 但**改写失败比不写更危险** —— 目录里会永远留着一份 pending，
 * 让人以为有一次搬迁卡住了。所以这里返回成功与否，调用方要在摘要里说出来。
 */
export async function finalizeLedger(
  projectPath: string,
  id: string,
  patch: Partial<
    Pick<
      MoveLedger,
      'status' | 'entries' | 'saved' | 'irreversible' | 'notes' | 'interrupted_reason'
    >
  >
): Promise<MoveLedger | undefined> {
  const existing = await readLedger(projectPath, id)
  if (!existing) return undefined

  const merged: MoveLedger = { ...existing, ...patch }
  merged.reversible =
    (merged.status ?? 'done') === 'done' &&
    merged.saved &&
    merged.entries.length > 0 &&
    merged.irreversible.length === 0

  try {
    await writeLedgerFile(merged)
  } catch (error) {
    console.warn('[organize-ledger] 改写账本失败：', error)
    return undefined
  }
  return merged
}

// ────────────────────────────────────────────────────────────────────────────
// 读
// ────────────────────────────────────────────────────────────────────────────

async function readLedgerFile(path: string): Promise<MoveLedger | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MoveLedger> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== VERSION) return undefined
    if (typeof parsed.id !== 'string' || !Array.isArray(parsed.entries)) return undefined
    return parsed as MoveLedger
  } catch {
    return undefined
  }
}

async function listLedgerFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir)
    return names.filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

/** 这个工程最近的账本，新的在前 */
export async function listLedgers(projectPath: string, limit = 20): Promise<LedgerSummary[]> {
  const dir = ledgerDir(projectKey(projectPath))
  const files = await listLedgerFiles(dir)
  const summaries: LedgerSummary[] = []
  for (const file of files) {
    const ledger = await readLedgerFile(join(dir, file))
    if (!ledger) continue
    summaries.push({
      id: ledger.id,
      created_at: ledger.created_at,
      tool: ledger.tool,
      reversible: ledger.reversible,
      saved: ledger.saved,
      count: ledger.entries.length,
      status: ledgerStatus(ledger),
      planned_count: ledger.planned?.length ?? 0
    })
  }
  summaries.sort((a, b) => {
    const byTime = b.created_at.localeCompare(a.created_at)
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id)
  })
  return summaries.slice(0, Math.max(0, limit))
}

export async function readLedger(projectPath: string, id: string): Promise<MoveLedger | undefined> {
  if (!isSafeId(id)) return undefined
  return readLedgerFile(join(ledgerDir(projectKey(projectPath)), `${id}.json`))
}

// ────────────────────────────────────────────────────────────────────────────
// 裁剪
// ────────────────────────────────────────────────────────────────────────────

export interface PruneOptions {
  maxCount: number
  maxAgeDays: number
  /** 毫秒时间戳；测试注入 */
  now: number
}

/**
 * 按份数和天数裁掉旧账本。时间以账本里的 `created_at` 为准，解析不了的退回文件 mtime。
 * @returns 删掉的文件名
 */
export async function pruneLedgers(dir: string, options: PruneOptions): Promise<string[]> {
  const files = await listLedgerFiles(dir)
  const dated: { file: string; at: number }[] = []
  for (const file of files) {
    const path = join(dir, file)
    const ledger = await readLedgerFile(path)
    let at = ledger ? Date.parse(ledger.created_at) : Number.NaN
    if (!Number.isFinite(at)) {
      try {
        at = (await fs.stat(path)).mtimeMs
      } catch {
        continue
      }
    }
    dated.push({ file, at })
  }
  dated.sort((a, b) => b.at - a.at)

  const cutoff = options.now - options.maxAgeDays * 24 * 60 * 60 * 1000
  const deleted: string[] = []
  for (let i = 0; i < dated.length; i += 1) {
    const { file, at } = dated[i]
    if (i < options.maxCount && at >= cutoff) continue
    try {
      await fs.unlink(join(dir, file))
      deleted.push(file)
    } catch (error) {
      console.warn(`[organize-ledger] 删不掉旧账本 ${file}：`, error)
    }
  }
  return deleted
}

// ────────────────────────────────────────────────────────────────────────────
// 从 batch_move 响应建条目
// ────────────────────────────────────────────────────────────────────────────

/**
 * `content.batch_move` 的 items → 账本条目。只收 `moved`；指纹三个字段
 * （`file` / `bytes` / `mtime`，插件只在落盘后回）齐了才记，缺一个都不记 ——
 * 半份指纹校验不了，不如没有。旧版插件一个都不回，条目照记、只是没指纹。
 */
export function entriesFromItems(items: BatchMoveItem[]): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  for (const item of items) {
    if (item.status !== 'moved' || !item.destination) continue
    const entry: LedgerEntry = {
      from: item.source,
      to: item.destination,
      status: 'moved',
      auto_renamed: item.auto_renamed === true
    }
    if (
      typeof item.file === 'string' &&
      item.file.length > 0 &&
      typeof item.bytes === 'number' &&
      Number.isFinite(item.bytes) &&
      typeof item.mtime === 'string' &&
      item.mtime.length > 0
    ) {
      entry.fingerprint = { file: item.file, bytes: item.bytes, mtime: item.mtime }
    }
    entries.push(entry)
  }
  return entries
}
