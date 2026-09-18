// 笔记工具相关类型定义

/**
 * 同步状态枚举（与数据库模型保持一致）
 */
export type NoteSyncStatus = 'local-only' | 'pending' | 'synced' | 'sync-failed'

/**
 * 创建笔记参数
 */
export interface CreateNoteParams {
  title?: string
  content?: string
  /**
   * 挂在哪个资产上。和 folderKey 二选一，必须给一个 ——
   * 没有挂载的笔记在界面上没有入口，见 ./noteAttachment.ts
   */
  assetKey?: string
  /** 挂在哪个文件夹上。和 assetKey 二选一 */
  folderKey?: string
}

/**
 * 更新笔记参数
 */
export interface UpdateNoteParams {
  id: number
  title?: string
  content?: string
}

/**
 * 搜索笔记参数
 */
export interface SearchNoteParams {
  keyword?: string
  limit?: number
  offset?: number
  /** 直接返回完整正文，而不是预览。缺省 false */
  full?: boolean
}

/**
 * 获取笔记参数
 */
export interface GetNoteParams {
  id: number
}

/**
 * 删除笔记参数
 */
export interface DeleteNoteParams {
  id: number
}

/**
 * 笔记信息（工具返回的格式化笔记）
 */
export interface NoteInfo {
  id: number
  title: string
  /** 正文。列表模式下可能只是开头一段 —— 看 contentTruncated */
  content: string
  /** 为真表示 content 只是开头，完整正文要用 note_get 或 full=true 拿 */
  contentTruncated?: true
  /** 完整正文的字符数，仅在截断时给出 */
  contentLength?: number
  createdAt: string
  updatedAt: string
}

/**
 * 笔记操作成功结果
 */
export interface NoteSuccessResult {
  success: true
  message?: string
  count?: number
  note?: NoteInfo
  notes?: NoteInfo[]
  noteId?: number
}

/**
 * 笔记操作失败结果
 */
export interface NoteErrorResult {
  success: false
  error: string
}

/**
 * 笔记操作结果
 */
export type NoteResult = NoteSuccessResult | NoteErrorResult
