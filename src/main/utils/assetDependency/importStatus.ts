import {
  splitSoftPath,
  type AssetImportItem,
  type AssetImportStatusSummary
} from '../../../shared/assetDependency'

/** 只取这里用得上的那几个字段，免得为了测一个纯函数去造一整条 AssetData */
export interface ImportStatusAsset {
  assetKey: string
  assetName?: string
  softPath?: string
  className?: string
  folderKey?: string
}

/**
 * 把 imports 列读成软路径数组。
 *
 * 这一列的历史包袱：可能是 JSON 字符串，也可能已经是数组；数组元素可能是
 * 字符串，也可能是 { path } 或 { name } 对象。解析失败当没有依赖处理 ——
 * 一条坏数据不该让整个详情面板打不开。
 */
export function parseImports(raw: unknown): string[] {
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry: unknown) => {
        if (typeof entry === 'string') return entry
        const obj = entry as { path?: string; name?: string } | null
        return obj?.path || obj?.name || ''
      })
      .filter((p): p is string => Boolean(p))
  } catch {
    return []
  }
}

/**
 * 把「这个资产声明的依赖」和「库里查到的资产」对起来，得出每条依赖的状态。
 *
 * 顺序跟着 softPaths 走，不跟着查询结果走 —— 用户看到的顺序应该和资产里
 * 记录的顺序一致，而不是数据库返回的顺序。
 */
export function buildImportStatusSummary(
  softPaths: string[],
  matchedAssets: ImportStatusAsset[]
): AssetImportStatusSummary {
  const bySoftPath = new Map<string, ImportStatusAsset>()
  for (const asset of matchedAssets) {
    // 同一条 softPath 可能命中多个资产（重复导入），取第一个就够了
    if (asset.softPath && !bySoftPath.has(asset.softPath)) {
      bySoftPath.set(asset.softPath, asset)
    }
  }

  const items: AssetImportItem[] = softPaths.map((softPath) => {
    const { name, folder } = splitSoftPath(softPath)
    const hit = bySoftPath.get(softPath)
    if (!hit) {
      return { softPath, name, folder, status: 'unresolved' }
    }
    return {
      softPath,
      name: hit.assetName || name,
      folder,
      status: 'in-vault',
      assetKey: hit.assetKey,
      className: hit.className,
      folderKey: hit.folderKey
    }
  })

  return {
    total: items.length,
    unresolvedCount: items.filter((item) => item.status === 'unresolved').length,
    items
  }
}
