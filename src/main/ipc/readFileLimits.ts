export interface ReadFileLimitOptions {
  maxLines?: number
  maxBytes?: number
}

export interface ReadFileLimitResult {
  content: string
  hasMore: boolean
  totalLines?: number
  totalBytes?: number
  truncated: boolean
}

export function applyReadFileLimits(
  content: string,
  options?: ReadFileLimitOptions
): ReadFileLimitResult {
  const maxLines = options?.maxLines ?? 10
  const maxBytes = options?.maxBytes ?? 5000

  if (maxLines > 0) {
    const lines = content.split('\n')
    const hasMore = lines.length > maxLines
    return {
      content: lines.slice(0, maxLines).join('\n'),
      hasMore,
      totalLines: lines.length,
      truncated: hasMore
    }
  }

  if (maxBytes > 0 && content.length > maxBytes) {
    return {
      content: content.substring(0, maxBytes),
      hasMore: true,
      totalBytes: content.length,
      truncated: true
    }
  }

  return {
    content,
    hasMore: false,
    truncated: false
  }
}
