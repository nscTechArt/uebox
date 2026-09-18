/**
 * 备份模式下资产的 softPath 兜底推导。
 *
 * softPath 是「这个资产在 UE 工程里的逻辑路径」。解析得出来当然用解析结果，
 * 解析不出来（非 UE 文件、解析失败的 uasset）就得自己推一个。
 *
 * 原来的兜底是 `/Game/<文件名>`——**不含任何目录**。而备份清单正是按 softPath 去重的，
 * 于是 `A/preview.png` 和 `B/preview.png` 被判成同一个资产，其中一个被直接剔除出
 * 备份清单：它没有被复制进保管库，数据库记录只能指向用户的原始目录。
 * **用户哪天清理了源文件夹，那个资产就变成死链接。**
 *
 * 而同名文件在 UE 工程里是常态（`preview.png`、`T_Base.png`、`SM_Rock.uasset`
 * 在不同目录下重名），所以这条兜底几乎必然被踩到。
 *
 * 现在的规则：兜底路径必须带上目录结构，两个不同位置的文件就不会再撞在一起。
 */

const normalizeSlashes = (value: string): string => String(value || '').replace(/\\/g, '/')

const stripExtension = (value: string): string => value.replace(/\.[^./]+$/, '')

/** 去掉盘符、UNC 前缀和首尾斜杠，只留可以拼进 softPath 的那部分 */
const toPathSegments = (value: string): string[] =>
  normalizeSlashes(value)
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\/{2,}/, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')

/**
 * 从磁盘路径里认出 UE 工程结构（`.../Content/X/Y` → `/Game/X/Y`）。
 * 认不出来返回空串。
 */
export function deriveSoftPathFromDiskPath(diskPath: string): string {
  const withoutExt = stripExtension(normalizeSlashes(diskPath))

  const contentMarkerIndex = withoutExt.lastIndexOf('/Content/')
  if (contentMarkerIndex !== -1) {
    const suffix = withoutExt.slice(contentMarkerIndex + '/Content/'.length).replace(/^\/+/, '')
    return suffix ? `/Game/${suffix}` : ''
  }

  const gameMarkerIndex = withoutExt.lastIndexOf('/Game/')
  if (gameMarkerIndex !== -1) {
    const suffix = withoutExt.slice(gameMarkerIndex + '/Game/'.length).replace(/^\/+/, '')
    return suffix ? `/Game/${suffix}` : ''
  }

  return ''
}

/**
 * 兜底 softPath —— **保证两个不同位置的文件不会得到同一个值**。
 *
 * 优先级：
 *  1. 磁盘路径里有 UE 工程结构 → 按 Content/Game 之后的部分推
 *  2. 文件在导入根目录下 → 用相对于根目录的路径（保留目录层级）
 *  3. 都不满足（散文件导入，根是 'ALL'）→ 用文件自己的完整目录路径
 */
export function deriveFallbackSoftPath(filePath: string, rootFolderPath?: string): string {
  const fromDisk = deriveSoftPathFromDiskPath(filePath)
  if (fromDisk) return fromDisk

  const fileSegments = toPathSegments(stripExtension(normalizeSlashes(filePath)))
  if (fileSegments.length === 0) return ''

  const rootSegments =
    rootFolderPath && rootFolderPath !== 'ALL' ? toPathSegments(rootFolderPath) : []

  // 文件在导入根目录下 → 取相对路径，但把根目录名本身也带上，
  // 这样「同时导入两个同名子目录」也不会撞
  const underRoot =
    rootSegments.length > 0 &&
    rootSegments.every((segment, i) => fileSegments[i]?.toLowerCase() === segment.toLowerCase())

  if (underRoot) {
    const rootName = rootSegments[rootSegments.length - 1]
    const relative = fileSegments.slice(rootSegments.length)
    return `/Game/${[rootName, ...relative].join('/')}`
  }

  return `/Game/${fileSegments.join('/')}`
}
