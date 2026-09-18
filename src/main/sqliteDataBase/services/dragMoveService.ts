import Database from 'better-sqlite3'

import { type AssetData, getAssetDataByKey, updateAssetData } from '../models/assetData'
import { type AssetFolder, getAssetFolderByKey, updateAssetFolder } from '../models/assetFolder'

export interface DragMoveItem {
  id: string
  type: 'file' | 'folder'
}

export interface MoveResult {
  success: boolean
  message: string
  movedItems: {
    folders: number
    files: number
  }
  changedFolderKeys: string[]
  changedAssetKeys: string[]
  errors?: string[]
}

interface FolderMoveResult {
  success: boolean
  folderCount: number
  fileCount: number
  folderKeys: string[]
  fileKeys: string[]
  error?: string
}

export class DragMoveService {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  async moveItems(items: DragMoveItem[], targetFolderId: string): Promise<MoveResult> {
    const errors: string[] = []
    let movedFolders = 0
    let movedFiles = 0
    const changedFolderKeys = new Set<string>()
    const changedAssetKeys = new Set<string>()

    const targetFolder = getAssetFolderByKey(this.db, targetFolderId)
    if (!targetFolder) {
      return {
        success: false,
        message: 'Target folder does not exist',
        movedItems: { folders: 0, files: 0 },
        changedFolderKeys: [],
        changedAssetKeys: [],
        errors: ['Target folder does not exist']
      }
    }

    const runMove = this.db.transaction(() => {
      for (const item of items) {
        try {
          if (item.type === 'folder') {
            const result = this.moveFolderWithChildren(item.id, targetFolderId)
            if (!result.success) {
              errors.push(`Failed to move folder ${item.id}: ${result.error}`)
              continue
            }

            movedFolders += result.folderCount
            movedFiles += result.fileCount
            result.folderKeys.forEach((folderKey) => changedFolderKeys.add(folderKey))
            result.fileKeys.forEach((assetKey) => changedAssetKeys.add(assetKey))
            continue
          }

          const result = this.moveFile(item.id, targetFolderId)
          if (!result.success) {
            errors.push(`Failed to move file ${item.id}: ${result.error}`)
            continue
          }

          movedFiles++
          if (result.changed) {
            changedAssetKeys.add(item.id)
          }
        } catch (error) {
          errors.push(`Failed to move item ${item.id}: ${String(error)}`)
        }
      }
    })

    try {
      runMove()
      return {
        success: errors.length === 0,
        message:
          errors.length === 0
            ? `Moved ${movedFolders} folders and ${movedFiles} files`
            : `Moved ${movedFolders} folders and ${movedFiles} files with errors`,
        movedItems: {
          folders: movedFolders,
          files: movedFiles
        },
        changedFolderKeys: [...changedFolderKeys],
        changedAssetKeys: [...changedAssetKeys],
        errors: errors.length > 0 ? errors : undefined
      }
    } catch (error) {
      return {
        success: false,
        message: 'Move transaction failed',
        movedItems: { folders: 0, files: 0 },
        changedFolderKeys: [],
        changedAssetKeys: [],
        errors: [`Transaction failed: ${String(error)}`]
      }
    }
  }

  private moveFile(
    fileId: string,
    targetFolderId: string
  ): { success: boolean; changed: boolean; error?: string } {
    try {
      const file = getAssetDataByKey(this.db, fileId)
      if (!file) {
        return { success: false, changed: false, error: 'File does not exist' }
      }

      if (file.folderKey === targetFolderId) {
        return { success: true, changed: false }
      }

      const updateResult = updateAssetData(this.db, fileId, {
        folderKey: targetFolderId,
        updated_at: new Date().toISOString()
      })

      return { success: updateResult, changed: updateResult }
    } catch (error) {
      return { success: false, changed: false, error: String(error) }
    }
  }

  private moveFolderWithChildren(folderId: string, targetFolderId: string): FolderMoveResult {
    try {
      // 每个目录移动有自己的 SAVEPOINT：路径更新失败时回滚整棵子树，
      // 同批次其他已经成功的项目仍按原有部分成功契约保留。
      return this.db.transaction(() => this.moveFolderSubtree(folderId, targetFolderId))()
    } catch (error) {
      return this.failedFolderMove(String(error))
    }
  }

  private moveFolderSubtree(folderId: string, targetFolderId: string): FolderMoveResult {
    const folder = getAssetFolderByKey(this.db, folderId)
    if (!folder) {
      return this.failedFolderMove('Folder does not exist')
    }

    if (folder.fatherKey === targetFolderId) {
      return {
        success: true,
        folderCount: 0,
        fileCount: 0,
        folderKeys: [],
        fileKeys: []
      }
    }

    if (this.isDescendantFolder(targetFolderId, folderId)) {
      return this.failedFolderMove('Cannot move a folder into its own descendant')
    }

    const allSubFolders = this.getAllSubFolders(folderId)
    const allFiles = this.getAllFilesInFolderTree(folderId)
    const updateResult = updateAssetFolder(this.db, folderId, {
      fatherKey: targetFolderId,
      updated_at: new Date().toISOString()
    })

    if (!updateResult) {
      return this.failedFolderMove('Failed to update folder')
    }

    this.recalculateFolderPaths(folderId)

    return {
      success: true,
      folderCount: allSubFolders.length + 1,
      fileCount: allFiles.length,
      folderKeys: [folderId, ...allSubFolders.map((subFolder) => subFolder.folderKey)],
      fileKeys: allFiles.map((file) => file.assetKey)
    }
  }

  private failedFolderMove(error: string): FolderMoveResult {
    return {
      success: false,
      folderCount: 0,
      fileCount: 0,
      folderKeys: [],
      fileKeys: [],
      error
    }
  }

  private isDescendantFolder(targetFolderId: string, sourceFolderId: string): boolean {
    let currentFolder = getAssetFolderByKey(this.db, targetFolderId)
    const visited = new Set<string>()

    while (currentFolder) {
      if (currentFolder.folderKey === sourceFolderId || visited.has(currentFolder.folderKey)) {
        return true
      }
      visited.add(currentFolder.folderKey)
      if (!currentFolder.fatherKey) break
      currentFolder = getAssetFolderByKey(this.db, currentFolder.fatherKey)
    }

    return false
  }

  private getAllSubFolders(folderId: string): AssetFolder[] {
    const stmt = this.db.prepare(`
      WITH RECURSIVE folder_tree AS (
        SELECT * FROM assetFolder WHERE fatherKey = ?
        UNION
        SELECT af.* FROM assetFolder af
        JOIN folder_tree ft ON af.fatherKey = ft.folderKey
      )
      SELECT * FROM folder_tree
    `)

    return stmt.all(folderId) as AssetFolder[]
  }

  private getAllFilesInFolderTree(folderId: string): AssetData[] {
    const stmt = this.db.prepare(`
      WITH RECURSIVE folder_tree AS (
        SELECT folderKey FROM assetFolder WHERE folderKey = ?
        UNION
        SELECT af.folderKey FROM assetFolder af
        JOIN folder_tree ft ON af.fatherKey = ft.folderKey
      )
      SELECT ad.* FROM assetData ad
      JOIN folder_tree ft ON ad.folderKey = ft.folderKey
    `)

    return stmt.all(folderId) as AssetData[]
  }

  private recalculateFolderPaths(folderId: string, visited = new Set<string>()): void {
    if (visited.has(folderId)) throw new Error('Cannot move a folder into its own descendant')
    visited.add(folderId)
    const folder = getAssetFolderByKey(this.db, folderId)
    if (!folder) return

    let fullPath = `/${folder.folderName}`
    let pathArray = JSON.stringify([folder.folderKey])
    let depth = 0
    let ancestorKeys = JSON.stringify([])

    if (folder.fatherKey) {
      const parentFolder = getAssetFolderByKey(this.db, folder.fatherKey)
      if (parentFolder) {
        fullPath = `${parentFolder.fullPath || ''}/${folder.folderName}`
        const parentPathArray = parentFolder.pathArray ? JSON.parse(parentFolder.pathArray) : []
        pathArray = JSON.stringify([...parentPathArray, folder.folderKey])
        depth = (parentFolder.depth || 0) + 1
        ancestorKeys = JSON.stringify([...parentPathArray])
      }
    }

    this.db
      .prepare(
        `
        UPDATE assetFolder
        SET fullPath = ?, pathArray = ?, depth = ?, ancestorKeys = ?, updated_at = datetime('now', 'localtime')
        WHERE folderKey = ?
      `
      )
      .run(fullPath, pathArray, depth, ancestorKeys, folderId)

    const childFolders = this.db
      .prepare(`SELECT folderKey FROM assetFolder WHERE fatherKey = ?`)
      .all(folderId) as { folderKey: string }[]

    for (const child of childFolders) {
      this.recalculateFolderPaths(child.folderKey, visited)
    }
  }
}
