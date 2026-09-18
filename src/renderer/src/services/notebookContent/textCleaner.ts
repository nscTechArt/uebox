/**
 * 文本清理工具函数
 * 提供统一的文本预处理能力，避免各服务重复实现
 */

/**
 * URL 匹配正则表达式
 * 匹配 http/https 协议的 URL 链接
 */
const URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi

/**
 * 移除文本中的 URL 链接
 * 用于避免触发 AI 模型的网页搜索功能
 * @param content 原始文本内容
 * @returns 移除 URL 后的文本
 */
export function removeUrls(content: string): string {
  return content.replace(URL_PATTERN, '')
}

/**
 * 移除 Markdown 代码块
 * @param content 原始文本内容
 * @returns 移除代码块后的文本
 */
export function removeCodeBlocks(content: string): string {
  // 匹配 ```...``` 格式的代码块
  return content.replace(/```[\s\S]*?```/g, '')
}

/**
 * 标准化空白字符
 * 将多个连续空行压缩为单个空行
 * @param content 原始文本内容
 * @returns 标准化后的文本
 */
export function normalizeWhitespace(content: string): string {
  return content.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 综合清理文本
 * 依次执行：移除 URL → 标准化空白
 * @param content 原始文本内容
 * @returns 清理后的文本
 */
export function cleanText(content: string): string {
  let result = removeUrls(content)
  result = normalizeWhitespace(result)
  return result
}
