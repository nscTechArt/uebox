/**
 * SyncProtocol — 网络资产库 V2 RPC 协议类型定义
 *
 * 定义 Server ↔ Client 之间 HTTP REST + WebSocket 通信的全部类型。
 * 与 v1 NetworkVaultTypes 完全独立，不再包含 Manifest / Journal 概念。
 */

// ─────────────────────────── .vault 服务发现 ───────────────────────────

/**
 * 网络共享根目录下 `.vault` 文件内容
 * Client 通过读取此文件发现 Server 地址
 */
export interface VaultDiscovery {
  /** 协议版本，用于向后兼容检测 */
  protocolVersion: number
  /** Server 的 IP 地址或 hostname */
  server: string
  /** Server HTTP 端口 */
  port: number
  /** 保管库唯一 ID */
  vaultId: string
  /** 保管库人类名 */
  name: string
  /** Server 最后更新此文件的时间戳 */
  updatedAt: number
  /** v3 起：服务端是否强制访问码鉴权。老客户端不认这个字段，靠 protocolVersion 拦 */
  authRequired?: boolean
  /**
   * v3 起：随共享目录分发的**只读**访问码。
   *
   * 信任模型：能读到这个共享目录的人 == 今天就能读到全部资产的人，
   * 所以把只读码放这里不降低安全性，却让老部署升级后**零操作**继续工作。
   */
  readKey?: string
  /** v3 起：只有主机在界面上勾了「共享写入权限」才写入 */
  writeKey?: string
}

/** 当前协议版本 —— v3 起强制访问码鉴权 */
export const PROTOCOL_VERSION = 3

/** 服务发现文件名 */
export const VAULT_DISCOVERY_FILE = '.vault'

/** 缩略图目录名 */
export const THUMBNAILS_DIR = '.thumbnails'

/** 扫描时排除的目录 */
export const SCAN_EXCLUDE_DIRS = [THUMBNAILS_DIR, '.vault']

// ─────────────────────────── change_log 表 ───────────────────────────

/** 变更操作类型 */
export type ChangeOp = 'insert' | 'update' | 'delete'

/** 可跟踪变更的表名 */
export type TrackedTable = 'assetData' | 'assetFolder' | 'assetTag' | 'assetFavorite'

/**
 * 变更日志条目 — 对应 `change_log` 表的一行
 * Server 每次写操作后追加一条，Client 通过 seq 增量拉取
 */
export interface ChangeLogEntry {
  /** 全局递增序号（主键） */
  seq: number
  /** 操作类型 */
  op: ChangeOp
  /** 被操作的表 */
  tableName: TrackedTable
  /** 被操作记录的主键值 */
  recordKey: string
  /** 变更后的完整行数据（JSON），delete 时为 null */
  payload: string | null
  /** 操作来源标识（'server' 或 clientId） */
  clientId: string
  /** 创建时间戳（ms） */
  createdAt: number
}

// ─────────────────────────── HTTP API 类型 ───────────────────────────

/** 统一 API 响应包装 */
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  /** 对于分页请求 */
  total?: number
}

/** GET /api/vaults/:vid/sync?since=SEQ 响应 */
export interface SyncResponse {
  changes: ChangeLogEntry[]
  /** Server 当前最新 seq */
  latestSeq: number
  /** 是否需要全量同步（Client 的 lastSeq 已被清理） */
  fullSyncRequired: boolean
}

/** GET /api/vaults/:vid/checksum 响应 */
export interface ChecksumResponse {
  assetCount: number
  folderCount: number
  latestSeq: number
}

/** POST /api/vaults/:vid/scan 响应 */
export interface ScanResponse {
  added: number
  updated: number
  removed: number
  total: number
}

// ─────────────────────────── WebSocket 消息 ───────────────────────────

/** WebSocket 消息基础结构 */
export interface WsMessageBase {
  type: string
}

/** Server → Client: 实时变更推送 */
export interface WsChangeMessage extends WsMessageBase {
  type: 'change'
  seq: number
  op: ChangeOp
  tableName: TrackedTable
  recordKey: string
  payload: string | null
  clientId: string
}

/** Server → Client: 扫描进度 */
export interface WsScanProgressMessage extends WsMessageBase {
  type: 'scan_progress'
  current: number
  total: number
  phase: 'scanning' | 'parsing' | 'done'
  assetName?: string
}

/** Server → Client: 服务器状态 */
export interface WsStatusMessage extends WsMessageBase {
  type: 'status'
  latestSeq: number
  assetCount: number
  connectedClients: number
}

/** Client → Server: 心跳 */
export interface WsPingMessage extends WsMessageBase {
  type: 'ping'
  clientId: string
  lastSeq: number
}

/** Server → Client: 心跳回复 */
export interface WsPongMessage extends WsMessageBase {
  type: 'pong'
  latestSeq: number
}

/** Server → Client: 磁盘空间警告 */
export interface WsDiskWarningMessage extends WsMessageBase {
  type: 'disk_warning'
  freeSpaceMB: number
  message: string
}

/** 所有 WebSocket 消息类型集合 */
export type WsServerMessage =
  | WsChangeMessage
  | WsScanProgressMessage
  | WsStatusMessage
  | WsPongMessage
  | WsDiskWarningMessage

export type WsClientMessage = WsPingMessage

// ─────────────────────────── Server 配置 ───────────────────────────

/** 权限等级 */
export type PermissionLevel = 'readonly' | 'readwrite' | 'admin'

/** Server 配置 */
export interface ServerConfig {
  /** HTTP + WS 监听端口 */
  port: number
  /**
   * @deprecated v3 起权限由「客户端出示了哪把访问码」决定。
   * 保留字段只为读旧配置，不再参与判定。
   */
  defaultPermission: PermissionLevel
  /**
   * IP → 权限**上限**（只降不升）。留空 = 不做 IP 限制。
   *
   * 语义变更：v2 里它是唯一权限来源（而且没有任何界面能填，导致所有客户端
   * 永远只读）；v3 里它是访问码之上的额外收紧。
   */
  permissions: Record<string, PermissionLevel>
  /** change_log 最大保留条数 */
  maxChangeLogEntries: number
  /** 自动备份间隔（ms），0 = 不备份 */
  autoBackupIntervalMs: number
  /**
   * 兼容窗口截止时间戳（ms）。> now 时允许**无凭据只读**（仅私网 IP）。
   *
   * 默认 0 = 关闭。安全修复的默认值必须是安全的；这个开关只是给
   * 「主机先升级、同事 PC 还没升级」的团队一个自救按钮，UI 上限 7 天。
   */
  legacyUnauthReadUntil?: number
  /** 允许出现在 Host 头里的主机名，默认 [os.hostname()] */
  allowedHostnames?: string[]
}

/** 默认配置 */
export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 18900,
  defaultPermission: 'readonly',
  permissions: {},
  maxChangeLogEntries: 100_000,
  autoBackupIntervalMs: 3600_000, // 1小时
  legacyUnauthReadUntil: 0
}

// ─────────────────────────── Client 注册 ───────────────────────────

/** 已注册的同步客户端信息 */
export interface SyncClientInfo {
  clientId: string
  hostname: string
  lastSeq: number
  lastSeen: number
  ip: string
}
