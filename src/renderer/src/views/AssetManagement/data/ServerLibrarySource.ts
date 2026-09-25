/**
 * 服务端资产库的数据源：把 asset-catalog 的文件夹 / 资产翻成本地库的形状，
 * 让现有的树、网格、详情面板直接用。
 *
 * - 文件夹键：根是 'ALL'（和本地库一样），其余是 `d<dirId>`；资产键是 `a<id>`。
 * - 翻页：列表按偏移量要（`offset/limit`），主进程把它变成 keyset 游标（接着上一页）
 *   或结果快照（跳着要），代价与位置无关；本机不存整库。
 * - 路径：`Content/Props/SM_Chair.uasset` ↔ 软路径 `/Game/Props/SM_Chair`（插件内容是 `/<插件名>/…`）。
 */
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import type {
  CatalogAssetDetail,
  CatalogAssetSummary,
  CatalogFolder,
  CatalogListQuery,
  CatalogSort
} from '@core/shared/catalogLibrary'
import type { AssetImportStatusSummary } from '@core/shared/assetDependency'
import {
  ROOT_FOLDER_KEY,
  type AssetLibrarySource,
  type LibraryCapabilities,
  type LibraryListCriteria,
  type SortBy,
  type SortOrder
} from './AssetLibrarySource'

export const SERVER_CAPABILITIES_BASE: LibraryCapabilities = {
  vaultFeatures: false,
  pagedOnly: true,
  canEditStructure: false,
  tagModel: 'none',
  canEditNotes: false,
  richNotes: false,
  canFavorite: false,
  hasTrash: false,
  canScan: false,
  canImport: false,
  canSendToProject: false,
  nativeDrag: false,
  folderSearch: false,
  dependencyGraph: false,
  tagManagement: false,
  sortByType: false,
  filters: {
    category: true,
    assetTypes: true,
    size: false,
    date: false,
    tags: false,
    favorite: false,
    showDependencies: false,
    engine: true
  },
  reasons: {
    canEditStructure: 'catalogLibrary.reasons.structure',
    canFavorite: 'catalogLibrary.reasons.favorite',
    hasTrash: 'catalogLibrary.reasons.trash',
    canScan: 'catalogLibrary.reasons.scan',
    folderSearch: 'catalogLibrary.reasons.folderSearch',
    dependencyGraph: 'catalogLibrary.reasons.dependencyGraph',
    tagManagement: 'catalogLibrary.reasons.tagManagement',
    sortByType: 'catalogLibrary.reasons.sortByType',
    nativeDrag: 'catalogLibrary.reasons.nativeDrag',
    richNotes: 'catalogLibrary.reasons.richNotes',
    'filters.size': 'catalogLibrary.reasons.filterUnsupported',
    'filters.date': 'catalogLibrary.reasons.filterUnsupported',
    'filters.tags': 'catalogLibrary.reasons.filterUnsupported',
    'filters.favorite': 'catalogLibrary.reasons.favorite',
    'filters.showDependencies': 'catalogLibrary.reasons.filterUnsupported'
  }
}

/** 服务端状态决定的那几项：注释、导入 / 下载（需要 Lore 和随包的 lore.exe） */
export function serverCapabilities(state: {
  annotations: boolean | null
  lore: boolean
  online: boolean
}): LibraryCapabilities {
  const annotations = state.annotations === true && state.online
  const lore = state.lore && state.online
  return {
    ...SERVER_CAPABILITIES_BASE,
    tagModel: annotations ? 'names' : 'none',
    canEditNotes: annotations,
    canImport: lore,
    canSendToProject: lore,
    reasons: {
      ...SERVER_CAPABILITIES_BASE.reasons,
      tagModel: annotations ? null : 'catalogLibrary.reasons.annotations',
      canEditNotes: annotations ? null : 'catalogLibrary.reasons.annotations',
      canImport: lore
        ? null
        : state.online
          ? 'catalogLibrary.reasons.lore'
          : 'catalogLibrary.reasons.offline',
      canSendToProject: lore
        ? null
        : state.online
          ? 'catalogLibrary.reasons.lore'
          : 'catalogLibrary.reasons.offline'
    }
  }
}

export function folderKeyOf(dirId: number): string {
  return dirId === 0 ? ROOT_FOLDER_KEY : `d${dirId}`
}

export function dirIdOf(folderKey: string | undefined | null): number {
  if (!folderKey || folderKey === ROOT_FOLDER_KEY) return 0
  const match = /^d(\d+)$/.exec(folderKey)
  return match ? Number(match[1]) : 0
}

export function assetKeyOf(id: number): string {
  return `a${id}`
}

export function assetIdOf(assetKey: string | undefined | null): number | null {
  const match = /^a(\d+)$/.exec(assetKey ?? '')
  return match ? Number(match[1]) : null
}

/** 库内路径 → UE 包路径（不带 .Object 后缀） */
export function softPathOf(path: string): string {
  const withoutExt = path.replace(/\.(uasset|umap)$/i, '')
  const parts = withoutExt.split('/')
  if (parts[0] === 'Content') return `/Game/${parts.slice(1).join('/')}`
  const content = parts.indexOf('Content')
  if (parts[0] === 'Plugins' && content > 1)
    return `/${parts[content - 1]}/${parts.slice(content + 1).join('/')}`
  return `/${withoutExt}`
}

function iso(ms: number | null | undefined): string | undefined {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined
}

/** 服务端一行 → 本地资产行的形状（多出来的字段带 catalog 前缀，给下载 / 导入用） */
export function mapAsset(item: CatalogAssetSummary): AssetData & Record<string, unknown> {
  const time = iso(item.modifiedMs)
  // 本地库的扩展名不带点（'uasset'），界面按这个判断类型
  const ext = item.ext.replace(/^\./, '')
  return {
    assetKey: assetKeyOf(item.id),
    id: assetKeyOf(item.id),
    folderKey: folderKeyOf(item.dirId),
    assetName: item.name.replace(/\.(uasset|umap)$/i, ''),
    name: item.name,
    type: 'file',
    fileExtension: ext,
    ext,
    extension: ext,
    className: item.class ?? undefined,
    classNameCn: item.classCn || item.class || undefined,
    engineVersion: item.engine ?? undefined,
    fileSize: item.size,
    size: item.size,
    updated_at: time,
    modifiedTime: time,
    softPath: softPathOf(item.path),
    path: item.path,
    tags: item.tags,
    color: item.color ?? undefined,
    thumbnailUrl: item.previewUrl ?? null,
    catalogId: item.id,
    catalogPath: item.path,
    catalogRepository: item.repository,
    catalogDirId: item.dirId
  }
}

export function mapFolder(
  folder: CatalogFolder,
  parentKey: string | null
): AssetFolder & Record<string, unknown> {
  return {
    folderKey: folderKeyOf(folder.dirId),
    fatherKey: parentKey ?? undefined,
    folderName: folder.dirId === 0 ? ROOT_FOLDER_KEY : folder.name,
    fullPath: folder.path,
    hasChildren: folder.nDirs > 0,
    color: folder.color ?? undefined,
    // 详情面板的"子文件夹 / 文件 / 总计"和列表计数用
    catalogDirId: folder.dirId,
    catalogPath: folder.path,
    nDirect: folder.nDirect,
    nSubtree: folder.nSubtree,
    nDirs: folder.nDirs,
    bytes: folder.bytes
  }
}

function catalogSort(sortBy?: SortBy | string): CatalogSort {
  if (sortBy === 'modifiedTime') return 'modified'
  if (sortBy === 'fileSize') return 'size'
  return 'name'
}

export class ServerLibrarySource implements AssetLibrarySource {
  readonly kind = 'server' as const
  readonly annotations: AssetLibrarySource['annotations']
  readonly facets: AssetLibrarySource['facets']
  readonly folders: AssetLibrarySource['folders']
  readonly assets: AssetLibrarySource['assets']
  readonly search: AssetLibrarySource['search']

  /** 看过的文件夹：dirId → 记录（路径、计数）。只是这一个会话的索引，不是镜像 */
  private readonly known = new Map<number, { folder: CatalogFolder; parent: number | null }>()
  private readonly childrenOf = new Map<number, CatalogFolder[]>()

  /** 能力随服务端状态变（在线 / 离线、有没有注释路由、是不是 writer），所以每次现取 */
  get capabilities(): LibraryCapabilities {
    return this.capabilitiesOf()
  }

  constructor(
    readonly id: string,
    private readonly capabilitiesOf: () => LibraryCapabilities
  ) {
    this.folders = {
      getRootFolders: async () => {
        const root = await this.loadChildren(0)
        return [mapFolder(root.folder ?? this.rootStub(root.items.length), null)]
      },
      getByFatherKey: async (fatherKey, sortBy, sortOrder, limit, offset) => {
        const dirId = dirIdOf(fatherKey)
        const { items } = await this.loadChildren(dirId)
        const sorted = [...items]
        if (sortBy === 'fileSize') sorted.sort((a, b) => a.bytes - b.bytes)
        if (sortOrder === 'desc') sorted.reverse()
        const start = offset ?? 0
        const page =
          typeof limit === 'number' ? sorted.slice(start, start + limit) : sorted.slice(start)
        return page.map((folder) => mapFolder(folder, folderKeyOf(dirId)))
      },
      getByKey: async (folderKey) => {
        const dirId = dirIdOf(folderKey)
        const known = this.known.get(dirId)
        if (known)
          return mapFolder(known.folder, known.parent === null ? null : folderKeyOf(known.parent))
        const { folder } = await this.loadChildren(dirId)
        return folder ? mapFolder(folder, null) : undefined
      },
      getChildCount: async (fatherKey) =>
        (await this.loadChildren(dirIdOf(fatherKey))).items.length,
      getPathArray: async (folderKey) => await this.pathArray(dirIdOf(folderKey))
    }

    this.assets = {
      getByFolderKey: async (folderKey, sortBy, sortOrder, _showDependencies, limit, offset) => {
        const window = await catalogLibraryAPI.listWindow(
          this.id,
          this.query({ dir: dirIdOf(folderKey), recursive: false }, sortBy, sortOrder),
          offset ?? 0,
          limit ?? 100
        )
        return window.items.map(mapAsset)
      },
      getCountByFolderKey: async (folderKey) => {
        const dirId = dirIdOf(folderKey)
        const known = this.known.get(dirId)
        if (known) return known.folder.nDirect
        const { folder } = await this.loadChildren(dirId)
        return folder?.nDirect ?? 0
      },
      getById: async (assetKey) => {
        const id = assetIdOf(assetKey)
        if (id === null) return undefined
        return this.mapDetail(await catalogLibraryAPI.detail(this.id, id))
      },
      getImportStatus: async (assetKey) => {
        const id = assetIdOf(assetKey)
        if (id === null) return { total: 0, unresolvedCount: 0, items: [] }
        const detail = await catalogLibraryAPI.detail(this.id, id)
        return importStatusOf(detail)
      },
      getDistinctAssetTypes: async () => {
        const result = await catalogLibraryAPI.facets(this.id, { dir: 0, recursive: true }, [
          'class'
        ])
        return (result.facets.class ?? []).map((value) => ({
          className: value.value,
          classNameCn: value.value,
          count: value.n
        }))
      }
    }

    this.search = {
      assets: async (criteria) => {
        const window = await catalogLibraryAPI.listWindow(
          this.id,
          this.criteriaQuery(criteria),
          criteria.offset ?? 0,
          criteria.limit ?? 50
        )
        return window.items.map(mapAsset)
      },
      // 第一切片没有按文件夹名搜索（capabilities.folderSearch = false）
      folders: async () => []
    }

    this.facets = {
      engines: async (criteria) => {
        const result = await catalogLibraryAPI.facets(
          this.id,
          this.criteriaQuery({ ...criteria, engineVersions: [] }),
          ['engine']
        )
        return result.facets.engine ?? []
      }
    }

    this.annotations = {
      get: async (target) => {
        if (target.assetKey) {
          const id = assetIdOf(target.assetKey)
          if (id === null) return { tags: [], note: '' }
          const detail = await catalogLibraryAPI.detail(this.id, id)
          return {
            tags: detail.annotations?.tags ?? detail.tags ?? [],
            note: detail.annotations?.note ?? ''
          }
        }
        // 文件夹注释：第一切片的文件夹记录还不带注释字段
        return { tags: [], note: '' }
      },
      edit: async (target, op) => {
        const path = target.assetKey
          ? await this.assetPath(target.assetKey)
          : this.known.get(dirIdOf(target.folderKey))?.folder.path
        if (!path && path !== '') return { ok: false, error: 'unknown target' }
        const result = await catalogLibraryAPI.editAnnotations(this.id, [
          {
            ...(target.assetKey ? { path } : { folderPath: path }),
            ...(op.note !== undefined ? { set: { note: op.note } } : {}),
            ...(op.addTags?.length ? { addTags: op.addTags } : {}),
            ...(op.removeTags?.length ? { removeTags: op.removeTags } : {})
          }
        ])
        return { ok: result.success, error: result.error }
      }
    }
  }

  private rootStub(children: number): CatalogFolder {
    return { dirId: 0, path: '', name: '', nDirect: 0, nSubtree: 0, bytes: 0, nDirs: children }
  }

  private async loadChildren(
    dirId: number
  ): Promise<{ folder: CatalogFolder | null; items: CatalogFolder[] }> {
    const result = await catalogLibraryAPI.folders(this.id, dirId)
    if (result.folder) {
      const previous = this.known.get(result.folder.dirId)
      this.known.set(result.folder.dirId, {
        folder: result.folder,
        parent: previous?.parent ?? null
      })
    }
    for (const item of result.items) this.known.set(item.dirId, { folder: item, parent: dirId })
    this.childrenOf.set(dirId, result.items)
    return { folder: result.folder, items: result.items }
  }

  /** ['ALL', 祖先…, 自己]：按路径逐级 by-path 查出 dirId（深度有限，每级一次有界请求） */
  private async pathArray(dirId: number): Promise<string[]> {
    if (dirId === 0) return [ROOT_FOLDER_KEY]
    let path = this.known.get(dirId)?.folder.path
    if (path === undefined) {
      const { folder } = await this.loadChildren(dirId)
      path = folder?.path ?? ''
    }
    const parts = path.split('/').filter(Boolean)
    const keys = [ROOT_FOLDER_KEY]
    let parent = 0
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join('/')
      let id = [...this.known.values()].find((entry) => entry.folder.path === prefix)?.folder.dirId
      if (id === undefined) {
        const folder = await catalogLibraryAPI.folderByPath(this.id, prefix)
        this.known.set(folder.dirId, { folder, parent })
        id = folder.dirId
      }
      keys.push(folderKeyOf(id))
      parent = id
    }
    return keys
  }

  private async assetPath(assetKey: string): Promise<string | undefined> {
    const id = assetIdOf(assetKey)
    if (id === null) return undefined
    return (await catalogLibraryAPI.detail(this.id, id)).path
  }

  private query(
    base: { dir: number; recursive: boolean },
    sortBy?: SortBy | string,
    sortOrder?: SortOrder
  ): CatalogListQuery {
    const sort = catalogSort(sortBy)
    return { ...base, sort, order: sortOrder ?? (sort === 'name' ? 'asc' : 'desc') }
  }

  private criteriaQuery(criteria: LibraryListCriteria): CatalogListQuery {
    const q = typeof criteria.keyword === 'string' ? criteria.keyword.trim() : ''
    return {
      ...this.query(
        { dir: dirIdOf(criteria.folderKey), recursive: criteria.includeSubfolders !== false },
        criteria.sortBy,
        criteria.sortOrder
      ),
      q: q || undefined,
      class: criteria.classNameCnFilters?.length ? [...criteria.classNameCnFilters] : undefined,
      ext: criteria.fileExtensions?.length
        ? criteria.fileExtensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
        : undefined,
      engine: criteria.engineVersions?.length ? [...criteria.engineVersions] : undefined
    }
  }

  private mapDetail(detail: CatalogAssetDetail): AssetData & Record<string, unknown> {
    return {
      ...mapAsset(detail),
      thumbnailUrl: detail.largePreviewUrl ?? detail.previewUrl ?? null,
      contentHash: detail.hash,
      dependentsCount: detail.dependentsCount,
      note: detail.annotations?.note ?? undefined,
      tags: detail.annotations?.tags ?? detail.tags
    }
  }

  /** 服务端数据变了：丢掉这个会话里记下的文件夹，下次按需重取 */
  forget(): void {
    this.known.clear()
    this.childrenOf.clear()
  }
}

/** 一跳依赖 → 详情面板"导入依赖"的形状（都在库里，都可点） */
export function importStatusOf(detail: CatalogAssetDetail): AssetImportStatusSummary {
  const items = detail.dependencies.map((dependency) => {
    const softPath = softPathOf(dependency.path)
    const slash = softPath.lastIndexOf('/')
    return {
      softPath,
      name: softPath.slice(slash + 1),
      folder: softPath.slice(0, slash),
      status: 'in-vault' as const,
      assetKey: assetKeyOf(dependency.id)
    }
  })
  return { total: items.length, unresolvedCount: 0, items }
}
