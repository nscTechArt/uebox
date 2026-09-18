export function stripAssetNameExtension(fileName: string): string {
  const trimmed = fileName.trim()
  if (!trimmed) return ''
  const lastDot = trimmed.lastIndexOf('.')
  if (lastDot <= 0) return trimmed
  return trimmed.substring(0, lastDot) || trimmed
}

export function getAssetNameFromFileName(fileName: string, fallback = 'unnamed'): string {
  return stripAssetNameExtension(fileName) || fallback
}

export function stripPathLeafExtension(pathValue: string): string {
  const normalized = pathValue.trim().replace(/\\/g, '/')
  if (!normalized) return ''
  const lastSlash = normalized.lastIndexOf('/')
  const prefix = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : ''
  const leaf = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
  if (!leaf) return normalized
  return `${prefix}${stripAssetNameExtension(leaf)}`
}
