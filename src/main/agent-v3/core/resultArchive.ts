/**
 * 大结果存档：工具一次回一大张表时，只给模型目录页和一个编号，整份留在消息的 details 里。
 *
 * ## 为什么
 *
 * 工具结果进了上下文就不出来，之后每一轮请求都要原样再带一遍。本机 2,457 个真实会话里，
 * 工具结果占全部消息文字的 94.7%，而大结果几乎都是「同一种记录排成的一张表」——
 * 300 个工程模板、两百多个资产 —— 模型通常只用其中几行。
 * 设计和数据见 `docs/大结果存档与按需查询设计-2026-10-19.md`。
 *
 * ## 三条规则
 *
 * 1. 只认工具声明过的表（`ArchiveSpec`），不按结构去猜哪个字段是表。
 * 2. 表以外的字段原样留着；表换成目录列，在预算内能塞多少行塞多少行。
 * 3. **明说缺了什么。** 以前为了省 token 悄悄删过蓝图引脚，模型照着残缺的数据猜，
 *    错了也查不出原因（见 `getBlueprintGraph.ts` 文件头）。这里不是删，
 *    是收起来，并在同一个返回里讲清楚怎么拿。
 *
 * ## 不新建存储
 *
 * 完整文本放在这条工具结果的 `details.archive.text`。details 本来就随消息落盘、
 * 随会话恢复，压缩也只改发给模型的那份 —— 所以重启后、压缩后、子 agent 继承父消息后
 * 都能凭编号查到，不需要另写一套文件和清理。
 *
 * 这个文件是纯函数，不碰 fs / electron；接线在 `createAgent.ts` 的 `afterToolCall`。
 */

import type { ArchiveSpec } from '../tools/defineTool'

/**
 * 超过这么多字符才存档，查询的每一页也以它为上限。
 *
 * 从真实会话里挑的：预算取 8K / 16K / 32K / 50K 时，存档能省下的累计搬运量
 * 分别是 16.3% / 15.0% / 11.8% / 9.8%。从 8K 放到 16K 几乎不少省，被改变的调用却少很多；
 * 再往上就开始明显少省。约合 4–5K token。全局只有这一个数，不按工具单配。
 */
export const ARCHIVE_BUDGET_CHARS = 16_000

export const RESULT_QUERY_TOOL_NAME = 'result_query'

/** 存在 details 里的那份 */
export interface ArchiveRecord {
  ref: string
  /** 哪个字段是表 */
  list: string
  /** 原本要给模型的完整文本（JSON） */
  text: string
}

type Row = Record<string, unknown>

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pick(row: Row, columns: readonly string[]): Row {
  const out: Row = {}
  for (const column of columns) {
    if (row[column] !== undefined && row[column] !== null && row[column] !== '') {
      out[column] = row[column]
    }
  }
  return out
}

/** 这张表里出现过的全部列，按首次出现排 */
function columnsOf(rows: Row[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key)
  return [...seen]
}

/** `r3` → 3；不是编号就 0 */
export function refNumber(ref: unknown): number {
  const match = typeof ref === 'string' ? /^r(\d+)$/.exec(ref) : null
  return match ? Number(match[1]) : 0
}

/** 消息上挂的存档，没有就 undefined */
export function archiveOf(message: unknown): ArchiveRecord | undefined {
  const m = message as { role?: string; details?: { archive?: unknown } } | null
  if (m?.role !== 'toolResult') return undefined
  const archive = m.details?.archive as Partial<ArchiveRecord> | undefined
  if (
    typeof archive?.ref !== 'string' ||
    typeof archive.list !== 'string' ||
    typeof archive.text !== 'string'
  ) {
    return undefined
  }
  return archive as ArchiveRecord
}

/**
 * 发给界面的 details：存档那份完整文本剔掉，只留编号。
 *
 * 界面要显示的东西还在 details 原有的字段里（存档只是往上挂了一项）；
 * 不剔的话，聊天记录（`userData/chat-history`）会把同样大的一段文字再存一遍。
 */
export function detailsForRenderer(details: unknown): unknown {
  const archive = (details as { archive?: Partial<ArchiveRecord> } | null)?.archive
  if (!archive || typeof archive !== 'object') return details
  return {
    ...(details as Record<string, unknown>),
    archive: { ref: archive.ref, list: archive.list }
  }
}

/** 历史里用过的最大编号。会话恢复、子 agent 继承父消息之后，新编号从它往后接 */
export function lastRefIn(messages: readonly unknown[]): number {
  let last = 0
  for (const message of messages) last = Math.max(last, refNumber(archiveOf(message)?.ref))
  return last
}

export interface ArchiveOutcome {
  /** 给模型的目录页 */
  text: string
  record: ArchiveRecord
}

/**
 * 判断要不要存档，要的话造出目录页。
 *
 * 不存档的情况都返回 null、调用方照原样给：没超预算、不是 JSON 对象、声明的表一个都不在、
 * 或者目录页并不比原文小。
 */
export function archiveResult(text: string, spec: ArchiveSpec, ref: string): ArchiveOutcome | null {
  if (text.length <= ARCHIVE_BUDGET_CHARS) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRow(parsed)) return null

  const list = Object.keys(spec.lists).find(
    (key) =>
      spec.lists[key] !== undefined &&
      Array.isArray(parsed[key]) &&
      (parsed[key] as unknown[]).every(isRow)
  )
  if (!list) return null

  const rows = parsed[list] as Row[]
  const catalog = spec.lists[list] ?? []
  const allColumns = columnsOf(rows)
  const rest: Row = { ...parsed }
  delete rest[list]

  const archived = (shown: number): Row => ({
    ref,
    list,
    total_rows: rows.length,
    shown_rows: shown,
    catalog_columns: catalog,
    all_columns: allColumns,
    note:
      `结果太大，这里只是目录：${list} 共 ${rows.length} 行，` +
      (shown < rows.length ? `列出了前 ${shown} 行的 ` : '每行只列了 ') +
      `${catalog.join(' / ')} 这几列。完整的行（全部 ${allColumns.length} 列）` +
      (shown < rows.length ? `和其余 ${rows.length - shown} 行` : '') +
      `用 ${RESULT_QUERY_TOOL_NAME} 按条件取，例如 {"ref":"${ref}","search":"关键词"} 或 ` +
      `{"ref":"${ref}","where":{"${catalog[0] ?? allColumns[0] ?? 'name'}":"值"}}。`
  })

  // 先量出不放行的骨架，再一行行往里加，直到预算用完。
  // 说明文字随列出几行而变（全列出时没有「和其余 N 行」），按两种写法里长的那种留够
  const skeleton = (shown: number): number =>
    JSON.stringify({ ...rest, archived: archived(shown), [list]: [] }).length
  let used = Math.max(skeleton(0), skeleton(rows.length))
  const shownRows: Row[] = []
  for (const row of rows) {
    const line = JSON.stringify(pick(row, catalog))
    if (used + line.length + 1 > ARCHIVE_BUDGET_CHARS) break
    shownRows.push(JSON.parse(line) as Row)
    used += line.length + 1
  }

  const preview = JSON.stringify({
    ...rest,
    archived: archived(shownRows.length),
    [list]: shownRows
  })
  if (preview.length >= text.length) return null
  return { text: preview, record: { ref, list, text } }
}

export interface ArchiverDeps {
  /** 当前 agent 的完整消息历史，用来接着往后编号 */
  getMessages: () => readonly unknown[]
  /** 这个工具声明的表；没声明就不参与 */
  specFor: (toolName: string) => ArchiveSpec | undefined
  /**
   * `result_query` 在不在这个 agent 的工具池里。按名单授权的会话可能没有它 ——
   * 给了编号却没有工具能查，比整份给还糟，那就不存
   */
  canQuery: () => boolean
  /** 把 `result_query` 加载上，返回加载记录（工具搜索关着时为 undefined） */
  loadQueryTool: () => unknown
}

/** `afterToolCall` 里用得到的那几样，结构上兼容 pi 的 `AfterToolCallContext` */
export interface ArchivableCall<TPart extends { type: string }> {
  isError: boolean
  toolCall: { name: string }
  result: { content?: TPart[]; details?: unknown }
}

export type ResultArchiver = <TPart extends { type: string }>(
  call: ArchivableCall<TPart>
) => { content: TPart[]; details: Record<string, unknown> } | undefined

/**
 * 造一个挂在 `afterToolCall` 上的存档器：结果该存档就返回改写后的 content 和 details，
 * 否则 undefined（调用方照原样给）。
 *
 * - 完整文本挂进 `details.archive`；原来的 details 字段一个不动，界面照旧读。
 * - 第一次存档时顺手加载 `result_query`，加载记录写进这条结果的 `details.toolSearch` ——
 *   和 `load_skill` 同一个写法，重启后 `toolSearch.restore` 照样恢复。
 * - 编号用计数器发，不按消息现数：同一轮里并行的两个工具会同时走到这里，
 *   那时谁的结果都还没进消息历史。第一次用时从历史接着往后编
 *   （恢复的会话、继承了父消息的子 agent）。
 */
export function createResultArchiver(deps: ArchiverDeps): ResultArchiver {
  let lastRef: number | undefined
  return <TPart extends { type: string }>(call: ArchivableCall<TPart>) => {
    if (call.isError || !deps.canQuery()) return undefined
    const spec = deps.specFor(call.toolCall.name)
    if (!spec) return undefined
    const parts = call.result.content ?? []
    const textParts = parts.filter((part) => part.type === 'text') as unknown as Array<{
      text?: unknown
    }>
    if (textParts.length !== 1 || typeof textParts[0].text !== 'string') return undefined
    const original = call.result.details
    if (original !== undefined && !isRow(original)) return undefined

    lastRef ??= lastRefIn(deps.getMessages())
    const outcome = archiveResult(textParts[0].text, spec, `r${lastRef + 1}`)
    if (!outcome) return undefined
    lastRef += 1

    const loaded = deps.loadQueryTool()
    return {
      content: parts.map((part) =>
        part.type === 'text' ? ({ ...part, text: outcome.text } as TPart) : part
      ),
      details: {
        ...original,
        archive: outcome.record,
        ...(loaded ? { toolSearch: loaded } : {})
      }
    }
  }
}

export interface QueryParams {
  where?: Record<string, unknown>
  search?: string
  fields?: string[]
  offset?: number
  limit?: number
}

function sameValue(cell: unknown, wanted: unknown): boolean {
  if (cell === undefined || cell === null) return false
  if (typeof cell === 'object') return false
  return String(cell).toLowerCase() === String(wanted).toLowerCase()
}

/** 一行里所有的文字和数字，嵌套的也算 —— search 就在这里面找子串 */
function textValues(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out
  if (typeof value === 'string') out.push(value.toLowerCase())
  else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value))
  else if (Array.isArray(value)) for (const item of value) textValues(item, out)
  else if (typeof value === 'object') for (const item of Object.values(value)) textValues(item, out)
  return out
}

function matches(row: Row, params: QueryParams): boolean {
  for (const [column, wanted] of Object.entries(params.where ?? {})) {
    const options = Array.isArray(wanted) ? wanted : [wanted]
    if (!options.some((option) => sameValue(row[column], option))) return false
  }
  const needle = params.search?.trim().toLowerCase()
  if (needle && !textValues(row).some((text) => text.includes(needle))) return false
  return true
}

/**
 * 在一份存档里查行。
 *
 * 返回同样受 `ARCHIVE_BUDGET_CHARS` 约束：塞不下就给 `next_offset`。
 * 单独一行就超预算时照样给这一行 —— 行是最小单位，拆开反而没法用。
 */
export function queryArchive(record: ArchiveRecord, params: QueryParams): Row {
  const parsed = JSON.parse(record.text) as Row
  const rows = (parsed[record.list] as Row[]) ?? []
  const allColumns = columnsOf(rows)

  const unknownColumns = [...Object.keys(params.where ?? {}), ...(params.fields ?? [])].filter(
    (column) => !allColumns.includes(column)
  )

  const matched = rows.filter((row) => matches(row, params))
  const offset = Math.max(0, params.offset ?? 0)
  const limit = params.limit ?? matched.length

  const head: Row = {
    ref: record.ref,
    list: record.list,
    matched: matched.length,
    offset,
    ...(unknownColumns.length > 0
      ? {
          unknown_columns: [...new Set(unknownColumns)],
          columns: allColumns
        }
      : {})
  }

  let used = JSON.stringify({
    ...head,
    returned: matched.length,
    next_offset: matched.length,
    rows: []
  }).length
  const out: Row[] = []
  for (const row of matched.slice(offset, offset + limit)) {
    const shaped = params.fields?.length ? pick(row, params.fields) : row
    const line = JSON.stringify(shaped)
    if (out.length > 0 && used + line.length + 1 > ARCHIVE_BUDGET_CHARS) break
    out.push(shaped)
    used += line.length + 1
  }

  const next = offset + out.length
  return {
    ...head,
    returned: out.length,
    ...(next < matched.length ? { next_offset: next } : {}),
    rows: out
  }
}

/**
 * 快照说明：这份存档是哪个工具在什么时候读的，之后又动过几次东西。
 *
 * 「动过」只认工具自己声明的风险（`isMutating`），不猜某个工具改没改到这张表 ——
 * 宁可多提醒一句「可能已变」，也不替引擎打包票说没变。
 */
export function describeSnapshot(
  messages: readonly unknown[],
  ref: string,
  isMutating: (toolName: string, args: unknown) => boolean
): { toolName: string; note: string } | undefined {
  const index = messages.findIndex((message) => archiveOf(message)?.ref === ref)
  if (index < 0) return undefined
  const source = messages[index] as { toolName?: string }
  const toolName = source.toolName ?? '工具'

  // 工具调用的参数在 assistant 消息里，按 id 对上
  const argsById = new Map<string, unknown>()
  for (const message of messages) {
    const m = message as { role?: string; content?: unknown }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const block of m.content as Array<{ type?: string; id?: string; arguments?: unknown }>) {
      if (block.type === 'toolCall' && block.id) argsById.set(block.id, block.arguments)
    }
  }

  let changes = 0
  for (const message of messages.slice(index + 1)) {
    const m = message as {
      role?: string
      toolName?: string
      toolCallId?: string
      isError?: boolean
    }
    if (m.role !== 'toolResult' || m.isError || !m.toolName) continue
    if (isMutating(m.toolName, argsById.get(m.toolCallId ?? ''))) changes += 1
  }

  return {
    toolName,
    note:
      changes === 0
        ? `快照：${toolName} 当时的结果，之后没有执行过修改类工具。`
        : `快照：${toolName} 当时的结果。之后执行过 ${changes} 个修改类工具，数据可能已变；` +
          `需要最新状态请重新调用 ${toolName}。`
  }
}
