/**
 * 把磁盘上的文件配到虚幻插件送来的资产元数据上 —— **按路径配，不按资产名配**。
 *
 * 为什么不能按名字配：UE 允许不同目录下有同名资产，例如
 * `/Game/0_MHC_Lecturer/Materials/M1_Clothing/M_yifu_Inst` 和
 * `/Game/0_MHC_Lecturer/Materials/M1_Clothing2/M_yifu_Inst`。
 * 按名字取第一个命中，第二个文件就会领到第一个的软路径：库里多出一条「文件是 A、软路径写 B」
 * 的错记录；而它真正的软路径稍后又被依赖解析器从 uasset 的 import 表里读出来，
 * 变成另一条 0 字节、挂在项目根目录的空壳。2026-09-14 在 FPS2测试 保管库里实测到的就是这个形态。
 *
 * 配对规则：把包路径去掉 `/Game/` 前缀后，当作磁盘路径的后缀来匹配
 * （`/Game/A/B/N` ↔ `<工程>/Content/A/B/N.uasset`），多个命中取最长的那个。
 */

/** 参与配对所需要的最小字段 */
export interface PackagePathedMeta {
  name: string
  package: string
}

/** UE 资产文件的扩展名 */
const ASSET_EXTENSIONS = ['uasset', 'umap']

/**
 * 规范化用于比较的路径：反斜杠转正斜杠、去掉资产扩展名、转小写。
 * 转小写是因为 Windows 路径大小写不敏感，而同一个工程里两处写法未必一致。
 */
export function normalizePathForMatch(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
  const lastDot = normalized.lastIndexOf('.')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastDot > lastSlash && lastDot >= 0) {
    const ext = normalized.slice(lastDot + 1)
    if (ASSET_EXTENSIONS.includes(ext)) {
      return normalized.slice(0, lastDot)
    }
  }
  return normalized
}

/** `/Game/A/B/Name` → `A/B/Name`；不是 /Game 下的包返回空串 */
export function packageRelativePath(packagePath: string): string {
  if (!packagePath) return ''
  const normalized = packagePath.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  if (!normalized.startsWith('/Game/')) return ''
  return normalized.slice('/Game/'.length)
}

/** `/Game/A/B/Name` → `A/B`（资产所在目录，对应盒子里的文件夹） */
export function packageFolderRelativePath(packagePath: string): string {
  const relative = packageRelativePath(packagePath)
  const lastSlash = relative.lastIndexOf('/')
  return lastSlash > 0 ? relative.slice(0, lastSlash) : ''
}

/** 文件名（不含目录和扩展名），小写 */
function fileStemLower(filePath: string): string {
  const normalized = normalizePathForMatch(filePath)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
}

/**
 * 元数据索引：先用资产名分桶，再在桶里按路径后缀挑最长的那个。
 */
export class PreloadedMetadataIndex<T extends PackagePathedMeta> {
  private readonly byName = new Map<string, T[]>()

  constructor(metas: Iterable<T>) {
    for (const meta of metas) {
      const key = (meta.name || '').toLowerCase()
      if (!key) continue
      const bucket = this.byName.get(key)
      if (bucket) {
        bucket.push(meta)
      } else {
        this.byName.set(key, [meta])
      }
    }
  }

  /**
   * 找出这个文件对应的元数据。
   *
   * @returns 配上了就返回那条元数据；配不上返回 undefined —— 调用方应该退回去自己解析
   *          uasset，而不是随便挑一条同名的。
   */
  match(filePath: string): T | undefined {
    const candidates = this.byName.get(fileStemLower(filePath))
    if (!candidates || candidates.length === 0) return undefined

    const normalized = normalizePathForMatch(filePath)

    let best: T | undefined
    let bestLength = -1
    for (const meta of candidates) {
      const relative = packageRelativePath(meta.package).toLowerCase()
      if (!relative) continue
      if (normalized === relative || normalized.endsWith('/' + relative)) {
        if (relative.length > bestLength) {
          best = meta
          bestLength = relative.length
        }
      }
    }
    if (best) return best

    // 路径对不上，但这个名字全局只有一条元数据 —— 不存在串到别人身上的风险，按名字认。
    // （文件在导入前被挪过位置时会走到这里，行为和按路径配对之前保持一致。）
    return candidates.length === 1 ? candidates[0] : undefined
  }
}
