/**
 * ue_content_move —— 批量移动 / 重命名资产。
 *
 * 取代了原来的单资产版本（同名，参数从一对路径变成一批）。一对路径照样能传，
 * 但底层永远走 `content.batch_move`：插件把整批交给一次 `IAssetTools::RenameAssets`，
 * 引用者只加载一遍、只重写一遍 —— 十个材质被同一批关卡引用时，逐个搬要把那批关卡
 * 加载十遍，整批搬只加载一遍。
 *
 * ## 分批
 *
 * 一次 RPC 塞一千对路径，引擎那边一口气加载所有引用者，内存和超时都不可控。
 * 这里按 batch_size 切成若干次调用，每批完成就 report 一次进度。代价是跨批的
 * 冲突检测（两批各有一个资产搬到同一个名字）引擎看不到 —— 所以在发出去之前
 * 本地先查重，多批时还会先对全部批次做一遍 dry_run，有冲突或有闸拦下就
 * 一个都不动。「半批搬完」的工程比没搬更难收拾。
 *
 * ## 三道闸（ §3）
 *
 * - 签出预检（`on_blocked`）和 CDO 引用（`on_cdo_refs`）在**插件里**守：`batch_move`
 *   规划完就查，默认 fail 时有问题一个都不发给 RenameAssets，响应带 `reason`。
 *   这里只把结果讲成人话，并在多批时先预演一遍保证全有或全无。
 * - 工程文本引用（`on_external_refs`）在**盒子侧**守：纯文本扫描，不需要引擎。
 *
 * ## 账本（同文 §4）
 *
 * 每次真搬完，把「谁从哪搬到哪 + 目标文件指纹」落成一份账本，`ue_content_rollback`
 * 靠它反向搬回去。第一轮的用户在搬 3000 个资产之前会犹豫，这个犹豫是对的。
 *
 * ## 关卡不搬
 *
 * World Partition 关卡改名要连 __ExternalActors__ 一起搬，RenameAssets 不管这个。
 * 插件会明确拒绝 World 类资产，这里照实转述，不装作能做。
 */

import { z } from 'zod'

import { WebSocketErrorCode, WebSocketServiceError } from '../../../services/websocket/types'
import { getTargetProjectPath } from '../../core/projectTargetContext'
import { defineTool, type ToolCallContext, type ToolOutcome } from '../defineTool'
import { callUeRawWhenRegistryReady } from '../defineUeTool'
import {
  entriesFromItems,
  finalizeLedger,
  recordMoveLedger,
  type LedgerPlannedEntry
} from './ledger'
import { NAMESPACE } from './namingAudit'
import { buildTargets, resolveProjectDir, scanProjectPathRefs } from './projectPathRefs'
import { summarizeBatchMove, type BatchMoveAggregate, type ExternalRefsSummary } from './summaries'
import type { BatchMoveResponse } from './types'

const Gate = z.enum(['fail', 'proceed'])

const MoveInput = z.object({
  moves: z
    .array(
      z.object({
        source: z
          .string()
          .describe('资产当前路径，如 /Game/Old/Rock（对象路径 /Game/Old/Rock.Rock 也行）'),
        destination: z
          .string()
          .describe(
            '目标：以 / 结尾或本身是已存在的目录 → 保留原名搬进去（/Game/Props/）；' +
              '否则最后一段就是新名字（/Game/Props/SM_Rock 表示搬到 Props 并改名）'
          )
      })
    )
    .optional()
    .describe('逐资产的移动 / 改名列表'),
  folder_moves: z
    .array(
      z.object({
        source_folder: z.string().describe('要整个搬走的目录，如 /Game/Temp/Props'),
        destination_folder: z.string().describe('搬到哪，如 /Game/Props；子目录结构原样保留')
      })
    )
    .optional()
    .describe('整目录搬迁（目录里所有资产连同子目录结构一起搬；空目录不会被搬）'),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      '只做计划不动手：列出每个资产会搬到哪、被多少资产引用、目标有没有冲突、' +
        '签出预检 / C++ 引用 / 工程文本引用三道闸的结果。第一次先用它'
    ),
  on_conflict: z
    .enum(['fail', 'skip', 'auto_rename'])
    .optional()
    .describe(
      '目标已存在时：fail（默认，整批不动）/ skip（跳过那一条）/ auto_rename（加 _1 _2 后缀）'
    ),
  on_blocked: Gate.optional().describe(
    '签出预检发现有文件动不了（别人签出着 / 不是最新版 / 只读 / 源码管理连不上）时：' +
      'fail（默认，整批不动）/ proceed（照发，引擎会整批拒绝，后果自负）'
  ),
  on_cdo_refs: Gate.optional().describe(
    '有资产被 C++ 类的默认值（CDO）引用时：fail（默认，整批不动）/ ' +
      'proceed（命令替你回答引擎的确认弹窗，改名照做；回答过的弹窗会全部列出来）'
  ),
  on_external_refs: Gate.optional().describe(
    '工程的 C++ / ini / csv / py 文本里有按路径引用这批资产的地方时：' +
      'fail（默认，整批不动，先去改文本）/ proceed（先搬，文本里的引用自己改）'
  ),
  /*
   * `fixup_redirectors` 在 2026-09-11 删掉了，**不留兼容层**。
   *
   * 它在 schema 里挂了一段时间，描述第一句就写着「已经不起作用，留着只为兼容旧调用」——
   * 一个明知无效的参数摆在模型眼前，是在骗它：传了会以为清干净了，而两侧都没有清。
   * 插件那边同样只是收下再回一句 note（`UAL_ContentOrganizeCommands.cpp:1589`），
   * 重定向器是**故意**留着的（引擎的清理接口在无人值守下会弹模态报告框并崩掉编辑器，
   * 5.5 和 5.8 都复现过，同文件 :1586 有完整说明）。
   *
   * 要清理只有 `ue_fixup_redirectors` 一条路，它跑在交互态、报告框真的会弹出来由人点。
   * 由盒子自己的 agent 读 schema 时点出。
   */
  save: z.boolean().optional().describe('搬完把搬过去的包和被重写的引用者落盘，默认 true'),
  batch_size: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('每次交给引擎多少条 moves，默认 100。folder_moves 不分批')
})

type MoveArgs = z.infer<typeof MoveInput>

const BATCH_TIMEOUT_MS = 10 * 60 * 1000
const FOLDER_TIMEOUT_MS = 30 * 60 * 1000

/** 去掉 .Object 后缀、尾部斜杠，小写 —— 只用来查重 */
function normalizeKey(path: string): string {
  let out = path.trim()
  const dot = out.indexOf('.')
  if (dot >= 0) out = out.slice(0, dot)
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out.toLowerCase()
}

/** 目标是「目录」形式（以 / 结尾）的话，最终包名要拼上源资产名 */
function destinationKey(move: { source: string; destination: string }): string {
  const dest = move.destination.trim()
  if (dest.endsWith('/')) {
    const src = normalizeKey(move.source)
    const name = src.slice(src.lastIndexOf('/') + 1)
    return normalizeKey(dest + name)
  }
  return normalizeKey(dest)
}

/** 发出去之前本地能查出来的问题：同一个源出现两次、两个源搬到同一个目标 */
export function findLocalDuplicates(moves: { source: string; destination: string }[]): string[] {
  const problems: string[] = []
  const seenSources = new Map<string, number>()
  const seenDests = new Map<string, string>()
  for (const move of moves) {
    const src = normalizeKey(move.source)
    seenSources.set(src, (seenSources.get(src) ?? 0) + 1)
    // 以 / 结尾的目录目标：最终名字取决于源资产名，插件解析后才知道；
    // 但「已存在的目录」这一形态本地认不出来，只对明确带名字的做查重
    const dest = destinationKey(move)
    const prior = seenDests.get(dest)
    if (prior && prior !== src) {
      problems.push(`${move.source} 和 ${prior} 都要搬到 ${move.destination}`)
    }
    seenDests.set(dest, src)
  }
  for (const [src, count] of seenSources) {
    if (count > 1) problems.push(`${src} 在 moves 里出现了 ${count} 次`)
  }
  return problems
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

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

export function mergeResponse(agg: BatchMoveAggregate, r: BatchMoveResponse): void {
  agg.chunks += 1
  agg.planned += r.planned
  agg.moved += r.moved
  agg.skipped += r.skipped
  agg.errors += r.errors
  agg.failed += r.failed ?? 0
  agg.conflicts.push(...r.conflicts)
  for (const item of r.items) {
    if (agg.items.length >= 500) {
      agg.items_truncated = true
      break
    }
    agg.items.push(item)
  }
  if (r.items_truncated) agg.items_truncated = true
  agg.redirectors_found += r.redirectors_found ?? 0
  agg.redirectors_fixed += r.redirectors_fixed ?? 0
  agg.saved_count += r.saved_count ?? 0
  agg.save_failed.push(...(r.save_failed ?? []))
  // 脏包数是「此刻」的快照，取最后一批的
  agg.dirty_after = r.dirty_after ?? agg.dirty_after
  agg.elapsed_ms += r.elapsed_ms
  for (const note of r.notes ?? []) {
    if (!agg.notes.includes(note)) agg.notes.push(note)
  }
  if (!r.ok) agg.ok = false

  // 三道闸 + 引擎日志：跨批合并。blocking / hits 按包去重，reason 取第一个
  if (r.reason && !agg.reason) agg.reason = r.reason
  if (r.checkout) {
    const c = (agg.checkout ??= {
      scc_enabled: r.checkout.scc_enabled,
      scc_provider: r.checkout.scc_provider,
      scc_available: r.checkout.scc_available,
      checked: 0,
      blocked: 0,
      blocking: [],
      states: []
    })
    c.checked += r.checkout.checked
    c.blocked += r.checkout.blocked
    const seen = new Set(c.blocking.map((s) => s.package.toLowerCase()))
    for (const s of r.checkout.blocking) {
      if (seen.has(s.package.toLowerCase())) continue
      seen.add(s.package.toLowerCase())
      c.blocking.push(s)
    }
    if (c.states && r.checkout.states) {
      for (const s of r.checkout.states) {
        if (c.states.length >= 500) {
          c.states_truncated = true
          break
        }
        c.states.push(s)
      }
    }
    if (r.checkout.note) c.note = r.checkout.note
  }
  if (r.cdo_refs) {
    const c = (agg.cdo_refs ??= { checked: 0, hits: [] })
    c.checked += r.cdo_refs.checked
    c.hits.push(...r.cdo_refs.hits)
    if (r.cdo_refs.note) c.note = r.cdo_refs.note
  }
  for (const line of r.engine_log ?? []) {
    if (agg.engine_log.length >= 200) break
    agg.engine_log.push(line)
  }
  agg.auto_answered_dialogs.push(...(r.auto_answered_dialogs ?? []))
}

async function callBatch(
  params: Record<string, unknown>,
  timeoutMs: number,
  ctx: ToolCallContext<BatchMoveAggregate>
): Promise<BatchMoveResponse> {
  // 不用 callUe：一批里有一条失败插件就回 ok:false，而那份逐条的 items /
  // engine_log 正是要拿去写摘要、写账本的东西，不能被压成一句错误扔掉
  return callUeRawWhenRegistryReady<BatchMoveResponse>('content.batch_move', params, {
    timeoutMs,
    ctx
  })
}

/**
 * 盒子侧的那道闸：扫工程文本里按路径引用这批资产的地方。
 *
 * 扫不成（没绑工程、目录不在）不等于「没有引用」—— 用 skipped_reason 如实说，
 * 摘要里也照实写；只有真扫过才会有 hits。
 */
export async function scanExternalRefs(
  moves: MoveArgs['moves'],
  folderMoves: MoveArgs['folder_moves']
): Promise<ExternalRefsSummary> {
  const projectPath = getTargetProjectPath()
  if (!projectPath) {
    return {
      hits: [],
      scanned_files: 0,
      truncated: false,
      note: '',
      skipped_reason:
        '这条会话没有绑定工程路径，扫不了工程文本。用 ue_project_path_refs 传 project 手动扫。'
    }
  }
  try {
    const targets = buildTargets({ moves: moves ?? [], folder_moves: folderMoves ?? [] })
    const result = await scanProjectPathRefs(resolveProjectDir(projectPath), targets)
    return {
      hits: result.hits.map((h) => ({
        file: h.file,
        line: h.line,
        token: h.token,
        ...(h.suggested_token ? { suggested_token: h.suggested_token } : {})
      })),
      scanned_files: result.scanned_files,
      truncated: result.truncated,
      note: result.note
    }
  } catch (error) {
    return {
      hits: [],
      scanned_files: 0,
      truncated: false,
      note: '',
      skipped_reason: error instanceof Error ? error.message : String(error)
    }
  }
}

function argsSummary(args: MoveArgs): Record<string, unknown> {
  return {
    on_conflict: args.on_conflict ?? 'fail',
    // 这里原来还记一条 `fixup_redirectors: true` —— 而那件事从来没做过。
    // 账本是回滚和事后对账唯一的依据，记一个没发生的动作比不记更坏。
    save: args.save ?? true,
    on_blocked: args.on_blocked ?? 'fail',
    on_cdo_refs: args.on_cdo_refs ?? 'fail'
  }
}

/**
 * 发出去之前先把「打算搬什么」记下来。
 *
 * ## 为什么不能等引擎回话再记账
 *
 * 引擎在执行途中崩掉（真机三次，5.5 一次 5.8 两次）时，RPC 只会抛一个
 * 「连接断了」的异常，`recordMoveLedger` 那一行根本走不到 —— 目录里**一份账本都没有**。
 * 于是「搬到哪一步了」只剩翻磁盘硬猜这一条路，每次要花十几分钟，用户全程陪着等。
 *
 * 先落一份 `pending`，崩了就是 `interrupted`，`ue_content_rollback action=verify`
 * 拿这份计划逐条查磁盘，几秒钟给出「哪些搬到位了、哪些没动」。
 *
 * `folder_moves` 展不开成具体条目（哪些资产在那个目录里是引擎才知道的事），
 * 计划里只记目录本身并标 `kind:'folder'` —— verify 那边按目录查，
 * 不标的话它会拿查资产那套去查一个目录，一次成功的目录搬迁会被核对成「两边都没有」。
 */
function plannedEntries(args: MoveArgs): LedgerPlannedEntry[] {
  const planned: LedgerPlannedEntry[] = []
  for (const move of args.moves ?? []) {
    planned.push({ from: move.source, to: move.destination, kind: 'asset' })
  }
  for (const folder of args.folder_moves ?? []) {
    planned.push({
      from: folder.source_folder,
      to: folder.destination_folder,
      kind: 'folder'
    })
  }
  return planned
}

/** 真搬之前落一份 pending 账本。写不成不挡搬迁，但要说出来 —— 没账本就没有恢复线索 */
async function openLedger(agg: BatchMoveAggregate, args: MoveArgs): Promise<string | undefined> {
  const projectPath = getTargetProjectPath()
  if (!projectPath) {
    agg.notes.push('没有绑定工程路径，这次搬迁没有记账本，不能用 ue_content_rollback 回滚。')
    return undefined
  }
  try {
    const ledger = await recordMoveLedger({
      projectPath,
      tool: 'ue_content_move',
      args_summary: argsSummary(args),
      saved: args.save !== false,
      entries: [],
      status: 'pending',
      planned: plannedEntries(args)
    })
    agg.ledger_id = ledger.id
    return ledger.id
  } catch (error) {
    agg.notes.push(
      `账本没写成（${error instanceof Error ? error.message : String(error)}），这次搬迁不能用 ue_content_rollback 回滚，中断了也查不到搬到哪一步。`
    )
    return undefined
  }
}

/** 引擎正常回话之后，把 pending 账本改写成最终结果 */
async function closeLedger(agg: BatchMoveAggregate, ledgerId: string | undefined): Promise<void> {
  const projectPath = getTargetProjectPath()
  if (!projectPath || !ledgerId) return

  const updated = await finalizeLedger(projectPath, ledgerId, {
    status: 'done',
    entries: entriesFromItems(agg.items),
    notes: agg.items_truncated ? ['items 超过 500 条被截断，账本只记录了前 500 条'] : []
  })
  if (!updated) {
    agg.notes.push(
      `账本 ${ledgerId} 没能改写成最终状态，它会一直显示「执行中」。回滚前先 ue_content_rollback action=verify id=${ledgerId} 对一遍磁盘。`
    )
  }
}

function blockedOutcome(agg: BatchMoveAggregate, reason: string): ToolOutcome<BatchMoveAggregate> {
  agg.reason = reason
  agg.ok = false
  return { isError: true, text: summarizeBatchMove(agg), details: agg }
}

export const batchMoveTool = defineTool<typeof MoveInput, BatchMoveAggregate>({
  name: 'ue_content_move',
  namespace: NAMESPACE,
  risk: 'mutating',
  concurrency: 'sequential',
  description: `批量移动或重命名虚幻工程里的资产，也能整目录搬迁。一对路径也走它。

【怎么用】
- 改名：moves=[{source:"/Game/Props/rock", destination:"/Game/Props/SM_Rock"}]
- 搬家保留原名：destination 以 / 结尾，如 "/Game/Props/"
- 整目录：folder_moves=[{source_folder:"/Game/Temp/Props", destination_folder:"/Game/Props"}]
- 命名规范化：把 ue_content_naming_audit 给的 {path → suggested_path} 直接当 moves

【流程建议】先 dry_run=true 看计划（每个资产搬到哪、被多少资产引用、目标冲不冲突、
三道闸的结果），确认后再 dry_run=false。

【它替你做的】整批一次交给引擎（引用者只加载一遍，比逐个搬快得多）；搬完落盘（save 默认开）；
每条都回读目标位置，「引擎说成功但资产不在新位置」会报成 failed 而不是 success；
**发出去之前就记一份账本**，搬错了 ue_content_rollback 能原路搬回，
中途引擎崩了也能 action=verify 查出搬到哪一步。

【重定向器会留在旧路径，这是故意的】搬走之后旧路径上会留下转发桩（重定向器），
本工具**不清理**它们 —— 引擎的清理接口在无人值守下会弹一个模态报告框，
而那个框被自动取消后引擎会读一个没设置的值，**直接把编辑器搞崩**（UE 5.4+，真机撞过三次）。
留着它们是安全的：引擎跟着转发，工程照常能用，打包也不受影响。
真要清掉就单独调 ue_fixup_redirectors，那条命令跑在交互态，报告框会弹出来由人点一下。

【引擎中途崩了怎么办】报错里会带上账本 id。**不要原样重试** ——
先 ue_content_rollback action=verify id=<账本 id>：它只查磁盘、不需要引擎，
逐条告诉你哪些已经搬到位、哪些还没动。崩溃常发生在改名做完之后的收尾阶段，
「断开」不等于「没做」，重试很可能把已经搬好的又搬一遍。

【三道闸，默认都是 fail = 有问题整批不动】
- on_blocked：签出预检。被搬的资产和它们的引用者里有任何一个别人签出着 / 不是最新版 /
  只读 / 源码管理连不上，引擎会整批拒绝，这里事前就报出是哪个文件、谁占着。
- on_cdo_refs：资产被 C++ 类的默认值引用（如 ConstructorHelpers::FClassFinder）。引擎改名前
  会弹确认框，无人值守下会被自动取消。proceed = 命令替你点确定，回答过的弹窗全部列出。
- on_external_refs：工程的 C++ / ini / csv / py 里按路径写着这批资产。搬走后那些引用会断，
  本工具只列出在哪、建议改成什么，不代改源码。

【冲突】on_conflict 默认 fail：有任何目标已存在就整批不动，报出冲突列表。
同一批里「A→B 同时 B→C」这种链式搬迁也算冲突（B 的位置此刻还被占着），分两次调。

【不做】关卡（World）不搬 —— 改关卡名要连外部 Actor 一起挪，用关卡工具。
重定向器本身不搬 —— 先 ue_fixup_redirectors。`,
  input: MoveInput,
  execute: async (args: MoveArgs, ctx): Promise<ToolOutcome<BatchMoveAggregate>> => {
    const moves = args.moves ?? []
    const folderMoves = args.folder_moves ?? []
    if (moves.length === 0 && folderMoves.length === 0) {
      return { isError: true, text: 'moves 和 folder_moves 至少要给一个' }
    }

    const duplicates = findLocalDuplicates(moves)
    if (duplicates.length > 0) {
      return {
        isError: true,
        text: `moves 里有互相冲突的条目，一个都没动：\n- ${duplicates.join('\n- ')}`
      }
    }

    const dryRun = args.dry_run === true
    const onConflict = args.on_conflict ?? 'fail'
    const onBlocked = args.on_blocked ?? 'fail'
    const onCdoRefs = args.on_cdo_refs ?? 'fail'
    const onExternalRefs = args.on_external_refs ?? 'fail'
    const common: Record<string, unknown> = {
      on_conflict: onConflict,
      on_blocked: onBlocked,
      on_cdo_refs: onCdoRefs
    }
    if (args.save !== undefined) common.save = args.save

    const batches = chunk(moves, args.batch_size ?? 100)
    const totalCalls = batches.length + (folderMoves.length > 0 ? 1 : 0)

    // 盒子侧的闸先过：不需要引擎，扫不到就不用麻烦引擎了
    const externalRefs = await scanExternalRefs(moves, folderMoves)
    if (!dryRun && onExternalRefs === 'fail' && externalRefs.hits.length > 0) {
      const agg = emptyAggregate(false)
      agg.planned = moves.length
      agg.external_refs = externalRefs
      return blockedOutcome(agg, 'external_refs')
    }

    // 多批时先把每批都预演一遍：目标冲突、签出预检、CDO 引用，任何一批被拦下就整批不动。
    // 引擎只看得见自己那一批，跨批的「全有或全无」只能在这里保证。
    const previewNeeded =
      !dryRun &&
      totalCalls > 1 &&
      (onConflict === 'fail' || onBlocked === 'fail' || onCdoRefs === 'fail')
    if (previewNeeded) {
      const preview = emptyAggregate(true)
      for (const batch of batches) {
        mergeResponse(
          preview,
          await callBatch({ ...common, moves: batch, dry_run: true }, BATCH_TIMEOUT_MS, ctx)
        )
      }
      if (folderMoves.length > 0) {
        mergeResponse(
          preview,
          await callBatch(
            { ...common, folder_moves: folderMoves, dry_run: true },
            FOLDER_TIMEOUT_MS,
            ctx
          )
        )
      }
      if (onConflict === 'fail' && preview.conflicts.length > 0) {
        return {
          isError: true,
          text:
            `${preview.conflicts.length} 个目标已存在，整批没有移动：\n` +
            preview.conflicts
              .slice(0, 20)
              .map((c) => `- ${c.source} → ${c.destination}`)
              .join('\n') +
            '\n换 on_conflict=skip / auto_rename，或者先改名。',
          details: preview
        }
      }
      preview.dry_run = false
      preview.external_refs = externalRefs
      if (onBlocked === 'fail' && (preview.checkout?.blocked ?? 0) > 0) {
        return blockedOutcome(preview, 'checkout_blocked')
      }
      if (onCdoRefs === 'fail' && (preview.cdo_refs?.hits.length ?? 0) > 0) {
        return blockedOutcome(preview, 'cdo_referenced')
      }
    }

    const agg = emptyAggregate(dryRun)
    agg.external_refs = externalRefs

    // 账本在**发出去之前**就开，理由见 openLedger 的注释
    const ledgerId = dryRun ? undefined : await openLedger(agg, args)

    let done = 0
    try {
      for (const batch of batches) {
        mergeResponse(
          agg,
          await callBatch({ ...common, moves: batch, dry_run: dryRun }, BATCH_TIMEOUT_MS, ctx)
        )
        done += 1
        if (totalCalls > 1) {
          ctx.report({
            text: dryRun
              ? `预演中：${done}/${totalCalls} 批`
              : `已搬 ${agg.moved} 个资产（${done}/${totalCalls} 批）`,
            details: agg
          })
        }
        // 插件的闸把这一批拦下了（预演过还被拦，多半是两次调用之间有人签出了文件）：
        // 后面的批次不再发，前面已经搬完的如实报
        if (!dryRun && agg.reason) break
      }
      if (folderMoves.length > 0 && !(agg.reason && !dryRun)) {
        mergeResponse(
          agg,
          await callBatch(
            { ...common, folder_moves: folderMoves, dry_run: dryRun },
            FOLDER_TIMEOUT_MS,
            ctx
          )
        )
      }
    } catch (error) {
      /**
       * 出错了。这里最要紧的是分清**这一批到底发出去了没有**。
       *
       * - 发出去了、结果不知道（引擎崩了、超时、用户按停止）：真机三次崩溃里
       *   改名其实每次都已经做完了、崩在收尾，所以既不能报「搬完了」也不能报
       *   「没搬」，只能标 interrupted 并告诉模型去 verify。
       * - **压根没发出去**（没连引擎、等注册表时超时或被取消）：底层那几句错误
       *   已经明说了「命令没有发出」。把它们也套上「结果未知、去 verify」，
       *   等于当着模型的面否掉一句确定的事实，还会在账本目录里留一份假的
       *   「中断」记录 —— 下次 list 出来吓人。
       *
       * 判据用错误类型：只有真正走到发送那一步才会抛 `WebSocketServiceError`；
       * 注册表轮询抛的是普通 Error，没连引擎抛的是 `UeNotConnectedError`。
       * 类型对上之后再看错误码 —— `E_CLIENT_NOT_FOUND` 也是发送前就抛的。
       */
      const reason = error instanceof Error ? error.message : String(error)
      const inFlight =
        error instanceof WebSocketServiceError &&
        error.code !== WebSocketErrorCode.E_CLIENT_NOT_FOUND
      const projectPath = getTargetProjectPath()

      if (!inFlight) {
        // 什么都没发出去：把账本收成一份空的 done，别留下假的「中断」
        if (ledgerId && projectPath) {
          await finalizeLedger(projectPath, ledgerId, { status: 'done', entries: [] })
        }
        throw error
      }

      if (ledgerId && projectPath) {
        await finalizeLedger(projectPath, ledgerId, {
          status: 'interrupted',
          entries: entriesFromItems(agg.items),
          interrupted_reason: `第 ${done + 1}/${totalCalls} 批：${reason}`
        })
      }
      const aborted =
        error instanceof WebSocketServiceError && error.code === WebSocketErrorCode.E_ABORTED
      throw new Error(
        `${reason}\n\n` +
          (aborted
            ? `你按了停止，但第 ${done + 1}/${totalCalls} 批已经发给引擎了 —— `
            : `已经发出去 ${done + 1}/${totalCalls} 批，`) +
          '这一批的结果**未知**：引擎崩在收尾阶段时，资产其实往往已经搬完了，' +
          '「断开」不等于「没做」。\n' +
          (ledgerId
            ? `别猜也别重试。这次搬迁的账本是 ${ledgerId}，` +
              `直接跑 ue_content_rollback action=verify id=${ledgerId} —— ` +
              '它只查磁盘，引擎还没起来也能跑，逐条告诉你哪些搬到位了、哪些没动。'
            : '这次没记成账本，只能在内容浏览器里逐个确认。')
      )
    }

    if (!dryRun) {
      await closeLedger(agg, ledgerId)
    }

    return {
      text: summarizeBatchMove(agg),
      details: agg,
      // 被闸拦下、或一个都没搬成又不是预演，算失败让模型看见
      isError:
        !dryRun &&
        (agg.reason !== undefined || (agg.moved === 0 && agg.planned > 0 && agg.failed > 0))
    }
  }
})
