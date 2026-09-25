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
  /** 标签管理（本地标签库） */
  tagManagement: boolean
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
}

/** 树的虚拟根（与本地库一致：ALL 永远在第一位、自动展开） */
export const ROOT_FOLDER_KEY = 'ALL'
