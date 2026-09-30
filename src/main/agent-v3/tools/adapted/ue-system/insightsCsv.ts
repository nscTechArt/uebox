/**
 * Insights 导出 CSV 的通用解析。
 *
 * 独立成模块是为了能直接测——工具文件里混着 child_process、fs、WebSocket
 * 调用，那些都要打桩；这里只有字符串处理，不需要。
 *
 * 这里只管把文本切成行和列，不管列是什么意思 —— 列的语义见 insightsBreakdown.ts。
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
