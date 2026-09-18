/**
 * 资产库页面类型定义
 */

import type { Dayjs } from 'dayjs'

// 资产类型枚举
export enum AssetType {
  MODEL = 'model',
  TEXTURE = 'texture',
  ANIMATION = 'animation',
  SOUND = 'sound',
  MATERIAL = 'material',
  BLUEPRINT = 'blueprint',
  LEVEL = 'level',
  OTHER = 'other'
}

// 资产状态枚举
export enum AssetStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  DRAFT = 'draft',
  ARCHIVED = 'archived',
  PROCESSING = 'processing',
  ERROR = 'error'
}

// 文件夹类型枚举
export enum FolderType {
  NORMAL = 'normal',
  PLUGIN = 'plugin',
  PROJECT = 'project',
  SYSTEM = 'system'
}

// 树节点类型
export interface TreeNode {
  key: string
  title: string
  type: 'folder' | 'file'
  folderType?: 'normal' | 'plugin' | 'project' | 'system' // 兼容全局 FolderType
  path: string
  children?: TreeNode[]
  childrenLoaded?: boolean
  isLeaf?: boolean
  color?: string // 用户自定义颜色（十六进制格式）
  img?: string // 插件图标路径
}

// 文件/文件夹类型
export interface AssetFile {
  id: string
  name: string
  type: 'folder' | 'file'
  folderType?: FolderType
  path: string
  size?: number
  modifiedTime: string
  extension?: string
  thumbnail?: string
  isFavorite?: boolean
}

// 数据库资产行（渲染层常用的资产基础数据）
export interface AssetDataRow {
  assetKey: string
  folderKey?: string
  assetName: string
  updated_at?: string
  imgLocalPath?: string
  thumbnail?: string
  customPoster?: string
  assetType?: string
  [key: string]: any
}

// 资产详情数据（在面板中展示的扩展信息）
export interface AssetDetail extends AssetDataRow {
  fileSize?: number
  fileExtension?: string
  path?: string
  created_at?: string
}

// 面包屑项目类型
export interface BreadcrumbItem {
  name: string
  path: string
}

// 资产基础信息接口
export interface Asset {
  /** 资产ID */
  id: string
  /** 资产名称 */
  name: string
  /** 资产类型 */
  type: AssetType
  /** 资产状态 */
  status: AssetStatus
  /** 文件路径 */
  filePath: string
  /** 文件大小（字节） */
  size: number
  /** 缩略图URL */
  thumbnail?: string
  /** 资产描述 */
  description?: string
  /** 标签列表 */
  tags?: string[]
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
  /** 创建者ID */
  creatorId?: string
  /** 创建者名称 */
  creatorName?: string
  /** 版本号 */
  version?: string
  /** 文件哈希值 */
  fileHash?: string
  /** 元数据 */
  metadata?: AssetMetadata
}

// 资产元数据接口
export interface AssetMetadata {
  /** 模型相关元数据 */
  model?: {
    /** 顶点数 */
    vertices?: number
    /** 面数 */
    faces?: number
    /** 材质数量 */
    materials?: number
    /** 动画数量 */
    animations?: number
  }
  /** 贴图相关元数据 */
  texture?: {
    /** 宽度 */
    width?: number
    /** 高度 */
    height?: number
    /** 颜色深度 */
    depth?: number
    /** 格式 */
    format?: string
  }
  /** 音频相关元数据 */
  audio?: {
    /** 时长（秒） */
    duration?: number
    /** 采样率 */
    sampleRate?: number
    /** 比特率 */
    bitRate?: number
    /** 声道数 */
    channels?: number
  }
}

// 筛选条件接口
export interface AssetFilters {
  /** 资产名称 */
  name: string
  /** 资产类型 */
  type: string
  /** 资产状态 */
  status: string
  /** 日期范围 */
  dateRange: (Dayjs | string)[]
  /** 标签 */
  tags?: string[]
  /** 创建者 */
  creator?: string
  /** 文件大小范围 */
  sizeRange?: [number, number]
}

// 分页配置接口
export interface PaginationConfig {
  /** 当前页码 */
  current: number
  /** 每页条数 */
  pageSize: number
  /** 总条数 */
  total: number
  /** 是否显示每页条数选择器 */
  showSizeChanger?: boolean
  /** 是否显示快速跳转 */
  showQuickJumper?: boolean
  /** 每页条数选项 */
  pageSizeOptions?: string[]
}

// 排序配置接口
export interface SortConfig {
  /** 排序字段 */
  field: keyof Asset
  /** 排序方向 */
  order: 'asc' | 'desc'
}

// API 请求参数接口
export interface AssetListParams extends Partial<AssetFilters> {
  /** 页码 */
  page?: number
  /** 每页条数 */
  pageSize?: number
  /** 排序配置 */
  sort?: SortConfig
}

// API 响应接口
export interface AssetListResponse {
  /** 资产列表 */
  data: Asset[]
  /** 总条数 */
  total: number
  /** 当前页码 */
  page: number
  /** 每页条数 */
  pageSize: number
}

// 资产创建/更新接口
export interface AssetCreateData {
  /** 资产名称 */
  name: string
  /** 资产类型 */
  type: AssetType
  /** 资产状态 */
  status: AssetStatus
  /** 文件路径 */
  filePath: string
  /** 缩略图URL */
  thumbnail?: string
  /** 资产描述 */
  description?: string
  /** 标签列表 */
  tags?: string[]
  /** 元数据 */
  metadata?: AssetMetadata
}

export interface AssetUpdateData extends Partial<AssetCreateData> {
  /** 资产ID */
  id: string
}

// 文件上传接口
export interface FileUploadData {
  /** 文件对象 */
  file: File
  /** 上传类型 */
  type: 'asset' | 'thumbnail'
  /** 资产类型 */
  assetType?: AssetType
}

export interface FileUploadResponse {
  /** 文件URL */
  url: string
  /** 文件大小 */
  size: number
  /** 文件哈希 */
  hash: string
  /** 元数据 */
  metadata?: AssetMetadata
}

// 表格列配置接口
export interface TableColumn {
  /** 列标题 */
  title: string
  /** 数据字段 */
  dataIndex?: string
  /** 列键值 */
  key: string
  /** 列宽度 */
  width?: number
  /** 对齐方式 */
  align?: 'left' | 'center' | 'right'
  /** 是否可排序 */
  sorter?: boolean
  /** 筛选选项 */
  filters?: Array<{ text: string; value: string }>
  /** 是否省略显示 */
  ellipsis?: boolean
}

// 模态框模式类型
export type ModalMode = 'add' | 'edit' | 'view'

// 操作类型
export type ActionType = 'create' | 'update' | 'delete' | 'view' | 'download'

// 错误信息接口
export interface ErrorInfo {
  /** 错误代码 */
  code: string
  /** 错误消息 */
  message: string
  /** 详细信息 */
  details?: any
}

// 缓存数据接口
export interface CacheData<T = any> {
  /** 缓存数据 */
  data: T
  /** 缓存时间戳 */
  timestamp: number
  /** 过期时间 */
  expireTime: number
}

// Hook 返回值接口
export interface UseAssetManagementReturn {
  /** 获取资产列表 */
  fetchAssets: (params?: AssetListParams) => Promise<AssetListResponse>
  /** 创建资产 */
  createAsset: (data: AssetCreateData) => Promise<Asset>
  /** 更新资产 */
  updateAsset: (id: string, data: Partial<AssetCreateData>) => Promise<Asset>
  /** 删除资产 */
  deleteAsset: (id: string) => Promise<void>
  /** 上传文件 */
  uploadFile: (data: FileUploadData) => Promise<FileUploadResponse>
  /** 获取资产详情 */
  getAssetDetail: (id: string) => Promise<Asset>
}

// 组件 Props 接口
export interface AssetFilterProps {
  /** 筛选条件 */
  filters: AssetFilters
}

export interface AssetTableProps {
  /** 数据源 */
  data: Asset[]
  /** 加载状态 */
  loading: boolean
  /** 分页配置 */
  pagination: PaginationConfig
}

export interface AssetModalProps {
  /** 显示状态 */
  visible: boolean
  /** 资产数据 */
  asset: Asset | null
  /** 模态框模式 */
  mode: ModalMode
}
