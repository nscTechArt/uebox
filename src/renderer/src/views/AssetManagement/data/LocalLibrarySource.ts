/**
 * 本地库（含旧网络库）的数据源：原样转发到今天的 API，一个参数、一个返回值都不改。
 * 它存在的唯一理由是让页面从同一个接缝取数 —— 行为零变化。
 */
import assetDataAPI from '@renderer/api/assetData'
import { assetFolderAPI } from '@renderer/api/assetFolder'
import { favoriteAPI } from '@renderer/api/favorite'
import { useVaultStore } from '@renderer/store/modules/vaultStore'
import type {
  AssetLibrarySource,
  LibraryCapabilities,
  LibraryFavoritesApi,
  LibraryTagRegistryApi,
  RegistryTag,
  RegistryTagGroup
} from './AssetLibrarySource'

export const LOCAL_CAPABILITIES: LibraryCapabilities = {
  vaultFeatures: true,
  pagedOnly: false,
  canEditStructure: true,
  tagModel: 'registry',
  canEditNotes: true,
  richNotes: true,
  canFavorite: true,
  hasTrash: true,
  canScan: true,
  canImport: true,
  canSendToProject: true,
  nativeDrag: true,
  folderSearch: true,
  dependencyGraph: true,
  tagManagement: true,
  folderColor: true,
  cloudDrives: true,
  sortByType: true,
  filters: {
    category: true,
    assetTypes: true,
    size: true,
    date: true,
    tags: true,
    favorite: true,
    showDependencies: true,
    engine: false,
    tagMode: 'full'
  },
  reasons: {}
}

async function invokeSearch<T>(channel: string, payload: unknown): Promise<T[]> {
  const response = (await window.electron.ipcRenderer.invoke(channel, payload)) as {
    success?: boolean
    error?: string
    data?: T[]
  }
  if (!response || !response.success) throw new Error(response?.error || 'Unknown error')
  return response.data || []
}

/** 本地收藏只有一个用户（1），按当前保管库存 —— 和原来各调用点传的参数一样 */
const FAVORITE_USER_ID = 1
const vaultId = (): string | undefined => useVaultStore().currentVault?.id ?? undefined

const localFavorites: LibraryFavoritesApi = {
  add: (assetKey) => favoriteAPI.add(assetKey, FAVORITE_USER_ID, vaultId()),
  remove: (assetKey) => favoriteAPI.remove(assetKey, FAVORITE_USER_ID, vaultId()),
  addFolder: (folderKey) => favoriteAPI.addFolder(folderKey, FAVORITE_USER_ID, vaultId()),
  removeFolder: (folderKey) => favoriteAPI.removeFolder(folderKey, FAVORITE_USER_ID, vaultId()),
  batchCheck: (assetKeys) =>
    favoriteAPI.batchCheckFavorites(assetKeys, FAVORITE_USER_ID, vaultId()),
  isFolderFavorite: (folderKey) =>
    favoriteAPI.isFolderFavorite(folderKey, FAVORITE_USER_ID, vaultId()),
  count: (vault) => favoriteAPI.getFavoriteCount(FAVORITE_USER_ID, vault ?? vaultId()),
  folders: async () =>
    (await favoriteAPI.getFavoriteFoldersWithDetails(
      FAVORITE_USER_ID,
      vaultId()
    )) as unknown as Array<Record<string, unknown>>
}

/** 公共标签库：就是标签管理页原来直接调的那几个 IPC */
const localTagRegistry: LibraryTagRegistryApi = {
  abilities: { renameUnused: true, renameUsed: true, favorite: true },
  async groups() {
    const result = await window.api.database.tagGroup.getAllWithCount()
    if (!result.success) throw new Error(result.error || 'load groups failed')
    return result.data as RegistryTagGroup[]
  },
  async tags() {
    const result = await window.api.database.tag.getAll()
    if (!result.success) throw new Error(result.error || 'load tags failed')
    return result.data as RegistryTag[]
  },
  async usageCounts() {
    const result = await window.api.database.assetTag.getUsageCounts()
    if (!result.success) return {}
    const next: Record<number, number> = {}
    result.data.forEach((row: { tagId: number; count: number }) => {
      next[row.tagId] = row.count
    })
    return next
  },
  async createGroup(name, sortOrder, color) {
    const result = await window.api.database.tagGroup.create({
      name,
      color,
      sort_order: sortOrder
    } as never)
    return result.success ? ((result.data as { id?: number } | undefined)?.id ?? 0) : null
  },
  async renameGroup(id, name) {
    return (await window.api.database.tagGroup.update(id, { name })).success
  },
  async deleteGroup(id) {
    return (await window.api.database.tagGroup.delete(id)).success
  },
  async createTag(name, groupId, favorite) {
    const result = await window.api.database.tag.create({
      name,
      group_id: groupId,
      is_favorite: favorite
    } as never)
    return result.success ? ((result.data as { id?: number } | undefined)?.id ?? 0) : null
  },
  async renameTag(id, name) {
    return (await window.api.database.tag.update(id, { name } as never)).success
  },
  async deleteTags(ids) {
    if (ids.length === 1) return (await window.api.database.tag.delete(ids[0])).success ? 1 : 0
    const result = await window.api.database.tag.batchDelete(ids)
    if (!result.success) throw new Error(result.error || 'delete failed')
    return (result.data as { deletedCount?: number } | undefined)?.deletedCount ?? ids.length
  },
  async update(id, patch) {
    return (await window.api.database.tag.update(id, patch as never)).success
  },
  async toggleFavorite(id) {
    return (await window.api.database.tag.toggleFavorite(id)).success
  },
  async moveToGroup(ids, groupId) {
    const result = await window.api.database.tag.moveToGroup(ids, groupId)
    if (!result.success) throw new Error(result.error || 'move failed')
    return (result.data as { updatedCount?: number } | undefined)?.updatedCount ?? ids.length
  }
}
export const localLibrarySource: AssetLibrarySource = {
  kind: 'local',
  id: 'local',
  capabilities: LOCAL_CAPABILITIES,
  // 参数原样透传（包括个数）：调用方和单测看到的调用与接缝之前一模一样
  folders: {
    getRootFolders: (...args) => assetFolderAPI.getRootFolders(...args),
    getByFatherKey: (...args) => assetFolderAPI.getByFatherKey(...args),
    getByKey: (...args) => assetFolderAPI.getByKey(...args),
    getChildCount: (...args) => assetFolderAPI.getChildCount(...args),
    getPathArray: (...args) => assetFolderAPI.getPathArray(...args),
    setColor: async (folderKey, color) => {
      const result = (await window.api.database.assetFolder.update(folderKey, {
        color
      } as never)) as { success?: boolean; updated?: boolean; error?: string } | undefined
      return { ok: result?.success === true || result?.updated === true, error: result?.error }
    }
  },
  assets: {
    getByFolderKey: (...args) => assetDataAPI.getByFolderKey(...args),
    getCountByFolderKey: (...args) => assetDataAPI.getCountByFolderKey(...args),
    getById: (...args) => assetDataAPI.getById(...args),
    getImportStatus: (...args) => assetDataAPI.getImportStatus(...args),
    getDistinctAssetTypes: () => assetDataAPI.getDistinctAssetTypes()
  },
  search: {
    assets: (criteria) => invokeSearch('db:assetSearch:search', criteria),
    folders: (params) => invokeSearch('db:assetFolder:search', params)
  },
  annotations: null,
  facets: null,
  favorites: localFavorites,
  tagRegistry: localTagRegistry
}
