/**
 * 同步状态枚举
 * - local-only: 仅本地，从未同步过
 * - pending: 本地有更新，待同步
 * - synced: 已同步到云端
 * - sync-failed: 同步失败
 */
export type NoteSyncStatus = 'local-only' | 'pending' | 'synced' | 'sync-failed'

/**
 * 笔记数据接口（前端使用）
 */
export interface Note {
  id?: number
  title: string
  content: string
  created_at?: string
  updated_at?: string

  // 同步相关字段
  remote_id?: string | null // 云端笔记 ID（MongoDB ObjectId）
  sync_status: NoteSyncStatus // 同步状态
  last_sync_at?: string | null // 上次成功同步时间
  sync_error?: string | null // 同步失败错误信息

  // 分享相关字段
  is_shared: boolean // 是否已公开分享
  share_id?: string | null // 云端分享记录 ID
  share_url?: string | null // 分享链接

  // 标签支持
  tags?: string | null // JSON 格式的标签数组
}
