import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  createEmptyGraphSummary,
  getMaterialCoverStyle,
  type MaterialCollection,
  type MaterialCompileStatus,
  type MaterialEntry,
  type MaterialLibraryFilters,
  type MaterialParameterValue,
  type MaterialSortType,
  type MaterialViewMode
} from '@renderer/views/MaterialLibrary/types/material'
import {
  extractLegacyMaterialDependencies,
  extractLegacyMaterialParameters,
  summarizeLegacyGraph
} from '@renderer/views/MaterialLibrary/services/materialLibraryTransformers'
import { sortLibraryEntries } from '@renderer/views/library-common/utils/libraryCollection'
import { createLibraryPackagePersistence, parseUiPrefs } from './libraryPackagePersistence'
import { clearLegacyLocalStorage, readLegacyLibrarySnapshot } from './libraryLegacyRead'

/** 旧版把整库写在这个 localStorage 键下，现在只在首次迁移时读一次 */
const LEGACY_PERSIST_KEY = 'material-library-v2-state'

/** 界面偏好（排序、视图模式、筛选）留在 localStorage —— 它本来就该放这儿 */
const UI_STATE_KEY = 'material-library-ui'

function readUiPrefs(): Record<string, unknown> {
  try {
    return parseUiPrefs(localStorage.getItem(UI_STATE_KEY))
  } catch {
    return {}
  }
}

function writeUiPrefs(ui: Record<string, unknown>): void {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(ui))
  } catch (error) {
    // 界面偏好存不下不该把用户的操作一起带走
    console.warn('[MaterialLibrary] 界面偏好存盘失败:', error)
  }
}
const LEGACY_LOCAL_DRAFT_SYNC_ISSUE = 'Local draft material. Not synced to Unreal Engine.'
const LOCAL_DRAFT_NOTE = '离线草稿，可保存材质节点文本。'

function generateCollectionId(name: string): string {
  return `material-collection-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`
}

function generateEntryId(name: string): string {
  return `material-local-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`
}

function normalizeDraftPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '/Game/Materials'
  return trimmed.replace(/\/+$/, '') || '/Game/Materials'
}

function mergeParameterRecords(
  existingParameters: MaterialParameterValue[] | undefined,
  extractedParameters: MaterialParameterValue[]
): MaterialParameterValue[] {
  const existing = existingParameters || []
  const seen = new Set(
    existing.map((item) => `${item.type}:${item.name}:${item.source || 'parameter'}`)
  )

  return [
    ...existing,
    ...extractedParameters.filter((item) => {
      const key = `${item.type}:${item.name}:${item.source || 'parameter'}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  ]
}

function hasParameterRecordChanges(
  currentParameters: MaterialParameterValue[] | undefined,
  nextParameters: MaterialParameterValue[]
): boolean {
  return JSON.stringify(currentParameters || []) !== JSON.stringify(nextParameters)
}

function normalizePersistedMaterialEntry(entry: MaterialEntry): MaterialEntry {
  const normalized = {
    ...entry,
    syncIssues: Array.isArray(entry.syncIssues)
      ? entry.syncIssues.map((issue) =>
          issue === LEGACY_LOCAL_DRAFT_SYNC_ISSUE ? LOCAL_DRAFT_NOTE : issue
        )
      : []
  }

  if (!normalized.graphBlueprintCode) return normalized

  const parameters = extractLegacyMaterialParameters(normalized.graphBlueprintCode)
  return {
    ...normalized,
    scalarParameters: mergeParameterRecords(
      normalized.scalarParameters,
      parameters.scalarParameters
    ),
    vectorParameters: mergeParameterRecords(
      normalized.vectorParameters,
      parameters.vectorParameters
    ),
    textureParameters: mergeParameterRecords(
      normalized.textureParameters,
      parameters.textureParameters
    ),
    staticSwitchParameters: mergeParameterRecords(
      normalized.staticSwitchParameters,
      parameters.staticSwitchParameters
    )
  }
}

function applyExtractedMaterialParameters(
  entry: MaterialEntry,
  parameters: ReturnType<typeof extractLegacyMaterialParameters>
): boolean {
  const hasChanges =
    hasParameterRecordChanges(entry.scalarParameters, parameters.scalarParameters) ||
    hasParameterRecordChanges(entry.vectorParameters, parameters.vectorParameters) ||
    hasParameterRecordChanges(entry.textureParameters, parameters.textureParameters) ||
    hasParameterRecordChanges(entry.staticSwitchParameters, parameters.staticSwitchParameters)

  if (!hasChanges) return false

  entry.scalarParameters = parameters.scalarParameters
  entry.vectorParameters = parameters.vectorParameters
  entry.textureParameters = parameters.textureParameters
  entry.staticSwitchParameters = parameters.staticSwitchParameters
  return true
}

function mergeDependencyRecords<
  TEntry extends Pick<
    MaterialEntry,
    'textureDependencies' | 'functionDependencies' | 'parameterCollectionDependencies'
  >
>(existingEntry: TEntry, kind: 'texture' | 'function' | 'parameterCollection', paths: string[]) {
  const existingDependencies =
    kind === 'texture'
      ? existingEntry.textureDependencies
      : kind === 'function'
        ? existingEntry.functionDependencies
        : existingEntry.parameterCollectionDependencies

  const existingByPath = new Map(
    existingDependencies.map((dependency) => [dependency.path, dependency])
  )

  return paths.map((path) => {
    const existing = existingByPath.get(path)
    return {
      path,
      name: existing?.name || path.split('/').pop() || path,
      kind,
      assetKey: existing?.assetKey,
      assetType: existing?.assetType,
      thumbnail: existing?.thumbnail,
      isResolved: existing?.isResolved ?? false
    }
  })
}

export const useMaterialLibraryStore = defineStore('materialLibrary', () => {
  const entries = ref<MaterialEntry[]>([])
  const collections = ref<MaterialCollection[]>([])
  const loading = ref(false)
  const activeEntryId = ref<string | null>(null)
  const viewMode = ref<MaterialViewMode>('grid')
  const sortType = ref<MaterialSortType>('recent')
  const liveSearchPath = ref('/Game')
  const filters = ref<MaterialLibraryFilters>({
    searchQuery: '',
    entryType: 'all',
    favoriteState: 'all',
    blendMode: 'all',
    materialDomain: 'all',
    shadingModel: 'all',
    compileStatus: 'all',
    hasTextureDependencies: 'all',
    hasFunctionDependencies: 'all',
    hasChildInstances: 'all',
    activeCollectionId: null
  })

  const activeEntry = computed(
    () => entries.value.find((entry) => entry.id === activeEntryId.value) || null
  )

  const availableBlendModes = computed(() =>
    [...new Set(entries.value.map((entry) => entry.blendMode).filter(Boolean))].sort()
  )
  const availableDomains = computed(() =>
    [...new Set(entries.value.map((entry) => entry.materialDomain).filter(Boolean))].sort()
  )
  const availableShadingModels = computed(() =>
    [...new Set(entries.value.map((entry) => entry.shadingModel).filter(Boolean))].sort()
  )

  const filteredEntries = computed(() => {
    let list = [...entries.value]
    const query = filters.value.searchQuery.trim().toLowerCase()

    if (query) {
      list = list.filter((entry) => {
        return (
          entry.name.toLowerCase().includes(query) ||
          entry.assetPath.toLowerCase().includes(query) ||
          entry.tags.some((tag) => tag.toLowerCase().includes(query))
        )
      })
    } else if (!filters.value.activeCollectionId) {
      list = list.filter((entry) => !entry.collectionId)
    }

    if (filters.value.entryType !== 'all') {
      list = list.filter((entry) => entry.entryType === filters.value.entryType)
    }

    if (filters.value.favoriteState !== 'all') {
      list = list.filter((entry) =>
        filters.value.favoriteState === 'favorite' ? entry.isFavorite : !entry.isFavorite
      )
    }

    if (filters.value.blendMode !== 'all') {
      list = list.filter((entry) => entry.blendMode === filters.value.blendMode)
    }

    if (filters.value.materialDomain !== 'all') {
      list = list.filter((entry) => entry.materialDomain === filters.value.materialDomain)
    }

    if (filters.value.shadingModel !== 'all') {
      list = list.filter((entry) => entry.shadingModel === filters.value.shadingModel)
    }

    if (filters.value.compileStatus !== 'all') {
      list = list.filter((entry) => entry.compileStatus === filters.value.compileStatus)
    }

    if (filters.value.hasTextureDependencies !== 'all') {
      list = list.filter((entry) =>
        filters.value.hasTextureDependencies === 'yes'
          ? entry.textureDependencies.length > 0
          : entry.textureDependencies.length === 0
      )
    }

    if (filters.value.hasFunctionDependencies !== 'all') {
      list = list.filter((entry) =>
        filters.value.hasFunctionDependencies === 'yes'
          ? entry.functionDependencies.length > 0
          : entry.functionDependencies.length === 0
      )
    }

    if (filters.value.hasChildInstances !== 'all') {
      list = list.filter((entry) =>
        filters.value.hasChildInstances === 'yes'
          ? entry.childInstancePaths.length > 0
          : entry.childInstancePaths.length === 0
      )
    }

    if (filters.value.activeCollectionId) {
      list = list.filter((entry) => entry.collectionId === filters.value.activeCollectionId)
    }

    return sortLibraryEntries(list, sortType.value)
  })

  /**
   * 持久化。
   *
   * 材质存成保管库里的 `xxx.uematerial` 包目录，封面单独落成包里的 cover.png
   * （见 libraryPackagePersistence.ts）。
   *
   * 原来这里是裸的 `localStorage.setItem`，写的是整个材质库（所有条目 + 分组），
   * 而 localStorage 只有几 MB —— 写满之后抛 `QuotaExceededError`，而调用存盘的是
   * 二十多个用户操作（新建、删除、改名、导入、换分组）：内存里改完了，存盘那一步炸了，
   * 整个动作崩在半路。
   *
   * 现在没有这个上限，而且只写变动的那几个包。写失败也不再往上抛 —— 那一层内部接住
   * 并在下次落盘时重试。老用户在 SQLite / 旧 localStorage 里那份，首次打开时自动搬成包。
   */
  function applyUiState(ui: Record<string, unknown>): void {
    if (typeof ui.activeEntryId === 'string') activeEntryId.value = ui.activeEntryId
    if (ui.viewMode === 'grid' || ui.viewMode === 'list') viewMode.value = ui.viewMode
    if (ui.sortType === 'recent' || ui.sortType === 'name' || ui.sortType === 'created') {
      sortType.value = ui.sortType
    }
    if (typeof ui.liveSearchPath === 'string') liveSearchPath.value = ui.liveSearchPath
    if (ui.filters && typeof ui.filters === 'object') {
      filters.value = { ...filters.value, ...(ui.filters as Partial<MaterialLibraryFilters>) }
    }
  }

  const persistence = createLibraryPackagePersistence<MaterialEntry, MaterialCollection>({
    library: 'material',
    readUi: readUiPrefs,
    writeUi: writeUiPrefs,
    // 只在这个保管库还没迁移过时调用一次：先看 SQLite，再看最早那版 localStorage
    readLegacy: () =>
      readLegacyLibrarySnapshot<MaterialEntry, MaterialCollection>({
        library: 'material',
        legacyKey: LEGACY_PERSIST_KEY,
        // 旧结构是一个扁平对象：条目、分组、界面偏好平铺在同一层
        parseLegacy: (raw) => ({
          entries: Array.isArray(raw.entries) ? (raw.entries as MaterialEntry[]) : [],
          collections: Array.isArray(raw.collections)
            ? (raw.collections as MaterialCollection[])
            : [],
          ui: {
            activeEntryId: raw.activeEntryId,
            viewMode: raw.viewMode,
            sortType: raw.sortType,
            liveSearchPath: raw.liveSearchPath,
            filters: raw.filters
          }
        })
      }),
    onMigrated: () => clearLegacyLocalStorage(LEGACY_PERSIST_KEY),
    getSnapshot: () => ({
      entries: entries.value,
      collections: collections.value,
      ui: {
        activeEntryId: activeEntryId.value,
        viewMode: viewMode.value,
        sortType: sortType.value,
        liveSearchPath: liveSearchPath.value,
        filters: filters.value
      }
    }),
    applySnapshot: (snapshot) => {
      // 每次开库都重跑一遍归一化：它会从图表文本里补出节点参数，老数据靠这一步修好
      entries.value = snapshot.entries.map((entry) => normalizePersistedMaterialEntry(entry))
      collections.value = snapshot.collections
      applyUiState(snapshot.ui)
    }
  })

  function persistState(): void {
    persistence.persist()
  }

  function releaseCollectionIfTooSmall(collectionId: string): void {
    const collection = collections.value.find((item) => item.id === collectionId)
    if (!collection) return

    const memberIds = entries.value
      .filter((entry) => entry.collectionId === collectionId)
      .map((entry) => entry.id)
    const memberIdSet = new Set(memberIds)
    collection.entryIds = [
      ...collection.entryIds.filter((entryId) => memberIdSet.has(entryId)),
      ...memberIds.filter((entryId) => !collection.entryIds.includes(entryId))
    ]

    if (collection.entryIds.length > 1) return

    for (const entry of entries.value) {
      if (entry.collectionId === collectionId) {
        entry.collectionId = undefined
      }
    }
    collections.value = collections.value.filter((item) => item.id !== collectionId)

    if (filters.value.activeCollectionId === collectionId) {
      filters.value.activeCollectionId = null
    }
  }

  function findExistingEntry(incoming: MaterialEntry): MaterialEntry | undefined {
    return entries.value.find((entry) => {
      if (
        incoming.assetPath &&
        entry.assetPath &&
        incoming.assetPath === entry.assetPath &&
        incoming.entryType === entry.entryType
      ) {
        return true
      }

      return entry.id === incoming.id
    })
  }

  function upsertEntries(incomingEntries: MaterialEntry[]): void {
    for (const incoming of incomingEntries) {
      const existing = findExistingEntry(incoming)
      if (!existing) {
        entries.value.push(incoming)
        continue
      }

      Object.assign(existing, {
        ...incoming,
        id: existing.id,
        createdAt: existing.createdAt,
        tags: existing.tags,
        isFavorite: existing.isFavorite,
        status: existing.status,
        collectionId: existing.collectionId,
        description: incoming.description || existing.description
      })
    }

    persistState()
  }

  function importLegacyEntries(
    importedEntries: MaterialEntry[],
    importedCollections: MaterialCollection[]
  ): void {
    upsertEntries(importedEntries)

    for (const collection of importedCollections) {
      const existing = collections.value.find((item) => item.name === collection.name)
      if (existing) {
        const mergedIds = new Set([...existing.entryIds, ...collection.entryIds])
        existing.entryIds = [...mergedIds]
      } else {
        collections.value.push(collection)
      }
    }

    for (const collection of collections.value) {
      for (const entry of entries.value) {
        if (collection.entryIds.includes(entry.id)) {
          entry.collectionId = collection.id
        }
      }
    }

    persistState()
  }

  function setActiveEntryId(id: string | null): void {
    activeEntryId.value = id
    persistState()
  }

  function setLoading(value: boolean): void {
    loading.value = value
  }

  function setViewMode(mode: MaterialViewMode): void {
    viewMode.value = mode
    persistState()
  }

  function setSortType(nextSortType: MaterialSortType): void {
    sortType.value = nextSortType
    persistState()
  }

  function setLiveSearchPath(path: string): void {
    liveSearchPath.value = path || '/Game'
    persistState()
  }

  function updateFilters(patch: Partial<MaterialLibraryFilters>): void {
    filters.value = { ...filters.value, ...patch }
    persistState()
  }

  function clearCollectionFilter(): void {
    filters.value.activeCollectionId = null
    persistState()
  }

  function clearFilters(): void {
    filters.value = {
      searchQuery: '',
      entryType: 'all',
      favoriteState: 'all',
      blendMode: 'all',
      materialDomain: 'all',
      shadingModel: 'all',
      compileStatus: 'all',
      hasTextureDependencies: 'all',
      hasFunctionDependencies: 'all',
      hasChildInstances: 'all',
      activeCollectionId: null
    }
    persistState()
  }

  function updateEntry(id: string, patch: Partial<MaterialEntry>): void {
    const entry = entries.value.find((item) => item.id === id)
    if (!entry) return
    Object.assign(entry, patch, { updatedAt: Date.now() })
    persistState()
  }

  function deleteEntry(id: string): void {
    const entry = entries.value.find((item) => item.id === id)
    const affectedCollectionIds = new Set<string>()
    if (entry?.collectionId) affectedCollectionIds.add(entry.collectionId)

    for (const collection of collections.value) {
      if (collection.entryIds.includes(id)) affectedCollectionIds.add(collection.id)
    }

    entries.value = entries.value.filter((item) => item.id !== id)

    for (const collection of collections.value) {
      collection.entryIds = collection.entryIds.filter((entryId) => entryId !== id)
    }

    for (const collectionId of affectedCollectionIds) {
      releaseCollectionIfTooSmall(collectionId)
    }

    if (activeEntryId.value === id) {
      activeEntryId.value = null
    }

    if (entry?.collectionId && filters.value.activeCollectionId === entry.collectionId) {
      const hasRemainingEntries = entries.value.some(
        (item) => item.collectionId === filters.value.activeCollectionId
      )
      if (!hasRemainingEntries) {
        filters.value.activeCollectionId = null
      }
    }

    persistState()
  }

  function toggleFavorite(id: string): void {
    const entry = entries.value.find((item) => item.id === id)
    if (!entry) return
    entry.isFavorite = !entry.isFavorite
    entry.updatedAt = Date.now()
    persistState()
  }

  function setTags(id: string, tags: string[]): void {
    const entry = entries.value.find((item) => item.id === id)
    if (!entry) return
    entry.tags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
    entry.updatedAt = Date.now()
    persistState()
  }

  function createDraftMaterial(options: {
    name: string
    entryType?: MaterialEntry['entryType']
    destinationPath?: string
    blendMode?: string
    shadingModel?: string
    twoSided?: boolean
    parentMaterialPath?: string
  }): MaterialEntry | null {
    const name = options.name.trim()
    if (!name) return null

    const entryType = options.entryType || 'material'
    const destinationPath = normalizeDraftPath(options.destinationPath || '/Game/Materials')
    const assetPath = `${destinationPath}/${name}`
    if (entries.value.some((entry) => entry.assetPath === assetPath)) {
      return null
    }

    const now = Date.now()
    const entry = {
      id: generateEntryId(name),
      name,
      entryType,
      assetPath,
      engineVersion: 'Local Draft',
      description: '',
      tags: [],
      thumbnail: undefined,
      coverStyle: getMaterialCoverStyle(entryType),
      createdAt: now,
      updatedAt: now,
      isFavorite: false,
      status: 'draft',
      materialDomain: entryType === 'function' ? 'Function' : 'Surface',
      blendMode: entryType === 'function' ? 'Function' : options.blendMode || 'Opaque',
      shadingModel: entryType === 'function' ? 'Function' : options.shadingModel || 'DefaultLit',
      twoSided: Boolean(options.twoSided),
      usageFlags: [],
      compileStatus: 'unknown',
      compileDiagnostics: [],
      lastHealthCheckAt: undefined,
      nodeCount: 0,
      connectionCount: 0,
      graphSummary: createEmptyGraphSummary(),
      graphBlueprintCode: '',
      scalarParameters: [],
      vectorParameters: [],
      textureParameters: [],
      staticSwitchParameters: [],
      textureDependencies: [],
      functionDependencies: [],
      parameterCollectionDependencies: [],
      missingDependencies: [],
      parentMaterialPath: entryType === 'instance' ? options.parentMaterialPath : undefined,
      childInstancePaths: [],
      referencedByPaths: [],
      collectionId: undefined,
      sourceOrigin: 'local',
      liveDataState: 'unavailable',
      syncIssues: [LOCAL_DRAFT_NOTE],
      lastSyncedAt: undefined,
      lastSyncAttemptAt: now,
      liveRefreshAvailable: false,
      legacyKey: undefined
    } as MaterialEntry

    entries.value.unshift(entry)
    persistState()
    return entry
  }

  function updateGraphCode(entryId: string, code: string): void {
    const entry = entries.value.find((item) => item.id === entryId)
    if (!entry) return

    if ((entry.graphBlueprintCode || '') === code) {
      const parameters = extractLegacyMaterialParameters(code)
      if (applyExtractedMaterialParameters(entry, parameters)) {
        entry.updatedAt = Date.now()
        persistState()
      }
      return
    }

    const graphSummary = summarizeLegacyGraph(code)
    const dependencies = extractLegacyMaterialDependencies(code)
    const parameters = extractLegacyMaterialParameters(code)
    const now = Date.now()

    entry.graphBlueprintCode = code
    entry.graphSummary = graphSummary
    entry.nodeCount = graphSummary.nodeCount
    entry.connectionCount = graphSummary.connectionCount
    applyExtractedMaterialParameters(entry, parameters)
    entry.textureDependencies = mergeDependencyRecords(entry, 'texture', dependencies.texturePaths)
    entry.functionDependencies = mergeDependencyRecords(
      entry,
      'function',
      dependencies.functionPaths
    )
    entry.parameterCollectionDependencies = mergeDependencyRecords(
      entry,
      'parameterCollection',
      dependencies.parameterCollectionPaths
    )
    entry.updatedAt = now

    persistState()
  }

  function createCollection(name: string, entryIds: string[] = []): MaterialCollection | null {
    const normalizedName = name.trim()
    if (!normalizedName) return null
    const existingEntryIds = [...new Set(entryIds)].filter((entryId) =>
      entries.value.some((entry) => entry.id === entryId)
    )
    const collection: MaterialCollection = {
      id: generateCollectionId(normalizedName),
      name: normalizedName,
      entryIds: existingEntryIds,
      createdAt: Date.now()
    }
    collections.value.push(collection)

    const previousCollectionIds = new Set<string>()
    for (const entryId of existingEntryIds) {
      const entry = entries.value.find((item) => item.id === entryId)
      if (!entry) continue
      if (entry.collectionId && entry.collectionId !== collection.id) {
        previousCollectionIds.add(entry.collectionId)
        const previousCollection = collections.value.find((item) => item.id === entry.collectionId)
        if (previousCollection) {
          previousCollection.entryIds = previousCollection.entryIds.filter((id) => id !== entry.id)
        }
      }
      entry.collectionId = collection.id
    }

    for (const previousCollectionId of previousCollectionIds) {
      releaseCollectionIfTooSmall(previousCollectionId)
    }

    persistState()
    return collection
  }

  /**
   * 把一批材质移到某个文件夹。`folderKey` 传空串表示移回根目录。
   *
   * 跟上面那套集合操作的区别只有一条但很要紧：**不会自动解散**。
   * `releaseCollectionIfTooSmall` 在集合剩 ≤1 个成员时把集合整个删掉 —— 那是
   * iOS 桌面文件夹的脾气，放在库里就是「我把最后一个拖出来，文件夹没了」。
   * 文件夹是用户建的地方，空着也该在。
   *
   * 材质落成保管库里的包之后，这里的 `collectionId` 换成真实目录路径，签名不变。
   */
  function moveEntriesToFolder(entryIds: string[], folderKey: string): void {
    const moving = new Set(entryIds)
    if (moving.size === 0) return

    const target = folderKey ? collections.value.find((item) => item.id === folderKey) : null
    // 指定了目标却找不到，说明 key 是脏的 —— 什么都不做，
    // 而不是把材质丢回根目录（那等于静默把用户的整理搞乱）
    if (folderKey && !target) return

    for (const collection of collections.value) {
      collection.entryIds = collection.entryIds.filter((id) => !moving.has(id))
    }
    if (target) target.entryIds.push(...entryIds)

    for (const entry of entries.value) {
      if (moving.has(entry.id)) entry.collectionId = folderKey || undefined
    }

    persistState()
  }

  /** 新建一个空文件夹。空着也留着 —— 用户建它就是为了往里放东西。 */
  function createFolder(name: string): MaterialCollection | null {
    return createCollection(name, [])
  }

  function renameCollection(collectionId: string, name: string): boolean {
    const collection = collections.value.find((item) => item.id === collectionId)
    const normalizedName = name.trim()
    if (!collection || !normalizedName) return false
    collection.name = normalizedName
    persistState()
    return true
  }

  function deleteCollection(collectionId: string): void {
    collections.value = collections.value.filter((collection) => collection.id !== collectionId)
    for (const entry of entries.value) {
      if (entry.collectionId === collectionId) {
        entry.collectionId = undefined
      }
    }

    if (filters.value.activeCollectionId === collectionId) {
      filters.value.activeCollectionId = null
    }

    persistState()
  }

  function assignToCollection(entryId: string, collectionId: string | null): void {
    const entry = entries.value.find((item) => item.id === entryId)
    if (!entry) return
    if (entry.collectionId === collectionId) {
      if (collectionId) {
        const collection = collections.value.find((item) => item.id === collectionId)
        if (collection && !collection.entryIds.includes(entry.id)) {
          collection.entryIds.push(entry.id)
          persistState()
        }
      }
      return
    }

    const previousCollectionId = entry.collectionId

    if (previousCollectionId) {
      const previousCollection = collections.value.find((item) => item.id === previousCollectionId)
      if (previousCollection) {
        previousCollection.entryIds = previousCollection.entryIds.filter((id) => id !== entry.id)
      }
      entry.collectionId = undefined
      releaseCollectionIfTooSmall(previousCollectionId)
    }

    if (collectionId) {
      const nextCollection = collections.value.find((item) => item.id === collectionId)
      if (nextCollection) {
        entry.collectionId = collectionId
        if (!nextCollection.entryIds.includes(entry.id)) {
          nextCollection.entryIds.push(entry.id)
        }
      }
    }

    persistState()
  }

  function getCollectionEntries(collectionId: string): MaterialEntry[] {
    const collection = collections.value.find((item) => item.id === collectionId)
    if (!collection) return entries.value.filter((entry) => entry.collectionId === collectionId)

    const entriesById = new Map(entries.value.map((entry) => [entry.id, entry]))
    const orderedEntries = collection.entryIds
      .map((entryId) => entriesById.get(entryId))
      .filter((entry): entry is MaterialEntry => !!entry && entry.collectionId === collectionId)
    const orderedIds = new Set(orderedEntries.map((entry) => entry.id))
    const unlistedEntries = entries.value.filter(
      (entry) => entry.collectionId === collectionId && !orderedIds.has(entry.id)
    )
    return [...orderedEntries, ...unlistedEntries]
  }

  // 读库是异步的，但材质库的路由在进入之前会 await 这个 ready（见 mainRoutes.ts），
  // 所以组件仍然是「一挂载数据就在」，视图代码不需要动。
  const ready = persistence.ready

  return {
    ready,
    /** 立刻落盘，不等防抖。测试和「关页面前保一手」用 */
    flushPersistence: persistence.flush,
    /**
     * 落盘状态，给界面用。写盘失败（切了保管库、包目录被改名）时界面要能看见 ——
     * 否则用户之后的每一次编辑都「看起来成功」，关掉应用才发现没了。
     */
    saveState: persistence.saveState,

    entries,
    collections,
    loading,
    activeEntryId,
    activeEntry,
    filteredEntries,
    viewMode,
    sortType,
    filters,
    liveSearchPath,
    availableBlendModes,
    availableDomains,
    availableShadingModels,
    upsertEntries,
    importLegacyEntries,
    setActiveEntryId,
    setLoading,
    setViewMode,
    setSortType,
    setLiveSearchPath,
    updateFilters,
    clearCollectionFilter,
    clearFilters,
    updateEntry,
    deleteEntry,
    toggleFavorite,
    setTags,
    createDraftMaterial,
    updateGraphCode,
    createCollection,
    moveEntriesToFolder,
    createFolder,
    renameCollection,
    deleteCollection,
    assignToCollection,
    getCollectionEntries,
    persistState
  }
})
