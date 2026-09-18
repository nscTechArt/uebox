/**
 * ue_content_rollback —— 把一次 `ue_content_move` 反着搬回去。
 *
 * 设计。
 *
 * ## 回滚就是再搬一次
 *
 * 不另起一条引擎路径：把账本里每条的 from / to 对调，交给同一个 `content.batch_move`。
 * 于是签出预检、CDO 引用闸、重定向器清理、落盘回读 —— 正向搬迁过的每一道闸，
 * 回滚一样要过；插件那边加一道闸，这里自动带上。被闸挡下时的文案也复用
 * `summaries.ts` 那几段，模型看到的和 ue_content_move 被挡下时是同一种说法。
 *
 * ## 指纹逐条校验
 *
 * 搬完之后用户可能改过那个资产。字节数或 mtime 对不上就默认跳过（`on_modified=skip`），
 * 把「哪些被改过」摆在摘要里让用户自己决定要不要 `force`。文件不在了永远跳过 ——
 * 那条的现状我们已经不知道了，搬回去只会把问题带到旧路径。
 * 没有指纹的条目（`save=false` 或旧版插件）同样默认跳过：校验不了等于不知道，
 * 按 §4.3 的保守方向处理。
 *
 * ## 回滚也写账本
 *
 * 回滚成功后再落一份 `tool: ue_content_rollback` 的账本，带 `rollback_of`。
 * 回滚错了还能回滚回来，不然「撤销」本身就成了不可撤销的操作。
 */

import { promises as fs } from 'node:fs'
import { z } from 'zod'

import { getTargetProjectPath } from '../../core/projectTargetContext'
import { defineTool, type ToolCallContext, type ToolOutcome } from '../defineTool'
import { callUeRawWhenRegistryReady } from '../defineUeTool'
import { chunk, mergeResponse } from './batchMove'
import {
  checkFolderMoveOnDisk,
  checkMoveOnDisk,
  projectDirOf,
  type MoveDiskCheck
} from './diskCheck'
import {
  entriesFromItems,
  ledgerStatus,
  listLedgers,
  readLedger,
  recordMoveLedger,
  type LedgerEntry,
  type LedgerSummary,
  type MoveLedger
} from './ledger'
import { NAMESPACE } from './namingAudit'
import { cdoLines, checkoutLines, summarizeBatchMove, type BatchMoveAggregate } from './summaries'
import type { BatchMoveItem, BatchMoveResponse } from './types'

const RollbackInput = z.object({
  action: z
    .enum(['list', 'verify', 'preview', 'apply'])
    .describe(
      'list 列最近的账本；verify 查这次搬迁到底做成了没有（只看磁盘，不需要引擎）；' +
        'preview 看反向计划（不动手）；apply 真的搬回去'
    ),
  id: z.string().optional().describe('账本 id（list 给的），verify / preview / apply 必填'),
  on_modified: z
    .enum(['skip', 'force'])
    .optional()
    .describe(
      '搬完之后被改过（字节数或修改时间变了）或没有指纹的条目：skip（默认，跳过并报出来）/ force（照样搬回去）'
    ),
  on_conflict: z
    .enum(['fail', 'skip', 'auto_rename'])
    .optional()
    .describe('旧路径已经被别的资产占了：fail（默认，整批不动）/ skip / auto_rename'),
  limit: z.number().int().min(1).max(200).optional().describe('list 最多列多少份，默认 20')
})

type RollbackArgs = z.infer<typeof RollbackInput>

export type FingerprintStatus = 'ok' | 'modified' | 'missing' | 'no_fingerprint'

export interface FingerprintCheck {
  from: string
  to: string
  status: FingerprintStatus
  /** 人话：哪里对不上 */
  detail?: string
  /** 这一条最终有没有进反向 moves */
  included: boolean
}

export interface RollbackDetails {
  ledger_id: string
  action: RollbackArgs['action']
  checks: FingerprintCheck[]
  /** 每次 content.batch_move 的原始响应，含预演那几次 */
  responses: BatchMoveResponse[]
  aggregate?: BatchMoveAggregate
  /** apply 成功后新写的账本 id */
  rollback_ledger_id?: string
  /** list 用 */
  ledgers?: LedgerSummary[]
  /** verify 用：逐条的磁盘现状 */
  disk_checks?: MoveDiskCheck[]
}

const BATCH_SIZE = 100
const BATCH_TIMEOUT_MS = 10 * 60 * 1000
/** 文件系统的 mtime 精度和 ISO 字符串的秒级截断之间留的余量 */
const MTIME_TOLERANCE_MS = 2000
const SAMPLE = 20

// ────────────────────────────────────────────────────────────────────────────
// 指纹校验
// ────────────────────────────────────────────────────────────────────────────

async function checkEntry(entry: LedgerEntry, force: boolean): Promise<FingerprintCheck> {
  const base = { from: entry.from, to: entry.to }
  const fp = entry.fingerprint
  if (!fp) {
    return {
      ...base,
      status: 'no_fingerprint',
      detail: '账本里没有指纹，校验不了有没有被改过',
      included: force
    }
  }
  let stat: { size: number; mtimeMs: number }
  try {
    stat = await fs.stat(fp.file)
  } catch {
    return { ...base, status: 'missing', detail: `文件不在了：${fp.file}`, included: false }
  }
  const expectedMtime = Date.parse(fp.mtime)
  const sizeChanged = stat.size !== fp.bytes
  const mtimeChanged =
    !Number.isFinite(expectedMtime) || Math.abs(stat.mtimeMs - expectedMtime) > MTIME_TOLERANCE_MS
  if (sizeChanged || mtimeChanged) {
    const parts: string[] = []
    if (sizeChanged) parts.push(`字节 ${fp.bytes} → ${stat.size}`)
    if (mtimeChanged) parts.push(`修改时间 ${fp.mtime} → ${new Date(stat.mtimeMs).toISOString()}`)
    return {
      ...base,
      status: 'modified',
      detail: `搬完之后被改过（${parts.join('，')}）`,
      included: force
    }
  }
  return { ...base, status: 'ok', included: true }
}

/** 只校验 `moved` 的条目；账本被手改成别的状态的一律不动 */
export async function checkEntries(
  entries: LedgerEntry[],
  onModified: 'skip' | 'force'
): Promise<FingerprintCheck[]> {
  const checks: FingerprintCheck[] = []
  for (const entry of entries) {
    if (entry.status !== 'moved') continue
    checks.push(await checkEntry(entry, onModified === 'force'))
  }
  return checks
}

// ────────────────────────────────────────────────────────────────────────────
// 文案
// ────────────────────────────────────────────────────────────────────────────

/** 引擎的闸把整批挡下了：说清是哪道闸、挡在哪些文件上 */
function describeGate(r: BatchMoveResponse): string {
  const lines: string[] = ['回滚被引擎挡下，一个都没动。']
  if (r.reason === 'checkout_blocked') {
    lines.push(...checkoutLines(r.checkout, 'blocked'))
  } else if (r.reason === 'cdo_referenced') {
    lines.push(...cdoLines(r.cdo_refs, 'blocked'))
  } else {
    lines.push(`原因：${r.reason}${r.error ? ` —— ${r.error}` : ''}`)
  }
  if (r.engine_log && r.engine_log.length > 0) {
    lines.push('引擎日志（LogAssetTools，Warning 及以上）：')
    for (const line of r.engine_log.slice(0, SAMPLE)) lines.push(`  ${line}`)
  }
  lines.push('处理完再 action=apply；回滚走的是和 ue_content_move 同一道闸，规则一样。')
  return lines.join('\n')
}

function statusLabel(status: FingerprintStatus): string {
  switch (status) {
    case 'ok':
      return '可回滚'
    case 'modified':
      return '被改过'
    case 'missing':
      return '文件缺失'
    case 'no_fingerprint':
      return '无指纹'
  }
}

function countsLine(checks: FingerprintCheck[], conflicts: number): string {
  const count = (s: FingerprintStatus): number => checks.filter((c) => c.status === s).length
  const included = checks.filter((c) => c.included).length
  const forced = checks.filter((c) => c.included && c.status !== 'ok').length
  return (
    `指纹校验 ${checks.length} 条：可回滚 ${count('ok')}，被改过 ${count('modified')}，` +
    `文件缺失 ${count('missing')}，无指纹 ${count('no_fingerprint')}` +
    (conflicts > 0 ? `，目标被占 ${conflicts}` : '') +
    `；本次反向搬 ${included} 条` +
    (forced > 0 ? `（其中 ${forced} 条是 on_modified=force 强制带上的）` : '')
  )
}

function skippedLines(checks: FingerprintCheck[]): string[] {
  const skipped = checks.filter((c) => !c.included)
  if (skipped.length === 0) return []
  const lines = ['', `跳过的条目（前 ${Math.min(SAMPLE, skipped.length)} 条）：`]
  for (const c of skipped.slice(0, SAMPLE)) {
    lines.push(`- ${c.to}：${statusLabel(c.status)}${c.detail ? ` —— ${c.detail}` : ''}`)
  }
  if (skipped.length > SAMPLE) {
    // details 不进模型上下文（见 summaries.ts 顶部），只能给能执行的下一步
    lines.push(`… 只列了前 ${SAMPLE} 条，一共 ${skipped.length} 条跳过。`)
  }
  const forcible = skipped.some((c) => c.status === 'modified' || c.status === 'no_fingerprint')
  if (forcible) lines.push('被改过 / 无指纹的条目要一起搬回去，加 on_modified=force。')
  return lines
}

/** 同 batchMove.ts 的私有版本；那边没导出，这里不为了省 20 行去改别人的文件 */
function emptyAggregate(dryRun: boolean): BatchMoveAggregate {
  return {
    dry_run: dryRun,
    chunks: 0,
    planned: 0,
    moved: 0,
    skipped: 0,
    errors: 0,
    failed: 0,
    conflicts: [],
    items: [],
    items_truncated: false,
    redirectors_found: 0,
    redirectors_fixed: 0,
    saved_count: 0,
    save_failed: [],
    dirty_after: 0,
    elapsed_ms: 0,
    notes: [],
    ok: true,
    engine_log: [],
    auto_answered_dialogs: []
  }
}

function localTime(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  const d = new Date(at)
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function whyNotReversible(ledger: MoveLedger): string {
  const lines = [`账本 ${ledger.id} 不能自动回滚：`]
  if (!ledger.saved) {
    lines.push('- 那次搬迁是 save=false，没有落盘也没有指纹；在编辑器里检查后手动保存或撤销。')
  }
  if (ledger.entries.length === 0) lines.push('- 账本里没有 moved 条目。')
  if (ledger.irreversible.length > 0) {
    lines.push(`- 含 ${ledger.irreversible.length} 条不可逆操作：`)
    for (const it of ledger.irreversible.slice(0, SAMPLE)) {
      lines.push(`  - [${it.kind}] ${it.path}：${it.note}`)
    }
  }
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// 执行
// ────────────────────────────────────────────────────────────────────────────

async function callBatch(
  params: Record<string, unknown>,
  ctx: ToolCallContext<RollbackDetails>
): Promise<BatchMoveResponse> {
  return callUeRawWhenRegistryReady<BatchMoveResponse>('content.batch_move', params, {
    timeoutMs: BATCH_TIMEOUT_MS,
    ctx
  })
}

async function listAction(
  projectPath: string,
  limit: number | undefined
): Promise<ToolOutcome<RollbackDetails>> {
  const ledgers = await listLedgers(projectPath, limit ?? 20)
  const details: RollbackDetails = {
    ledger_id: '',
    action: 'list',
    checks: [],
    responses: [],
    ledgers
  }
  if (ledgers.length === 0) {
    return {
      text: '这个工程还没有账本。每次真实执行（非 dry_run）ue_content_move 之后会自动写一份。',
      details
    }
  }
  const lines = [`最近的账本（${ledgers.length} 份，新的在前）：`]
  let unfinished = 0
  for (const l of ledgers) {
    const flag =
      l.status === 'interrupted'
        ? `⚠️ 中断了，结果未知（计划 ${l.planned_count} 条）`
        : l.status === 'pending'
          ? `⚠️ 还在执行中（计划 ${l.planned_count} 条）`
          : l.reversible
            ? '可回滚'
            : l.saved
              ? '不可回滚'
              : '不可回滚（未落盘）'
    if (l.status !== 'done') unfinished += 1
    lines.push(`- ${l.id}  ${localTime(l.created_at)}  ${l.tool}  ${l.count} 条  ${flag}`)
  }
  lines.push('')
  if (unfinished > 0) {
    lines.push(
      `有 ${unfinished} 份账本没跑完（引擎多半是崩了或被关了）。` +
        '先 action=verify id=<id> —— 只查磁盘、不需要引擎，逐条告诉你哪些其实已经搬到位了。'
    )
  }
  lines.push('下一步：action=preview id=<id> 看反向计划，确认后 action=apply。')
  return { text: lines.join('\n'), details }
}

const DISK_STATE_TEXT: Record<MoveDiskCheck['state'], string> = {
  moved: '已搬到位',
  not_moved: '没有搬',
  both: '两边都有',
  neither: '两边都没有',
  unknown: '查不了'
}

/**
 * 只看磁盘，回答「这次搬迁到底做成了没有」。
 *
 * 存在的理由是崩溃恢复：引擎在执行途中把编辑器搞崩时，RPC 只抛一个异常，
 * 结果是未知的。而真机三次崩溃里，改名**每次都已经做完了**，崩在收尾 ——
 * 「断开」不等于「没做」，靠猜会把已经搬好的再搬一遍。
 *
 * 所以这条路一点引擎都不碰：拿账本里的计划逐条 stat 磁盘文件。
 * 引擎还没重启也能跑，几秒钟出结果。
 */
async function verifyAction(
  projectPath: string,
  ledger: MoveLedger
): Promise<ToolOutcome<RollbackDetails>> {
  const status = ledgerStatus(ledger)
  /**
   * 核对哪一份清单：**没跑完的一律用 `planned`**。
   *
   * `entries` 是引擎逐条回读过的结果，只包含**回来了的那几批**。一次分三批的
   * 搬迁在第二批崩掉时，`entries` 里躺着第一批的 20 条 —— 拿它去核对会得出
   * 「20/20 全搬到位，不用重试」，而真正结果未知的第二、三批**一条都没查**。
   * 那正好是这个功能存在的场景，也正好是它最容易骗人的地方。
   *
   * 跑完的账本反过来优先用 `entries`：`auto_rename` 会把目标名加上 `_1`，
   * 只有 `entries` 里记的是真实落点，`planned` 里是改名前的那个。
   */
  const usePlanned = status !== 'done' && (ledger.planned?.length ?? 0) > 0
  const pairs = usePlanned
    ? (ledger.planned ?? [])
    : ledger.entries.length > 0
      ? ledger.entries.map((e) => ({ from: e.from, to: e.to }))
      : (ledger.planned ?? [])

  const details: RollbackDetails = {
    ledger_id: ledger.id,
    action: 'verify',
    checks: [],
    responses: [],
    disk_checks: []
  }
  const header =
    `账本 ${ledger.id}（${localTime(ledger.created_at)}，${ledger.tool}，状态 ${status}` +
    (ledger.interrupted_reason ? `：${ledger.interrupted_reason}` : '') +
    '）'

  if (pairs.length === 0) {
    return {
      text: `${header}\n账本里既没有计划也没有结果，没什么可核对的。`,
      details
    }
  }

  const projectDir = projectDirOf(projectPath)
  const checks: MoveDiskCheck[] = []
  for (const pair of pairs) {
    // 目录搬迁的 from / to 是目录不是包，要按目录查（见 diskCheck 里的注释）
    const isFolder = 'kind' in pair && (pair as { kind?: string }).kind === 'folder'
    checks.push(
      isFolder
        ? await checkFolderMoveOnDisk(projectDir, pair.from, pair.to)
        : await checkMoveOnDisk(projectDir, pair.from, pair.to)
    )
  }
  details.disk_checks = checks

  const count = (state: MoveDiskCheck['state']): number =>
    checks.filter((c) => c.state === state).length
  // `both` 里旧文件小得像重定向器的才算「搬完了」；旧文件很大的那种
  // 是「同名的另一个资产」，要人看一眼，不能混进「已搬到位」的数里
  const leftover = checks.filter((c) => c.state === 'both' && c.source_looks_like_redirector)
  const ambiguousBoth = checks.filter((c) => c.state === 'both' && !c.source_looks_like_redirector)

  const lines = [header, '【只查了磁盘，没有问引擎 —— 引擎没起来这个结论也成立】']
  lines.push(
    `核对 ${checks.length} 条：已搬到位 ${count('moved') + leftover.length}` +
      (leftover.length > 0 ? `（其中 ${leftover.length} 条旧路径还留着重定向器）` : '') +
      `，没有搬 ${count('not_moved')}，两边都没有 ${count('neither')}` +
      (ambiguousBoth.length > 0 ? `，两边都有文件、要人看 ${ambiguousBoth.length}` : '') +
      `，查不了 ${count('unknown')}`
  )

  const notDone = checks.filter(
    (c) => c.state !== 'moved' && !(c.state === 'both' && c.source_looks_like_redirector)
  )
  if (notDone.length > 0) {
    lines.push('')
    lines.push(`需要你处理的（前 ${Math.min(SAMPLE, notDone.length)} 条）：`)
    for (const c of notDone.slice(0, SAMPLE)) {
      lines.push(
        `- ${c.from} → ${c.to}：${DISK_STATE_TEXT[c.state]}${c.detail ? ` —— ${c.detail}` : ''}`
      )
    }
    if (notDone.length > SAMPLE) {
      lines.push(`… 一共 ${notDone.length} 条没搬到位。`)
    }
  }

  lines.push('')
  if (count('not_moved') > 0) {
    lines.push(
      `还没搬的那 ${count('not_moved')} 条可以用 ue_content_move 重发 —— ` +
        '只发这几条，别把整批重来一遍，已经搬好的会因为「源不存在」报失败。'
    )
  } else if (notDone.length === 0) {
    lines.push('这次搬迁其实全部做完了，不用重试。旧路径上的重定向器（如果有）不影响使用。')
  }
  if (count('unknown') > 0) {
    lines.push(
      `${count('unknown')} 条算不出磁盘位置（不是 /Game 下的包），这几条只能等引擎起来后用 ue_content_search 确认。`
    )
  }

  return { text: lines.join('\n'), details }
}

export const rollbackTool = defineTool<typeof RollbackInput, RollbackDetails>({
  name: 'ue_content_rollback',
  namespace: NAMESPACE,
  risk: 'mutating',
  concurrency: 'sequential',
  description: `查一次 ue_content_move 做成了没有，或者把它搬回去。

【引擎崩了 / 断线了，先用这个】ue_content_move 中途连接断掉时，报错里会带一个账本 id。
跑 action=verify id=<账本 id>：它**只查磁盘、完全不需要引擎**，逐条告诉你哪些已经搬到位、
哪些还没动。崩溃常发生在改名做完之后的收尾阶段 —— 「断开」不等于「没做」，
不核对就重试，会把已经搬好的又搬一遍（然后一堆「源不存在」的失败）。

【账本】ue_content_move **在发给引擎之前**就写一份账本（记下打算搬什么），
引擎回话后再补上逐条结果和文件指纹。所以就算编辑器当场崩掉，账本也在。
action=list 列出本工程最近的账本（30 天 / 200 份内），没跑完的会标出来。

【怎么回滚】action=preview id=<id> 先看反向计划；确认后 action=apply。回滚 = 把账本里每条的
from / to 对调，再交给同一个引擎命令 content.batch_move —— 正向搬迁要过的闸（签出预检、
C++ 默认值引用检查、重定向器清理、落盘回读）回滚一样要过；被挡下会原样报出来。

【被改过的不动】搬完之后字节数或修改时间变了的资产默认跳过（on_modified=skip），
摘要里逐条列出；确认要一起搬回去再 on_modified=force。文件已经不在的条目永远跳过。

【旧路径被占】搬走之后有别的资产用了旧名字：on_conflict 默认 fail（整批不动），
可改 skip / auto_rename。

【不能回滚的】save=false 的搬迁（没落盘、没指纹）；ue_content_migrate 拷到别的工程的文件；
ue_fixup_redirectors delete_broken 删掉的重定向器 —— 删了就没了，账本只记录删了什么。
回滚本身也会写一份账本（带 rollback_of），回滚错了还能再回滚。`,
  input: RollbackInput,
  execute: async (args: RollbackArgs, ctx): Promise<ToolOutcome<RollbackDetails>> => {
    const projectPath = getTargetProjectPath()
    if (!projectPath) {
      return { isError: true, text: '没有绑定工程，账本按工程存放' }
    }

    if (args.action === 'list') return listAction(projectPath, args.limit)

    if (!args.id) {
      return { isError: true, text: `action=${args.action} 需要 id，先 action=list 看有哪些账本` }
    }
    const ledger = await readLedger(projectPath, args.id)
    if (!ledger) {
      return {
        isError: true,
        text: `找不到账本 ${args.id}（id 只认字母、数字、- 和 _；用 action=list 查）`
      }
    }

    // verify 排在可回滚判断之前：中断的账本正是最需要核对的那一种，
    // 而它按定义就是「不可回滚」（结果还不知道）
    if (args.action === 'verify') return verifyAction(projectPath, ledger)

    if (ledgerStatus(ledger) !== 'done') {
      return {
        isError: true,
        text:
          `账本 ${ledger.id} 还没跑完（状态 ${ledgerStatus(ledger)}` +
          (ledger.interrupted_reason ? `：${ledger.interrupted_reason}` : '') +
          '），结果未知，不能直接回滚 —— 会把没搬过去的也「搬回来」。\n' +
          `先 action=verify id=${ledger.id} 看清楚哪些真的搬到位了。`
      }
    }

    if (!ledger.reversible) {
      return { isError: true, text: whyNotReversible(ledger) }
    }

    const onModified = args.on_modified ?? 'skip'
    const onConflict = args.on_conflict ?? 'fail'
    const dryRun = args.action === 'preview'
    const header = `账本 ${ledger.id}（${localTime(ledger.created_at)}，${ledger.tool}，${ledger.entries.length} 条）`

    const checks = await checkEntries(ledger.entries, onModified)
    const details: RollbackDetails = {
      ledger_id: ledger.id,
      action: args.action,
      checks,
      responses: []
    }
    const moves = checks
      .filter((c) => c.included)
      .map((c) => ({ source: c.to, destination: c.from }))

    if (moves.length === 0) {
      return {
        isError: !dryRun,
        text: [
          header,
          countsLine(checks, 0),
          '没有可回滚的条目，引擎没有被调用。',
          ...skippedLines(checks)
        ].join('\n'),
        details
      }
    }

    const common: Record<string, unknown> = {
      on_conflict: onConflict,
      save: true
    }
    const batches = chunk(moves, BATCH_SIZE)

    // 同 batchMove：on_conflict=fail 且分了多批，先把每批都预演一遍，任何一批有冲突
    // 或会被闸挡下就一个都不动。引擎只看得见自己那一批。
    if (!dryRun && onConflict === 'fail' && batches.length > 1) {
      const preview = emptyAggregate(true)
      for (const batch of batches) {
        const r = await callBatch({ ...common, moves: batch, dry_run: true }, ctx)
        details.responses.push(r)
        if (r.reason !== undefined) {
          return { isError: true, text: [header, describeGate(r)].join('\n'), details }
        }
        mergeResponse(preview, r)
      }
      if (preview.conflicts.length > 0) {
        details.aggregate = preview
        return {
          isError: true,
          text:
            `${header}\n${preview.conflicts.length} 个旧路径已被占用，整批没有回滚：\n` +
            preview.conflicts
              .slice(0, SAMPLE)
              .map((c) => `- ${c.source} → ${c.destination}`)
              .join('\n') +
            '\n换 on_conflict=skip / auto_rename，或者先把占位的资产挪开。',
          details
        }
      }
    }

    const agg = emptyAggregate(dryRun)
    const allItems: BatchMoveItem[] = []
    let done = 0
    for (const batch of batches) {
      const r = await callBatch({ ...common, moves: batch, dry_run: dryRun }, ctx)
      details.responses.push(r)
      // 预演时 reason 只是「真跑会被挡」的提醒，summarizeBatchMove 会讲；真跑被挡就停
      if (!dryRun && r.reason !== undefined) {
        details.aggregate = agg
        const partial =
          agg.moved > 0
            ? `\n注意：前面已有 ${agg.moved} 条搬回去了，它们没有单独的账本；再 action=preview 同一个 id 能看到剩下的。`
            : ''
        return { isError: true, text: [header, describeGate(r) + partial].join('\n'), details }
      }
      mergeResponse(agg, r)
      allItems.push(...r.items)
      done += 1
      if (batches.length > 1) {
        ctx.report({
          text: dryRun
            ? `回滚预演中：${done}/${batches.length} 批`
            : `已搬回 ${agg.moved} 个资产（${done}/${batches.length} 批）`,
          details
        })
      }
    }
    details.aggregate = agg

    const lines = [header, dryRun ? '【预演，没有改动任何东西】' : '【已执行回滚】']
    lines.push(countsLine(checks, agg.conflicts.length))
    lines.push(summarizeBatchMove(agg))
    lines.push(...skippedLines(checks))

    if (!dryRun && agg.moved > 0) {
      try {
        const rollbackLedger = await recordMoveLedger({
          projectPath,
          tool: 'ue_content_rollback',
          args_summary: {
            rollback_of: ledger.id,
            on_modified: onModified,
            on_conflict: onConflict
          },
          saved: true,
          entries: entriesFromItems(allItems)
        })
        details.rollback_ledger_id = rollbackLedger.id
        lines.push('', `回滚本身也记了账本：${rollbackLedger.id}（回滚错了可以再回滚）`)
      } catch (error) {
        lines.push(
          '',
          `回滚已执行，但回滚账本没写成：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    return {
      text: lines.join('\n'),
      details,
      isError: !dryRun && agg.moved === 0 && agg.planned > 0 && agg.failed > 0
    }
  }
})
