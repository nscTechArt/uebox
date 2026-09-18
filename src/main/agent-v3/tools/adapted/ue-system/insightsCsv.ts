/**
 * Insights 导出 CSV 的通用解析。
 *
 * 独立成模块是为了能直接测——工具文件里混着 child_process、fs、WebSocket
 * 调用，那些都要打桩；这里只有字符串处理，不需要。
 *
 * 不假设具体列名。`TimingInsights.ExportTimerStatistics` 的输出格式没有
 * 官方文档，是从社区帖子的用法反推的，解析时用启发式找"名字列"和"总计列"，
 * 找不到就把原始列名如实回给调用方，而不是编一个可能是错的语义。
 */

export interface ParsedInsightsTable {
  columns: string[]
  rows: Record<string, string>[]
  malformedRowCount: number
}

/**
 * 不处理带引号转义的逗号：Insights 导出的计时器名字一般不含逗号，
 * 真遇到了会体现为 malformedRowCount，如实报出来而不是悄悄错位。
 */
export function parseGenericCsv(text: string): ParsedInsightsTable | null {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return null

  const columns = lines[0]!.split(',').map((c) => c.trim())
  const rows: Record<string, string>[] = []
  let malformedRowCount = 0

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(',')
    if (cells.length !== columns.length) {
      malformedRowCount++
      continue
    }
    const row: Record<string, string> = {}
    columns.forEach((col, idx) => {
      row[col] = (cells[idx] ?? '').trim()
    })
    rows.push(row)
  }

  return { columns, rows, malformedRowCount }
}

/** 按一串候选正则依次找列名，第一个模式优先——patterns 按"更精确"到"更宽松"排列 */
export function pickColumn(columns: string[], patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const found = columns.find((c) => pattern.test(c))
    if (found) return found
  }
  return undefined
}

export const TIMER_NAME_PATTERNS = [/name/i, /timer/i, /event/i]
export const TIMER_VALUE_PATTERNS = [
  /total.*incl/i,
  /inclusive/i,
  /total/i,
  /sum/i,
  /time.*ms/i,
  /ms$/i
]

export interface RankedInsightsRows {
  sortedBy?: string
  topEntries: Record<string, string>[]
}

/** 按识别出的总计列降序排，取前 N 条；识别不出就原样截断，不猜排序依据 */
export function rankRows(
  table: ParsedInsightsTable,
  valueColumn: string | undefined,
  limit: number
): RankedInsightsRows {
  if (!valueColumn) {
    return { topEntries: table.rows.slice(0, limit) }
  }
  const topEntries = [...table.rows]
    .sort(
      (a, b) => (parseFloat(b[valueColumn] ?? '0') || 0) - (parseFloat(a[valueColumn] ?? '0') || 0)
    )
    .slice(0, limit)
  return { sortedBy: valueColumn, topEntries }
}
