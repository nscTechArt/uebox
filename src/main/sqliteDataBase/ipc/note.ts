import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { ipcMain } from 'electron'

import { getPublicDatabase } from '../index'
import { PathManager } from '../../utils/PathManager'
import {
  createNote,
  getNoteById,
  listNotes,
  searchNotes,
  updateNote,
  deleteNote,
  type Note
} from '../models/note'

/**
 * 注册笔记相关的IPC处理函数
 */
export const registerNoteIPC = (): void => {
  // 创建笔记
  ipcMain.handle('note:create', async (_e, data: Partial<Note> = {}) => {
    try {
      const db = getPublicDatabase()
      const id = createNote(db, data)
      return { success: true, data: { id } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 根据ID获取笔记
  ipcMain.handle('note:getById', async (_e, id: number) => {
    try {
      const db = getPublicDatabase()
      const note = getNoteById(db, id)
      return { success: true, data: note }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 列出所有笔记
  ipcMain.handle('note:list', async (_e, options: { limit?: number; offset?: number } = {}) => {
    try {
      const db = getPublicDatabase()
      const notes = listNotes(db, options)
      return { success: true, data: notes }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 搜索笔记
  ipcMain.handle(
    'note:search',
    async (_e, keyword: string, options: { limit?: number; offset?: number } = {}) => {
      try {
        const db = getPublicDatabase()
        const notes = searchNotes(db, keyword, options)
        return { success: true, data: notes }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 更新笔记
  ipcMain.handle('note:update', async (_e, id: number, updates: Partial<Note>) => {
    try {
      const db = getPublicDatabase()
      const ok = updateNote(db, id, updates)
      return { success: true, data: { updated: ok } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 笔记里贴进来的图片落到磁盘上，返回它的路径。
   *
   * ## 为什么不能继续存 base64
   *
   * 编辑器原来把贴进来的图直接 `setImage({ src: dataUrl })`，于是图片变成正文的一部分：
   * 贴五张截图，这篇笔记就是几 MB 的 HTML；而正文每改一个字都要整篇写回数据库、
   * 重算内容哈希、把索引标成待重建 —— 越写越卡。更要紧的是它违反了「用户创作的东西，
   * 唯一真相源是磁盘上的文件」：图片存在数据库的一列 TEXT 里，拷不走也备份不到。
   *
   * 落在保管库的 `Notes/images/` 下，跟着保管库走。
   */
  ipcMain.handle(
    'note:saveImage',
    async (_e, params: { bytes: ArrayBuffer | Uint8Array; ext?: string }) => {
      try {
        const vaultPath = PathManager.getInstance().getCurrentVaultPath()
        const dir = join(vaultPath, 'Notes', 'images')
        await fs.mkdir(dir, { recursive: true })

        /*
          扩展名只认白名单里的几个，其余一律当 png —— 这个值来自渲染层。

          这份名单和渲染层 `noteImages.ts` 的 `SAVABLE_EXTENSIONS` 必须一致：
          那边多报一个格式，文件就会以 `.png` 存下去、里面却是别的格式的字节，
          本地资源按扩展名给 Content-Type，那张图就再也渲染不出来了。
          尤其别往里加 svg —— SVG 能带 `<script>`。
        */
        const ext = /^(png|jpg|jpeg|gif|webp|bmp)$/i.test(String(params.ext ?? ''))
          ? String(params.ext).toLowerCase()
          : 'png'
        const filePath = join(dir, `${randomUUID()}.${ext}`)
        await fs.writeFile(filePath, Buffer.from(params.bytes as ArrayBuffer))

        return { success: true, data: { filePath } }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 把视频存进保管库，供笔记内嵌播放。
   *
   * 和 saveImage 一个规矩：扩展名走白名单，因为本地资源服务是按扩展名给
   * Content-Type 的。但这里不做「不认识就当 mp4」的兜底 —— 图片认错了顶多
   * 不显示，视频认错了会存下一个几十上百兆、永远播不出来的文件。宁可拒绝。
   *
   * 白名单只放 Chromium 真能播的容器。`.mov` 不在里面：QuickTime 容器在
   * Chromium 里不保证能解，存下去就是一个占空间的哑文件。
   */
  ipcMain.handle(
    'note:saveVideo',
    async (_e, params: { bytes: ArrayBuffer | Uint8Array; ext?: string }) => {
      try {
        const ext = String(params.ext ?? '').toLowerCase()
        if (!/^(mp4|webm|ogv)$/.test(ext)) {
          return { success: false, error: `unsupported video format: ${ext || 'unknown'}` }
        }

        const vaultPath = PathManager.getInstance().getCurrentVaultPath()
        const dir = join(vaultPath, 'Notes', 'videos')
        await fs.mkdir(dir, { recursive: true })

        const filePath = join(dir, `${randomUUID()}.${ext}`)
        await fs.writeFile(filePath, Buffer.from(params.bytes as ArrayBuffer))

        return { success: true, data: { filePath } }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 删除笔记
  ipcMain.handle('note:delete', async (_e, id: number) => {
    try {
      const db = getPublicDatabase()
      const ok = deleteNote(db, id)
      return { success: true, data: { deleted: ok } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
