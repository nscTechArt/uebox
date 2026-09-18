import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'

import { buildDragMoveSyncPlan } from '../dragMoveSyncHelper'
import { pushAssetUpdate, pushFolderUpdate } from '../../networkV2/NetworkSyncBridge'
import { getCurrentRemoteHttpVaultContext } from '../../networkV2/currentRemoteHttpVault'
import type { SyncClient } from '../../networkV2/SyncClient'
import { getVaultDatabase } from '../index'
import { getAssetDataByKey } from '../models/assetData'
import { getAssetFolderByKey } from '../models/assetFolder'
import { DragMoveService, type DragMoveItem } from '../services/dragMoveService'

export const registerDragMoveIPC = (): void => {
  ipcMain.handle(
    'db:dragMove:moveItems',
    async (_, items: DragMoveItem[], targetFolderId: string) => {
      void _
      try {
        const db = getVaultDatabase()
        const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
        if (remoteHttpCtx) {
          const result = await moveRemoteHttpItems(db, remoteHttpCtx.client, items, targetFolderId)
          return {
            success: result.success,
            data: result,
            error: result.success ? undefined : result.message
          }
        }

        const dragMoveService = new DragMoveService(db)
        const result = await dragMoveService.moveItems(items, targetFolderId)

        const syncPlan = buildDragMoveSyncPlan(
          db,
          result.changedAssetKeys,
          result.changedFolderKeys
        )

        await Promise.allSettled([
          ...syncPlan.assetUpdates.map((item) => pushAssetUpdate(item.assetKey, item.updates)),
          ...syncPlan.folderUpdates.map((item) => pushFolderUpdate(item.folderKey, item.updates))
        ])

        return {
          success: result.success,
          data: result,
          error: result.success ? undefined : result.message
        }
      } catch (error) {
        console.error('dragMove moveItems failed:', error)
        return {
          success: false,
          error: (error as Error).message,
          data: {
            success: false,
            message: 'dragMove moveItems failed',
            movedItems: { folders: 0, files: 0 },
            changedFolderKeys: [],
            changedAssetKeys: [],
            errors: [(error as Error).message]
          }
        }
      }
    }
  )

  ipcMain.handle(
    'db:dragMove:validateMove',
    async (_, items: DragMoveItem[], targetFolderId: string) => {
      void _
      try {
        const db = getVaultDatabase()
        const validationResult = {
          valid: true,
          warnings: [] as string[],
          errors: [] as string[]
        }

        const targetFolderExists = db
          .prepare('SELECT 1 FROM assetFolder WHERE folderKey = ?')
          .get(targetFolderId)
        if (!targetFolderExists) {
          validationResult.valid = false
          validationResult.errors.push('Target folder does not exist')
        }

        for (const item of items) {
          if (item.type !== 'folder') continue
          const isDescendant = checkIfDescendant(db, targetFolderId, item.id)
          if (!isDescendant) continue
          validationResult.valid = false
          validationResult.errors.push(`Cannot move folder ${item.id} into its descendant`)
        }

        return {
          success: true,
          data: validationResult
        }
      } catch (error) {
        console.error('dragMove validateMove failed:', error)
        return {
          success: false,
          error: (error as Error).message,
          data: {
            valid: false,
            warnings: [],
            errors: [(error as Error).message]
          }
        }
      }
    }
  )
}

async function moveRemoteHttpItems(
  db: Database.Database,
  client: SyncClient,
  items: DragMoveItem[],
  targetFolderId: string
) {
  const plan = buildRemoteHttpMovePlan(db, items || [], targetFolderId)
  if (!plan.success) return plan

  if (plan.operations.length === 0) {
    return {
      success: true,
      message: 'Moved 0 folders and 0 files',
      movedItems: { folders: 0, files: 0 },
      changedFolderKeys: [],
      changedAssetKeys: []
    }
  }

  try {
    await client.batch(plan.operations)
    await client.pullChanges()
    return {
      success: true,
      message: `Moved ${plan.movedItems.folders} folders and ${plan.movedItems.files} files`,
      movedItems: plan.movedItems,
      changedFolderKeys: plan.changedFolderKeys,
      changedAssetKeys: plan.changedAssetKeys
    }
  } catch (error) {
    try {
      await client.pullChanges()
    } catch {
      /* Best-effort cache repair after a rejected remote move. */
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      message,
      movedItems: { folders: 0, files: 0 },
      changedFolderKeys: [],
      changedAssetKeys: [],
      errors: [message]
    }
  }
}

export function buildRemoteHttpMovePlan(
  db: Database.Database,
  items: DragMoveItem[],
  targetFolderId: string
): {
  success: boolean
  message: string
  operations: Array<{ type: string; table: string; data: Record<string, unknown> }>
  movedItems: { folders: number; files: number }
  changedFolderKeys: string[]
  changedAssetKeys: string[]
  errors?: string[]
} {
  const targetFolder = getAssetFolderByKey(db, targetFolderId)
  if (!targetFolder) {
    return {
      success: false,
      message: 'Target folder does not exist',
      operations: [],
      movedItems: { folders: 0, files: 0 },
      changedFolderKeys: [],
      changedAssetKeys: [],
      errors: ['Target folder does not exist']
    }
  }

  const errors: string[] = []
  const operations: Array<{ type: string; table: string; data: Record<string, unknown> }> = []
  const changedFolderKeys = new Set<string>()
  const changedAssetKeys = new Set<string>()
  const now = new Date().toISOString()
  let movedFolders = 0
  let movedFiles = 0

  for (const item of items) {
    if (item.type === 'folder') {
      if (item.id === 'ALL') {
        errors.push('Cannot move the root folder')
        continue
      }

      const folder = getAssetFolderByKey(db, item.id)
      if (!folder) {
        errors.push(`Folder ${item.id} does not exist`)
        continue
      }

      if (folder.fatherKey === targetFolderId) {
        continue
      }

      if (checkIfDescendant(db, targetFolderId, item.id)) {
        errors.push(`Cannot move folder ${item.id} into its descendant`)
        continue
      }

      const counts = getFolderSubtreeCounts(db, item.id)
      movedFolders += counts.folders
      movedFiles += counts.files
      changedFolderKeys.add(item.id)
      operations.push({
        type: 'update',
        table: 'assetFolder',
        data: {
          folderKey: item.id,
          fatherKey: targetFolderId,
          updated_at: now
        }
      })
      continue
    }

    const asset = getAssetDataByKey(db, item.id)
    if (!asset) {
      errors.push(`File ${item.id} does not exist`)
      continue
    }

    if (asset.folderKey === targetFolderId) {
      continue
    }

    movedFiles++
    changedAssetKeys.add(item.id)
    operations.push({
      type: 'update',
      table: 'assetData',
      data: {
        assetKey: item.id,
        folderKey: targetFolderId,
        updated_at: now
      }
    })
  }

  if (errors.length > 0) {
    return {
      success: false,
      message: errors.join('; '),
      operations: [],
      movedItems: { folders: 0, files: 0 },
      changedFolderKeys: [],
      changedAssetKeys: [],
      errors
    }
  }

  return {
    success: true,
    message: `Prepared ${operations.length} remote move operations`,
    operations,
    movedItems: { folders: movedFolders, files: movedFiles },
    changedFolderKeys: [...changedFolderKeys],
    changedAssetKeys: [...changedAssetKeys]
  }
}

function getFolderSubtreeCounts(
  db: Database.Database,
  folderKey: string
): { folders: number; files: number } {
  const rows = db
    .prepare(
      `
      WITH RECURSIVE folder_tree AS (
        SELECT folderKey FROM assetFolder WHERE folderKey = ?
        UNION ALL
        SELECT af.folderKey FROM assetFolder af
        JOIN folder_tree ft ON af.fatherKey = ft.folderKey
      )
      SELECT folderKey FROM folder_tree
    `
    )
    .all(folderKey) as { folderKey: string }[]
  const folderKeys = rows.map((row) => row.folderKey)
  if (folderKeys.length === 0) return { folders: 0, files: 0 }

  const placeholders = folderKeys.map(() => '?').join(',')
  const assetCount = db
    .prepare(
      `SELECT COUNT(*) AS count FROM assetData WHERE folderKey IN (${placeholders}) AND isDelete = 0`
    )
    .get(...folderKeys) as { count: number }
  return {
    folders: folderKeys.length,
    files: assetCount.count || 0
  }
}

/**
 * 判断 targetFolderId 是否是 sourceFolderId 的后代（禁止把文件夹拖进自己的子树）。
 *
 * 本地拖拽（第 89 行）与远端移动计划（第 213 行）双用。导出是为了让远端那部分
 * 后续能整体移出公开仓库，而本地这部分留下 —— 否则搬走时会把这个私有函数一起带走。
 */
export function checkIfDescendant(
  db: Database.Database,
  targetFolderId: string,
  sourceFolderId: string
): boolean {
  const stmt = db.prepare(`
    WITH RECURSIVE folder_path AS (
      SELECT folderKey, fatherKey FROM assetFolder WHERE folderKey = ?
      UNION ALL
      SELECT af.folderKey, af.fatherKey
      FROM assetFolder af
      JOIN folder_path fp ON af.folderKey = fp.fatherKey
    )
    SELECT 1 FROM folder_path WHERE folderKey = ?
  `)

  const result = stmt.get(targetFolderId, sourceFolderId)
  return !!result
}
