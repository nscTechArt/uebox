/**
 * 本地库（含旧网络库）的数据源：原样转发到今天的 API，一个参数、一个返回值都不改。
 * 它存在的唯一理由是让页面从同一个接缝取数 —— 行为零变化。
 */
import assetDataAPI from '@renderer/api/assetData'
import { assetFolderAPI } from '@renderer/api/assetFolder'
import type { AssetLibrarySource, LibraryCapabilities } from './AssetLibrarySource'

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
  sortByType: true,
  filters: {
    category: true,
    assetTypes: true,
    size: true,
    date: true,
    tags: true,
    favorite: true,
    showDependencies: true,
    engine: false
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
    getPathArray: (...args) => assetFolderAPI.getPathArray(...args)
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
  facets: null
}
