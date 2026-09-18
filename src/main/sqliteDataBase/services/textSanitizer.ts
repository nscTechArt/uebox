/**
 * 文本清洗工具
 * 用于在发送到 Jina Embeddings API 之前清理无效 Unicode 字符
 * 防止 HTTP 400/500 错误
 */

/**
 * Sanitize text to remove invalid Unicode characters that can cause Jina API failures.
 * - Removes incomplete surrogate pairs (orphan high/low surrogates)
 * - Removes NULL characters and other control characters
 * - Replaces invalid sequences with empty string
 */
export const sanitizeText = (text: string): string => {
  if (!text) return text

  let result = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)

    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < text.length) {
        const nextCode = text.charCodeAt(i + 1)
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          result += text[i] + text[i + 1]
          i++
          continue
        }
      }
      continue
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      continue
    }

    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      continue
    }

    result += text[i]
  }

  return result
}

/**
 * 验证并清洗 embedding 输入数组
 * - 清洗无效 Unicode 字符
 * - 将空字符串替换为 placeholder
 * - 确保所有元素都是有效字符串
 */
export const sanitizeEmbeddingInputs = (inputs: string[], tag: string = 'Embedding'): string[] => {
  return inputs.map((input, idx) => {
    if (!input || typeof input !== 'string') {
      console.warn(`[${tag}] Invalid input at index ${idx}, using placeholder`)
      return '[empty]'
    }
    const sanitized = sanitizeText(input)
    const trimmed = sanitized.trim()
    if (trimmed.length === 0) {
      console.warn(`[${tag}] Empty string at index ${idx} after sanitization, using placeholder`)
      return '[empty]'
    }
    return trimmed
  })
}
