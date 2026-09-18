/**
 * Excel 文件解析工具
 * 使用 xlsx 库解析 Excel 文件内容，转换为 Markdown 表格格式
 */

import type * as XLSXTypes from 'xlsx'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 懒加载 xlsx。
 *
 * 这个包近 8MB，只有用户真的往笔记里拖一个 Excel 时才用得到，
 * 顶层 import 会把它钉进启动路径。类型是 `import type`，编译后不留痕迹。
 */
let cachedXlsx: typeof XLSXTypes | null = null

function loadXlsx(): typeof XLSXTypes {
  if (!cachedXlsx) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedXlsx = require('xlsx') as typeof XLSXTypes
  }
  return cachedXlsx
}

/**
 * Excel 解析结果接口
 */
export interface ExcelParseResult {
  /** 是否成功 */
  success: boolean
  /** 解析后的文本内容（Markdown 表格格式） */
  content?: string
  /** 总行数 */
  rowCount?: number
  /** 工作表名称 */
  sheetName?: string
  /** 文件名 */
  fileName?: string
  /** 是否被截断 */
  truncated?: boolean
  /** 错误信息 */
  error?: string
}

/** 最大行数限制 */
const MAX_ROWS = 500
/** 最大文件大小（5MB） */
const MAX_FILE_SIZE = 5 * 1024 * 1024

/**
 * 解析 Excel 文件
 * @param filePath 文件路径
 * @returns 解析结果
 */
export function parseExcelFile(filePath: string): ExcelParseResult {
  try {
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在' }
    }

    // 检查文件大小
    const stats = fs.statSync(filePath)
    if (stats.size > MAX_FILE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2)
      return { success: false, error: `文件过大（${sizeMB}MB），最大支持 5MB` }
    }

    // 读取文件
    const buffer = fs.readFileSync(filePath)
    return parseExcelBuffer(buffer, path.basename(filePath))
  } catch (error) {
    console.error('[ExcelParser] 解析文件失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '解析文件失败'
    }
  }
}

/**
 * 解析 Excel Buffer
 * @param buffer 文件 Buffer
 * @param fileName 文件名（用于显示）
 * @returns 解析结果
 */
export function parseExcelBuffer(buffer: Buffer, fileName?: string): ExcelParseResult {
  try {
    const XLSX = loadXlsx()

    // 尝试解析工作簿
    let workbook: XLSXTypes.WorkBook
    try {
      workbook = XLSX.read(buffer, { type: 'buffer' })
    } catch (parseError) {
      // 解析失败，可能是密码保护或格式损坏
      console.error('[ExcelParser] 工作簿解析失败:', parseError)
      return {
        success: false,
        error: '无法解析此文件，可能是格式损坏或受密码保护'
      }
    }

    // 获取第一个工作表
    const sheetNames = workbook.SheetNames
    if (!sheetNames || sheetNames.length === 0) {
      return { success: false, error: '文件中没有工作表' }
    }

    const sheetName = sheetNames[0]
    const worksheet = workbook.Sheets[sheetName]

    // 转换为 JSON 数组
    const jsonData = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1, // 使用数组格式（包含表头）
      defval: '' // 空单元格默认值
    })

    // 检查是否为空
    if (!jsonData || jsonData.length === 0) {
      return {
        success: false,
        error: '文件内容为空',
        sheetName,
        fileName
      }
    }

    // 过滤空行
    const nonEmptyRows = jsonData.filter(
      (row) => row && row.some((cell) => cell !== '' && cell !== null && cell !== undefined)
    )

    if (nonEmptyRows.length === 0) {
      return {
        success: false,
        error: '文件内容为空',
        sheetName,
        fileName
      }
    }

    // 检查是否需要截断
    const truncated = nonEmptyRows.length > MAX_ROWS
    const rowsToProcess = truncated ? nonEmptyRows.slice(0, MAX_ROWS) : nonEmptyRows

    // 转换为 Markdown 表格
    const markdown = convertToMarkdownTable(rowsToProcess)

    // 构建结果
    let content = markdown
    if (truncated) {
      content += `\n\n> ⚠️ 注意：文件共 ${nonEmptyRows.length} 行，仅显示前 ${MAX_ROWS} 行`
    }

    return {
      success: true,
      content,
      rowCount: nonEmptyRows.length,
      sheetName,
      fileName,
      truncated
    }
  } catch (error) {
    console.error('[ExcelParser] 解析失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '解析失败'
    }
  }
}

/**
 * 将二维数组转换为 Markdown 表格
 * @param rows 数据行
 * @returns Markdown 表格字符串
 */
function convertToMarkdownTable(rows: unknown[][]): string {
  if (rows.length === 0) return ''

  // 获取最大列数
  const maxCols = Math.max(...rows.map((row) => row.length))

  // 处理表头（第一行）
  const headerRow = rows[0] || []
  const headers = Array.from({ length: maxCols }, (_, i) => {
    const cell = headerRow[i]
    return formatCell(cell) || `列${i + 1}`
  })

  // 构建表头行
  const headerLine = '| ' + headers.join(' | ') + ' |'
  const separatorLine = '| ' + headers.map(() => '---').join(' | ') + ' |'

  // 构建数据行
  const dataLines = rows.slice(1).map((row) => {
    const cells = Array.from({ length: maxCols }, (_, i) => {
      return formatCell(row[i])
    })
    return '| ' + cells.join(' | ') + ' |'
  })

  return [headerLine, separatorLine, ...dataLines].join('\n')
}

/**
 * 格式化单元格内容
 * @param cell 单元格值
 * @returns 格式化后的字符串
 */
function formatCell(cell: unknown): string {
  if (cell === null || cell === undefined || cell === '') {
    return ''
  }

  // 转换为字符串
  let str = String(cell)

  // 转义 Markdown 表格特殊字符
  str = str.replace(/\|/g, '\\|')
  str = str.replace(/\n/g, ' ')

  // 限制单元格长度（避免表格过宽）
  if (str.length > 100) {
    str = str.slice(0, 97) + '...'
  }

  return str
}

export default {
  parseExcelFile,
  parseExcelBuffer
}
