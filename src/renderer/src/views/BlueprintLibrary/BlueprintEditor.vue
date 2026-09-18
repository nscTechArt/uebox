<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch, type Component } from 'vue'
import {
  PhDiamond,
  PhEmpty,
  PhFunction,
  PhGraph,
  PhMagnifyingGlass,
  PhPlaceholder,
  PhShapes
} from '@phosphor-icons/vue'
import LibraryEditorTopbar from '@renderer/views/library-common/components/LibraryEditorTopbar.vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { confirmDialog } from '@renderer/utils/dialog'
import { useBlueprintLibraryStore } from '@renderer/store/modules/blueprintLibraryStore'
import { useLayoutUiStore } from '@renderer/store/modules/layoutUiStore'
import {
  getBlueprintTypeLabel,
  getVariableTypeColor,
  getVariableTypeLabel
} from '@renderer/views/BlueprintLibrary/types/blueprint'
import type {
  BlueprintElementType,
  BlueprintEventDispatcher,
  BlueprintFunction,
  BlueprintGraph,
  BlueprintMacro
} from '@renderer/views/BlueprintLibrary/types/blueprint'
import BlueprintRenderer from '@renderer/views/BlueprintLibrary/BlueprintRenderer.vue'
import SnippetDetail from '@renderer/views/BlueprintLibrary/SnippetDetail.vue'
import { detectSnippetForm } from '@renderer/views/library-common/utils/snippetForm'
import { appExecuteAgent } from '@renderer/views/Assistant/composables/appAgentRunner'
import { ensureSessionWithTitle } from '@renderer/views/Assistant/composables/chatSendPrimitives'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { message } from '@renderer/utils/messageManager'
import LibraryAIPanel from '@renderer/views/library-common/components/LibraryAIPanel.vue'
import type { LibraryChatContext } from '@renderer/views/Assistant/composables/libraryChatContext'
import type { SelectedNodeInfo } from '@renderer/views/BlueprintLibrary/BlueprintRenderer.vue'
import {
  extractVariablesFromCodes,
  extractComponentsFromCodes,
  extractFlowSummaryFromCodes,
  compressBlueprintCode,
  countNodesFromCode,
  extractFunctionSignatureFromCode
} from '@renderer/views/BlueprintLibrary/utils/blueprintCodeParser'
import type {
  ExtractedVariable,
  ExtractedComponent
} from '@renderer/views/BlueprintLibrary/utils/blueprintCodeParser'
import {
  useLibraryEditorShell,
  useLibraryTabTitleSync
} from '@renderer/views/library-common/composables/useLibraryEditorShell'
import type { VariableNodeAccessType } from '@renderer/views/BlueprintLibrary/utils/variableNodeFactory'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const store = useBlueprintLibraryStore()
const layoutUiStore = useLayoutUiStore()

// ========== 编辑器壳（AI 面板 / focus mode / 快捷键 / 侧栏拖宽） ==========
const {
  aiPanelMode,
  isFocusMode,
  isLeftSidebarVisible,
  sidebarWidth,
  toggleFocusMode,
  restoreAiPanel,
  handleAiPanelModeUpdate,
  onSidebarResizeStart: onResizeStart,
  startKeyboardListening: startListening,
  stopKeyboardListening: stopListening
} = useLibraryEditorShell({
  panelModeStorageKey: 'bp-ai-panel-mode',
  sidebarVisibleStorageKey: 'bp-left-sidebar-visible',
  defaultSidebarWidth: 260,
  onEnterFocusMode: () => layoutUiStore.requestSideMenuCollapse()
})

// ========== Keyboard Shortcuts ==========
import { onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue'

const isEditorActive = ref(false)
const currentBlueprintId = ref(typeof route.params.id === 'string' ? route.params.id : '')

function getEditorTabId(): string {
  const tabId = route.query._tab_id
  return typeof tabId === 'string' && tabId.trim() ? tabId : 'default'
}

const { syncTabTitle: syncBlueprintTabTitle } = useLibraryTabTitleSync(() => blueprint.value?.name)

function syncActiveBlueprintStore(): void {
  store.setEditorTabId(getEditorTabId())
  store.setActiveBlueprintId(currentBlueprintId.value || null)
}

function ensureSideMenuCollapsedForFocusMode(): void {
  if (isFocusMode.value) {
    layoutUiStore.requestSideMenuCollapse()
  }
}

onMounted(() => {
  isEditorActive.value = true
  syncActiveBlueprintStore()
  syncBlueprintTabTitle()
  startListening()
  ensureSideMenuCollapsedForFocusMode()
})

onActivated(() => {
  isEditorActive.value = true
  syncActiveBlueprintStore()
  syncBlueprintTabTitle()
  startListening()
  ensureSideMenuCollapsedForFocusMode()
})

onDeactivated(() => {
  isEditorActive.value = false
  stopListening()
})

onBeforeUnmount(() => {
  isEditorActive.value = false
  stopListening()
})

onBeforeRouteLeave(() => {
  flushActiveRendererState()
})

onBeforeRouteUpdate(() => {
  flushActiveRendererState()
})

// ========== 当前蓝图 ==========
const bpId = computed(() => currentBlueprintId.value)
const blueprint = computed(
  () => store.blueprints.find((bp) => bp.id === currentBlueprintId.value) || null
)

/**
 * 片段条目（新形态）的 payload；老条目是 null。
 *
 * 判别规则见 `library-common/utils/snippetForm.ts` —— 缺 `form` 一律按老形态，
 * 因为 2026-08-29 之前的包里根本没有这个字段，判错会让存量条目全打不开。
 */
const snippetPayload = computed(() => {
  const bp = blueprint.value as unknown as Record<string, unknown> | null
  if (!bp) return null
  return detectSnippetForm(bp) === 'snippet' ? bp : null
})

/** 「放进当前工程」跑到哪儿了 */
const applyingSnippet = ref(false)

/**
 * 把这个片段放进当前工程。
 *
 * 走 `appExecuteAgent` 而不是助手页自己的 `executeAgent`：助手页没有 keepAlive，
 * 用户点完按钮很可能就切走了，借它的运行器会跟着页面一起卸载
 * （见 `composables/appAgentRunner.ts` 的文件头）。
 *
 * 为什么绕一圈交给 agent 而不是直接调工具：`blueprint_library_apply` 是
 * `mutating`，审批门挂在 agent 的 `beforeToolCall` 上。直接从渲染层调 IPC
 * 会把那道门整个绕过去 —— 而这是唯一一个会改用户工程的操作。
 *
 * 审批框已经挂到 `MainLayout`（应用级），所以切走页面也看得见。
 */
async function handleApplySnippet(): Promise<void> {
  const bp = blueprint.value
  if (!bp || applyingSnippet.value) return

  applyingSnippet.value = true
  const chatSid = `library-apply-${bp.id}`
  try {
    const prompt = t('snippetDetail.applyPrompt', { name: bp.name, id: bp.id })
    ensureSessionWithTitle(chatSid, prompt, {
      chatStore: useChatSessionsStore(),
      tabsStore: useTabsStore(),
      route,
      unnamedTitle: t('assistant.chatFlow.unnamedSession')
    })
    await appExecuteAgent(prompt, undefined, { chatSid })
  } catch (error) {
    message.error(
      t('snippetDetail.applyFailed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    )
  } finally {
    applyingSnippet.value = false
  }
}

watch(
  () => blueprint.value?.name,
  (newName) => {
    if (newName && isEditorActive.value) {
      syncBlueprintTabTitle()
    }
  },
  { immediate: true }
)

// ========== 扁平 Section 列表（参考 UE5 My Blueprint 面板） ==========
interface SectionDef {
  key: BlueprintElementType
  label: string
  icon: Component
  /** 始终显示（逻辑类），否则仅有元素时显示 */
  alwaysShow: boolean
}

type LogicElementType = Extract<BlueprintElementType, 'graph' | 'function' | 'macro'>
type LogicElement = BlueprintGraph | BlueprintFunction | BlueprintMacro
type BlueprintSidebarElement =
  | BlueprintGraph
  | BlueprintFunction
  | BlueprintMacro
  | BlueprintEventDispatcher
  | ExtractedVariable
  | ExtractedComponent

const sections = computed<SectionDef[]>(() => [
  { key: 'graph', label: t('blueprintEditor.sections.graph'), icon: PhGraph, alwaysShow: true },
  {
    key: 'function',
    label: t('blueprintEditor.sections.function'),
    icon: PhFunction,
    alwaysShow: true
  },
  {
    key: 'variable',
    label: t('blueprintEditor.sections.variable'),
    icon: PhDiamond,
    alwaysShow: true
  },
  {
    key: 'component',
    label: t('blueprintEditor.sections.component'),
    icon: PhShapes,
    alwaysShow: false
  }
])

// ========== 折叠状态 ==========
const collapsedSections = reactive<Record<string, boolean>>({})

function toggleSection(sectionKey: string): void {
  collapsedSections[sectionKey] = !collapsedSections[sectionKey]
}

// ========== 获取分类下的元素列表 ==========
function getElements(type: BlueprintElementType): BlueprintSidebarElement[] {
  if (!blueprint.value) return []
  switch (type) {
    case 'graph':
      return blueprint.value.graphs
    case 'function':
      return blueprint.value.functions
    case 'variable':
      return extractedVariables.value
    case 'component':
      return extractedComponents.value
    case 'eventDispatcher':
      return blueprint.value.eventDispatchers
    case 'macro':
      return blueprint.value.macros
    default:
      return []
  }
}

// ========== 左侧面板搜索与过滤 ==========
const sidebarSearchQuery = ref('')
const sidebarFilter = ref<'all' | 'graphs' | 'used_vars' | 'unused_vars'>('all')

const isFiltering = computed(() => !!sidebarSearchQuery.value || sidebarFilter.value !== 'all')

function matchSearch(el: BlueprintSidebarElement): boolean {
  if (!sidebarSearchQuery.value) return true
  const q = sidebarSearchQuery.value.toLowerCase()
  return (el.name || '').toLowerCase().includes(q)
}

function getFilteredElements(type: BlueprintElementType): BlueprintSidebarElement[] {
  let list = getElements(type)

  if (sidebarFilter.value === 'graphs') {
    if (type !== 'graph') return []
  } else if (sidebarFilter.value === 'used_vars') {
    if (type !== 'variable') return []
    list = usedVariables.value
  } else if (sidebarFilter.value === 'unused_vars') {
    if (type !== 'variable') return []
    list = unusedVariables.value
  }

  if (sidebarSearchQuery.value) {
    list = list.filter((el) => matchSearch(el))
  }

  return list
}

function clearFilters(): void {
  sidebarSearchQuery.value = ''
  sidebarFilter.value = 'all'
}

// ========== 变量按当前图表使用情况分组 ==========
/** 判断变量是否在当前活跃图表/函数中被引用 */
function isVarUsedInActiveGraph(varName: string): boolean {
  if (!activeLogicId.value || !activeLogicType.value || !blueprint.value) return false
  let code = ''
  if (activeLogicType.value === 'graph') {
    const g = blueprint.value.graphs.find((g) => g.id === activeLogicId.value)
    if (g) code = g.code
  } else if (activeLogicType.value === 'function') {
    const f = blueprint.value.functions.find((f) => f.id === activeLogicId.value)
    if (f) code = f.code
  } else if (activeLogicType.value === 'macro') {
    const m = blueprint.value.macros.find((m) => m.id === activeLogicId.value)
    if (m) code = m.code
  }
  return !!code && code.includes(`MemberName="${varName}"`)
}

/** 当前图表中使用的变量 */
const usedVariables = computed(() =>
  extractedVariables.value.filter((v) => isVarUsedInActiveGraph(v.name))
)

/** 当前图表中未使用的变量 */
const unusedVariables = computed(() =>
  extractedVariables.value.filter((v) => !isVarUsedInActiveGraph(v.name))
)

// 仅当 alwaysShow 或有元素时展示该 section
function getVisibleSections(): SectionDef[] {
  if (isFiltering.value) {
    return sections.value.filter((sec) => getFilteredElements(sec.key).length > 0)
  }
  return sections.value.filter((sec) => sec.alwaysShow || getElements(sec.key).length > 0)
}

// ========== 从蓝图代码中动态提取变量和组件 ==========
const allCodes = computed(() => {
  if (!blueprint.value) return []
  const codes: string[] = []
  for (const g of blueprint.value.graphs) {
    if (g.code) codes.push(g.code)
  }
  for (const f of blueprint.value.functions) {
    if (f.code) codes.push(f.code)
  }
  for (const m of blueprint.value.macros) {
    if (m.code) codes.push(m.code)
  }
  return codes
})

const extractedVariables = computed(() => {
  const extracted = extractVariablesFromCodes(allCodes.value)
  const merged = new Map<string, ExtractedVariable>()

  for (const variable of blueprint.value?.variables ?? []) {
    merged.set(variable.name, {
      id: variable.id,
      name: variable.name,
      type: variable.type,
      defaultValue: variable.defaultValue
    })
  }

  for (const variable of extracted) {
    const existing = merged.get(variable.name)
    merged.set(variable.name, {
      id: existing?.id ?? variable.id,
      name: variable.name,
      type: existing?.type ?? variable.type,
      defaultValue: existing?.defaultValue ?? variable.defaultValue,
      containerType: variable.containerType,
      subType: variable.subType
    })
  }

  return Array.from(merged.values())
})
const extractedComponents = computed(() => extractComponentsFromCodes(allCodes.value))

// ========== 逻辑类型 vs 数据类型 ==========
function isLogicType(type: BlueprintElementType): type is LogicElementType {
  return type === 'graph' || type === 'function' || type === 'macro'
}

// ========== 选中元素 ==========
// 当前选中的逻辑元素（驱动中央图表区）
const activeLogicId = ref<string | null>(null)
const activeLogicType = ref<LogicElementType | null>(null)
const rendererRef = ref<InstanceType<typeof BlueprintRenderer> | null>(null)
const selectedNodesSnapshot = ref<SelectedNodeInfo[]>([])

function flushActiveRendererState(): void {
  rendererRef.value?.flushSerializedCode?.()
}

function getLogicElements(type: LogicElementType): LogicElement[] {
  if (!blueprint.value) return []

  switch (type) {
    case 'graph':
      return blueprint.value.graphs
    case 'function':
      return blueprint.value.functions
    case 'macro':
      return blueprint.value.macros
  }
}

function resolveLogicElement(
  id: string | null,
  type: BlueprintElementType | null
): LogicElement | null {
  if (!id || !type || !isLogicType(type) || !blueprint.value) return null
  return getLogicElements(type).find((el) => el.id === id) || null
}

function getDefaultLogicSelection(): { id: string; type: LogicElementType } | null {
  const bp = blueprint.value
  if (!bp) return null

  const defaultGraph = bp.graphs.find((graph) => graph.type === 'event') || bp.graphs[0]
  if (defaultGraph) {
    return { id: defaultGraph.id, type: 'graph' }
  }

  if (bp.functions[0]) {
    return { id: bp.functions[0].id, type: 'function' }
  }

  if (bp.macros[0]) {
    return { id: bp.macros[0].id, type: 'macro' }
  }

  return null
}

function ensureActiveLogicSelection(): void {
  if (resolveLogicElement(activeLogicId.value, activeLogicType.value)) return

  const fallbackSelection = getDefaultLogicSelection()
  if (fallbackSelection) {
    activeLogicId.value = fallbackSelection.id
    activeLogicType.value = fallbackSelection.type
    store.setActiveElement(fallbackSelection.id, fallbackSelection.type)
    return
  }

  activeLogicId.value = null
  activeLogicType.value = null
}

const logicAvailabilityKey = computed(() => {
  const bp = blueprint.value
  if (!bp) return 'no-blueprint'

  return [
    bp.id,
    bp.graphs.map((graph) => `${graph.id}:${graph.type}`).join(','),
    bp.functions.map((fn) => fn.id).join(','),
    bp.macros.map((macro) => macro.id).join(',')
  ].join('|')
})

watch(
  logicAvailabilityKey,
  () => {
    ensureActiveLogicSelection()
  },
  { immediate: true }
)

function selectElement(id: string, type: BlueprintElementType): void {
  const isSwitchingLogicTarget =
    isLogicType(type) && (id !== activeLogicId.value || type !== activeLogicType.value)
  if (isSwitchingLogicTarget) {
    flushActiveRendererState()
  }
  store.setActiveElement(id, type)
  // 只有逻辑类型才切换中央内容区
  if (isLogicType(type)) {
    activeLogicId.value = id
    activeLogicType.value = type
  }
}

function isActive(id: string): boolean {
  return store.activeElementId === id
}

// ========== 中央图表区当前元素（只显示逻辑元素）==========
const activeLogicDetail = computed(() => {
  if (!blueprint.value || !activeLogicId.value || !activeLogicType.value) return null
  return getLogicElements(activeLogicType.value).find((el) => el.id === activeLogicId.value) || null
})

// 精简蓝图摘要（传给 AI 面板，节省 token 同时保留关键信息）
const blueprintSummary = computed(() => {
  const bp = blueprint.value
  if (!bp) return ''
  const lines: string[] = []
  lines.push(`蓝图: ${bp.name} (${bp.blueprintType}, UE${bp.engineVersion})`)
  if (bp.description) lines.push(`描述: ${bp.description}`)

  // 图表（含类型和描述）
  if (bp.graphs.length) {
    lines.push(`图表(${bp.graphs.length}):`)
    bp.graphs.forEach((g) => {
      const desc = g.description ? ` - ${g.description}` : ''
      const nc = countNodesFromCode(g.code)
      lines.push(`  ${g.name} [${g.type}] (${nc}节点)${desc}`)
    })
  }

  // 函数签名（含描述和节点数）
  if (bp.functions.length) {
    lines.push(`函数(${bp.functions.length}):`)
    bp.functions.forEach((f) => {
      const ins = f.inputs.map((p) => `${p.name}:${p.type}`).join(', ')
      const outs = f.outputs.map((p) => `${p.name}:${p.type}`).join(', ')
      const nc = countNodesFromCode(f.code)
      const sig = `  ${f.access} ${f.isPure ? 'pure ' : ''}${f.name}(${ins})→(${outs}) (${nc}节点)`
      lines.push(f.description ? `${sig} - ${f.description}` : sig)
    })
  }

  // 变量（含类型和默认值）
  if (extractedVariables.value.length) {
    const vars = extractedVariables.value
      .map((v: ExtractedVariable) => `${v.name}:${v.type}`)
      .join(', ')
    lines.push(`变量(${extractedVariables.value.length}): ${vars}`)
  }

  // 组件
  if (extractedComponents.value.length) {
    const comps = extractedComponents.value
      .map((c: ExtractedComponent) => `${c.name}(${c.componentClass})`)
      .join(', ')
    lines.push(`组件(${extractedComponents.value.length}): ${comps}`)
  }

  // 事件分发器
  if (bp.eventDispatchers.length) {
    const eds = bp.eventDispatchers.map((ed) => {
      const params = ed.params.map((p) => `${p.name}:${p.type}`).join(', ')
      return params ? `${ed.name}(${params})` : ed.name
    })
    lines.push(`事件分发器(${bp.eventDispatchers.length}): ${eds.join(', ')}`)
  }

  // 宏
  if (bp.macros.length) {
    lines.push(`宏(${bp.macros.length}): ${bp.macros.map((m) => m.name).join(', ')}`)
  }

  // 执行流摘要（从代码中提取节点连接关系）
  const codePairs = [
    ...bp.graphs.map((g) => ({ name: g.name, code: g.code })),
    ...bp.functions.map((f) => ({ name: f.name, code: f.code })),
    ...bp.macros.map((m) => ({ name: m.name, code: m.code }))
  ].filter((c) => c.code)
  if (codePairs.length) {
    const flow = extractFlowSummaryFromCodes(codePairs)
    if (flow) {
      lines.push(`\n执行流:`)
      lines.push(flow)
    }
  }

  // 当前选中元素（代码经压缩去噪后传给 AI）
  const detail = activeLogicDetail.value as Record<string, unknown> | null
  if (detail) {
    lines.push(`\n======== 当前查看: ${activeLogicType.value} "${detail.name}" ========`)
    if (detail.description) lines.push(`说明: ${detail.description as string}`)
    if (detail.code) {
      lines.push(`代码(已压缩):\n${compressBlueprintCode(detail.code as string)}`)
    }
  }

  return lines.join('\n')
})

// ========== 选中快照 ==========
/**
 * AI 聊天面板 mousedown 时调用，快照当前选中节点信息用于 AI 上下文。
 * 选中状态的保持由 BlueprintRenderer 中的 patchSetFocused 补丁保证。
 */
function handleSnapshotSelection(): void {
  const renderer = rendererRef.value
  if (!renderer) return
  selectedNodesSnapshot.value = renderer.getSelectedNodesInfo()
}

/** 每个选中节点最多往上下文里塞多少字符。整段节点文本能有好几千 */
const SELECTED_NODE_CODE_LIMIT = 2000

/**
 * 交给助手的「用户正在看什么」。
 *
 * 这是个 computed，助手每一轮请求前读一次 —— 所以用户点了别的节点，
 * 下一轮带的就是新的那几个，不会一轮一轮累积。
 */
const libraryChatContext = computed<LibraryChatContext | null>(() => {
  const bp = blueprint.value
  if (!bp) return null

  return {
    library: 'blueprint',
    entryId: bp.id,
    entryName: bp.name,
    overview: blueprintSummary.value,
    selectedNodes: selectedNodesSnapshot.value.map((node) => ({
      label: node.displayName,
      code: node.serializedText
        ? compressBlueprintCode(node.serializedText).slice(0, SELECTED_NODE_CODE_LIMIT)
        : undefined
    }))
  }
})

// ========== 操作 ==========
function goBack(): void {
  flushActiveRendererState()
  store.setActiveElement(null, null)
  router.push({ name: 'BlueprintGallery' })
}

function handleFavorite(): void {
  if (bpId.value) store.toggleFavorite(bpId.value)
}

function handleAddElement(type: BlueprintElementType): void {
  if (!bpId.value) return
  const bp = blueprint.value
  if (!bp) return
  switch (type) {
    case 'graph': {
      const n = bp.graphs.length + 1
      store.addGraph(bpId.value, {
        name: t('blueprintEditor.defaultNames.graph', { n }),
        type: 'custom',
        code: '',
        nodeCount: 0,
        description: ''
      })
      break
    }
    case 'function': {
      const n = bp.functions.length + 1
      store.addFunction(bpId.value, {
        name: t('blueprintEditor.defaultNames.function', { n }),
        inputs: [],
        outputs: [],
        code: '',
        description: '',
        isPure: false,
        access: 'public'
      })
      break
    }
    case 'variable': {
      const n = bp.variables.length + 1
      store.addVariable(bpId.value, {
        name: t('blueprintEditor.defaultNames.variable', { n }),
        type: 'Boolean',
        defaultValue: 'false',
        isEditable: true,
        isBlueprintReadOnly: false,
        isExposedOnSpawn: false,
        category: '',
        description: '',
        replication: 'none'
      })
      break
    }
    case 'component': {
      const n = bp.components.length + 1
      store.addComponent(bpId.value, {
        name: t('blueprintEditor.defaultNames.component', { n }),
        componentClass: 'SceneComponent',
        isRoot: false,
        isInherited: false,
        description: ''
      })
      break
    }
    case 'eventDispatcher': {
      const n = bp.eventDispatchers.length + 1
      store.addEventDispatcher(bpId.value, {
        name: t('blueprintEditor.defaultNames.eventDispatcher', { n }),
        params: [],
        description: ''
      })
      break
    }
    case 'macro': {
      const n = bp.macros.length + 1
      store.addMacro(bpId.value, {
        name: t('blueprintEditor.defaultNames.macro', { n }),
        inputs: [],
        outputs: [],
        code: '',
        description: ''
      })
      break
    }
  }
}

function getElementTypeLabel(type: BlueprintElementType): string {
  const labels: Record<BlueprintElementType, string> = {
    graph: t('blueprintEditor.sections.graph'),
    function: t('blueprintEditor.sections.function'),
    variable: t('blueprintEditor.sections.variable'),
    component: t('blueprintEditor.sections.component'),
    eventDispatcher: t('blueprintEditor.sections.eventDispatcher'),
    macro: t('blueprintEditor.sections.macro')
  }
  return labels[type] || t('blueprintEditor.sections.element')
}

function handleDeleteElement(id: string, type: BlueprintElementType): void {
  const target = getElements(type).find((el) => el.id === id)
  const targetName = target?.name || getElementTypeLabel(type)
  confirmDialog({
    title: t('blueprintEditor.deleteConfirm.title', { type: getElementTypeLabel(type) }),
    content: t('blueprintEditor.deleteConfirm.content', { name: targetName }),
    okText: t('blueprintEditor.deleteConfirm.okText'),
    danger: true,
    cancelText: t('blueprintEditor.deleteConfirm.cancelText'),
    centered: true,
    onOk: () => {
      if (bpId.value) store.removeElement(bpId.value, id, type)
    }
  })
}

// ========== F2 重命名 ==========
const renamingId = ref<string | null>(null)
const renamingType = ref<BlueprintElementType | null>(null)
const renameText = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

function startRename(id: string, type: BlueprintElementType, currentName: string): void {
  renamingId.value = id
  renamingType.value = type
  renameText.value = currentName
  nextTick(() => {
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  })
}

function commitRename(): void {
  if (renamingId.value && renamingType.value && renameText.value.trim()) {
    store.renameElement(bpId.value, renamingId.value, renamingType.value, renameText.value)
  }
  cancelRename()
}

function cancelRename(): void {
  renamingId.value = null
  renamingType.value = null
  renameText.value = ''
}

function handleTreeItemKeydown(
  e: KeyboardEvent,
  id: string,
  type: BlueprintElementType,
  name: string
): void {
  if (e.key === 'F2') {
    e.preventDefault()
    startRename(id, type, name)
  }
}

// ========== 变量 Tooltip ==========
const hoveredVar = ref<ExtractedVariable | null>(null)
const tooltipPos = reactive({ x: 0, y: 0 })
let tooltipTimer: ReturnType<typeof setTimeout> | null = null

function showVarTooltip(ev: MouseEvent, v: ExtractedVariable): void {
  if (tooltipTimer) clearTimeout(tooltipTimer)
  const target = ev.currentTarget as HTMLElement
  tooltipTimer = setTimeout(() => {
    hoveredVar.value = v
    const rect = target.getBoundingClientRect()
    tooltipPos.x = rect.right + 8
    tooltipPos.y = rect.top
  }, 350)
}

function hideVarTooltip(): void {
  if (tooltipTimer) {
    clearTimeout(tooltipTimer)
    tooltipTimer = null
  }
  hoveredVar.value = null
}

/** 查找变量出现在哪些图表/函数中 */
function getVarUsageLocations(varName: string): string[] {
  if (!blueprint.value) return []
  const locations: string[] = []
  for (const g of blueprint.value.graphs) {
    if (g.code && g.code.includes(`MemberName="${varName}"`)) {
      locations.push(g.name)
    }
  }
  for (const f of blueprint.value.functions) {
    if (f.code && f.code.includes(`MemberName="${varName}"`)) {
      locations.push(f.name)
    }
  }
  return locations
}

/** 点击变量时聚焦到对应节点（多个时循环切换） */
function handleVariableClick(varName: string): void {
  const renderer = rendererRef.value
  if (!renderer) return
  renderer.focusOnVariableNode(varName)
}

/**
 * 变量树节点点击：选中 + 聚焦画布节点。
 *
 * 抽成函数而不是在模板里写两条语句 —— Vue 内联事件的多语句必须用分号分隔，
 * 而 prettier 会把行尾分号删掉，导致模板编译直接报 SyntaxError。
 */
function handleVariableTreeItemClick(id: string, type: BlueprintElementType, name: string): void {
  selectElement(id, type)
  handleVariableClick(name)
}

// ========== Variable drag to canvas ==========
const VARIABLE_DRAG_MIME = 'application/x-blueprint-variable'

interface DraggedVariablePayload {
  id: string
  name: string
  type: string
  defaultValue?: string
  containerType?: ExtractedVariable['containerType']
  subType?: string
}

interface DraggedFunctionPayload {
  id: string
  name: string
  inputs: BlueprintFunction['inputs']
  outputs: BlueprintFunction['outputs']
  isPure: boolean
}

type DraggedCanvasPayload =
  | { kind: 'variable'; data: DraggedVariablePayload }
  | { kind: 'function'; data: DraggedFunctionPayload }

const isCanvasDropActive = ref(false)
const dragAccessType = ref<VariableNodeAccessType>('get')
const dragOverDepth = ref(0)
const draggedCanvasPayload = ref<DraggedCanvasPayload | null>(null)
const FUNCTION_DRAG_MIME = 'application/x-blueprint-function'

function getVariableDragHintText(): string {
  if (draggedCanvasPayload.value?.kind === 'function') {
    return t('blueprintEditor.dragHint.dropForFunctionCall')
  }
  return dragAccessType.value === 'set'
    ? t('blueprintEditor.dragHint.dropForSet')
    : t('blueprintEditor.dragHint.dropForGet')
}

function getVariableDragSubtitle(): string {
  if (draggedCanvasPayload.value?.kind === 'function') {
    return t('blueprintEditor.dragHint.functionCallSubtitle')
  }
  return dragAccessType.value === 'set'
    ? t('blueprintEditor.dragHint.shiftForSetSubtitle')
    : t('blueprintEditor.dragHint.shiftToSetSubtitle')
}

function createDraggedVariablePayload(variable: ExtractedVariable): DraggedVariablePayload {
  return {
    id: variable.id,
    name: variable.name,
    type: variable.type,
    defaultValue: variable.defaultValue,
    containerType: variable.containerType,
    subType: variable.subType
  }
}

function readDraggedVariablePayload(event: DragEvent): DraggedVariablePayload | null {
  const raw = event.dataTransfer?.getData(VARIABLE_DRAG_MIME)
  if (!raw) {
    return draggedCanvasPayload.value?.kind === 'variable' ? draggedCanvasPayload.value.data : null
  }

  try {
    return JSON.parse(raw) as DraggedVariablePayload
  } catch {
    return draggedCanvasPayload.value?.kind === 'variable' ? draggedCanvasPayload.value.data : null
  }
}

function createDraggedFunctionPayload(fn: BlueprintFunction): DraggedFunctionPayload {
  const signature = extractFunctionSignatureFromCode(fn.code)
  return {
    id: fn.id,
    name: fn.name,
    inputs: signature.inputs.length > 0 ? signature.inputs : fn.inputs,
    outputs: signature.outputs.length > 0 ? signature.outputs : fn.outputs,
    isPure: fn.isPure
  }
}

function readDraggedFunctionPayload(event: DragEvent): DraggedFunctionPayload | null {
  const raw = event.dataTransfer?.getData(FUNCTION_DRAG_MIME)
  if (!raw) {
    return draggedCanvasPayload.value?.kind === 'function' ? draggedCanvasPayload.value.data : null
  }

  try {
    return JSON.parse(raw) as DraggedFunctionPayload
  } catch {
    return draggedCanvasPayload.value?.kind === 'function' ? draggedCanvasPayload.value.data : null
  }
}

function clearCanvasDragState(): void {
  draggedCanvasPayload.value = null
  isCanvasDropActive.value = false
  dragAccessType.value = 'get'
  dragOverDepth.value = 0
}

function handleVariableDragStart(event: DragEvent, variable: ExtractedVariable): void {
  if (!activeLogicDetail.value) {
    event.preventDefault()
    return
  }

  const payload = createDraggedVariablePayload(variable)
  draggedCanvasPayload.value = { kind: 'variable', data: payload }
  dragAccessType.value = event.shiftKey ? 'set' : 'get'

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(VARIABLE_DRAG_MIME, JSON.stringify(payload))
    event.dataTransfer.setData('text/plain', variable.name)
  }
}

function handleFunctionDragStart(event: DragEvent, fn: BlueprintFunction): void {
  if (!activeLogicDetail.value) {
    event.preventDefault()
    return
  }

  const payload = createDraggedFunctionPayload(fn)
  draggedCanvasPayload.value = { kind: 'function', data: payload }

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(FUNCTION_DRAG_MIME, JSON.stringify(payload))
    event.dataTransfer.setData('text/plain', fn.name)
  }
}

function handleSidebarItemDragStart(
  event: DragEvent,
  element: BlueprintSidebarElement,
  type: BlueprintElementType
): void {
  if (type === 'variable') {
    handleVariableDragStart(event, element as ExtractedVariable)
    return
  }

  if (type === 'function') {
    handleFunctionDragStart(event, element as BlueprintFunction)
    return
  }

  event.preventDefault()
}

function handleCanvasItemDragEnd(): void {
  clearCanvasDragState()
}

function updateCanvasDragState(event: DragEvent): void {
  if (draggedCanvasPayload.value?.kind === 'variable') {
    dragAccessType.value = event.shiftKey ? 'set' : 'get'
  }
  isCanvasDropActive.value = true
}

function handleCanvasDragEnter(event: DragEvent): void {
  const hasSupportedType =
    event.dataTransfer?.types.includes(VARIABLE_DRAG_MIME) ||
    event.dataTransfer?.types.includes(FUNCTION_DRAG_MIME)
  if (!hasSupportedType || !activeLogicDetail.value) return
  event.preventDefault()
  dragOverDepth.value += 1
  updateCanvasDragState(event)
}

function handleCanvasDragOver(event: DragEvent): void {
  const dataTransfer = event.dataTransfer
  const hasSupportedType =
    dataTransfer?.types.includes(VARIABLE_DRAG_MIME) ||
    dataTransfer?.types.includes(FUNCTION_DRAG_MIME)
  if (!hasSupportedType || !activeLogicDetail.value) return
  event.preventDefault()
  if (!dataTransfer) return
  dataTransfer.dropEffect = 'copy'
  updateCanvasDragState(event)
}

function handleCanvasDragLeave(event: DragEvent): void {
  const hasSupportedType =
    event.dataTransfer?.types.includes(VARIABLE_DRAG_MIME) ||
    event.dataTransfer?.types.includes(FUNCTION_DRAG_MIME)
  if (!hasSupportedType) return
  dragOverDepth.value = Math.max(0, dragOverDepth.value - 1)
  if (dragOverDepth.value === 0) {
    isCanvasDropActive.value = false
  }
}

function handleCanvasDrop(event: DragEvent): void {
  if (!activeLogicDetail.value) return
  event.preventDefault()
  const renderer = rendererRef.value
  let inserted = false

  const variablePayload = readDraggedVariablePayload(event)
  if (variablePayload) {
    inserted =
      renderer?.insertVariableNode({
        variable: variablePayload,
        accessType: event.shiftKey ? 'set' : 'get',
        clientX: event.clientX,
        clientY: event.clientY
      }) ?? false
  } else {
    const functionPayload = readDraggedFunctionPayload(event)
    if (functionPayload) {
      inserted =
        renderer?.insertFunctionNode({
          fn: functionPayload,
          clientX: event.clientX,
          clientY: event.clientY
        }) ?? false
    }
  }

  if (inserted) {
    selectElement(activeLogicId.value!, activeLogicType.value!)
  }

  clearCanvasDragState()
}
</script>

<template>
  <!--
    片段条目走摘要视图，不进下面这套仿 UE 编辑器。

    两种 payload 在库里共存，存的其实是同一种文本（都是 T3D），但下面整套界面
    读的是 `bp.graphs / bp.functions / bp.macros` —— 片段条目一个都没有，
    所以必须在这里分流，不能靠往下走再逐个判空。
  -->
  <SnippetDetail
    v-if="snippetPayload"
    :name="blueprint?.name ?? ''"
    :payload="snippetPayload"
    :applying="applyingSnippet"
    :entry-id="bpId"
    :ai-panel-mode="aiPanelMode"
    @back="goBack"
    @apply="handleApplySnippet"
    @update:ai-panel-mode="handleAiPanelModeUpdate"
    @restore-ai-panel="restoreAiPanel"
  />

  <div v-else-if="blueprint" class="bp-editor-page">
    <!-- Top Bar -->
    <LibraryEditorTopbar
      :back-label="t('blueprintEditor.topbar.back')"
      :name="blueprint.name"
      :subtitle="blueprint.description"
      @back="goBack"
    >
      <template #chips>
        <span class="topbar-chip">{{ getBlueprintTypeLabel(blueprint.blueprintType) }}</span>
        <span class="topbar-chip">UE {{ blueprint.engineVersion }}</span>
      </template>

      <template #actions>
        <button
          type="button"
          class="topbar-action focus-btn"
          :class="{ active: isFocusMode }"
          :title="t('blueprintEditor.topbar.focusModeTitle')"
          @click.stop.prevent="toggleFocusMode"
        >
          <template v-if="isFocusMode">
            <svg
              style="pointer-events: none"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
            <span style="pointer-events: none">{{ t('blueprintEditor.topbar.exitFocus') }}</span>
          </template>
          <template v-else>
            <svg
              style="pointer-events: none"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
            <span style="pointer-events: none">{{ t('blueprintEditor.topbar.focusMode') }}</span>
          </template>
        </button>
        <button
          class="topbar-action"
          :class="{ 'is-favorite': blueprint.isFavorite }"
          @click="handleFavorite"
        >
          {{
            blueprint.isFavorite
              ? t('blueprintEditor.topbar.favorited')
              : t('blueprintEditor.topbar.favorite')
          }}
        </button>
      </template>
    </LibraryEditorTopbar>

    <!-- 三栏布局 -->
    <div class="editor-body">
      <!-- 左侧：My Blueprint 树（扁平，参考 UE5） -->
      <div v-if="isLeftSidebarVisible" class="sidebar-left" :style="{ width: sidebarWidth + 'px' }">
        <div class="sidebar-title">
          <span>{{ t('blueprintEditor.sidebar.myBlueprint') }}</span>
          <button
            class="icon-btn collapse-btn"
            :title="t('blueprintEditor.sidebar.collapsePanel')"
            @click="isLeftSidebarVisible = false"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <rect x="3" y="3" width="18" height="18" rx="2"></rect>
              <path d="M9 3v18"></path>
            </svg>
          </button>
        </div>

        <div class="sidebar-filters">
          <div class="search-box">
            <PhMagnifyingGlass class="search-icon" :size="14" aria-hidden="true" />
            <input
              v-model="sidebarSearchQuery"
              class="search-input"
              :placeholder="t('blueprintEditor.sidebar.searchPlaceholder')"
            />
            <button
              v-show="sidebarSearchQuery"
              class="clear-search"
              @click="sidebarSearchQuery = ''"
            >
              ×
            </button>
          </div>
          <div class="filter-tags">
            <span
              class="filter-tag"
              :class="{ active: sidebarFilter === 'all' }"
              @click="sidebarFilter = 'all'"
              >{{ t('blueprintEditor.sidebar.filterAll') }}</span
            >
            <span
              class="filter-tag"
              :class="{ active: sidebarFilter === 'graphs' }"
              @click="sidebarFilter = 'graphs'"
              >{{ t('blueprintEditor.sidebar.filterGraphs') }}</span
            >
            <span
              class="filter-tag"
              :class="{ active: sidebarFilter === 'used_vars' }"
              @click="sidebarFilter = 'used_vars'"
              >{{ t('blueprintEditor.sidebar.filterUsedVars') }}</span
            >
            <span
              class="filter-tag"
              :class="{ active: sidebarFilter === 'unused_vars' }"
              @click="sidebarFilter = 'unused_vars'"
              >{{ t('blueprintEditor.sidebar.filterUnusedVars') }}</span
            >
          </div>
        </div>

        <div v-if="isFiltering && getVisibleSections().length === 0" class="filter-empty">
          <PhEmpty class="fe-icon" :size="24" aria-hidden="true" />
          <div class="fe-text">{{ t('blueprintEditor.sidebar.noMatches') }}</div>
          <button class="fe-btn" @click="clearFilters">
            {{ t('blueprintEditor.sidebar.clearFilters') }}
          </button>
        </div>

        <div v-for="sec in getVisibleSections()" :key="sec.key" class="tree-section">
          <div class="section-header" @click="toggleSection(sec.key)">
            <span class="section-arrow" :class="{ collapsed: collapsedSections[sec.key] }">▾</span>
            <component :is="sec.icon" class="section-icon" :size="14" aria-hidden="true" />
            <span class="section-label">{{ sec.label }}</span>
            <span v-if="getFilteredElements(sec.key).length > 0" class="section-count">{{
              getFilteredElements(sec.key).length
            }}</span>
            <button
              class="add-btn"
              :title="t('blueprintEditor.sidebar.add')"
              @click.stop="handleAddElement(sec.key)"
            >
              ＋
            </button>
          </div>
          <div v-show="!collapsedSections[sec.key]" class="section-items">
            <!-- 变量分组：已使用 / 分割线 / 未使用 -->
            <template v-if="sec.key === 'variable' && activeLogicId && !isFiltering">
              <div
                v-for="el in usedVariables"
                :key="(el as any).id"
                class="tree-item"
                :class="{ active: isActive((el as any).id) }"
                tabindex="0"
                draggable="true"
                :title="t('blueprintEditor.dragHint.treeItemVariable')"
                @click="handleVariableTreeItemClick((el as any).id, sec.key, (el as any).name)"
                @keydown="handleTreeItemKeydown($event, (el as any).id, sec.key, (el as any).name)"
                @dragstart="handleVariableDragStart($event, el as ExtractedVariable)"
                @dragend="handleCanvasItemDragEnd"
                @mouseenter="showVarTooltip($event, el as ExtractedVariable)"
                @mouseleave="hideVarTooltip()"
              >
                <input
                  v-if="renamingId === (el as any).id"
                  ref="renameInputRef"
                  v-model="renameText"
                  class="rename-input"
                  @blur="commitRename"
                  @keydown.enter.prevent="commitRename"
                  @keydown.escape.prevent="cancelRename"
                  @click.stop
                />
                <span
                  v-else
                  class="item-name"
                  draggable="true"
                  @click.stop="
                    handleVariableTreeItemClick((el as any).id, sec.key, (el as any).name)
                  "
                  @dragstart.stop="handleVariableDragStart($event, el as ExtractedVariable)"
                  @dragend.stop="handleCanvasItemDragEnd"
                  @dblclick.stop="startRename((el as any).id, sec.key, (el as any).name)"
                  >{{ (el as any).name }}</span
                >
                <span
                  class="var-type-group"
                  draggable="true"
                  @dragstart.stop="handleVariableDragStart($event, el as ExtractedVariable)"
                  @dragend.stop="handleCanvasItemDragEnd"
                >
                  <span
                    class="var-dot"
                    :style="{ background: getVariableTypeColor((el as any).type) }"
                  />
                  <span class="var-type-text">{{
                    getVariableTypeLabel(
                      (el as any).type,
                      (el as any).containerType,
                      (el as any).subType
                    )
                  }}</span>
                </span>
              </div>
              <!-- 分割线 -->
              <div
                v-if="unusedVariables.length > 0 && usedVariables.length > 0"
                class="var-divider"
              >
                <span class="var-divider-line" />
                <span class="var-divider-label">{{
                  t('blueprintEditor.sidebar.notUsedInGraph')
                }}</span>
                <span class="var-divider-line" />
              </div>
              <div
                v-for="el in unusedVariables"
                :key="(el as any).id"
                class="tree-item tree-item--unused"
                :class="{ active: isActive((el as any).id) }"
                tabindex="0"
                draggable="true"
                :title="t('blueprintEditor.dragHint.treeItemVariable')"
                @click="handleVariableTreeItemClick((el as any).id, sec.key, (el as any).name)"
                @keydown="handleTreeItemKeydown($event, (el as any).id, sec.key, (el as any).name)"
                @dragstart="handleVariableDragStart($event, el as ExtractedVariable)"
                @dragend="handleCanvasItemDragEnd"
                @mouseenter="showVarTooltip($event, el as ExtractedVariable)"
                @mouseleave="hideVarTooltip()"
              >
                <input
                  v-if="renamingId === (el as any).id"
                  ref="renameInputRef"
                  v-model="renameText"
                  class="rename-input"
                  @blur="commitRename"
                  @keydown.enter.prevent="commitRename"
                  @keydown.escape.prevent="cancelRename"
                  @click.stop
                />
                <span
                  v-else
                  class="item-name"
                  draggable="true"
                  @click.stop="
                    handleVariableTreeItemClick((el as any).id, sec.key, (el as any).name)
                  "
                  @dragstart.stop="handleVariableDragStart($event, el as ExtractedVariable)"
                  @dragend.stop="handleCanvasItemDragEnd"
                  @dblclick.stop="startRename((el as any).id, sec.key, (el as any).name)"
                  >{{ (el as any).name }}</span
                >
                <span
                  class="var-type-group"
                  draggable="true"
                  @dragstart.stop="handleVariableDragStart($event, el as ExtractedVariable)"
                  @dragend.stop="handleCanvasItemDragEnd"
                >
                  <span
                    class="var-dot"
                    :style="{ background: getVariableTypeColor((el as any).type) }"
                  />
                  <span class="var-type-text">{{
                    getVariableTypeLabel(
                      (el as any).type,
                      (el as any).containerType,
                      (el as any).subType
                    )
                  }}</span>
                </span>
              </div>
            </template>
            <!-- 非变量元素或未选中图表时：原逻辑 -->
            <template v-else>
              <div
                v-for="el in getFilteredElements(sec.key)"
                :key="(el as any).id"
                class="tree-item"
                :class="{ active: isActive((el as any).id) }"
                tabindex="0"
                :draggable="sec.key === 'variable' || sec.key === 'function'"
                :title="
                  sec.key === 'variable'
                    ? t('blueprintEditor.dragHint.treeItemVariable')
                    : sec.key === 'function'
                      ? t('blueprintEditor.dragHint.treeItemFunction')
                      : undefined
                "
                @click="selectElement((el as any).id, sec.key)"
                @keydown="handleTreeItemKeydown($event, (el as any).id, sec.key, (el as any).name)"
                @dragstart="
                  handleSidebarItemDragStart($event, el as BlueprintSidebarElement, sec.key)
                "
                @dragend="
                  (sec.key === 'variable' || sec.key === 'function') && handleCanvasItemDragEnd()
                "
                @mouseenter="
                  sec.key === 'variable' && showVarTooltip($event, el as ExtractedVariable)
                "
                @mouseleave="sec.key === 'variable' && hideVarTooltip()"
              >
                <input
                  v-if="renamingId === (el as any).id"
                  ref="renameInputRef"
                  v-model="renameText"
                  class="rename-input"
                  @blur="commitRename"
                  @keydown.enter.prevent="commitRename"
                  @keydown.escape.prevent="cancelRename"
                  @click.stop
                />
                <span
                  v-else
                  class="item-name"
                  :draggable="sec.key === 'variable' || sec.key === 'function'"
                  @click.stop="selectElement((el as any).id, sec.key)"
                  @dragstart.stop="
                    (sec.key === 'variable' || sec.key === 'function') &&
                    handleSidebarItemDragStart($event, el as BlueprintSidebarElement, sec.key)
                  "
                  @dragend.stop="
                    (sec.key === 'variable' || sec.key === 'function') && handleCanvasItemDragEnd()
                  "
                  @dblclick.stop="startRename((el as any).id, sec.key, (el as any).name)"
                  >{{ (el as any).name }}</span
                >
                <template v-if="sec.key === 'variable' && renamingId !== (el as any).id">
                  <span
                    class="var-type-group"
                    draggable="true"
                    @dragstart.stop="handleVariableDragStart($event, el as ExtractedVariable)"
                    @dragend.stop="handleCanvasItemDragEnd"
                  >
                    <span
                      class="var-dot"
                      :style="{ background: getVariableTypeColor((el as any).type) }"
                    />
                    <span class="var-type-text">{{
                      getVariableTypeLabel(
                        (el as any).type,
                        (el as any).containerType,
                        (el as any).subType
                      )
                    }}</span>
                  </span>
                </template>
                <button
                  v-if="isLogicType(sec.key) && renamingId !== (el as any).id"
                  class="del-btn"
                  :title="t('blueprintEditor.sidebar.delete')"
                  @click.stop="handleDeleteElement((el as any).id, sec.key)"
                >
                  ✕
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 折叠后的左侧边栏（我的蓝图） -->
      <div
        v-else
        class="bp-sidebar-collapsed"
        :title="t('blueprintEditor.sidebar.expandTitle')"
        @click="isLeftSidebarVisible = true"
      >
        <div class="collapsed-icon">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <rect x="3" y="3" width="18" height="18" rx="2"></rect>
            <path d="M9 3v18"></path>
          </svg>
        </div>
        <div class="collapsed-text">{{ t('blueprintEditor.sidebar.myBlueprint') }}</div>
      </div>

      <!-- 拖拽调整宽度手柄 -->
      <div v-show="isLeftSidebarVisible" class="resize-handle" @mousedown="onResizeStart" />

      <!-- 变量悬浮 Tooltip -->
      <Teleport to="body">
        <div
          v-if="hoveredVar"
          class="var-tooltip"
          :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }"
        >
          <div class="vt-header">
            <span class="vt-dot" :style="{ background: getVariableTypeColor(hoveredVar.type) }" />
            <span class="vt-name">{{ hoveredVar.name }}</span>
          </div>
          <div class="vt-row">
            <span class="vt-label">{{ t('blueprintEditor.varTooltip.type') }}</span>
            <span class="vt-value">{{
              getVariableTypeLabel(hoveredVar.type, hoveredVar.containerType, hoveredVar.subType)
            }}</span>
          </div>
          <div v-if="hoveredVar.subType" class="vt-row">
            <span class="vt-label">{{ t('blueprintEditor.varTooltip.subType') }}</span>
            <span class="vt-value">{{ hoveredVar.subType }}</span>
          </div>
          <div v-if="hoveredVar.containerType" class="vt-row">
            <span class="vt-label">{{ t('blueprintEditor.varTooltip.container') }}</span>
            <span class="vt-value">{{ hoveredVar.containerType }}</span>
          </div>
          <div v-if="hoveredVar.defaultValue" class="vt-row">
            <span class="vt-label">{{ t('blueprintEditor.varTooltip.defaultValue') }}</span>
            <span class="vt-value">{{ hoveredVar.defaultValue }}</span>
          </div>
          <div v-if="getVarUsageLocations(hoveredVar.name).length > 0" class="vt-row vt-usage">
            <span class="vt-label">{{ t('blueprintEditor.varTooltip.referencedIn') }}</span>
            <span class="vt-value">{{
              getVarUsageLocations(hoveredVar.name).join(
                t('blueprintEditor.varTooltip.listSeparator')
              )
            }}</span>
          </div>
        </div>
      </Teleport>

      <!-- 中央：主内容区（只显示逻辑元素：图表/函数/宏） -->
      <div class="main-content">
        <template v-if="activeLogicDetail">
          <div class="content-breadcrumb">
            {{ blueprint.name }} › {{ t(`blueprintEditor.sections.${activeLogicType}`) }} ›
            {{ activeLogicDetail.name }}
          </div>
          <div
            class="blueprint-viewer"
            :class="{ 'is-drop-active': isCanvasDropActive }"
            @dragenter="handleCanvasDragEnter"
            @dragover="handleCanvasDragOver"
            @dragleave="handleCanvasDragLeave"
            @drop="handleCanvasDrop"
          >
            <BlueprintRenderer
              :key="`${activeLogicType}:${activeLogicId}`"
              ref="rendererRef"
              :code="(activeLogicDetail as any).code || ''"
              :name="activeLogicDetail.name"
              :blueprint-id="bpId"
              :element-id="activeLogicId!"
              :element-type="activeLogicType!"
            />
            <div
              v-if="!isCanvasDropActive && !String((activeLogicDetail as any).code || '').trim()"
              class="canvas-empty-hint"
            >
              <PhGraph :size="28" weight="thin" aria-hidden="true" />
              <div class="canvas-empty-hint__title">
                {{ t('blueprintEditor.canvasEmpty.title') }}
              </div>
              <div class="canvas-empty-hint__desc">{{ t('blueprintEditor.canvasEmpty.desc') }}</div>
            </div>
            <div v-if="isCanvasDropActive" class="canvas-drop-hint">
              <div class="canvas-drop-hint__title">{{ getVariableDragHintText() }}</div>
              <div class="canvas-drop-hint__subtitle">{{ getVariableDragSubtitle() }}</div>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="empty-state">
            <PhPlaceholder class="empty-icon" :size="48" weight="thin" aria-hidden="true" />
            <div class="empty-title">{{ t('blueprintEditor.emptyState.title') }}</div>
            <div class="empty-desc">{{ t('blueprintEditor.emptyState.desc') }}</div>
          </div>
        </template>
      </div>

      <!-- 右侧：AI 面板。里面嵌的就是主助手本身 -->
      <LibraryAIPanel
        :session-id="`library-chat-blueprint-${bpId}`"
        :mode="aiPanelMode"
        :context="libraryChatContext"
        overlay-storage-prefix="blueprint-ai-panel"
        @update:mode="handleAiPanelModeUpdate"
        @restore="restoreAiPanel"
        @snapshot-selection="handleSnapshotSelection"
      />
    </div>
  </div>

  <!-- 蓝图不存在 -->
  <div v-else class="bp-not-found">
    <div class="nf-icon">⊘</div>
    <div class="nf-text">{{ t('blueprintEditor.notFound.text') }}</div>
    <button class="nf-btn" @click="goBack">{{ t('blueprintEditor.notFound.backButton') }}</button>
  </div>
</template>

<style scoped lang="less">
.bp-editor-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  color: var(--color-text-primary);
}

// ========== Three-Panel Body ==========
.editor-body {
  display: flex;
  flex: 1;
  min-height: 0;
  position: relative;
}

// ========== Left Sidebar ==========
.sidebar-left {
  width: 260px;
  min-width: 180px;
  max-width: 500px;
  border-right: 1px solid var(--color-border-subtle);
  overflow-y: auto;
  padding: 12px 0;
  flex-shrink: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.bp-sidebar-collapsed {
  width: 40px;
  background: var(--color-bg-surface-hover);
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 14px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  .collapsed-icon {
    margin-bottom: 16px;
    color: var(--color-text-primary);
  }

  .collapsed-text {
    writing-mode: vertical-rl;
    font-size: 12px;
    color: var(--color-text-primary);
    letter-spacing: 2px;
    user-select: none;
  }
}

// ========== Resize Handle ==========
.resize-handle {
  width: 5px;
  cursor: col-resize;
  flex-shrink: 0;
  position: relative;
  z-index: 10;
  // 视觉指示线
  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 2px;
    width: 1px;
    background: transparent;
    transition: background 0.15s;
  }
  &:hover::after,
  &:active::after {
    background: var(--color-accent-solid);
  }
}

// ========== Sidebar Filters ==========
.sidebar-filters {
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid var(--color-border-subtle);
  margin-bottom: 8px;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 8px;
  color: var(--color-text-muted);
  font-size: 14px;
}

.search-input {
  flex: 1;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  padding: 6px 24px 6px 26px;
  color: var(--color-text-primary);
  font-size: 12px;
  outline: none;
  transition: border-color 0.2s;
  &:focus {
    border-color: var(--color-accent-border);
  }
  &::placeholder {
    color: var(--color-text-disabled);
  }
}

.clear-search {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  color: var(--color-text-primary);
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  &:hover {
    color: var(--color-text-primary);
  }
}

.filter-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.filter-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  // 选中和悬停不能只差一级灰：描边把它从一排里拎出来
  &.active {
    background: var(--color-bg-selected);
    border-color: var(--color-border);
    color: var(--color-text-selected);
  }
}

.filter-empty {
  padding: 30px 10px;
  text-align: center;
  color: var(--color-text-muted);

  .fe-icon {
    font-size: 24px;
    margin-bottom: 8px;
  }
  .fe-text {
    font-size: 12px;
    margin-bottom: 12px;
  }
  .fe-btn {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text-primary);
    border-radius: 4px;
    padding: 4px 12px;
    font-size: 12px;
    cursor: pointer;
    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
    }
  }
}

.sidebar-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  letter-spacing: 0.2px;
  padding: 0 14px 10px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

// ---- Section（UE5 扁平顶级行） ----
.tree-section {
  margin-bottom: 0;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px 7px 12px;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.2px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
  &:hover {
    background: var(--color-bg-surface-hover);
  }
}

.section-arrow {
  font-size: 9px;
  color: var(--color-text-muted);
  transition: transform 0.2s;
  &.collapsed {
    transform: rotate(-90deg);
  }
}

.section-icon {
  flex: 0 0 auto;
  width: 18px;
  color: var(--color-text-secondary);
}

.section-label {
  flex: 1;
}

.section-count {
  font-size: 11px;
  color: var(--color-text-muted);
  min-width: 16px;
  text-align: center;
}

.add-btn {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
  .section-header:hover & {
    opacity: 1;
  }
  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

// ---- Tree Item ----
.tree-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px 5px 44px;
  font-size: 13px;
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background 0.15s;
  outline: none;

  &:hover {
    background: var(--color-bg-surface-hover);
    .del-btn {
      opacity: 1;
    }
  }

  &.active {
    background: var(--color-bg-selected);
    color: var(--color-text-primary);
  }

  &--unused {
    color: var(--color-text-muted);
  }

  &[draggable='true'] {
    cursor: grab;
    -webkit-user-drag: element !important;
    -khtml-user-drag: element !important;
    -moz-user-drag: element !important;
    -o-user-drag: element !important;
    user-drag: element !important;
  }

  &[draggable='true'] .item-name,
  &[draggable='true'] .var-type-group,
  &[draggable='true'] .var-dot,
  &[draggable='true'] .var-type-text {
    -webkit-user-drag: element !important;
    -khtml-user-drag: element !important;
    -moz-user-drag: element !important;
    -o-user-drag: element !important;
    user-drag: element !important;
  }
}

// ---- Variable Divider ----
.var-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px 6px 28px;
  user-select: none;
}

.var-divider-line {
  flex: 1;
  height: 1px;
  background: var(--color-bg-surface-hover);
}

.var-divider-label {
  font-size: 10px;
  color: var(--color-text-muted);
  white-space: nowrap;
  letter-spacing: 0.3px;
}

.var-type-group {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  max-width: 110px;
  margin-left: auto;
  padding-left: 6px;
}

.var-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.var-type-text {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}

.item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;

  &[draggable='true'] {
    cursor: grab;
    -webkit-user-drag: element !important;
    -khtml-user-drag: element !important;
    -moz-user-drag: element !important;
    -o-user-drag: element !important;
    user-drag: element !important;
  }
}

// ========== Variable Tooltip (Teleported to body, needs :global) ==========
:global(.var-tooltip) {
  position: fixed;
  z-index: 99999;
  min-width: 200px;
  max-width: 300px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 8px 24px var(--shadow-color-strong);
  backdrop-filter: blur(12px);
  color: var(--color-text-primary);
  font-size: 12px;
  pointer-events: none;
  animation: var-tooltip-fade-in 0.15s ease;
}

@keyframes var-tooltip-fade-in {
  from {
    opacity: 0;
    transform: translateX(-4px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

:global(.vt-header) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--color-border-subtle);
}

:global(.vt-dot) {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

:global(.vt-name) {
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-primary);
}

:global(.vt-row) {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
}

:global(.vt-label) {
  color: var(--color-text-primary);
  flex-shrink: 0;
  min-width: 42px;
}

:global(.vt-value) {
  color: var(--color-text-primary);
  word-break: break-all;
}

:global(.vt-usage .vt-value) {
  color: var(--color-accent-text);
}

.del-btn {
  opacity: 0;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 10px;
  cursor: pointer;
  transition: opacity 0.15s;
  &:hover {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
}

.rename-input {
  flex: 1;
  min-width: 0;
  padding: 1px 4px;
  font-size: 13px;
  color: var(--color-text-primary);
  background: var(--color-accent-bg);
  border: 1px solid var(--color-accent-border);
  border-radius: 3px;
  outline: none;
  font-family: inherit;
  &:focus {
    border-color: var(--color-accent-border);
    background: var(--color-accent-bg);
  }
}

// ========== Center Content ==========
.main-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.content-breadcrumb {
  padding: 11px 16px;
  font-size: 12px;
  color: var(--color-text-primary);
  position: absolute;
  z-index: 9999;
}

.blueprint-viewer {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
  position: relative;

  &.is-drop-active {
    box-shadow: inset 0 0 0 1px var(--color-accent-border);
  }
}

// 图表没有一个节点时，网格上只剩空白，说不清是没内容还是没画出来 —— 给一句话
.canvas-empty-hint {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  pointer-events: none;
  color: var(--color-text-muted);

  &__title {
    font-size: 13px;
    color: var(--color-text-primary);
  }

  &__desc {
    font-size: 12px;
  }
}

.canvas-drop-hint {
  position: absolute;
  top: 18px;
  right: 18px;
  z-index: 20;
  pointer-events: none;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--color-accent-border);
  background: var(--color-bg-overlay);
  box-shadow: 0 12px 30px var(--shadow-color);
}

.canvas-drop-hint__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.canvas-drop-hint__subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-primary);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
  color: var(--color-text-muted);
  font-weight: 300;
}

.empty-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--color-text-primary);
  margin-bottom: 6px;
}

.empty-desc {
  font-size: 13px;
}

// ========== Not Found ==========
.bp-not-found {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-text-primary);
}

.nf-icon {
  font-size: 48px;
  margin-bottom: 12px;
  color: var(--color-text-muted);
  font-weight: 300;
}

.nf-text {
  font-size: 16px;
  margin-bottom: 16px;
}

.nf-btn {
  padding: 8px 20px;
  border-radius: 8px;
  border: 1px solid var(--color-border-subtle);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}
</style>
