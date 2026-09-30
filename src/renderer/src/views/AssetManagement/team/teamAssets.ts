/**
 * 工程内路径 → 目录服务里的那一行（缩略图、资产键），给「点缩略图，右边详情打开那个资产」用（方案 4.8）。
 *
 * 目录服务按文件夹分页、按名字搜：先按路径找到文件夹，再在这一个文件夹里按名字要一页，
 * 对上完整路径的就是它。每一步都是有界的请求；结果按库缓存。
 */
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import type { CatalogAssetSummary } from '@core/shared/catalogLibrary'
import { mapAsset } from '../data/ServerLibrarySource'

const cache = new Map<string, CatalogAssetSummary | null>()

export async function catalogRowByPath(
  libraryKey: string,
  path: string
): Promise<CatalogAssetSummary | null> {
  const id = `${libraryKey}|${path}`
  if (cache.has(id)) return cache.get(id) ?? null
  const slash = path.lastIndexOf('/')
  const folderPath = slash >= 0 ? path.slice(0, slash) : ''
  const name = path.slice(slash + 1)
  let found: CatalogAssetSummary | null = null
  try {
    const folder = folderPath
      ? await catalogLibraryAPI.folderByPath(libraryKey, folderPath)
      : { dirId: 0 }
    const window = await catalogLibraryAPI.listWindow(
      libraryKey,
      { dir: folder.dirId, recursive: false, q: name.replace(/\.(uasset|umap)$/i, '') },
      0,
      50
    )
    found = window.items.find((item) => item.path === path) ?? null
  } catch {
    found = null
  }
  cache.set(id, found)
  return found
}

/** 同上，但直接给详情面板要的那种「本地库形状」的资产行 */
export async function assetRowByPath(
  libraryKey: string,
  path: string
): Promise<(AssetData & Record<string, unknown>) | null> {
  const row = await catalogRowByPath(libraryKey, path)
  return row ? mapAsset(row) : null
}

export function forgetCatalogRows(): void {
  cache.clear()
}
