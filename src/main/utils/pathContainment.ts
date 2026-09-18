import { resolve, sep } from 'path'

/**
 * 「这个路径是不是在那个目录里面」。
 *
 * 仓库里原本到处是裸 `target.startsWith(root)`，少了分隔符这一步：
 * `assetData` 与同级的 `assetDataXXX` 前缀相同，于是兄弟目录也被判成「在里面」。
 * 这种判断用在删文件和路径穿越防护上，判错一次就是删错文件或读到不该读的东西。
 *
 * Windows 上路径大小写不敏感，比较前统一大小写，否则 `C:\Vault` 与 `c:\vault`
 * 会被判成两个地方。
 */
export function isInsideDirectory(candidate: string, root: string): boolean {
  if (!candidate || !root) return false

  const normalize = (value: string): string => {
    const resolved = resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  const resolvedRoot = normalize(root)
  const resolvedCandidate = normalize(candidate)
  if (resolvedCandidate === resolvedRoot) return true

  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep
  return resolvedCandidate.startsWith(prefix)
}

/** 任意一个根目录命中即可。空/无效的根会被跳过，不会误放行 */
export function isInsideAnyDirectory(
  candidate: string,
  roots: readonly (string | undefined)[]
): boolean {
  return roots.some((root) => (root ? isInsideDirectory(candidate, root) : false))
}
