import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { existsSync } from 'fs'
import { PathManager } from '../../utils/PathManager'
import { getVaultDatabase } from '../index'
import { createAssetFolder, getAssetFolderByKey, updateAssetFolder } from '../models/assetFolder'
import { createAssetData } from '../models/assetData'

/**
 * 清理文件名中的非法字符
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled'
}

/**
 * 将图片保存到知识库资产目录
 */
async function saveInfographicToLocal(
  imageUrl: string,
  notebookId: string,
  notebookTitle: string,
  imageTitle?: string
): Promise<{ success: boolean; localPath?: string; error?: string }> {
  try {
    const pm = PathManager.getInstance()
    const vaultPath = pm.getCurrentVaultPath()
    const safeNotebookTitle = sanitizeFileName(notebookTitle)
    const baseDir = join(vaultPath, 'Notebook', notebookId)

    if (!existsSync(baseDir)) {
      await fs.mkdir(baseDir, { recursive: true })
    }

    const db = getVaultDatabase()
    const notebookFolderKey = 'Notebook'
    const notebookSubFolderKey = `Notebook_${notebookId}`

    if (!getAssetFolderByKey(db, notebookFolderKey)) {
      createAssetFolder(db, {
        folderKey: notebookFolderKey,
        fatherKey: null,
        type: 'system',
        folderName: 'Notebook',
        img: ''
      })
    }

    if (!getAssetFolderByKey(db, notebookSubFolderKey)) {
      createAssetFolder(db, {
        folderKey: notebookSubFolderKey,
        fatherKey: notebookFolderKey,
        type: 'folder',
        folderName: safeNotebookTitle,
        img: ''
      })
    } else {
      const existingFolder = getAssetFolderByKey(db, notebookSubFolderKey)
      if (existingFolder && existingFolder.folderName !== safeNotebookTitle) {
        const parentFullPath = getAssetFolderByKey(db, notebookFolderKey)?.fullPath || '/Notebook'
        const fullPath =
          parentFullPath === '/' || parentFullPath === ''
            ? `/${safeNotebookTitle}`
            : `${parentFullPath}/${safeNotebookTitle}`
        updateAssetFolder(db, notebookSubFolderKey, {
          folderName: safeNotebookTitle,
          fullPath
        })
      }
    }

    const timestamp = Date.now()
    const safeImageTitle = imageTitle ? sanitizeFileName(imageTitle) : 'infographic'
    const truncatedTitle =
      safeImageTitle.length > 30 ? safeImageTitle.substring(0, 30) : safeImageTitle
    const fileName = `${truncatedTitle}_${timestamp}.png`
    const filePath = join(baseDir, fileName)

    let buffer: Buffer
    if (imageUrl.startsWith('data:')) {
      const base64Data = imageUrl.replace(/^data:image\/\w+;base64,/, '')
      buffer = Buffer.from(base64Data, 'base64')
    } else {
      const response = await fetch(imageUrl)
      if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)
      buffer = Buffer.from(await response.arrayBuffer())
    }

    await fs.writeFile(filePath, buffer)
    console.log(`[NotebookInfographic] 保存信息图: ${fileName}`)

    createAssetData(db, {
      assetKey: `notebook_infographic_${timestamp}_${Math.random().toString(36).slice(2, 6)}`,
      folderKey: notebookSubFolderKey,
      assetName: fileName,
      filePath,
      originPath: filePath,
      fileSize: buffer.length,
      fileExtension: 'png',
      modifiedTime: new Date().toISOString(),
      processorType: 'Notebook',
      assetType: 'Texture',
      classNameCn: '知识库信息图',
      classColor: '#734D5E'
    })

    return { success: true, localPath: filePath }
  } catch (error) {
    console.error('[NotebookInfographic] 保存图片失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export const registerNotebookInfographicIPC = (): void => {
  ipcMain.handle(
    'notebook:infographic:saveLocal',
    async (
      _,
      params: {
        imageUrl: string
        notebookId: string
        notebookTitle: string
        imageTitle?: string
      }
    ): Promise<{ success: boolean; localPath?: string; error?: string }> => {
      try {
        return await saveInfographicToLocal(
          params.imageUrl,
          params.notebookId,
          params.notebookTitle,
          params.imageTitle
        )
      } catch (error) {
        console.error('[NotebookInfographic IPC] 保存信息图失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  console.log('[NotebookInfographic] IPC 处理程序注册完成')
}
