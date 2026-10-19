/**
 * 大结果存档：工具一次回一大张表时，只给模型目录页和一个编号，整份留在消息的 details 里。
 *
 * ## 为什么
 *
 * 工具结果进了上下文就不出来，之后每一轮请求都要原样再带一遍。本机 2,457 个真实会话里，
 * 工具结果占全部消息文字的 94.7%，而大结果几乎都是「同一种记录排成的一张表」——
 * 300 个工程模板、两百多个资产、两百个蓝图节点 —— 模型通常只用其中几行。
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
 * ## 两种来源
 *
 * - `text`（默认）：给模型的文本就是一份 JSON，表在里面。目录页**替换**它。
 * - `details`：工具自己把结果排成了文字、并已自行封顶（`material_get_graph`），
 *   表在 details 里。文字原样给，后面**补一句**存档编号 —— 补的是被它自己的额度
 *   截掉的那部分怎么拿。以前那部分是死路：没有别的工具读得到。
 *
 * ## 不新建存储
 *
 * 完整数据放在这条工具结果的 `details.archive.text`。details 本来就随消息落盘、
 * 随会话恢复，压缩也只改发给模型的那份 —— 所以重启后、压缩后、子 agent 继承父消息后
 * 都能凭编号查到，不需要另写一套文件和清理。
 *
 * 这个文件是纯函数，不碰 fs / electron；接线在 `createAgent.ts` 的 `afterToolCall`。
 */

import type { ArchiveSpec } from '../tools/defineTool'

/**
 * 超过这么多字符才存档，目录页和查询的每一页也以它为上限。
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
  /** 哪几个字段是表，按声明顺序 */
  lists: string[]
  /**
   * 原本要给模型的那份完整文本（JSON）。表就在这条消息的 details 里时不带它
   * （`source: 'details'`），再存一份只会让会话文件翻倍
   */
  text?: string
  /**
   * 表在 details 里时明说出来。不能拿「没有 text」来判：界面那份 details 也剔掉了 text
   * （`detailsForRenderer`），两者就分不开了
   */
  source?: 'details'
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
    !Array.isArray(archive.lists) ||
    (typeof archive.text !== 'string' && archive.source !== 'details')
  ) {
    return undefined
  }
  return archive as ArchiveRecord
}

/**
 * 最近解析过的几份存档。模型翻页时同一份会被连着查好几次，每次重新 parse 十几万字符不划算；
 * 但只留最近两份 —— 消息活多久缓存就活多久的话，长会话会一直攥着几 MB 解析结果不放
 */
const PARSED_CACHE_SIZE = 2
const parsedArchives = new Map<object, Row>()

/** 存档里的表在哪：`details` 来源就是消息的 details 本身，否则解析那份文本 */
export function archiveDataOf(message: unknown): Row | undefined {
  const record = archiveOf(message)
  if (!record) return undefined
  if (record.source === 'details') {
    const details = (message as { details?: unknown }).details
    return isRow(details) ? details : undefined
  }
  const key = message as object
  let data = parsedArchives.get(key)
  if (data) {
    parsedArchives.delete(key)
  } else {
    data = JSON.parse(record.text as string) as Row
  }
  parsedArchives.set(key, data)
  while (parsedArchives.size > PARSED_CACHE_SIZE) {
    parsedArchives.delete(parsedArchives.keys().next().value as object)
  }
  return data
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
  // 工具本来没有 details、是存档器给它造的：剩下的只有编号和工具加载记录，
  // 界面拿去当结果显示就成了一个空壳 —— 交回 undefined，让界面照旧显示正文
  const own = Object.keys(details as Row).filter((key) => key !== 'archive' && key !== 'toolSearch')
  if (own.length === 0) return undefined
  return {
    ...(details as Record<string, unknown>),
    archive: { ref: archive.ref, lists: archive.lists }
  }
}

/** 历史里用过的最大编号。会话恢复、子 agent 继承父消息之后，新编号从它往后接 */
export function lastRefIn(messages: readonly unknown[]): number {
  let last = 0
  for (const message of messages) last = Math.max(last, refNumber(archiveOf(message)?.ref))
  return last
}

interface Table {
  key: string
  rows: Row[]
  catalog: readonly string[]
  allColumns: string[]
}

/** 声明过、且这次结果里真有的表 */
function tablesIn(parsed: Row, spec: ArchiveSpec): Table[] {
  return Object.entries(spec.lists).flatMap(([key, catalog]) => {
    const rows = parsed[key]
    if (!catalog || !Array.isArray(rows) || !rows.every(isRow)) return []
    return [{ key, rows: rows as Row[], catalog, allColumns: columnsOf(rows as Row[]) }]
  })
}

/** 查询示例。多张表时带上 list，告诉模型这个参数存在 */
function queryExample(ref: string, tables: Table[]): string {
  const first = tables[0]
  const column = first.catalog[0] ?? first.allColumns[0] ?? 'name'
  const list = tables.length > 1 ? `"list":"${first.key}",` : ''
  return (
    `例如 {"ref":"${ref}",${list}"where":{"${column}":"值"}} 或 {"ref":"${ref}",${list}"search":"关键词"}` +
    (tables.length > 1 ? `；list 可选 ${tables.map((t) => t.key).join(' / ')}` : '')
  )
}

export interface ArchiveOutcome {
  /** 给模型的目录页 */
  text: string
  record: ArchiveRecord
}

/**
 * `text` 来源：判断要不要存档，要的话造出目录页。
 *
 * 不存档的情况都返回 null、调用方照原样给：没超预算、不是 JSON 对象、声明的表一个都不在、
 * 或者目录页并不比原文小。
 *
 * 多张表时按声明顺序往目录页里填行，预算先给排在前面的表（蓝图是节点先于连线：
 * 先知道图里有什么，连线可以按节点 id 去查）。
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

  const tables = tablesIn(parsed, spec)
  if (tables.length === 0) return null

  const rest: Row = { ...parsed }
  for (const table of tables) delete rest[table.key]

  const catalogRows = tables.map((table) => table.rows.map((row) => pick(row, table.catalog)))

  const build = (shown: number[]): string => {
    const summary = tables.map((table, i) => {
      const n = shown[i]
      const cols = table.catalog.join(' / ')
      if (n === 0) return `${table.key} 共 ${table.rows.length} 行，这里一行都没列`
      if (n < table.rows.length) {
        return `${table.key} 共 ${table.rows.length} 行，列出了前 ${n} 行的 ${cols} 这几列，其余 ${table.rows.length - n} 行没列`
      }
      return `${table.key} 共 ${table.rows.length} 行，每行只列了 ${cols} 这几列`
    })
    const archived = {
      ref,
      lists: Object.fromEntries(
        tables.map((table, i) => [
          table.key,
          {
            total_rows: table.rows.length,
            shown_rows: shown[i],
            catalog_columns: table.catalog,
            all_columns: table.allColumns
          }
        ])
      ),
      note:
        `结果太大，这里只是目录：${summary.join('；')}。完整的行和没列出的行用 ` +
        `${RESULT_QUERY_TOOL_NAME} 按条件取，${queryExample(ref, tables)}。`
    }
    return JSON.stringify({
      ...rest,
      archived,
      ...Object.fromEntries(
        tables.map((table, i) => [table.key, catalogRows[i].slice(0, shown[i])])
      )
    })
  }

  // 按声明顺序一行行往里填，每加一行量一次真实长度 —— 说明文字随列出的行数在变，
  // 估出来的骨架长度靠不住（第一版就因此超了预算十个字符）。
  // 先按每行的长度粗填，最后再用真实长度往回退，保证不超
  const shown = tables.map(() => 0)
  let used = build(shown).length
  for (let i = 0; i < tables.length; i++) {
    for (const row of catalogRows[i]) {
      const line = JSON.stringify(row).length + 1
      if (used + line > ARCHIVE_BUDGET_CHARS) break
      shown[i] += 1
      used += line
    }
    if (shown[i] < catalogRows[i].length) break
  }
  let preview = build(shown)
  for (let i = tables.length - 1; i >= 0 && preview.length > ARCHIVE_BUDGET_CHARS; ) {
    if (shown[i] === 0) {
      i -= 1
      continue
    }
    shown[i] -= 1
    preview = build(shown)
  }

  if (preview.length >= text.length) return null
  return { text: preview, record: { ref, lists: tables.map((t) => t.key), text } }
}

/**
 * `details` 来源：工具的文字原样给，后面补一句存档编号。
 *
 * 判据和 `text` 来源同一个：完整数据超预算才存。没超说明工具自己的文字放得下全部，
 * 不需要另一条取数的路。
 */
export function archiveDetails(
  details: unknown,
  spec: ArchiveSpec,
  ref: string
): { note: string; record: ArchiveRecord } | null {
  if (!isRow(details)) return null
  const text = JSON.stringify(details)
  if (text.length <= ARCHIVE_BUDGET_CHARS) return null
  const tables = tablesIn(details, spec)
  if (tables.length === 0) return null

  const summary = tables.map((table) => `${table.key} ${table.rows.length} 行`).join('、')
  return {
    note:
      `完整数据已存档为 ${ref}（${summary}，含全部字段）。上面没展开或没列出的部分用 ` +
      `${RESULT_QUERY_TOOL_NAME} 按条件取，${queryExample(ref, tables)}。`,
    record: { ref, lists: tables.map((t) => t.key), source: 'details' }
  }
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

/**
 * details 里是不是已经有一模一样的表。适配工具的 details 就是给模型的那份结果对象
 * （见 `adaptV2Tool` 的 toText），这时存档不必另存文本 —— 会话文件里本来就有一份。
 * 逐张表比序列化结果：只要有一张对不上（比如 details 是插件原始回包），就老实存文本
 */
function sameTablesInDetails(record: ArchiveRecord, details: unknown): boolean {
  if (!isRow(details) || record.text === undefined) return false
  const parsed = JSON.parse(record.text) as Row
  return record.lists.every(
    (list) => JSON.stringify(details[list]) === JSON.stringify(parsed[list])
  )
}

export type ResultArchiver = <TPart extends { type: string }>(
  call: ArchivableCall<TPart>
) => { content: TPart[]; details: Record<string, unknown> } | undefined

/**
 * 造一个挂在 `afterToolCall` 上的存档器：结果该存档就返回改写后的 content 和 details，
 * 否则 undefined（调用方照原样给）。
 *
 * - 完整数据挂进 `details.archive`；原来的 details 字段一个不动，界面照旧读。
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
    const ref = `r${lastRef + 1}`

    let content: TPart[]
    let record: ArchiveRecord
    if (spec.source === 'details') {
      const outcome = archiveDetails(original, spec, ref)
      if (!outcome) return undefined
      // 工具自己的正文加上编号放得下，就照原样给 —— 中等大小的图正文本来是完整的，
      // 换小额度只会把已经列出来的引脚挤掉。放不下才换小额度那一版
      const full = textParts[0].text as string
      const fits = full.length + 2 + outcome.note.length <= ARCHIVE_BUDGET_CHARS
      const body = !fits && spec.compact ? spec.compact(original) : full
      content = parts.map((part) =>
        part.type === 'text' ? ({ ...part, text: `${body}\n\n${outcome.note}` } as TPart) : part
      )
      record = outcome.record
    } else {
      const outcome = archiveResult(textParts[0].text, spec, ref)
      if (!outcome) return undefined
      content = parts.map((part) =>
        part.type === 'text' ? ({ ...part, text: outcome.text } as TPart) : part
      )
      record = sameTablesInDetails(outcome.record, original)
        ? { ref, lists: outcome.record.lists, source: 'details' }
        : outcome.record
    }
    lastRef += 1

    const loaded = deps.loadQueryTool()
    return {
      content,
      details: {
        ...original,
        archive: record,
        ...(loaded ? { toolSearch: loaded } : {})
      }
    }
  }
}

export interface QueryParams {
  /** 多张表时查哪一张，默认第一张 */
  list?: string
  where?: Record<string, unknown>
  search?: string
  /** search 只在这几列里找。不给就找整行 —— 路径这类长字段很容易让短关键词误中 */
  search_in?: string[]
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
  const scope = params.search_in?.length ? pick(row, params.search_in) : row
  if (needle && !textValues(scope).some((text) => text.includes(needle))) return false
  return true
}

/**
 * 在一份存档里查行。`data` 是存档里的表所在的那个对象（见 `archiveDataOf`）。
 *
 * 返回同样受 `ARCHIVE_BUDGET_CHARS` 约束：塞不下就给 `next_offset`。
 * `preface` 是调用方要排在最前面的字段（快照说明），一起算进预算 ——
 * 不算的话整页会比预算多出那一句。
 * 单独一行就超预算时照样给这一行 —— 行是最小单位，拆开反而没法用。
 * 表名写错了抛出去，并列出有哪几张。
 */
export function queryArchive(
  record: Pick<ArchiveRecord, 'ref' | 'lists'>,
  data: Row,
  params: QueryParams,
  preface: Row = {}
): Row {
  const list = params.list ?? record.lists[0]
  if (!record.lists.includes(list)) {
    throw new Error(`存档 ${record.ref} 里没有 ${list} 这张表，有：${record.lists.join('、')}。`)
  }
  // 只给 search_in 不给 search 什么也筛不了；照常返回全表的话，模型会以为已经筛过了
  if (params.search_in?.length && !params.search?.trim()) {
    throw new Error(
      'search_in 只限定 search 在哪几列里找，要和 search 一起用；按列等值筛用 where。'
    )
  }
  const rows = (data[list] as Row[]) ?? []
  const allColumns = columnsOf(rows)

  const unknownColumns = [
    ...Object.keys(params.where ?? {}),
    ...(params.fields ?? []),
    ...(params.search_in ?? [])
  ].filter((column) => !allColumns.includes(column))

  const matched = rows.filter((row) => matches(row, params))
  const offset = Math.max(0, params.offset ?? 0)
  const limit = params.limit ?? matched.length

  const head: Row = {
    ...preface,
    ref: record.ref,
    list,
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
  /** 存档所在那条消息的下标。由调用方找：它本来就要先找到这条消息才能查 */
  index: number,
  isMutating: (toolName: string, args: unknown) => boolean
): { toolName: string; note: string } | undefined {
  if (!archiveOf(messages[index])) return undefined
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
