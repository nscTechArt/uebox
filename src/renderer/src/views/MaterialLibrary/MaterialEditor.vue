<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch
} from 'vue'
import LibraryEditorTopbar from '@renderer/views/library-common/components/LibraryEditorTopbar.vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import { useMaterialLibraryStore } from '@renderer/store/modules/materialLibraryStore'
import {
  useLibraryEditorShell,
  useLibraryTabTitleSync
} from '@renderer/views/library-common/composables/useLibraryEditorShell'
import type { SelectedNodeInfo } from '@renderer/views/BlueprintLibrary/BlueprintRenderer.vue'
import LibraryAIPanel from '@renderer/views/library-common/components/LibraryAIPanel.vue'
import type { LibraryChatContext } from '@renderer/views/Assistant/composables/libraryChatContext'
import { compressBlueprintCode } from '@renderer/views/BlueprintLibrary/utils/blueprintCodeParser'
import MaterialRenderer from './MaterialRenderer.vue'
import {
  formatMaterialValue,
  getMaterialCompileLabel,
  getMaterialEntryLabel,
  getParameterCount,
  type MaterialDependency,
  type MaterialParameterValue
} from './types/material'

type EditorSection = 'graph' | 'texture-dependencies' | 'function-dependencies'

type SidebarNodeParameterGroup = {
  owner: string
  items: MaterialParameterValue[]
}

const route = useRoute()
const router = useRouter()
const store = useMaterialLibraryStore()
const { t } = useI18n()

const section = ref<EditorSection>('graph')
const isParameterGroupCollapsed = ref(false)
const activeParameterName = ref<string | null>(null)
const collapsedNodeParameterOwners = ref<Set<string>>(new Set())
const materialRendererRef = ref<InstanceType<typeof MaterialRenderer> | null>(null)
const selectedNodesSnapshot = ref<SelectedNodeInfo[]>([])

const isEditorActive = ref(false)

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
  panelModeStorageKey: 'material-ai-panel-mode',
  sidebarVisibleStorageKey: 'material-left-sidebar-visible',
  defaultSidebarWidth: 200
})

const { syncTabTitle: syncMaterialTabTitle } = useLibraryTabTitleSync(() => entry.value?.name)

const entry = computed(() => {
  const currentId = route.params.id
  if (typeof currentId !== 'string') return null
  return store.entries.find((item) => item.id === currentId) || null
})

const sections = computed<
  Array<{ key: EditorSection; label: string; icon: string; badge?: () => number }>
>(() => [
  {
    key: 'graph',
    label: t('materialEditor.sections.graph'),
    icon: '▣',
    badge: () => entry.value?.graphSummary.nodeCount || 0
  },
  {
    key: 'texture-dependencies',
    label: t('materialEditor.sections.textureDependencies'),
    icon: '❖',
    badge: () => entry.value?.textureDependencies.length || 0
  },
  {
    key: 'function-dependencies',
    label: t('materialEditor.sections.functionDependencies'),
    icon: 'ƒ',
    badge: () =>
      (entry.value?.functionDependencies.length || 0) +
      (entry.value?.parameterCollectionDependencies.length || 0)
  }
])

const materialParameters = computed<MaterialParameterValue[]>(() => {
  const currentEntry = entry.value
  if (!currentEntry) return []
  return [
    ...currentEntry.scalarParameters,
    ...currentEntry.vectorParameters,
    ...currentEntry.textureParameters,
    ...currentEntry.staticSwitchParameters
  ]
})

const materialParameterItems = computed(() =>
  materialParameters.value.filter((item) => item.source !== 'nodeProperty')
)

const nodeParameterGroups = computed<SidebarNodeParameterGroup[]>(() => {
  const buckets = new Map<string, MaterialParameterValue[]>()

  for (const item of materialParameters.value) {
    if (item.source !== 'nodeProperty') continue
    const owner = getSidebarParameterOwner(item) || item.name
    const bucket = buckets.get(owner) || []
    bucket.push(item)
    buckets.set(owner, bucket)
  }

  return Array.from(buckets.entries()).map(([owner, items]) => ({ owner, items }))
})

const groupedNodeParameterGroups = computed(() =>
  nodeParameterGroups.value.filter((group) => group.items.length > 1)
)

const singleNodeParameters = computed(() =>
  nodeParameterGroups.value.flatMap((group) => (group.items.length === 1 ? group.items : []))
)

const nodeParameterTotal = computed(() =>
  nodeParameterGroups.value.reduce((total, group) => total + group.items.length, 0)
)

const parameterTotal = computed(() => (entry.value ? getParameterCount(entry.value) : 0))

const textureDependencyStats = computed(() => {
  const dependencies = entry.value?.textureDependencies || []
  const missing = dependencies.filter((dependency) => dependency.isResolved === false).length
  return {
    total: dependencies.length,
    recorded: dependencies.length - missing,
    missing
  }
})

watch(
  () => route.query.section,
  (nextSection) => {
    if (
      nextSection === 'graph' ||
      nextSection === 'texture-dependencies' ||
      nextSection === 'function-dependencies'
    ) {
      section.value = nextSection
    } else {
      section.value = 'graph'
    }
  },
  { immediate: true }
)

watch(
  () => entry.value?.id,
  () => {
    activeParameterName.value = null
    collapsedNodeParameterOwners.value = new Set()
    selectedNodesSnapshot.value = []
  }
)

function goBack(): void {
  router.push({ name: 'MaterialGallery' })
}

function setSection(nextSection: EditorSection): void {
  section.value = nextSection
  activeParameterName.value = null
}

function toggleParameterGroup(): void {
  isParameterGroupCollapsed.value = !isParameterGroupCollapsed.value
}

function getParameterDisplayValue(item: MaterialParameterValue): unknown {
  return item.overrideValue ?? item.inheritedValue
}

function getSidebarParameterName(item: MaterialParameterValue): string {
  const dotIndex = item.name.lastIndexOf('.')
  return dotIndex > 0 ? item.name.slice(dotIndex + 1) : item.name
}

function getSidebarParameterOwner(item: MaterialParameterValue): string {
  const dotIndex = item.name.lastIndexOf('.')
  return dotIndex > 0 ? item.name.slice(0, dotIndex) : ''
}

function getParameterTypeLabel(item: MaterialParameterValue): string {
  switch (item.type) {
    case 'scalar':
      return 'Scalar'
    case 'vector':
      return 'Vector'
    case 'texture':
      return 'Texture'
    case 'staticSwitch':
      return 'Switch'
    default:
      return item.type
  }
}

async function focusMaterialParameter(item: MaterialParameterValue): Promise<void> {
  activeParameterName.value = item.name
  section.value = 'graph'
  await nextTick()
  materialRendererRef.value?.focusOnMaterialParameter?.(item.name)
}

function handleSnapshotSelection(): void {
  selectedNodesSnapshot.value = materialRendererRef.value?.getSelectedNodesInfo?.() ?? []
}

// ========== 交给助手的上下文 ==========
/** 每个选中节点最多往上下文里塞多少字符 */
const SELECTED_NODE_CODE_LIMIT = 2000
/** 参数 / 依赖各列多少条。再多就把这一轮的正事挤掉了 */
const OVERVIEW_LIST_LIMIT = 16
/** 整段节点文本最多带多少。材质图动辄上万字符 */
const GRAPH_CODE_LIMIT = 3000

function formatParameterSummary(): string {
  const current = entry.value
  if (!current) return ''
  const items = [
    ...current.scalarParameters,
    ...current.vectorParameters,
    ...current.textureParameters,
    ...current.staticSwitchParameters
  ]
  if (!items.length) return '无参数'
  return items
    .slice(0, OVERVIEW_LIST_LIMIT)
    .map(
      (item) =>
        `- ${item.type}: ${item.name} = ${formatMaterialValue(item.overrideValue ?? item.inheritedValue)}`
    )
    .join('\n')
}

function formatDependencySummary(items: MaterialDependency[], emptyText: string): string {
  if (!items.length) return emptyText
  return items
    .slice(0, OVERVIEW_LIST_LIMIT)
    .map((item) => {
      const state = item.isResolved === false ? '缺失' : '已记录'
      return `- ${item.kind ?? item.assetType ?? ''} ${item.name}: ${item.path} (${state})`.trim()
    })
    .join('\n')
}

/**
 * 条目概况。这段原来在 `MaterialAIChat.vue` 的系统提示词里拼，
 * 那个组件随阶段 4 一起删了，内容搬到这儿 —— 材质要讲的是参数和依赖，
 * 和蓝图差得远，塞不进一个共用结构里。
 */
function buildMaterialOverview(): string {
  const current = entry.value
  if (!current) return ''

  return [
    '材质概况：',
    `- 类型: ${getMaterialEntryLabel(current.entryType)}`,
    `- 库路径: ${current.assetPath}`,
    `- 材质域: ${current.materialDomain}`,
    `- 混合模式: ${current.blendMode}`,
    `- 着色模型: ${current.shadingModel}`,
    `- 节点 ${current.graphSummary.nodeCount} / 连线 ${current.graphSummary.connectionCount} / ` +
      `贴图节点 ${current.graphSummary.textureNodeCount} / 函数调用 ${current.graphSummary.functionCallCount}`,
    '',
    '参数：',
    formatParameterSummary(),
    '',
    '贴图依赖：',
    formatDependencySummary(current.textureDependencies, '无贴图依赖'),
    '',
    '函数 / 参数集合依赖：',
    formatDependencySummary(
      [...current.functionDependencies, ...current.parameterCollectionDependencies],
      '无函数或参数集合依赖'
    ),
    '',
    '材质节点文本摘要：',
    current.graphBlueprintCode?.trim()
      ? current.graphBlueprintCode.trim().slice(0, GRAPH_CODE_LIMIT)
      : '无节点文本'
  ].join('\n')
}

const libraryChatContext = computed<LibraryChatContext | null>(() => {
  const current = entry.value
  if (!current) return null

  return {
    library: 'material',
    entryId: current.id,
    entryName: current.name,
    overview: buildMaterialOverview(),
    selectedNodes: selectedNodesSnapshot.value.map((node) => ({
      label: node.displayName || node.nodeName || '未命名节点',
      code: node.serializedText
        ? compressBlueprintCode(node.serializedText).slice(0, SELECTED_NODE_CODE_LIMIT)
        : undefined
    }))
  }
})

function isNodeParameterGroupCollapsed(owner: string): boolean {
  return collapsedNodeParameterOwners.value.has(owner)
}

function toggleNodeParameterGroup(owner: string): void {
  const nextOwners = new Set(collapsedNodeParameterOwners.value)
  if (nextOwners.has(owner)) {
    nextOwners.delete(owner)
  } else {
    nextOwners.add(owner)
  }
  collapsedNodeParameterOwners.value = nextOwners
}

function isParameterOwnerActive(group: SidebarNodeParameterGroup): boolean {
  return group.items.some((item) => item.name === activeParameterName.value)
}

async function copyAssetPath(): Promise<void> {
  if (!entry.value) return
  await navigator.clipboard.writeText(entry.value.assetPath)
  message.success(t('materialEditor.copiedLibraryPath'))
}

async function copyDependencyPath(path: string): Promise<void> {
  await navigator.clipboard.writeText(path)
  message.success(t('materialEditor.copiedTexturePath'))
}

function getDependencyStatusLabel(dependency: MaterialDependency): string {
  return dependency.isResolved === false
    ? t('materialEditor.status.missing')
    : t('materialEditor.status.recorded')
}

function getDependencySourceLabel(dependency: MaterialDependency): string {
  return dependency.assetKey
    ? t('materialEditor.textureDependencies.sourceAsset')
    : t('materialEditor.textureDependencies.sourceNode')
}

function handleGraphContentChange(code: string): void {
  if (!entry.value) return
  store.updateGraphCode(entry.value.id, code)
}

function handleFavorite(): void {
  if (entry.value) {
    store.toggleFavorite(entry.value.id)
  }
}

function getSectionLabel(secKey: EditorSection): string {
  const matched = sections.value.find((s) => s.key === secKey)
  return matched ? matched.label : t('materialEditor.sections.graph')
}

onMounted(() => {
  isEditorActive.value = true
  syncMaterialTabTitle()
  startListening()
})
onActivated(() => {
  isEditorActive.value = true
  syncMaterialTabTitle()
  startListening()
})
onDeactivated(() => {
  isEditorActive.value = false
  stopListening()
})
onBeforeUnmount(() => {
  isEditorActive.value = false
  stopListening()
})

watch(
  () => entry.value?.name,
  (newName) => {
    if (newName && isEditorActive.value) {
      syncMaterialTabTitle()
    }
  },
  { immediate: true }
)
</script>

<template>
  <div v-if="entry" class="material-editor-page">
    <!-- Top Bar -->
    <LibraryEditorTopbar
      :back-label="$t('materialEditor.actions.back')"
      :name="entry.name"
      :subtitle="entry.assetPath"
      :subtitle-title="$t('materialEditor.actions.copyPathTitle')"
      subtitle-clickable
      @back="goBack"
      @subtitle-click="copyAssetPath"
    >
      <template #chips>
        <span class="topbar-chip">{{ getMaterialEntryLabel(entry.entryType) }}</span>
        <span class="topbar-chip" :class="`status-${entry.compileStatus}`">
          {{ getMaterialCompileLabel(entry.compileStatus) }}
        </span>
        <span class="topbar-chip">UE {{ entry.engineVersion }}</span>
      </template>

      <template #actions>
        <button
          type="button"
          class="topbar-action focus-btn"
          :class="{ active: isFocusMode }"
          :title="$t('materialEditor.actions.focusModeTitle')"
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
            <span style="pointer-events: none">
              {{ $t('materialEditor.actions.exitFocusMode') }}
            </span>
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
            <span style="pointer-events: none">{{ $t('materialEditor.actions.focusMode') }}</span>
          </template>
        </button>
        <button
          class="topbar-action"
          :class="{ 'is-favorite': entry.isFavorite }"
          @click="handleFavorite"
        >
          {{
            entry.isFavorite
              ? $t('materialEditor.actions.favorited')
              : $t('materialEditor.actions.favorite')
          }}
        </button>
      </template>
    </LibraryEditorTopbar>

    <!-- Body Layout -->
    <div class="editor-body">
      <!-- Left Sidebar (Flat list of sections, matching style of blueprint) -->
      <div v-if="isLeftSidebarVisible" class="sidebar-left" :style="{ width: sidebarWidth + 'px' }">
        <div class="sidebar-title">
          <span>{{ $t('materialEditor.sidebar.title') }}</span>
          <button
            class="icon-btn collapse-btn"
            :title="$t('materialEditor.sidebar.collapseTitle')"
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

        <div class="sidebar-items">
          <div
            v-for="item in sections"
            :key="item.key"
            class="tree-item"
            :class="{ active: section === item.key }"
            @click="setSection(item.key)"
          >
            <span class="section-icon">{{ item.icon }}</span>
            <span class="item-name">{{ item.label }}</span>
            <span v-if="item.badge && item.badge() > 0" class="section-count">{{
              item.badge()
            }}</span>
          </div>

          <div class="tree-section parameter-tree-section">
            <button type="button" class="section-header" @click="toggleParameterGroup">
              <span class="section-arrow" :class="{ collapsed: isParameterGroupCollapsed }">▾</span>
              <span class="section-icon">◇</span>
              <span class="section-label">{{ $t('materialEditor.parameters.sectionLabel') }}</span>
              <span v-if="parameterTotal > 0" class="section-count">{{ parameterTotal }}</span>
            </button>

            <div v-if="!isParameterGroupCollapsed" class="parameter-tree">
              <template v-if="parameterTotal > 0">
                <div v-if="materialParameterItems.length" class="parameter-tree-group">
                  <div class="parameter-group-divider">
                    <span class="divider-line"></span>
                    <span class="divider-label">{{
                      $t('materialEditor.parameters.materialGroupLabel')
                    }}</span>
                    <span class="divider-count">{{ materialParameterItems.length }}</span>
                  </div>
                  <button
                    v-for="param in materialParameterItems"
                    :key="`material-${param.name}`"
                    type="button"
                    class="material-param-item"
                    :class="[
                      `param-type-${param.type}`,
                      { active: activeParameterName === param.name }
                    ]"
                    :title="`${param.name}: ${formatMaterialValue(getParameterDisplayValue(param))}`"
                    @click="focusMaterialParameter(param)"
                  >
                    <span class="param-dot"></span>
                    <span class="param-main">
                      <span class="item-name">{{ getSidebarParameterName(param) }}</span>
                      <small v-if="getSidebarParameterOwner(param)">{{
                        getSidebarParameterOwner(param)
                      }}</small>
                    </span>
                    <span class="param-type">{{ getParameterTypeLabel(param) }}</span>
                    <code class="param-value">{{
                      formatMaterialValue(getParameterDisplayValue(param))
                    }}</code>
                  </button>
                </div>

                <div v-if="nodeParameterTotal > 0" class="parameter-tree-group">
                  <div class="parameter-group-divider">
                    <span class="divider-line"></span>
                    <span class="divider-label">{{
                      $t('materialEditor.parameters.nodeGroupLabel')
                    }}</span>
                    <span class="divider-count">{{ nodeParameterTotal }}</span>
                  </div>

                  <div
                    v-for="nodeGroup in groupedNodeParameterGroups"
                    :key="nodeGroup.owner"
                    class="material-param-node-group"
                  >
                    <button
                      type="button"
                      class="material-param-node"
                      :class="{
                        active: isParameterOwnerActive(nodeGroup),
                        collapsed: isNodeParameterGroupCollapsed(nodeGroup.owner)
                      }"
                      :aria-expanded="!isNodeParameterGroupCollapsed(nodeGroup.owner)"
                      :title="
                        $t('materialEditor.parameters.nodeCountTitle', {
                          owner: nodeGroup.owner,
                          count: nodeGroup.items.length
                        })
                      "
                      @click="toggleNodeParameterGroup(nodeGroup.owner)"
                    >
                      <span class="param-node-icon">▾</span>
                      <span class="param-node-main">
                        <span class="item-name">{{ nodeGroup.owner }}</span>
                        <small>{{ $t('materialEditor.parameters.nodeGroupLabel') }}</small>
                      </span>
                      <span class="section-count">{{ nodeGroup.items.length }}</span>
                    </button>

                    <template v-if="!isNodeParameterGroupCollapsed(nodeGroup.owner)">
                      <button
                        v-for="param in nodeGroup.items"
                        :key="`node-${param.name}`"
                        type="button"
                        class="material-param-item material-param-child"
                        :class="[
                          `param-type-${param.type}`,
                          { active: activeParameterName === param.name }
                        ]"
                        :title="`${param.name}: ${formatMaterialValue(getParameterDisplayValue(param))}`"
                        @click="focusMaterialParameter(param)"
                      >
                        <span class="param-dot"></span>
                        <span class="param-main">
                          <span class="item-name">{{ getSidebarParameterName(param) }}</span>
                        </span>
                        <span class="param-type">{{ getParameterTypeLabel(param) }}</span>
                        <code class="param-value">{{
                          formatMaterialValue(getParameterDisplayValue(param))
                        }}</code>
                      </button>
                    </template>
                  </div>

                  <button
                    v-for="param in singleNodeParameters"
                    :key="`single-node-${param.name}`"
                    type="button"
                    class="material-param-item"
                    :class="[
                      `param-type-${param.type}`,
                      { active: activeParameterName === param.name }
                    ]"
                    :title="`${param.name}: ${formatMaterialValue(getParameterDisplayValue(param))}`"
                    @click="focusMaterialParameter(param)"
                  >
                    <span class="param-dot"></span>
                    <span class="param-main">
                      <span class="item-name">{{ getSidebarParameterName(param) }}</span>
                      <small v-if="getSidebarParameterOwner(param)">{{
                        getSidebarParameterOwner(param)
                      }}</small>
                    </span>
                    <span class="param-type">{{ getParameterTypeLabel(param) }}</span>
                    <code class="param-value">{{
                      formatMaterialValue(getParameterDisplayValue(param))
                    }}</code>
                  </button>
                </div>
              </template>
              <div v-else class="parameter-empty">
                {{ $t('materialEditor.parameters.emptyState') }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Collapsed Left Sidebar -->
      <div
        v-else
        class="material-sidebar-collapsed"
        :title="$t('materialEditor.sidebar.expandTitle')"
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
        <div class="collapsed-text">{{ $t('materialEditor.sidebar.title') }}</div>
      </div>

      <!-- Resize handle -->
      <div v-show="isLeftSidebarVisible" class="resize-handle" @mousedown="onResizeStart" />

      <!-- Center content -->
      <div class="main-content">
        <div class="content-breadcrumb">{{ entry.name }} › {{ getSectionLabel(section) }}</div>

        <div class="canvas-viewer">
          <!-- Graph -->
          <MaterialRenderer
            v-if="section === 'graph'"
            ref="materialRendererRef"
            :entry="entry"
            mode="graph"
            @content-change="handleGraphContentChange"
          />

          <!-- Texture Dependencies -->
          <section
            v-else-if="section === 'texture-dependencies'"
            class="table-panel texture-dependency-panel"
          >
            <div class="panel-title">
              <h2>{{ $t('materialEditor.textureDependencies.heading') }}</h2>
              <span>
                {{
                  $t('materialEditor.textureDependencies.stats', {
                    total: textureDependencyStats.total,
                    recorded: textureDependencyStats.recorded,
                    missing: textureDependencyStats.missing
                  })
                }}
              </span>
            </div>
            <div v-if="entry.textureDependencies.length" class="texture-dependency-list">
              <button
                v-for="dependency in entry.textureDependencies"
                :key="dependency.path"
                type="button"
                class="texture-dependency-row"
                :title="
                  $t('materialEditor.textureDependencies.copyTitle', { path: dependency.path })
                "
                @click="copyDependencyPath(dependency.path)"
              >
                <span class="dependency-thumb">
                  <img v-if="dependency.thumbnail" :src="dependency.thumbnail" alt="" />
                  <span v-else>{{ dependency.name.slice(0, 2).toUpperCase() }}</span>
                </span>
                <span class="dependency-main">
                  <strong>{{ dependency.name }}</strong>
                  <small>{{ dependency.path }}</small>
                </span>
                <em>{{ dependency.assetType || dependency.kind }}</em>
                <small class="dependency-source">{{ getDependencySourceLabel(dependency) }}</small>
                <b :class="{ unresolved: dependency.isResolved === false }">
                  {{ getDependencyStatusLabel(dependency) }}
                </b>
              </button>
            </div>
            <div v-else class="empty-panel">
              {{ $t('materialEditor.textureDependencies.emptyState') }}
            </div>
          </section>

          <!-- Function Dependencies -->
          <section v-else-if="section === 'function-dependencies'" class="table-panel">
            <div class="panel-title">
              <h2>{{ $t('materialEditor.functionDependencies.heading') }}</h2>
              <span>{{
                $t('materialEditor.functionDependencies.count', {
                  count:
                    entry.functionDependencies.length + entry.parameterCollectionDependencies.length
                })
              }}</span>
            </div>
            <div
              v-if="
                entry.functionDependencies.length || entry.parameterCollectionDependencies.length
              "
              class="data-list"
            >
              <div
                v-for="dependency in [
                  ...entry.functionDependencies,
                  ...entry.parameterCollectionDependencies
                ]"
                :key="dependency.path"
                class="data-row"
              >
                <span>
                  <strong>{{ dependency.name }}</strong>
                  <small>{{ dependency.path }}</small>
                </span>
                <em>{{ dependency.kind }}</em>
                <b :class="{ unresolved: dependency.isResolved === false }">
                  {{
                    dependency.isResolved === false
                      ? $t('materialEditor.status.missing')
                      : $t('materialEditor.status.recorded')
                  }}
                </b>
              </div>
            </div>
            <div v-else class="empty-panel">
              {{ $t('materialEditor.functionDependencies.emptyState') }}
            </div>
          </section>
        </div>
      </div>

      <!-- Right Side: AI Assistant Panel。里面嵌的就是主助手本身 -->
      <LibraryAIPanel
        :session-id="`library-chat-material-${entry.id}`"
        :mode="aiPanelMode"
        :context="libraryChatContext"
        overlay-storage-prefix="material-ai-panel"
        @update:mode="handleAiPanelModeUpdate"
        @restore="restoreAiPanel"
        @snapshot-selection="handleSnapshotSelection"
      />
    </div>
  </div>

  <div v-else class="not-found">
    <div class="nf-icon">⊘</div>
    <div class="nf-text">{{ $t('materialEditor.notFound.title') }}</div>
    <button class="nf-btn" @click="goBack">{{ $t('materialEditor.notFound.backButton') }}</button>
  </div>
</template>

<style scoped lang="less">
.material-editor-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  color: var(--color-text-primary);
}

// ========== Body Layout ==========
.editor-body {
  display: flex;
  flex: 1;
  min-height: 0;
  position: relative;
}

// ========== Left Sidebar ==========
.sidebar-left {
  border-right: 1px solid var(--color-border-subtle);
  overflow-y: auto;
  padding: 12px 0;
  flex-shrink: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.sidebar-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-primary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
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

.sidebar-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tree-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 13px;
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background 0.15s;
  user-select: none;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  &.active {
    background: var(--color-bg-selected);
    color: var(--color-text-primary);
  }
}

.tree-section {
  margin-top: 4px;
}

.section-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px 7px 12px;
  border: 0;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
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

.section-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parameter-tree {
  padding-bottom: 6px;
}

.parameter-group-divider {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px 5px 28px;
  user-select: none;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: var(--color-bg-surface-hover);
}

.divider-label,
.divider-count {
  color: var(--color-text-muted);
  font-size: 10px;
  white-space: nowrap;
}

.material-param-node-group {
  display: flex;
  flex-direction: column;
}

.material-param-node {
  width: 100%;
  min-height: 32px;
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 5px 10px 5px 28px;
  border: 0;
  background: transparent;
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  &.active {
    background: var(--color-bg-selected);
    color: var(--color-text-primary);
  }
}

.param-node-icon {
  color: var(--color-text-secondary);
  font-size: 11px;
  transition: transform 0.15s;
}

.material-param-node.collapsed .param-node-icon {
  transform: rotate(-90deg);
}

.param-node-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.param-node-main small {
  color: var(--color-text-muted);
  font-size: 10px;
}

.material-param-item {
  width: 100%;
  min-height: 34px;
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 7px;
  padding: 5px 10px 5px 34px;
  border: 0;
  background: transparent;
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  &.active {
    background: var(--color-bg-selected);
    color: var(--color-text-primary);
  }
}

.material-param-child {
  min-height: 30px;
  padding-left: 48px;
  grid-template-columns: 9px minmax(0, 1fr) auto auto;
}

.param-dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  background: var(--color-warning-solid);
}

.param-type-vector .param-dot {
  background: var(--color-accent-solid);
}

.param-type-texture .param-dot {
  background: var(--color-accent-solid);
}

.param-type-staticSwitch .param-dot {
  background: var(--color-success-solid);
}

.param-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.param-main small {
  color: var(--color-text-muted);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.param-type {
  color: var(--color-text-primary);
  font-size: 10px;
}

.param-value {
  max-width: 60px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
  color: var(--color-warning-text);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parameter-empty {
  margin: 6px 12px 8px 34px;
  padding: 8px 10px;
  border: 1px dashed var(--color-border-subtle);
  border-radius: 4px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.section-icon {
  font-size: 13px;
  width: 18px;
  text-align: center;
}

.item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-count {
  font-size: 11px;
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
  padding: 1px 5px;
  border-radius: 8px;
  min-width: 14px;
  text-align: center;
}

// ========== Collapsed Sidebar ==========
.material-sidebar-collapsed {
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

// ========== Center Content ==========
.main-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.content-breadcrumb {
  padding: 11px 16px;
  font-size: 12px;
  color: var(--color-text-primary);
  position: absolute;
  top: 0;
  left: 0;
  z-index: 9;
  pointer-events: none;
}

.canvas-viewer {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 16px;
  padding-top: 40px; // Spacing for breadcrumb
  background: var(--color-bg-page);
}

// ========== Panels Styling ==========
.table-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  border-radius: 6px;
  overflow-y: auto;
}

.panel-title {
  min-height: 44px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  border-radius: 6px 6px 0 0;
}

.panel-title h2 {
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.panel-title span {
  font-size: 12px;
  color: var(--color-text-primary);
}

.data-list {
  padding: 8px;
}

.data-row {
  min-height: 48px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px 80px;
  align-items: center;
  gap: 16px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.data-row:last-child {
  border-bottom: 0;
}

.data-row span {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.data-row strong {
  font-size: 13px;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.data-row small {
  font-size: 11px;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.data-row em {
  color: var(--color-text-primary);
  font-style: normal;
  font-size: 12px;
}

.data-row b {
  color: var(--color-success-text);
  font-weight: 500;
  font-size: 12px;
}

.data-row b.unresolved {
  color: var(--color-danger-text);
}

.texture-dependency-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.texture-dependency-row {
  width: 100%;
  min-height: 58px;
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 120px 108px 72px;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.texture-dependency-row:hover {
  border-color: var(--color-accent-border);
  background: var(--color-accent-bg);
}

.dependency-thumb {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 4px;
  background: var(--color-bg-surface);
  color: var(--color-accent-text);
  font-size: 11px;
  font-weight: 700;
}

.dependency-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.dependency-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dependency-main strong,
.dependency-main small,
.dependency-source,
.texture-dependency-row em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dependency-main strong {
  color: var(--color-text-primary);
  font-size: 13px;
}

.dependency-main small,
.dependency-source,
.texture-dependency-row em {
  color: var(--color-text-primary);
  font-size: 11px;
  font-style: normal;
}

.texture-dependency-row b {
  color: var(--color-success-text);
  font-size: 12px;
  font-weight: 500;
  text-align: right;
}

.texture-dependency-row b.unresolved {
  color: var(--color-danger-text);
}

.empty-panel {
  display: grid;
  place-items: center;
  min-height: 160px;
  color: var(--color-text-muted);
  font-size: 13px;
}

// ========== Not Found ==========
.not-found {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-text-primary);
  background: var(--color-bg-page);
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
