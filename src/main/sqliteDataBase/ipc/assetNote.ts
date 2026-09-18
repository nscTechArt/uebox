import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

import { getVaultDatabase } from '../index'
import {
  createAssetNote,
  deleteAssetNote,
  getAssetNoteById,
  searchAssetNotes,
  updateAssetNote,
  type AssetNote
} from '../models/assetNote'
import { PathManager } from '../../utils/PathManager'

/**
 * 资产/文件夹「详细说明」的 IPC。
 *
 * 和 `ipc/note.ts` 的分工：那一套操作公共库的 note 表，现在只剩知识库的
 * 文本来源在用；这一套操作保管库的 assetNote 表，是用户看得见的那种说明。
 *
 * 正文里的图片和视频落在 `<保管库>/Notes/` 下，本来就跟着保管库走 ——
 * 现在正文也在保管库里，整块是完整的。
 */

/** 图片扩展名白名单。和渲染层 noteImages.ts 的 SAVABLE_EXTENSIONS 必须一致 */
const IMAGE_EXT = /^(png|jpg|jpeg|gif|webp|bmp)$/i
/** 视频扩展名白名单。和渲染层 noteVideos.ts 的那份必须一致 */
const VIDEO_EXT = /^(mp4|webm|ogv)$/i

async function saveMedia(
  kind: 'images' | 'videos',
  bytes: ArrayBuffer | Uint8Array,
  ext: string
): Promise<string> {
  const vaultPath = PathManager.getInstance().getCurrentVaultPath()
  const dir = join(vaultPath, 'Notes', kind)
  await fs.mkdir(dir, { recursive: true })
  const filePath = join(dir, `${randomUUID()}.${ext}`)
  await fs.writeFile(filePath, Buffer.from(bytes as ArrayBuffer))
  return filePath
}

export function registerAssetNoteIPC(): void {
  ipcMain.handle('assetNote:create', async (_e, data: Partial<AssetNote> = {}) => {
    void _e
    try {
      const db = getVaultDatabase()
      const id = createAssetNote(db, data)
      return { success: true, data: { id } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('assetNote:getById', async (_e, id: number) => {
    void _e
    try {
      return { success: true, data: getAssetNoteById(getVaultDatabase(), id) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'assetNote:search',
    async (_e, keyword: string, options: { limit?: number } = {}) => {
      void _e
      try {
        return { success: true, data: searchAssetNotes(getVaultDatabase(), keyword ?? '', options) }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('assetNote:update', async (_e, id: number, updates: Partial<AssetNote>) => {
    void _e
    try {
      return { success: true, data: { updated: updateAssetNote(getVaultDatabase(), id, updates) } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('assetNote:delete', async (_e, id: number) => {
    void _e
    try {
      const db = getVaultDatabase()
      const deleted = deleteAssetNote(db, id)
      // 把指向它的挂载点一起清掉，免得详情面板指着一篇不存在的说明
      if (deleted) {
        db.prepare('UPDATE assetData SET noteId = NULL WHERE noteId = ?').run(id)
        db.prepare('UPDATE assetFolder SET noteId = NULL WHERE noteId = ?').run(id)
      }
      return { success: true, data: { deleted } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /*
    图片和视频都只认白名单里的扩展名，但两边失败的处理不一样：

    图片认不出来就当 png 存下去 —— 和公共库那套保持一致，调用方拿不到路径时
    会退回 base64 内联，至少显示得出来。
    视频认不出来**直接拒绝**：几十上百兆存下一个播不出来的哑文件，比不让存更糟，
    而且 base64 兜底会把正文撑爆。
  */
  ipcMain.handle(
    'assetNote:saveImage',
    async (_e, params: { bytes: ArrayBuffer | Uint8Array; ext?: string }) => {
      void _e
      try {
        const raw = String(params.ext ?? '')
        const ext = IMAGE_EXT.test(raw) ? raw.toLowerCase() : 'png'
        return { success: true, data: { filePath: await saveMedia('images', params.bytes, ext) } }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'assetNote:saveVideo',
    async (_e, params: { bytes: ArrayBuffer | Uint8Array; ext?: string }) => {
      void _e
      try {
        const ext = String(params.ext ?? '').toLowerCase()
        if (!VIDEO_EXT.test(ext)) {
          return { success: false, error: `unsupported video format: ${ext || 'unknown'}` }
        }
        return { success: true, data: { filePath: await saveMedia('videos', params.bytes, ext) } }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
