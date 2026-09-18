/**
 * 蓝图库 v2 Store
 * 管理蓝图列表、CRUD、筛选、排序
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  Blueprint,
  BlueprintType,
  BlueprintStatus,
  BlueprintGraph,
  BlueprintFunction,
  BlueprintVariable,
  BlueprintComponent,
  BlueprintEventDispatcher,
  BlueprintMacro,
  BlueprintCollection,
  GalleryCategory,
  GallerySortType,
  GalleryViewMode,
  BlueprintElementType
} from '@renderer/views/BlueprintLibrary/types/blueprint'
import { SAMPLE_EVENT_GRAPH_CODE } from '@renderer/views/BlueprintLibrary/constants/sampleBlueprintCode'
import { getBlueprintTypeLabel } from '@renderer/views/BlueprintLibrary/types/blueprint'
import { extractFunctionSignatureFromCode } from '@renderer/views/BlueprintLibrary/utils/blueprintCodeParser'
import { sortLibraryEntries } from '@renderer/views/library-common/utils/libraryCollection'
import { createLibraryPackagePersistence, parseUiPrefs } from './libraryPackagePersistence'
import { clearLegacyLocalStorage, readLegacyLibrarySnapshot } from './libraryLegacyRead'
import { detectSnippetForm } from '@renderer/views/library-common/utils/snippetForm'
import i18n from '@renderer/i18n'

/** store 不是组件，拿不到 `useI18n()`；`i18n.global.t` 每次调用现读当前语言 */
const t = i18n.global.t

// ============================================================
//  常量
// ============================================================

/** 旧版把整库写在这个 localStorage 键下，现在只在首次迁移时读一次 */
const LEGACY_PERSIST_KEY = 'blueprint-library-v2-state'

/** 界面偏好（排序、视图模式、编辑器视角）留在 localStorage —— 它本来就该放这儿 */
const UI_STATE_KEY = 'blueprint-library-ui'

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
    console.warn('[BlueprintLibrary] 界面偏好存盘失败:', error)
  }
}
const CREATE_MODAL_SETTINGS_KEY = 'blueprint-create-modal-settings'

const ENGINE_VERSIONS = ['5.7', '5.6', '5.5', '5.4', '5.3', '5.2', '5.1', '5.0', '4.27', '4.26']

// 封面按蓝图类型在渲染时现取（getBlueprintCoverStyle 的类型兜底），
// 不落进 coverStyle —— 那会把某次安装解析出的内置封面地址写死到磁盘上

// ============================================================
//  Store
// ============================================================

export const useBlueprintLibraryStore = defineStore('blueprintLibrary', () => {
  type BlueprintEditorViewState = {
    zoom: number
    scrollX: number
    scrollY: number
    translateX: number | null
    translateY: number | null
    centerX: number | null
    centerY: number | null
    selectedNodeNames: string[]
  }

  type EditorTabState = {
    activeBlueprintId: string | null
    activeElementId: string | null
    activeElementType: BlueprintElementType | null
  }

  // ========== 蓝图列表 ==========
  const blueprints = ref<Blueprint[]>([])
  const collections = ref<BlueprintCollection[]>([])
  const loading = ref(false)

  // ========== Gallery 状态 ==========
  const category = ref<GalleryCategory>('all')
  const sortType = ref<GallerySortType>('created')
  const searchQuery = ref('')
  const typeFilter = ref<string>('all')
  const favoriteOnly = ref(false)
  const galleryViewMode = ref<GalleryViewMode>('grid')

  // ========== Editor 状态 ==========
  const editorTabStates = new Map<string, EditorTabState>()
  const editorViewStates = new Map<string, BlueprintEditorViewState>()
  const editorTabId = ref('default')
  const activeBlueprintId = ref<string | null>(null)
  const activeElementId = ref<string | null>(null)
  const activeElementType = ref<BlueprintElementType | null>(null)

  // ========== 新建蓝图弹窗设置 ==========
  const createModalAdvancedExpanded = ref(false)

  // ========== 引擎版本列表 ==========
  const engineVersionList = computed(() => ENGINE_VERSIONS)

  // ========== 计算属性 ==========

  /** 按排序和筛选条件过滤后的蓝图列表（排除已属于集合的蓝图，搜索时显示全部） */
  const filteredBlueprints = computed(() => {
    let list = [...blueprints.value]

    // 搜索过滤
    const isSearching = !!searchQuery.value
    if (isSearching) {
      const q = searchQuery.value.toLowerCase()
      list = list.filter(
        (bp) =>
          bp.name.toLowerCase().includes(q) ||
          bp.description.toLowerCase().includes(q) ||
          bp.blueprintType.toLowerCase().includes(q) ||
          getBlueprintTypeLabel(bp.blueprintType).toLowerCase().includes(q) ||
          bp.tags.some((tag) => tag.toLowerCase().includes(q))
      )
    } else {
      // 非搜索模式：排除已属于集合的蓝图
      list = list.filter((bp) => !bp.collectionId)
    }

    if (typeFilter.value !== 'all') {
      list = list.filter((bp) => bp.blueprintType === typeFilter.value)
    }

    if (favoriteOnly.value) {
      list = list.filter((bp) => bp.isFavorite)
    }

    // 分类过滤
    if (category.value === 'my') {
      list = list.filter((bp) => bp.status !== 'archived')
    }

    // 排序
    return sortLibraryEntries(list, sortType.value)
  })

  /** 当前活跃蓝图 */
  const activeBlueprint = computed(() =>
    activeBlueprintId.value
      ? blueprints.value.find((bp) => bp.id === activeBlueprintId.value) || null
      : null
  )

  // ========== 工具方法 ==========

  function generateId(): string {
    return `bp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ========== 持久化 ==========
  //
  // 蓝图存成保管库里的 `xxx.ueblueprint` 包目录，封面单独落成包里的 cover.png
  // （见 libraryPackagePersistence.ts）。界面偏好留在 localStorage。
  // 老用户在 SQLite / 旧 localStorage 里那份，首次打开时自动搬成包。

  /** 从一份（新的或旧的）界面偏好里挑出这个 store 关心的字段并做校验 */
  function applyUiState(ui: Record<string, unknown>): void {
    // 组件可能已经先于读取设过当前蓝图（深链进编辑器），别把它盖掉
    if (ui.activeBlueprintId && !activeBlueprintId.value) {
      activeBlueprintId.value = ui.activeBlueprintId as string
    }
    if (ui.sortType) {
      sortType.value = ui.sortType as GallerySortType
    }
    if (ui.galleryViewMode) {
      galleryViewMode.value = ui.galleryViewMode as GalleryViewMode
    }
    if (typeof ui.typeFilter === 'string') {
      typeFilter.value = ui.typeFilter
    }
    if (typeof ui.favoriteOnly === 'boolean') {
      favoriteOnly.value = ui.favoriteOnly
    }
    if (ui.editorViewStates && typeof ui.editorViewStates === 'object') {
      for (const [key, value] of Object.entries(ui.editorViewStates)) {
        if (!value || typeof value !== 'object') continue
        const candidate = value as Partial<BlueprintEditorViewState>
        editorViewStates.set(key, {
          zoom: typeof candidate.zoom === 'number' ? candidate.zoom : 0,
          scrollX: typeof candidate.scrollX === 'number' ? candidate.scrollX : 0,
          scrollY: typeof candidate.scrollY === 'number' ? candidate.scrollY : 0,
          translateX: typeof candidate.translateX === 'number' ? candidate.translateX : null,
          translateY: typeof candidate.translateY === 'number' ? candidate.translateY : null,
          centerX: typeof candidate.centerX === 'number' ? candidate.centerX : null,
          centerY: typeof candidate.centerY === 'number' ? candidate.centerY : null,
          selectedNodeNames: Array.isArray(candidate.selectedNodeNames)
            ? candidate.selectedNodeNames.filter(
                (item): item is string => typeof item === 'string' && item.length > 0
              )
            : []
        })
      }
    }

    editorTabStates.set('default', {
      activeBlueprintId: activeBlueprintId.value,
      activeElementId: activeElementId.value,
      activeElementType: activeElementType.value
    })
  }

  const persistence = createLibraryPackagePersistence<Blueprint, BlueprintCollection>({
    library: 'blueprint',
    readUi: readUiPrefs,
    writeUi: writeUiPrefs,
    // 只在这个保管库还没迁移过时调用一次：先看 SQLite，再看最早那版 localStorage
    readLegacy: () =>
      readLegacyLibrarySnapshot<Blueprint, BlueprintCollection>({
        library: 'blueprint',
        legacyKey: LEGACY_PERSIST_KEY,
        // 旧结构是一个扁平对象：蓝图、分组、界面偏好平铺在同一层
        parseLegacy: (raw) => ({
          entries: Array.isArray(raw.blueprints) ? (raw.blueprints as Blueprint[]) : [],
          collections: Array.isArray(raw.collections)
            ? (raw.collections as BlueprintCollection[])
            : [],
          ui: {
            activeBlueprintId: raw.activeBlueprintId,
            sortType: raw.sortType,
            typeFilter: raw.typeFilter,
            favoriteOnly: raw.favoriteOnly,
            galleryViewMode: raw.galleryViewMode,
            editorViewStates: raw.editorViewStates
          }
        })
      }),
    onMigrated: () => clearLegacyLocalStorage(LEGACY_PERSIST_KEY),
    /**
     * 片段仓库存下来的 payload 是 `{ form: "snippet", t3d: "...", meta: {...} }`，
     * 里面**没有** `graphs` / `functions` / `variables` 这些字段，而详情页
     * （`BlueprintEditor.vue`）会直接 `bp.graphs.map(...)` —— 不补就崩。
     *
     * 补的是空数组而不是伪造内容：详情页会按 `form` 分流到摘要视图，
     * 不去走老条目那套图表 / 函数 / 变量的渲染。
     *
     * （片段的正文其实也是 T3D，第三方渲染器画得了 —— 但那是另一件事，
     * 要接的话在 `SnippetDetail.vue` 里接，不是在这儿伪造成一条老条目。）
     */
    normalizeEntry: (payload) => {
      if (detectSnippetForm(payload) !== 'snippet') return payload
      return {
        blueprintType: 'actor',
        engineVersion: '5.x',
        description: '',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isFavorite: false,
        status: 'draft',
        ...payload,
        graphs: [],
        functions: [],
        variables: [],
        components: [],
        eventDispatchers: [],
        macros: []
      }
    },
    getSnapshot: () => ({
      entries: blueprints.value,
      collections: collections.value,
      ui: {
        activeBlueprintId: activeBlueprintId.value,
        sortType: sortType.value,
        typeFilter: typeFilter.value,
        favoriteOnly: favoriteOnly.value,
        galleryViewMode: galleryViewMode.value,
        editorViewStates: Object.fromEntries(editorViewStates.entries())
      }
    }),
    applySnapshot: (snapshot) => {
      blueprints.value = snapshot.entries
      collections.value = snapshot.collections
      applyUiState(snapshot.ui)
    }
  })

  function persistState(): void {
    persistence.persist()
  }

  // ========== 新建蓝图弹窗设置持久化 ==========
  function loadCreateModalSettings(): void {
    try {
      const raw = localStorage.getItem(CREATE_MODAL_SETTINGS_KEY)
      if (raw) {
        const data = JSON.parse(raw)
        if (typeof data.advancedExpanded === 'boolean') {
          createModalAdvancedExpanded.value = data.advancedExpanded
        }
      }
    } catch (err) {
      console.warn('[BlueprintLibrary] 弹窗设置加载失败:', err)
    }
  }

  function persistCreateModalSettings(): void {
    try {
      localStorage.setItem(
        CREATE_MODAL_SETTINGS_KEY,
        JSON.stringify({
          advancedExpanded: createModalAdvancedExpanded.value
        })
      )
    } catch (err) {
      console.warn('[BlueprintLibrary] 弹窗设置保存失败:', err)
    }
  }

  function setCreateModalAdvancedExpanded(expanded: boolean): void {
    createModalAdvancedExpanded.value = expanded
    persistCreateModalSettings()
  }

  // ========== Gallery 操作 ==========

  function setCategory(cat: GalleryCategory): void {
    category.value = cat
  }

  function setSortType(sort: GallerySortType): void {
    sortType.value = sort
    persistState()
  }

  function setSearchQuery(query: string): void {
    searchQuery.value = query
  }

  function setTypeFilter(type: string): void {
    typeFilter.value = type || 'all'
    persistState()
  }

  function setFavoriteOnly(value: boolean): void {
    favoriteOnly.value = value
    persistState()
  }

  function setGalleryViewMode(mode: GalleryViewMode): void {
    galleryViewMode.value = mode
    persistState()
  }

  function saveCurrentEditorTabState(): void {
    const tabId = editorTabId.value || 'default'
    editorTabStates.set(tabId, {
      activeBlueprintId: activeBlueprintId.value,
      activeElementId: activeElementId.value,
      activeElementType: activeElementType.value
    })
  }

  function buildEditorViewStateKey(
    tabId: string,
    blueprintId: string,
    elementId: string,
    elementType: BlueprintElementType
  ): string {
    return [tabId, blueprintId, elementType, elementId].join('::')
  }

  function saveEditorViewState(
    blueprintId: string,
    elementId: string,
    elementType: BlueprintElementType,
    viewState: BlueprintEditorViewState,
    tabId = editorTabId.value
  ): void {
    const normalizedTabId = String(tabId || '').trim() || 'default'
    const key = buildEditorViewStateKey(normalizedTabId, blueprintId, elementId, elementType)
    editorViewStates.set(key, {
      zoom: viewState.zoom,
      scrollX: viewState.scrollX,
      scrollY: viewState.scrollY,
      translateX: viewState.translateX,
      translateY: viewState.translateY,
      centerX: viewState.centerX,
      centerY: viewState.centerY,
      selectedNodeNames: [...viewState.selectedNodeNames]
    })
    persistState()
  }

  function getEditorViewState(
    blueprintId: string,
    elementId: string,
    elementType: BlueprintElementType,
    tabId = editorTabId.value
  ): BlueprintEditorViewState | null {
    const normalizedTabId = String(tabId || '').trim() || 'default'
    const key = buildEditorViewStateKey(normalizedTabId, blueprintId, elementId, elementType)
    const viewState = editorViewStates.get(key)
    if (!viewState) return null
    return {
      zoom: viewState.zoom,
      scrollX: viewState.scrollX,
      scrollY: viewState.scrollY,
      translateX: viewState.translateX,
      translateY: viewState.translateY,
      centerX: viewState.centerX,
      centerY: viewState.centerY,
      selectedNodeNames: [...viewState.selectedNodeNames]
    }
  }

  function removeEditorViewStatesForBlueprint(bpId: string): void {
    let didDelete = false
    for (const key of editorViewStates.keys()) {
      const parts = key.split('::')
      if (parts[1] !== bpId) continue
      editorViewStates.delete(key)
      didDelete = true
    }
    if (didDelete) {
      persistState()
    }
  }

  function removeEditorViewStatesForElement(
    bpId: string,
    elementId: string,
    elementType: BlueprintElementType
  ): void {
    let didDelete = false
    for (const key of editorViewStates.keys()) {
      const parts = key.split('::')
      if (parts[1] !== bpId || parts[2] !== elementType || parts[3] !== elementId) continue
      editorViewStates.delete(key)
      didDelete = true
    }
    if (didDelete) {
      persistState()
    }
  }

  function setEditorTabId(tabId: string): void {
    const normalizedTabId = String(tabId || '').trim() || 'default'
    saveCurrentEditorTabState()
    editorTabId.value = normalizedTabId

    const savedState = editorTabStates.get(normalizedTabId)
    if (savedState) {
      activeBlueprintId.value = savedState.activeBlueprintId
      activeElementId.value = savedState.activeElementId
      activeElementType.value = savedState.activeElementType
      return
    }

    activeBlueprintId.value = null
    activeElementId.value = null
    activeElementType.value = null
    saveCurrentEditorTabState()
  }

  function copyEditorStateToTabId(sourceTabId: string, targetTabId: string): void {
    const sourceState = editorTabStates.get(sourceTabId)
    if (!sourceState) return
    editorTabStates.set(targetTabId, { ...sourceState })

    for (const [key, value] of editorViewStates.entries()) {
      const parts = key.split('::')
      if (parts[0] !== sourceTabId) continue
      const duplicatedKey = buildEditorViewStateKey(
        targetTabId,
        parts[1] ?? '',
        parts[3] ?? '',
        (parts[2] as BlueprintElementType) ?? 'graph'
      )
      editorViewStates.set(duplicatedKey, {
        zoom: value.zoom,
        scrollX: value.scrollX,
        scrollY: value.scrollY,
        translateX: value.translateX,
        translateY: value.translateY,
        centerX: value.centerX,
        centerY: value.centerY,
        selectedNodeNames: [...value.selectedNodeNames]
      })
    }

    persistState()
  }

  function setActiveBlueprintId(id: string | null): void {
    activeBlueprintId.value = id
    saveCurrentEditorTabState()
  }

  // ========== CRUD ==========

  function createBlueprint(opts: {
    name: string
    blueprintType: BlueprintType
    engineVersion: string
    description?: string
    tags?: string[]
  }): Blueprint {
    const now = Date.now()
    const bp: Blueprint = {
      id: generateId(),
      name: opts.name,
      blueprintType: opts.blueprintType,
      engineVersion: opts.engineVersion,
      description: opts.description || '',
      tags: opts.tags || [],
      createdAt: now,
      updatedAt: now,
      isFavorite: false,
      status: 'draft',
      // 默认带一个 EventGraph
      graphs: [
        {
          id: generateId(),
          name: t('blueprintLibraryStore.defaultGraph.name'),
          type: 'event',
          code: '',
          nodeCount: 0,
          description: t('blueprintLibraryStore.defaultGraph.description'),
          createdAt: now,
          updatedAt: now
        }
      ],
      functions: [],
      variables: [],
      components: [],
      eventDispatchers: [],
      macros: []
    }
    blueprints.value.push(bp)
    persistState()
    return bp
  }

  function updateBlueprint(id: string, updates: Partial<Blueprint>): void {
    const idx = blueprints.value.findIndex((bp) => bp.id === id)
    if (idx === -1) return
    blueprints.value[idx] = { ...blueprints.value[idx], ...updates, updatedAt: Date.now() }
    persistState()
  }

  function deleteBlueprint(id: string): void {
    blueprints.value = blueprints.value.filter((bp) => bp.id !== id)
    if (activeBlueprintId.value === id) {
      activeBlueprintId.value = null
    }
    for (const state of editorTabStates.values()) {
      if (state.activeBlueprintId === id) {
        state.activeBlueprintId = null
      }
    }
    saveCurrentEditorTabState()
    removeEditorViewStatesForBlueprint(id)
    persistState()
  }

  function toggleFavorite(id: string): void {
    const bp = blueprints.value.find((b) => b.id === id)
    if (bp) {
      bp.isFavorite = !bp.isFavorite
      bp.updatedAt = Date.now()
      persistState()
    }
  }

  // ========== Editor 内部元素操作 ==========

  function setActiveElement(id: string | null, type: BlueprintElementType | null): void {
    activeElementId.value = id
    activeElementType.value = type
    saveCurrentEditorTabState()
  }

  function addGraph(
    bpId: string,
    graph: Omit<BlueprintGraph, 'id' | 'createdAt' | 'updatedAt'>
  ): void {
    const bp = blueprints.value.find((b) => b.id === bpId)
    if (!bp) return
    const now = Date.now()
    bp.graphs.push({ ...graph, id: generateId(), createdAt: now, updatedAt: now })
    bp.updatedAt = now
    persistState()
  }

  function addFunction(
    bpId: string,
    fn: Omit<BlueprintFunction, 'id' | 'createdAt' | 'updatedAt'>
  ): void {
    const bp = blueprints.value.find((b) => b.id === bpId)
    if (!bp) return
    const now = Date.now()
    bp.functions.push({ ...fn, id: generateId(), createdAt: now, updatedAt: now })
    bp.updatedAt = now
    persistState()
  }

  function addVariable(bpId: string, variable: Omit<BlueprintVariable, 'id' | 'createdAt'>): void {
    const bp = blueprints.value.find((b) => b.id === bpId)
    if (!bp) return
    const now = Date.now()
    bp.variables.push({ ...variable, id: generateId(), createdAt: now })
    bp.updatedAt = now
    persistState()
  }

  function addComponent(bpId: string, comp: Omit<BlueprintComponent, 'id'>): void {
    const bp = blueprints.value.find((b) => b.id === bpId)
    if (!bp) return
    bp.components.push({ ...comp, id: generateId() })
    bp.updatedAt = Date.now()
    persistState()
  }

  function addEventDispatcher(
    bpId: string,
    ed: Omit<BlueprintEventDispatcher, 'id' | 'createdAt'>
  ): void {
    const bp = blueprints.value.find((b) => b.id === bpId)
    if (!bp) return
    const now = Date.now()
    bp.eventDispatchers.push({ ...ed, id: generateId(), createdAt: now })
    bp.updatedAt = now
    persistState()
  }

  function addMacro(
    bpId: string,
    macro: Omit<BlueprintMacro, 'id' | 'createdAt' | 'updatedAt'>
  ): void {
    const bp = blueprints.value.find((b) => b.id === bpId)
    if (!bp) return
    const now = Date.now()
    bp.macros.push({ ...macro, id: generateId(), createdAt: now, updatedAt: now })
    bp.updatedAt = now
    persistState()
  }

  function removeElement(bpId: string, elementId: string, type: BlueprintElementType): void {
    const bp = blueprints.value.find((b) => b.id === bpId)
    if (!bp) return
    switch (type) {
      case 'graph':
        bp.graphs = bp.graphs.filter((g) => g.id !== elementId)
        break
      case 'function':
        bp.functions = bp.functions.filter((f) => f.id !== elementId)
        break
      case 'variable':
        bp.variables = bp.variables.filter((v) => v.id !== elementId)
        break
      case 'component':
        bp.components = bp.components.filter((c) => c.id !== elementId)
        break
      case 'eventDispatcher':
        bp.eventDispatchers = bp.eventDispatchers.filter((e) => e.id !== elementId)
        break
      case 'macro':
        bp.macros = bp.macros.filter((m) => m.id !== elementId)
        break
    }
    if (activeElementId.value === elementId) {
      activeElementId.value = null
      activeElementType.value = null
    }
    for (const state of editorTabStates.values()) {
      if (state.activeElementId === elementId) {
        state.activeElementId = null
        state.activeElementType = null
      }
    }
    saveCurrentEditorTabState()
    bp.updatedAt = Date.now()
    removeEditorViewStatesForElement(bpId, elementId, type)
    persistState()
  }

  /** 更新元素的 code（蓝图序列化文本），用于画布持久化 */
  function updateElementCode(
    bpId: string,
    elementId: string,
    type: BlueprintElementType,
    code: string
  ): void {
    const bp = blueprints.value.find((b) => b.id === bpId)
    if (!bp) return
    const now = Date.now()
    switch (type) {
      case 'graph': {
        const g = bp.graphs.find((g) => g.id === elementId)
        if (g) {
          g.code = code
          g.updatedAt = now
        }
        break
      }
      case 'function': {
        const f = bp.functions.find((f) => f.id === elementId)
        if (f) {
          f.code = code
          const signature = extractFunctionSignatureFromCode(code)
          f.inputs = signature.inputs
          f.outputs = signature.outputs
          f.updatedAt = now
        }
        break
      }
      case 'macro': {
        const m = bp.macros.find((m) => m.id === elementId)
        if (m) {
          m.code = code
          m.updatedAt = now
        }
        break
      }
      default:
        // variables, components, eventDispatchers don't have code
        return
    }
    bp.updatedAt = now
    persistState()
  }

  /** 重命名元素（图表/函数/宏/事件分发器） */
  function renameElement(
    bpId: string,
    elementId: string,
    type: BlueprintElementType,
    newName: string
  ): void {
    const bp = blueprints.value.find((b) => b.id === bpId)
    if (!bp || !newName.trim()) return
    const name = newName.trim()
    const now = Date.now()
    switch (type) {
      case 'graph': {
        const g = bp.graphs.find((g) => g.id === elementId)
        if (g) {
          g.name = name
          g.updatedAt = now
        }
        break
      }
      case 'function': {
        const f = bp.functions.find((f) => f.id === elementId)
        if (f) {
          f.name = name
          f.updatedAt = now
        }
        break
      }
      case 'macro': {
        const m = bp.macros.find((m) => m.id === elementId)
        if (m) {
          m.name = name
          m.updatedAt = now
        }
        break
      }
      case 'eventDispatcher': {
        const ed = bp.eventDispatchers.find((e) => e.id === elementId)
        if (ed) {
          ed.name = name
        }
        break
      }
      default:
        return
    }
    bp.updatedAt = now
    persistState()
  }

  // ========== 文件夹操作 ==========

  /**
   * 把一批蓝图移到某个文件夹。`folderKey` 传空串表示移回根目录。
   *
   * 跟下面那套「集合」操作的区别，只有一条但很要紧：**这里不会自动解散**。
   * `removeFromCollection` 在集合剩 ≤1 个成员时会把集合整个删掉 —— 那是
   * iOS 桌面文件夹的脾气，放在库里就是「我把最后一个拖出来，文件夹没了」。
   * 文件夹是用户建的地方，空着也该在。
   *
   * 集合模型退场之后，这里的 `collectionId` 会换成包在保管库里的真实目录路径，
   * 函数签名不变。
   */
  function moveBlueprintsToFolder(blueprintIds: string[], folderKey: string): void {
    const moving = new Set(blueprintIds)
    if (moving.size === 0) return

    const target = folderKey ? collections.value.find((c) => c.id === folderKey) : null
    // 指定了目标却找不到，说明传进来的 key 是脏的 —— 什么都不做，
    // 而不是把蓝图丢回根目录（那等于静默地把用户的整理搞乱）
    if (folderKey && !target) return

    for (const collection of collections.value) {
      collection.blueprintIds = collection.blueprintIds.filter((id) => !moving.has(id))
    }
    if (target) target.blueprintIds.push(...blueprintIds)

    for (const id of blueprintIds) {
      const bp = blueprints.value.find((b) => b.id === id)
      if (bp) bp.collectionId = folderKey || undefined
    }

    persistState()
  }

  /** 新建一个空文件夹。空着也留着 —— 用户建它就是为了往里放东西。 */
  function createFolder(name: string): BlueprintCollection {
    return createCollection(name, [])
  }

  // ========== 集合操作 ==========

  /** 创建集合并加入指定蓝图 */
  function createCollection(name: string, blueprintIds: string[]): BlueprintCollection {
    const col: BlueprintCollection = {
      id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      blueprintIds: [...blueprintIds],
      createdAt: Date.now()
    }
    collections.value.push(col)
    // 标记蓝图的 collectionId
    blueprintIds.forEach((bpId) => {
      const bp = blueprints.value.find((b) => b.id === bpId)
      if (bp) bp.collectionId = col.id
    })
    persistState()
    return col
  }

  /** 将蓝图加入已有集合 */
  function addToCollection(collectionId: string, blueprintId: string): boolean {
    const col = collections.value.find((c) => c.id === collectionId)
    if (!col) return false
    if (col.blueprintIds.includes(blueprintId)) return true // 已存在
    col.blueprintIds.push(blueprintId)
    const bp = blueprints.value.find((b) => b.id === blueprintId)
    if (bp) bp.collectionId = collectionId
    persistState()
    return true
  }

  /** 从集合中移除蓝图（剩 ≤1 自动解散） */
  function removeFromCollection(collectionId: string, blueprintId: string): void {
    const col = collections.value.find((c) => c.id === collectionId)
    if (!col) return
    col.blueprintIds = col.blueprintIds.filter((id) => id !== blueprintId)
    const bp = blueprints.value.find((b) => b.id === blueprintId)
    if (bp) bp.collectionId = undefined
    // 集合内 ≤1 个蓝图时自动解散
    if (col.blueprintIds.length <= 1) {
      // 释放剩余蓝图
      col.blueprintIds.forEach((id) => {
        const remainBp = blueprints.value.find((b) => b.id === id)
        if (remainBp) remainBp.collectionId = undefined
      })
      collections.value = collections.value.filter((c) => c.id !== collectionId)
    }
    persistState()
  }

  /** 重命名集合 */
  function renameCollection(collectionId: string, newName: string): void {
    const col = collections.value.find((c) => c.id === collectionId)
    if (col) {
      col.name = newName
      persistState()
    }
  }

  /** 删除集合（释放所有蓝图） */
  function deleteCollection(collectionId: string): void {
    const col = collections.value.find((c) => c.id === collectionId)
    if (!col) return
    col.blueprintIds.forEach((id) => {
      const bp = blueprints.value.find((b) => b.id === id)
      if (bp) bp.collectionId = undefined
    })
    collections.value = collections.value.filter((c) => c.id !== collectionId)
    persistState()
  }

  /** 获取集合内的蓝图列表 */
  function getCollectionBlueprints(collectionId: string): Blueprint[] {
    const col = collections.value.find((c) => c.id === collectionId)
    if (!col) return []
    return col.blueprintIds
      .map((id) => blueprints.value.find((b) => b.id === id))
      .filter((b): b is Blueprint => !!b)
  }

  // ========== Mock 数据 ==========

  function loadMockData(): void {
    if (blueprints.value.length > 0) return
    const now = Date.now()

    const mockBp1 = createBlueprint({
      name: 'BP_DamageSystem',
      blueprintType: 'BlueprintClass',
      engineVersion: '5.4',
      description: t('blueprintLibraryStore.samples.damageSystem'),
      tags: ['combat', 'damage']
    })
    // 给 mock 蓝图添加一些内部元素
    addFunction(mockBp1.id, {
      name: 'CalculateDamage',
      inputs: [
        { name: 'BaseDamage', type: 'Float' },
        { name: 'DamageType', type: 'Enum' }
      ],
      outputs: [{ name: 'FinalDamage', type: 'Float' }],
      code: '',
      description: t('blueprintLibraryStore.samples.calculateDamage'),
      isPure: true,
      access: 'public'
    })
    addVariable(mockBp1.id, {
      name: 'DamageMultiplier',
      type: 'Float',
      defaultValue: '1.0',
      isEditable: true,
      isBlueprintReadOnly: false,
      isExposedOnSpawn: false,
      category: 'Damage',
      description: t('blueprintLibraryStore.samples.damageMultiplier'),
      replication: 'none'
    })
    addVariable(mockBp1.id, {
      name: 'bIsActive',
      type: 'Boolean',
      defaultValue: 'true',
      isEditable: true,
      isBlueprintReadOnly: false,
      isExposedOnSpawn: true,
      category: 'State',
      description: t('blueprintLibraryStore.samples.isActive'),
      replication: 'replicated'
    })

    createBlueprint({
      name: 'BP_CharacterController',
      blueprintType: 'BlueprintClass',
      engineVersion: '5.4',
      description: t('blueprintLibraryStore.samples.characterController'),
      tags: ['movement', 'character']
    })

    createBlueprint({
      name: 'WBP_MainMenu',
      blueprintType: 'WidgetBlueprint',
      engineVersion: '5.4',
      description: t('blueprintLibraryStore.samples.mainMenu'),
      tags: ['UI', 'menu']
    })

    createBlueprint({
      name: 'BP_NetworkManager',
      blueprintType: 'GameModeBlueprint',
      engineVersion: '5.4',
      description: t('blueprintLibraryStore.samples.networkManager'),
      tags: ['network', 'multiplayer']
    })
  }

  // 初始化
  //
  // 读库是异步的，但两个库的路由在进入之前会 await 这个 ready（见 mainRoutes.ts），
  // 所以组件仍然是「一挂载数据就在」，视图代码不需要动。
  editorTabStates.set('default', {
    activeBlueprintId: null,
    activeElementId: null,
    activeElementType: null
  })
  loadCreateModalSettings()
  const ready = persistence.ready.then(() => {
    if (blueprints.value.length === 0) {
      loadMockData()
    }
  })

  /*
   * 主进程往包目录写了一条（`blueprint_library_save`）—— 把**那一条**并进来。
   *
   * 为什么不能等界面那边 `await appExecuteAgent()` 之后再刷：
   * 那个函数是**后台发起、立刻返回**的（`api/ai.ts` 里注释写着
   * 「不 await —— 用户要能在执行过程中随时 stop()」），await 完的时候
   * 条目多半还没存下来；而真正存完之后就再也没人刷了。
   *
   * 为什么是「并一条」而不是整库重读：重读会在扫盘那几百毫秒里
   * 把用户同时改的其它条目盖掉，flush 失败时还会盖掉没存上的改动 ——
   * 两个都实测复现过，详见 `mergeEntryFromDisk` 的注释。
   *
   * store 是模块级单例、活到应用关闭，所以这个监听不用解绑。
   */
  window.api?.on?.('library:entry-saved', (_event, payload) => {
    const data = payload as { library?: string; entryId?: string } | undefined
    if (data?.library && data.library !== 'blueprint') return
    if (!data?.entryId) return
    void persistence.mergeEntryFromDisk?.(data.entryId)
  })

  return {
    // 初始化完成信号
    ready,
    /** 立刻落盘，不等防抖。测试和「关页面前保一手」用 */
    flushPersistence: persistence.flush,
    /**
     * 落盘状态，给界面用。写盘失败（切了保管库、包目录被改名）时界面要能看见 ——
     * 否则用户之后的每一次编辑都「看起来成功」，关掉应用才发现没了。
     */
    saveState: persistence.saveState,

    /**
     * 把磁盘上某一条并进列表。
     *
     * 「从引擎存一段进来」是主进程工具直接写包目录的，渲染层这边不知情。
     * 正常路径是上面那个 `library:entry-saved` 监听自动调它，
     * 这里导出来是给测试和「用户手动点刷新」用的。
     */
    mergeEntryFromDisk: async (entryId: string): Promise<boolean> =>
      (await persistence.mergeEntryFromDisk?.(entryId)) ?? false,
    // 状态
    blueprints,
    collections,
    loading,
    category,
    sortType,
    searchQuery,
    typeFilter,
    favoriteOnly,
    galleryViewMode,
    activeBlueprintId,
    activeElementId,
    activeElementType,
    createModalAdvancedExpanded,
    // 计算属性
    filteredBlueprints,
    activeBlueprint,
    engineVersionList,
    // Gallery
    setCategory,
    setSortType,
    setSearchQuery,
    setTypeFilter,
    setFavoriteOnly,
    setGalleryViewMode,
    setEditorTabId,
    copyEditorStateToTabId,
    saveEditorViewState,
    getEditorViewState,
    setActiveBlueprintId,
    // 新建蓝图弹窗设置
    setCreateModalAdvancedExpanded,
    // CRUD
    createBlueprint,
    updateBlueprint,
    deleteBlueprint,
    toggleFavorite,
    // Editor 内部
    setActiveElement,
    addGraph,
    addFunction,
    addVariable,
    addComponent,
    addEventDispatcher,
    addMacro,
    removeElement,
    updateElementCode,
    renameElement,
    // 集合操作
    moveBlueprintsToFolder,
    createFolder,
    createCollection,
    addToCollection,
    removeFromCollection,
    renameCollection,
    deleteCollection,
    getCollectionBlueprints,
    persistState,
    // Mock
    loadMockData
  }
})
