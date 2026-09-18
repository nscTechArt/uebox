/**
 * 「把这条来源里的图读一遍」的 IPC。
 *
 * 放在主进程是因为三件事都在这边：抓图片不受 CORS 限制、模型绑定在这边解析、
 * 结果要写回 SQLite。渲染层只负责发起和显示结果。
 */
import { ipcMain } from 'electron'

import { getPublicDatabase } from '../index'
import { getNotebookSourceBySourceId, updateNotebookSource } from '../models/notebook'
import { getSetting } from '../models/settings'
import {
  DEFAULT_IMAGE_READ_POLICY,
  readImagesInMarkdown,
  type ImageReadStats
} from '../../services/notebookImageReader'
import { DEFAULT_IMAGE_READ_MAX, normalizeMaxImages } from '../../../shared/notebookImagePolicy'

/** 设置表里的开关键。默认关 —— 读图按张收费，不能替用户决定 */
export const NOTEBOOK_READ_IMAGES_KEY = 'notebook_read_images'

/** 每篇读几张。用户自己配，这里不写死 */
export const NOTEBOOK_READ_IMAGES_MAX_KEY = 'notebook_read_images_max'

interface ReadImagesResult {
  success: boolean
  stats?: ImageReadStats
  error?: string
}

export const registerNotebookImagesIPC = (): void => {
  /**
   * 读完这条来源里的图，把识别到的文字插回正文。
   *
   * 开关没开就原样返回（`stats.read === 0`），不报错也不改任何东西 ——
   * 调用方可以无脑调，由这里统一判断该不该花这笔钱。
   */
  ipcMain.handle(
    'notebook:source:read-images',
    async (_event, sourceId: string): Promise<ReadImagesResult> => {
      try {
        const db = getPublicDatabase()
        const source = getNotebookSourceBySourceId(db, sourceId)
        if (!source) return { success: false, error: '来源不存在' }

        const enabled = Boolean(getSetting(db, NOTEBOOK_READ_IMAGES_KEY, false))
        const maxImages = normalizeMaxImages(
          getSetting(db, NOTEBOOK_READ_IMAGES_MAX_KEY, DEFAULT_IMAGE_READ_MAX)
        )

        const { markdown, stats } = await readImagesInMarkdown(source.content, {
          ...DEFAULT_IMAGE_READ_POLICY,
          enabled,
          maxImages
        })

        // 一张都没读出来就别写库：写了会白白 bump content_revision，
        // 触发一次没有任何意义的重新向量化
        if (stats.read > 0) {
          updateNotebookSource(db, sourceId, { content: markdown })
        }

        return { success: true, stats }
      } catch (error) {
        console.error('[NotebookImages IPC] 读图失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '读图失败' }
      }
    }
  )

  console.log('[NotebookImages IPC] 处理器已注册')
}
