/**
 * UE 的包路径 / 对象路径互转。
 *
 * 引擎在不同地方用不同形状指同一个资产：
 *
 *   包路径 (package path)  `/Game/Materials/M_Rock`
 *   对象路径 (object path) `/Game/Materials/M_Rock.M_Rock`
 *
 * `UObject::GetPathName()` 回的是**对象路径**，而我们在 app 侧算出来、
 * 传给 `material.create` / `ue_save` 的通常是**包路径** —— 两者直接
 * 字符串相等比，每一次正常操作都会被判成「路径不对」。
 *
 * 这不是假想的：`material.create` 的回执用的就是 `GetPathName()`，
 * 而调用方拿它跟自己拼的 `/Game/X/M_Test` 比，永远不等。
 *
 * 所以凡是要比较 UE 资产路径的地方，两边都先过 `toPackagePath()`。
 */

/** 只有 `/Game/...`、`/Engine/...` 这类以 `/` 开头的才是 UE 资产路径 */
export function isUeAssetPath(path: string): boolean {
  return typeof path === 'string' && path.startsWith('/') && path.length > 1
}

/**
 * 归一化成包路径。
 *
 * `/Game/X/M.M`      → `/Game/X/M`
 * `/Game/X/M.M:Sub`  → `/Game/X/M`（子对象也归到它所在的包）
 * `/Game/X/M`        → 原样
 *
 * 只砍**最后一段里**的 `.`，不碰目录名里的点 —— `/Game/v1.2/M` 里那个
 * 点属于目录，砍掉就指到别的地方去了。
 */
export function toPackagePath(path: string): string {
  if (!isUeAssetPath(path)) return path

  const trimmed = path.trim()
  const lastSlash = trimmed.lastIndexOf('/')
  const head = trimmed.slice(0, lastSlash + 1)
  const tail = trimmed.slice(lastSlash + 1)

  const dot = tail.indexOf('.')
  if (dot < 0) return trimmed

  return head + tail.slice(0, dot)
}

/**
 * 归一化成对象路径。包名最后一段既是包名也是对象名，这是 UE 的约定。
 *
 * `/Game/X/M`   → `/Game/X/M.M`
 * `/Game/X/M.M` → 原样
 */
export function toObjectPath(path: string): string {
  if (!isUeAssetPath(path)) return path

  const packagePath = toPackagePath(path)
  const assetName = packagePath.slice(packagePath.lastIndexOf('/') + 1)
  if (!assetName) return packagePath

  return `${packagePath}.${assetName}`
}

/**
 * 两个路径指不指同一个资产。大小写敏感 —— UE 的资产路径是大小写敏感的，
 * 这里放宽反而会把 `M_Rock` 和 `m_rock` 判成同一个。
 */
export function isSameAsset(a: string, b: string): boolean {
  if (!a || !b) return false
  return toPackagePath(a) === toPackagePath(b)
}

/**
 * 在一堆路径里找有没有目标资产。`ue_save` 的回执 `saved` 是包名数组，
 * 而调用方手里可能是对象路径 —— 两边都归一化之后再找。
 */
export function containsAsset(list: readonly string[] | undefined, target: string): boolean {
  if (!list || list.length === 0 || !target) return false
  const normalized = toPackagePath(target)
  return list.some((item) => toPackagePath(item) === normalized)
}
