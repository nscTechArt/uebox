/**
 * 资产库数据源接缝：资产库页面（树、列表、搜索、筛选、详情）从这里取数，不再直接调本地 IPC。
 *
 * 两个实现：
 *
 * - **LocalLibrarySource**：原样转发到今天的 assetFolderAPI / assetDataAPI / 统一搜索 IPC，
 *   本地库和旧网络库的行为一行不变；
 * - **ServerLibrarySource**：服务端资产库（asset-catalog）。一行也不抄到本机，
 *   每个调用都是向主进程要一页（主进程再向服务器要，或命中看过的页）。
 *   返回的对象是**本地的形状**（folderKey / assetKey / assetName / className …），
 *   所以现有的树、网格、详情面板不用认识第二种数据。
 *
 * 界面按 `capabilities` 决定显示什么、禁用什么（并给一句原因），
 * 不在各处判断"是不是服务器库"。
 */
import type { AssetImportStatusSummary } from '@core/shared/assetDependency'
import type { CatalogUnclaimed } from '@core/shared/catalogLibrary'

export type SortBy = 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType'
export type SortOrder = 'asc' | 'desc'

/** 统一搜索的条件（与 index.vue 的 buildListCriteria 同形） */
export interface LibraryListCriteria {
  folderKey?: string
  includeSubfolders?: boolean
  keyword?: string
  classNameCnFilters?: string[]
  fileExtensions?: string[]
  /** 只有服务端库有：引擎版本分面 */
  engineVersions?: string[]
  sortBy?: string
  sortOrder?: SortOrder
  limit?: number
  offset?: number
  [key: string]: unknown
}

/** 某个能力不可用时给用户的一句话（i18n 键），挂在禁用项的 title 上 */
export type CapabilityReason = string | null

export interface LibraryCapabilities {
  /**
   * 当前库就是主进程的当前保管库：保管库级的功能（旧网络库同步、离线横幅、整包上传……）
   * 只在这时出现
   */
  vaultFeatures: boolean
  /** 列表只能向服务端一页一页要，没有可在本机切片的全量数据 */
  pagedOnly: boolean
  /** 能改库的结构：新建 / 重命名 / 删除 / 移动文件夹和资产，改颜色和封面 */
  canEditStructure: boolean
  /** 标签模型：本地标签库（按 id）/ 服务端注释（按名字）/ 不支持 */
  tagModel: 'registry' | 'names' | 'none'
  /** 能写一句话备注 */
  canEditNotes: boolean
  /** 能挂富文本说明书（本地笔记库） */
  richNotes: boolean
  canFavorite: boolean
  hasTrash: boolean
  /** 扫描变更 / 增量扫描 / 拉取同步 */
  canScan: boolean
  /** 导入（本地复制 / 引用，或服务端经 lore 提交） */
  canImport: boolean
  /** 下载到工程：本地库走工程导入；服务端库经 lore 物化后复制 */
  canSendToProject: boolean
  /** Alt 拖出到系统（需要本机已有文件） */
  nativeDrag: boolean
  /** 按文件夹名搜索 */
  folderSearch: boolean
  /** 依赖关系图页 */
  dependencyGraph: boolean
  /** 标签管理（本地标签库，或服务端的标签注册表） */
  tagManagement: boolean
  /** 给文件夹设颜色（本地库属于改结构；服务端库是注释） */
  folderColor: boolean
  /** 百度网盘 / WebDAV：本地库的导入来源，在它们里面挑文件进当前库 */
  cloudDrives: boolean
  /** 按类型排序 */
  sortByType: boolean
  /** 筛选栏里各组是否可用 */
  filters: {
    category: boolean
    assetTypes: boolean
    size: boolean
    date: boolean
    tags: boolean
    favorite: boolean
    showDependencies: boolean
    /** 服务端分面：引擎版本 */
    engine: boolean
    /**
     * 标签筛选能做到哪一步：'full' = 本地库的全部（包含 / 排除 / 全部命中 / 无标签）；
     * 'include-any' = 只能"带其中任一标签"（服务端的 tag 参数）
     */
    tagMode: 'full' | 'include-any'
  }
  /** 不可用的原因（i18n 键），按能力名查 */
  reasons: Record<string, CapabilityReason>
}

export interface LibraryFolderApi {
  getRootFolders(sortBy?: SortBy, sortOrder?: SortOrder): Promise<AssetFolder[]>
  getByFatherKey(
    fatherKey: string,
    sortBy?: SortBy,
    sortOrder?: SortOrder,
    limit?: number,
    offset?: number
  ): Promise<AssetFolder[]>
  getByKey(folderKey: string): Promise<AssetFolder | undefined>
  getChildCount(fatherKey: string): Promise<number>
  getPathArray(folderKey: string): Promise<string[]>
  /** 文件夹颜色（null 清除）；能力看 capabilities.folderColor */
  setColor(folderKey: string, color: string | null): Promise<{ ok: boolean; error?: string }>
}

export interface LibraryAssetApi {
  getByFolderKey(
    folderKey: string,
    sortBy?: SortBy,
    sortOrder?: SortOrder,
    showDependencies?: boolean,
    limit?: number,
    offset?: number
  ): Promise<AssetData[]>
  getCountByFolderKey(folderKey: string, showDependencies?: boolean): Promise<number>
  getById(assetKey: string): Promise<AssetData | undefined>
  getImportStatus(assetKey: string): Promise<AssetImportStatusSummary>
  getDistinctAssetTypes(): Promise<
    Array<{ className: string; classNameCn: string; count?: number }>
  >
}

export interface LibrarySearchApi {
  /** 资产搜索，回原始行（调用方再映射成列表项） */
  assets(criteria: LibraryListCriteria): Promise<Array<Record<string, unknown>>>
  /** 当前文件夹下按名字找子文件夹 */
  folders(params: {
    folderKey?: string
    includeSubfolders?: boolean
    keyword?: string
    limit?: number
  }): Promise<Array<Record<string, unknown>>>
}

/** 按名字的标签与一句话备注（服务端注释模型） */
export interface LibraryAnnotationApi {
  get(target: { assetKey?: string; folderKey?: string }): Promise<{ tags: string[]; note: string }>
  edit(
    target: { assetKey?: string; folderKey?: string },
    op: { addTags?: string[]; removeTags?: string[]; note?: string }
  ): Promise<{ ok: boolean; error?: string }>
}

/** 引擎版本等服务端分面（本地库没有） */
export interface LibraryFacetApi {
  engines(criteria: LibraryListCriteria): Promise<Array<{ value: string; n: number }>>
  /** 标签分面（名字 + 挂在多少个资产上），给服务器库的标签筛选用 */
  tags(criteria: LibraryListCriteria): Promise<Array<{ value: string; n: number }>>
}

/**
 * 收藏。本地库存在保管库里；服务端库存在本机（按库、按资产 id），服务器不知道。
 * 形状照搬 favoriteAPI，方便原来的调用点直接换。
 */
export interface LibraryFavoritesApi {
  add(assetKey: string): Promise<boolean>
  remove(assetKey: string): Promise<boolean>
  addFolder(folderKey: string): Promise<boolean>
  removeFolder(folderKey: string): Promise<boolean>
  batchCheck(assetKeys: string[]): Promise<Record<string, boolean>>
  isFolderFavorite(folderKey: string): Promise<boolean>
  /** vaultId 只对本地库有意义（切保管库的那一刻，当前保管库可能还没换过来） */
  count(vaultId?: string): Promise<number>
  /** 收藏的文件夹，列表能直接显示的形状 */
  folders(): Promise<Array<Record<string, unknown>>>
}

/** 标签管理页用的标签组 / 标签（与本地标签库同形） */
export interface RegistryTagGroup {
  id: number
  name: string
  color?: string
  sort_order?: number
  tagCount?: number
}
export interface RegistryTag {
  id: number
  name: string
  color?: string
  group_id?: number | null
  is_favorite?: boolean
}

/**
 * 标签管理页的后端。本地 = 公共标签库；服务端 = 库的标签注册表（名字 + 颜色 + 分组名）。
 * 服务端做不到的（改名已在用的标签、常用）由 abilities 说明，页面据此隐藏或禁用。
 */
export interface LibraryTagRegistryApi {
  readonly abilities: {
    /** 能改名（服务端：只有还没挂在任何资产上的标签） */
    renameUnused: boolean
    renameUsed: boolean
    favorite: boolean
  }
  groups(): Promise<RegistryTagGroup[]>
  tags(): Promise<RegistryTag[]>
  usageCounts(): Promise<Record<number, number>>
  createGroup(name: string, sortOrder: number, color?: string): Promise<number | null>
  renameGroup(id: number, name: string): Promise<boolean>
  deleteGroup(id: number): Promise<boolean>
  createTag(name: string, groupId: number | null, favorite: boolean): Promise<number | null>
  renameTag(id: number, name: string): Promise<boolean>
  deleteTags(ids: number[]): Promise<number>
  update(id: number, patch: { group_id?: number | null; is_favorite?: boolean }): Promise<boolean>
  toggleFavorite(id: number): Promise<boolean>
  moveToGroup(ids: number[], groupId: number | null): Promise<number>
  /**
   * 服务器库：文件已不在（删除，或移动后没配上）的标签和备注，等人认领到某个资产上。
   * 本地库没有这回事（不实现）。null = 服务端没有这条路由或你看不到。
   */
  unclaimed?(): Promise<CatalogUnclaimed[] | null>
  claim?(from: string, to: string): Promise<boolean>
}

export interface AssetLibrarySource {
  readonly kind: 'local' | 'server'
  /** 本地：'local'；服务端：库键 */
  readonly id: string
  readonly capabilities: LibraryCapabilities
  readonly folders: LibraryFolderApi
  readonly assets: LibraryAssetApi
  readonly search: LibrarySearchApi
  readonly annotations: LibraryAnnotationApi | null
  readonly facets: LibraryFacetApi | null
  readonly favorites: LibraryFavoritesApi
  readonly tagRegistry: LibraryTagRegistryApi
}

/** 树的虚拟根（与本地库一致：ALL 永远在第一位、自动展开） */
export const ROOT_FOLDER_KEY = 'ALL'
