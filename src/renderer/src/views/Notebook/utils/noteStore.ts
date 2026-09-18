import noteAPI from '@renderer/api/note'
import assetNoteAPI from '@renderer/api/assetNote'

/**
 * 笔记编辑器要操作的两个存储。
 *
 * 同一个编辑器界面，底下是两张表：
 *
 * - `vault` —— 保管库的 `assetNote`。资产/文件夹的「详细说明」，跟着保管库走，
 *   正文里的图片视频也落在同一个保管库目录下。这是用户看得见的那种。
 * - `public` —— 公共库的 `note`。知识库文本来源的内部存储，知识库本身是全局的，
 *   不属于任何保管库，所以它不能跟着保管库走。
 *
 * 抽这一层是为了让 NoteEditor 只写一遍逻辑 —— 否则每个读写点都要分叉，
 * 而那种分叉最后一定会漏掉一两处，表现成「在知识库里写的图存进了保管库」。
 */
export type NoteStoreKind = 'vault' | 'public'

export interface EditableNote {
  id?: number
  title: string
  content: string
  created_at?: string
  updated_at?: string
}

export interface NoteStore {
  list(options?: { limit?: number }): Promise<EditableNote[]>
  create(data: { title?: string; content?: string }): Promise<number>
  getById(id: number): Promise<EditableNote | undefined>
  update(id: number, updates: { title?: string; content?: string }): Promise<boolean>
  saveImage(bytes: Uint8Array, ext: string): Promise<string>
  saveVideo(bytes: Uint8Array, ext: string): Promise<string>
}

const vaultStore: NoteStore = {
  list: (options = {}) => assetNoteAPI.search('', { limit: options.limit ?? 100 }),
  create: (data) => assetNoteAPI.create(data),
  getById: (id) => assetNoteAPI.getById(id),
  update: (id, updates) => assetNoteAPI.update(id, updates),
  saveImage: (bytes, ext) => assetNoteAPI.saveImage(bytes, ext),
  saveVideo: (bytes, ext) => assetNoteAPI.saveVideo(bytes, ext)
}

const publicStore: NoteStore = {
  list: (options = {}) => noteAPI.list({ limit: options.limit ?? 100 }),
  create: (data) => noteAPI.create(data),
  getById: (id) => noteAPI.getById(id),
  update: (id, updates) => noteAPI.update(id, updates),
  saveImage: (bytes, ext) => noteAPI.saveImage(bytes, ext),
  saveVideo: (bytes, ext) => noteAPI.saveVideo(bytes, ext)
}

export function getNoteStore(kind: NoteStoreKind): NoteStore {
  return kind === 'public' ? publicStore : vaultStore
}
