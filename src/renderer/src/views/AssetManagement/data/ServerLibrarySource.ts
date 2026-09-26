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
  CatalogFavorites,
  CatalogFolder,
  CatalogListQuery,
  CatalogSort,
  CatalogTagDef,
  CatalogUnclaimed
} from '@core/shared/catalogLibrary'
import { getAssetClassColor, getAssetClassNameCn } from '@core/shared/assetClassNames'
import type { AssetImportStatusSummary } from '@core/shared/assetDependency'
import {
  ROOT_FOLDER_KEY,
  type AssetLibrarySource,
  type LibraryCapabilities,
  type LibraryFavoritesApi,
  type LibraryListCriteria,
  type LibraryTagRegistryApi,
  type RegistryTag,
  type RegistryTagGroup,
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
  // 收藏存在本机（按库、按资产 id），服务器不知道 —— 所以服务器库也能收藏
  canFavorite: true,
  hasTrash: false,
  canScan: false,
  canImport: false,
  canSendToProject: false,
  nativeDrag: false,
  folderSearch: false,
  dependencyGraph: false,
  tagManagement: false,
  folderColor: false,
  cloudDrives: false,
  sortByType: false,
  filters: {
    category: true,
    assetTypes: true,
    size: false,
    date: false,
    tags: false,
    favorite: false,
    showDependencies: false,
    engine: true,
    tagMode: 'include-any'
  },
  reasons: {
    canEditStructure: 'catalogLibrary.reasons.structure',
    hasTrash: 'catalogLibrary.reasons.trash',
    cloudDrives: 'catalogLibrary.reasons.cloudDrives',
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
    'filters.favorite': 'catalogLibrary.reasons.favoriteFilter',
    'filters.showDependencies': 'catalogLibrary.reasons.filterUnsupported'
  }
}

/** 服务端状态决定的那几项：注释、导入 / 下载（需要 Lore 和随包的 lore.exe） */
export function serverCapabilities(state: {
  annotations: boolean | null
  lore: boolean
  online: boolean
  /** 服务端有没有按文件夹名搜索；null = 还没试过（先当有，试了没有再关） */
  folderSearch?: boolean | null
  /** 服务端有没有标签注册表；null = 还没试过 */
  tagRegistry?: boolean | null
}): LibraryCapabilities {
  const annotations = state.annotations === true && state.online
  const lore = state.lore && state.online
  const folderSearch = state.folderSearch !== false && state.online
  const tagManagement = annotations && state.tagRegistry !== false
  const offlineOr = (reason: string): string =>
    state.online ? reason : 'catalogLibrary.reasons.offline'
  return {
    ...SERVER_CAPABILITIES_BASE,
    tagModel: annotations ? 'names' : 'none',
    canEditNotes: annotations,
    canImport: lore,
    canSendToProject: lore,
    folderSearch,
    tagManagement,
    folderColor: annotations,
    filters: { ...SERVER_CAPABILITIES_BASE.filters, tags: state.online },
    reasons: {
      ...SERVER_CAPABILITIES_BASE.reasons,
      tagModel: annotations ? null : 'catalogLibrary.reasons.annotations',
      canEditNotes: annotations ? null : 'catalogLibrary.reasons.annotations',
      folderColor: annotations ? null : 'catalogLibrary.reasons.annotations',
      folderSearch: folderSearch ? null : offlineOr('catalogLibrary.reasons.folderSearch'),
      tagManagement: tagManagement
        ? null
        : !annotations
          ? 'catalogLibrary.reasons.annotations'
          : 'catalogLibrary.reasons.tagManagement',
      'filters.tags': state.online ? null : 'catalogLibrary.reasons.offline',
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

/** 和本地库的时间字段同一种写法（`YYYY-MM-DD HH:mm:ss`，本机时区），界面原样显示 */
function iso(ms: number | null | undefined): string | undefined {
  if (typeof ms !== 'number' || ms <= 0) return undefined
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

const FALLBACK_CLASS_COLOR = '#888888'

function classNameCnOf(item: CatalogAssetSummary): string | undefined {
  if (!item.class) return undefined
  const desktop = getAssetClassNameCn(item.class)
  return desktop !== item.class ? desktop : item.classCn || desktop
}

function classColorOf(item: CatalogAssetSummary): string | undefined {
  if (!item.class) return undefined
  const desktop = getAssetClassColor(item.class)
  return desktop !== FALLBACK_CLASS_COLOR ? desktop : item.classColor || desktop
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
    className: item.class || undefined,
    // 类名的中文名和颜色：优先桌面端自己的表（和本地库入库时同一张）；
    // 表里没有的类（查出来还是原名 / 默认灰）才用服务端行上带的 classCn / classColor
    classNameCn: classNameCnOf(item),
    classColor: classColorOf(item),
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
    path: folder.path,
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
  readonly favorites: LibraryFavoritesApi
  readonly tagRegistry: ServerTagRegistry

  /** 看过的文件夹：dirId → 记录（路径、计数）。只是这一个会话的索引，不是镜像 */
  private readonly known = new Map<number, { folder: CatalogFolder; parent: number | null }>()
  private readonly childrenOf = new Map<number, CatalogFolder[]>()
  /** 中文类名 → 服务端类名（几个类可能共用一个中文名，筛选时都要带上） */
  private readonly classesByCn = new Map<string, string[]>()
  private favoriteCache: CatalogFavorites | null = null

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
      getPathArray: async (folderKey) => await this.pathArray(dirIdOf(folderKey)),
      setColor: async (folderKey, color) => {
        const dirId = dirIdOf(folderKey)
        if (dirId === 0) return { ok: false, error: 'root' }
        const path =
          this.known.get(dirId)?.folder.path ?? (await this.loadChildren(dirId)).folder?.path
        if (!path) return { ok: false, error: 'unknown folder' }
        const result = await catalogLibraryAPI.editAnnotations(this.id, [
          { folderPath: path, set: { color } }
        ])
        return { ok: result.success, error: result.error }
      }
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
        const result = await catalogLibraryAPI.facets(
          this.id,
          { dir: 0, recursive: true },
          ['class'],
          200
        )
        // 按中文名合并（和本地库的类型下拉一致），记下每个中文名对应哪些服务端类名
        const merged = new Map<string, { className: string; classNameCn: string; count: number }>()
        this.classesByCn.clear()
        for (const value of result.facets.class ?? []) {
          const cn = getAssetClassNameCn(value.value)
          this.classesByCn.set(cn, [...(this.classesByCn.get(cn) ?? []), value.value])
          const entry = merged.get(cn)
          if (entry) entry.count += value.n
          else merged.set(cn, { className: value.value, classNameCn: cn, count: value.n })
        }
        return [...merged.values()]
      }
    }

    this.search = {
      assets: async (criteria) => {
        // 「我的收藏」：收藏记在本机，按 id 逐个取详情（有上限），筛选和排序在这一小批里做
        if (criteria.favoriteStatus === 'favorite') return await this.favoriteRows(criteria)
        const window = await catalogLibraryAPI.listWindow(
          this.id,
          this.criteriaQuery(criteria),
          criteria.offset ?? 0,
          criteria.limit ?? 50
        )
        return window.items.map(mapAsset)
      },
      /**
       * 按文件夹名搜索：服务端有 …/folders/search 时用它；没有时回空，
       * 同时主进程把 folderSearch 能力关掉，界面退回"服务器还不支持"的提示。
       */
      folders: async (params) => {
        const keyword = typeof params.keyword === 'string' ? params.keyword.trim() : ''
        if (!keyword) return []
        const scope = params.folderKey ? dirIdOf(params.folderKey) : 0
        const found = await catalogLibraryAPI.searchFolders(
          this.id,
          keyword,
          Math.min(params.limit ?? 100, 100),
          scope
        )
        if (!found) return []
        const base = scope === 0 ? '' : (this.known.get(scope)?.folder.path ?? null)
        const inScope = found.filter((folder) => {
          if (scope === 0 || base === null) return true
          if (!folder.path.startsWith(`${base}/`)) return false
          // 列表里的"当前文件夹下"只要直接子文件夹；树上的全局搜索不带 folderKey
          const rest = folder.path.slice(base.length + 1)
          return params.includeSubfolders !== false || !rest.includes('/')
        })
        return inScope.map((folder) => {
          const slash = folder.path.lastIndexOf('/')
          const parentPath = slash >= 0 ? folder.path.slice(0, slash) : ''
          const parent = [...this.known.values()].find((entry) => entry.folder.path === parentPath)
          const parentKey =
            parentPath === '' ? ROOT_FOLDER_KEY : parent ? folderKeyOf(parent.folder.dirId) : null
          return mapFolder(folder, parentKey)
        })
      }
    }

    this.facets = {
      engines: async (criteria) => {
        const result = await catalogLibraryAPI.facets(
          this.id,
          this.criteriaQuery({ ...criteria, engineVersions: [] }),
          ['engine']
        )
        return result.facets.engine ?? []
      },
      tags: async (criteria) => {
        const result = await catalogLibraryAPI.facets(
          this.id,
          this.criteriaQuery({ ...criteria, tagNames: [] }),
          ['tags'],
          200
        )
        return result.facets.tags ?? []
      }
    }

    this.favorites = {
      add: async (assetKey) => await this.setFavorite('asset', assetIdOf(assetKey), true),
      remove: async (assetKey) => await this.setFavorite('asset', assetIdOf(assetKey), false),
      addFolder: async (folderKey) => await this.setFavorite('folder', dirIdOf(folderKey), true),
      removeFolder: async (folderKey) =>
        await this.setFavorite('folder', dirIdOf(folderKey), false),
      batchCheck: async (assetKeys) => {
        const ids = new Set((await this.loadFavorites()).assets)
        const out: Record<string, boolean> = {}
        for (const key of assetKeys) out[key] = ids.has(assetIdOf(key) ?? -1)
        return out
      },
      isFolderFavorite: async (folderKey) =>
        (await this.loadFavorites()).folders.includes(dirIdOf(folderKey)),
      count: async () => {
        const favorites = await this.loadFavorites()
        return favorites.assets.length + favorites.folders.length
      },
      folders: async () => {
        const favorites = await this.loadFavorites()
        const rows: Array<Record<string, unknown>> = []
        for (const dirId of favorites.folders.slice(0, FAVORITE_LIMIT)) {
          const folder = await this.loadChildren(dirId)
            .then((result) => result.folder)
            .catch(() => null)
          if (!folder) continue
          rows.push({
            id: folderKeyOf(folder.dirId),
            name: folder.name,
            type: 'folder',
            path: folder.path,
            fullPath: folder.path,
            folderKey: folderKeyOf(folder.dirId),
            folderName: folder.name,
            size: 0,
            modifiedTime: '',
            extension: '',
            color: folder.color ?? undefined
          })
        }
        return rows
      }
    }

    this.tagRegistry = new ServerTagRegistry(this)

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

  private async loadFavorites(): Promise<CatalogFavorites> {
    if (!this.favoriteCache) this.favoriteCache = await catalogLibraryAPI.favorites(this.id)
    return this.favoriteCache
  }

  private async setFavorite(
    kind: 'asset' | 'folder',
    id: number | null,
    on: boolean
  ): Promise<boolean> {
    if (id === null || (kind === 'folder' && id === 0)) return false
    this.favoriteCache = await catalogLibraryAPI.setFavorite(this.id, kind, id, on)
    return true
  }

  /**
   * 收藏的资产：逐个取详情（上限 FAVORITE_LIMIT），在这一小批里做关键字 / 类型 / 格式 /
   * 引擎 / 标签筛选和排序。取不到的（已删除、没权限）跳过。
   */
  private async favoriteRows(
    criteria: LibraryListCriteria
  ): Promise<Array<Record<string, unknown>>> {
    const favorites = await this.loadFavorites()
    const details = await Promise.all(
      favorites.assets
        .slice(0, FAVORITE_LIMIT)
        .map((id) => catalogLibraryAPI.detail(this.id, id).catch(() => null))
    )
    const keyword =
      typeof criteria.keyword === 'string' ? criteria.keyword.trim().toLowerCase() : ''
    const classes = new Set(this.expandClasses(criteria.classNameCnFilters))
    const exts = new Set(
      (criteria.fileExtensions ?? []).map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
    )
    const engines = new Set(criteria.engineVersions ?? [])
    const tags = new Set(tagNamesOf(criteria))
    const matches = (detail: CatalogAssetDetail): boolean =>
      (!keyword || detail.name.toLowerCase().includes(keyword)) &&
      (classes.size === 0 || classes.has(detail.class ?? '')) &&
      (exts.size === 0 || exts.has(detail.ext)) &&
      (engines.size === 0 || engines.has(detail.engine ?? '')) &&
      (tags.size === 0 || (detail.annotations?.tags ?? detail.tags).some((tag) => tags.has(tag)))
    const rows = details.filter(
      (detail): detail is CatalogAssetDetail => detail !== null && matches(detail)
    )
    const sort = catalogSort(criteria.sortBy)
    const direction = (criteria.sortOrder ?? (sort === 'name' ? 'asc' : 'desc')) === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      const delta =
        sort === 'size'
          ? a.size - b.size
          : sort === 'modified'
            ? a.modifiedMs - b.modifiedMs
            : a.name.localeCompare(b.name, 'zh-Hans-CN')
      return delta * direction
    })
    const start = criteria.offset ?? 0
    return rows.slice(start, start + (criteria.limit ?? 50)).map((detail) => mapAsset(detail))
  }

  /** 中文类名 → 服务端类名；没见过的中文名原样当类名（本来就是服务端的原始类名） */
  private expandClasses(cnNames?: string[]): string[] {
    return (cnNames ?? []).flatMap((cn) => this.classesByCn.get(cn) ?? [cn])
  }

  /** 给标签注册表用的：整库的标签分面（名字 → 挂在多少个资产上） */
  async tagUsage(): Promise<Map<string, number>> {
    const result = await catalogLibraryAPI.facets(
      this.id,
      { dir: 0, recursive: true },
      ['tags'],
      500
    )
    return new Map((result.facets.tags ?? []).map((value) => [value.value, value.n]))
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
      class: criteria.classNameCnFilters?.length
        ? this.expandClasses(criteria.classNameCnFilters)
        : undefined,
      tag: tagNamesOf(criteria).length ? tagNamesOf(criteria) : undefined,
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

/** 收藏一次最多取多少个详情（收藏是给人看的书签，不是第二个库） */
const FAVORITE_LIMIT = 500

/** 筛选条件里的标签名（服务器库按名字筛；本地库按 id，走 tagFilter） */
function tagNamesOf(criteria: LibraryListCriteria): string[] {
  const names = criteria.tagNames
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === 'string')
    : []
}

/**
 * 服务端标签注册表 → 标签管理页。
 *
 * 注册表只有「名字 + 颜色 + 分组名」：分组没有自己的记录（空分组只在这次打开期间存在），
 * 标签在不在资产上看资产的注释。所以：
 * - 改名只给还没挂到任何资产上的标签（挂着的要逐个改资产，不在这里做）；
 * - 删除同理：挂着的先从资产上去掉；
 * - 「常用」是本地标签库的概念，这里没有。
 */
export class ServerTagRegistry implements LibraryTagRegistryApi {
  readonly abilities = { renameUnused: true, renameUsed: false, favorite: false }
  private readonly ids = new Map<string, number>()
  private readonly groupIds = new Map<string, number>()
  private readonly emptyGroups = new Set<string>()
  private defs: CatalogTagDef[] = []
  private usage = new Map<string, number>()
  private nextId = 1

  constructor(private readonly source: ServerLibrarySource) {}

  private idOf(name: string): number {
    let id = this.ids.get(name)
    if (id === undefined) {
      id = this.nextId++
      this.ids.set(name, id)
    }
    return id
  }

  private groupIdOf(name: string): number {
    let id = this.groupIds.get(name)
    if (id === undefined) {
      id = this.nextId++
      this.groupIds.set(name, id)
    }
    return id
  }

  private nameOf(id: number): string | undefined {
    for (const [name, value] of this.ids) if (value === id) return name
    return undefined
  }

  private groupNameOf(id: number | null | undefined): string | null {
    if (id === null || id === undefined) return null
    for (const [name, value] of this.groupIds) if (value === id) return name
    return null
  }

  private defOf(name: string): CatalogTagDef {
    return this.defs.find((def) => def.name === name) ?? { name }
  }

  private async refresh(): Promise<void> {
    const [defs, usage] = await Promise.all([
      catalogLibraryAPI.listTags(this.source.id),
      this.source.tagUsage().catch(() => new Map<string, number>())
    ])
    this.defs = defs
    this.usage = usage
    for (const def of defs) if (def.group) this.emptyGroups.delete(def.group)
  }

  async groups(): Promise<RegistryTagGroup[]> {
    await this.refresh()
    const counts = new Map<string, number>()
    for (const def of this.defs)
      if (def.group) counts.set(def.group, (counts.get(def.group) ?? 0) + 1)
    const names = [...new Set([...counts.keys(), ...this.emptyGroups])].sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN')
    )
    return names.map((name, index) => ({
      id: this.groupIdOf(name),
      name,
      sort_order: index + 1,
      tagCount: counts.get(name) ?? 0
    }))
  }

  async tags(): Promise<RegistryTag[]> {
    // 注册表里的 + 资产上挂着但没登记的（后者没有颜色和分组）
    const names = new Set([...this.defs.map((def) => def.name), ...this.usage.keys()])
    return [...names].map((name) => {
      const def = this.defOf(name)
      return {
        id: this.idOf(name),
        name,
        color: def.color ?? undefined,
        group_id: def.group ? this.groupIdOf(def.group) : null,
        is_favorite: false
      }
    })
  }

  async usageCounts(): Promise<Record<number, number>> {
    const out: Record<number, number> = {}
    for (const [name, n] of this.usage) out[this.idOf(name)] = n
    return out
  }

  async createGroup(name: string): Promise<number | null> {
    this.emptyGroups.add(name)
    return this.groupIdOf(name)
  }

  async renameGroup(id: number, name: string): Promise<boolean> {
    const old = this.groupNameOf(id)
    if (!old) return false
    for (const def of this.defs.filter((candidate) => candidate.group === old)) {
      const result = await catalogLibraryAPI.putTag(this.source.id, def.name, { group: name })
      if (!result.success) return false
    }
    this.groupIds.delete(old)
    this.groupIds.set(name, id)
    if (this.emptyGroups.delete(old)) this.emptyGroups.add(name)
    return true
  }

  async deleteGroup(id: number): Promise<boolean> {
    const name = this.groupNameOf(id)
    if (!name) return false
    for (const def of this.defs.filter((candidate) => candidate.group === name)) {
      const result = await catalogLibraryAPI.putTag(this.source.id, def.name, { group: null })
      if (!result.success) return false
    }
    this.emptyGroups.delete(name)
    this.groupIds.delete(name)
    return true
  }

  async createTag(name: string, groupId: number | null): Promise<number | null> {
    const result = await catalogLibraryAPI.putTag(this.source.id, name, {
      group: this.groupNameOf(groupId)
    })
    if (!result.success) return null
    await this.refresh()
    return this.idOf(name)
  }

  async renameTag(id: number, name: string): Promise<boolean> {
    const old = this.nameOf(id)
    if (!old || this.usageOf(old) > 0) return false
    const def = this.defOf(old)
    const created = await catalogLibraryAPI.putTag(this.source.id, name, {
      color: def.color ?? null,
      group: def.group ?? null
    })
    if (!created.success) return false
    await catalogLibraryAPI.deleteTag(this.source.id, old)
    this.ids.delete(old)
    this.ids.set(name, id)
    await this.refresh()
    return true
  }

  async deleteTags(ids: number[]): Promise<number> {
    let deleted = 0
    for (const id of ids) {
      const name = this.nameOf(id)
      // 还挂在资产上的不删：注册表删了，资产上的标签还在，下次打开又会冒出来
      if (!name || this.usageOf(name) > 0) continue
      if ((await catalogLibraryAPI.deleteTag(this.source.id, name)).success) deleted += 1
    }
    await this.refresh()
    return deleted
  }

  async update(id: number, patch: { group_id?: number | null }): Promise<boolean> {
    const name = this.nameOf(id)
    if (!name || !('group_id' in patch)) return false
    const result = await catalogLibraryAPI.putTag(this.source.id, name, {
      group: this.groupNameOf(patch.group_id)
    })
    if (result.success) await this.refresh()
    return result.success
  }

  async toggleFavorite(): Promise<boolean> {
    return false
  }

  async moveToGroup(ids: number[], groupId: number | null): Promise<number> {
    let moved = 0
    for (const id of ids) if (await this.update(id, { group_id: groupId })) moved += 1
    return moved
  }

  async unclaimed(): Promise<CatalogUnclaimed[] | null> {
    return await catalogLibraryAPI.unclaimed(this.source.id)
  }

  async claim(from: string, to: string): Promise<boolean> {
    const result = await catalogLibraryAPI.claim(this.source.id, from, to)
    // 认领过来的标签马上算进用量（页面接着会重取标签列表）
    if (result.success) await this.refresh()
    return result.success
  }

  /** 这个标签挂在多少个资产上（页面据此决定能不能改名 / 删除） */
  usageOf(name: string): number {
    return this.usage.get(name) ?? 0
  }

  usageOfId(id: number): number {
    const name = this.nameOf(id)
    return name ? this.usageOf(name) : 0
  }
}

/**
 * 一跳依赖 → 详情面板"导入依赖"的形状。服务端给了文件头里的 imports 就按它（库里没有的
 * 标成未找到，和本地库一样报警）；老服务端只有解析成功的 dependencies，全部可点。
 */
export function importStatusOf(detail: CatalogAssetDetail): AssetImportStatusSummary {
  const split = (softPath: string): { name: string; folder: string } => {
    const slash = softPath.lastIndexOf('/')
    return { name: softPath.slice(slash + 1), folder: softPath.slice(0, slash) }
  }
  if (detail.imports && detail.imports.length > 0) {
    const items = detail.imports.map((entry) => {
      const softPath = entry.path ? softPathOf(entry.path) : entry.package
      return entry.id !== null
        ? {
            softPath,
            ...split(softPath),
            status: 'in-vault' as const,
            assetKey: assetKeyOf(entry.id)
          }
        : { softPath, ...split(softPath), status: 'unresolved' as const }
    })
    return {
      total: items.length,
      unresolvedCount: items.filter((item) => item.status === 'unresolved').length,
      items
    }
  }
  const items = detail.dependencies.map((dependency) => {
    const softPath = softPathOf(dependency.path)
    return {
      softPath,
      ...split(softPath),
      status: 'in-vault' as const,
      assetKey: assetKeyOf(dependency.id)
    }
  })
  return { total: items.length, unresolvedCount: 0, items }
}
