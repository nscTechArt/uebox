import Database from 'better-sqlite3'

import { getAssetDataByKey } from './models/assetData'
import { getAssetFolderByKey } from './models/assetFolder'

export interface DragMoveSyncPlan {
  assetUpdates: Array<{
    assetKey: string
    updates: Record<string, unknown>
  }>
  folderUpdates: Array<{
    folderKey: string
    updates: Record<string, unknown>
  }>
}

export function buildDragMoveSyncPlan(
  db: Database.Database,
  changedAssetKeys: string[],
  changedFolderKeys: string[]
): DragMoveSyncPlan {
  const assetUpdates = changedAssetKeys
    .map<DragMoveSyncPlan['assetUpdates'][number] | null>((assetKey) => {
      const asset = getAssetDataByKey(db, assetKey)
      if (!asset) return null
      return {
        assetKey,
        updates: {
          folderKey: asset.folderKey,
          updated_at: asset.updated_at
        }
      }
    })
    .filter((item): item is DragMoveSyncPlan['assetUpdates'][number] => item !== null)

  const folderUpdates = changedFolderKeys
    .map<DragMoveSyncPlan['folderUpdates'][number] | null>((folderKey) => {
      const folder = getAssetFolderByKey(db, folderKey)
      if (!folder) return null
      return {
        folderKey,
        updates: {
          fatherKey: folder.fatherKey ?? null,
          fullPath: folder.fullPath ?? null,
          pathArray: folder.pathArray ?? null,
          depth: folder.depth ?? 0,
          ancestorKeys: folder.ancestorKeys ?? null,
          updated_at: folder.updated_at
        }
      }
    })
    .filter((item): item is DragMoveSyncPlan['folderUpdates'][number] => item !== null)

  return {
    assetUpdates,
    folderUpdates
  }
}
