<template>
  <div class="asset-tree">
    <!-- 保管库切换器 -->
    <div class="vault-switcher-container">
      <VaultSwitcher @manage="handleManageVaults" @vault-changed="handleVaultChanged" />
    </div>

    <!-- 快捷目录 -->
    <div class="shortcuts-section">
      <div class="shortcuts-header" @click="shortcutsCollapsed = !shortcutsCollapsed">
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: shortcutsCollapsed }"
        />
        <span class="shortcuts-title">{{ t('assetLib.shortcuts.title') }}</span>
      </div>

      <div v-show="!shortcutsCollapsed" class="shortcuts-list">
        <!-- 移除"未标签的"入口：在海量资产场景下，该功能不实用，改为利用路径/类型等隐式元数据分类 -->

        <div
          class="shortcut-item"
          :class="{
            selected: selectedShortcut === 'favorites',
            disabled: !libraryCaps.canFavorite
          }"
          :title="libraryCaps.canFavorite ? undefined : capabilityReason('canFavorite')"
          :aria-disabled="!libraryCaps.canFavorite"
          @click="libraryCaps.canFavorite && handleShortcutClick('favorites')"
        >
          <span class="shortcut-label">{{ t('assetLib.shortcuts.favorites') }}</span>
          <span class="shortcut-badge">{{ favoriteCount }}</span>
        </div>

        <!--
          标签管理已从这里挪走。「我的收藏」「最近删除」是**资产**的视图，
          标签管理是维护工具，不是一类东西；而且它占掉整页右侧却只用得着一行半。
          现在是工具栏「排序 / 筛选」后面的一个按钮，开在弹窗里。
        -->
        <div
          v-if="supportsDeletedShortcut"
          class="shortcut-item"
          :class="{
            selected: selectedShortcut === 'recent' || selectedShortcut === 'deleted',
            disabled: !libraryCaps.hasTrash
          }"
          :title="libraryCaps.hasTrash ? undefined : capabilityReason('hasTrash')"
          :aria-disabled="!libraryCaps.hasTrash"
          @click="libraryCaps.hasTrash && handleShortcutClick('recent')"
        >
          <span class="shortcut-label">{{ t('assetLib.shortcuts.recent') }}</span>
        </div>
      </div>
    </div>

    <!-- 同步 -->
    <div class="sync-section">
      <div class="sync-header" @click="syncCollapsed = !syncCollapsed">
        <PhCaretRight weight="fill" class="collapse-icon" :class="{ collapsed: syncCollapsed }" />
        <span class="sync-title">{{ t('assetLib.network.title') }}</span>
      </div>

      <div v-show="!syncCollapsed" class="sync-list">
        <div
          class="sync-item"
          :class="{ selected: selectedShortcut === 'baiduyun' }"
          @click="handleShortcutClick('baiduyun')"
        >
          <span class="sync-label">{{ t('assetLib.network.baiduyun') }}</span>
        </div>
        <div
          class="sync-item"
          :class="{ selected: selectedShortcut === 'webdav' }"
          @click="handleShortcutClick('webdav')"
        >
          <span class="sync-label">{{ t('assetLib.network.webdav') }}</span>
        </div>
      </div>
    </div>

    <!-- 资产文件夹 -->
    <div class="folder-section">
      <div class="folder-header">
        <span class="folder-title">{{ t('assetLib.folder.title') }}</span>
      </div>
      <div class="folder-search">
        <a-input
          v-model:value="searchQuery"
          :placeholder="
            libraryCaps.folderSearch
              ? t('assetLib.folder.searchPlaceholder')
              : capabilityReason('folderSearch')
          "
          :disabled="!libraryCaps.folderSearch"
          :title="libraryCaps.folderSearch ? undefined : capabilityReason('folderSearch')"
          allow-clear
          size="small"
        >
          <template #prefix>
            <PhMagnifyingGlass class="search-icon" />
          </template>
        </a-input>
      </div>
    </div>

    <div class="tree-content" @dblclick.capture="handleTreeDoubleClick">
      <!-- 空状态 -->
      <div v-if="filteredTreeData.length === 0 && !effectiveLoading" class="empty-state">
        <div class="empty-icon">📁</div>
        <div class="empty-text">{{ folderEmptyTitle }}</div>
        <div class="empty-desc">{{ folderEmptyDescription }}</div>
      </div>

      <!-- 加载状态 -->
      <div v-else-if="effectiveLoading" class="loading-state">
        <AppSpin />
      </div>

      <!-- 树形结构 -->
      <a-tree
        v-else
        ref="treeRef"
        :tree-data="filteredTreeData"
        :selected-keys="selectedKeys"
        :expanded-keys="mergedExpandedKeys"
        show-line
        :show-icon="false"
        @select="handleSelect"
        @expand="handleExpand"
        @right-click="handleRightClick"
      >
        <template #switcherIcon="{ expanded, isLeaf: nodeIsLeaf }">
          <!-- 叶子节点不显示任何图标 -->
          <span v-if="nodeIsLeaf" class="empty-switcher"></span>
          <PhCaretRight
            v-else
            weight="fill"
            class="arrow"
            :style="{
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s'
            }"
          />
        </template>

        <!-- eslint-disable-next-line vue/no-unused-vars -- folderType 暂时隐藏，保留供后续恢复 -->
        <template #title="{ title, folderType, key, color, img }">
          <div
            class="tree-node-title"
            :class="{ 'node-drop-target': dropTargetKey === key }"
            :title="title"
            :data-folder-key="key"
            @dragover.prevent.stop="handleNodeDragOver($event)"
            @dragenter.prevent.stop="handleNodeDragEnter($event, key)"
            @dragleave.stop="handleNodeDragLeave($event, key)"
            @drop.prevent.stop="handleNodeDrop($event, key)"
          >
            <span
              class="tree-node-icon"
              :class="{ 'has-custom-color': color }"
              :style="color ? { '--custom-folder-color': color } : undefined"
            >
              <!-- 插件类型使用插件自带图标，其他类型使用文件夹图标 -->
              <img
                v-if="folderType === 'plugin' && img && !failedPluginIcons.has(img)"
                :src="toLocalResourceUrl(img)"
                alt="plugin"
                class="plugin-folder-icon"
                @error="handlePluginIconError(img)"
              />
              <span
                v-else-if="folderType === 'plugin'"
                class="mono-icon plugin-folder-icon"
                role="img"
                aria-label="plugin"
                :style="{ '--mono-icon': `url(${icPluginsIcon})` }"
              />
              <PhFolder v-else weight="fill" class="folder-icon" />
            </span>
            <span class="tree-node-text">{{ title }}</span>
          </div>
        </template>
      </a-tree>
    </div>

    <!-- 右键菜单 -->
    <ContextMenu
      ref="contextMenuRef"
      :menu-items="contextMenuItems"
      @click="handleContextMenuClick"
    />

    <ImportToProjectModal
      v-if="importProjectSource"
      v-model:open="importProjectModalVisible"
      :source="importProjectSource"
    />
    <!-- 服务器库：同一个"导入到工程"菜单项，经 lore 取文件再复制进工程 -->
    <CatalogDownloadModal
      v-if="libraryStore.activeServerKey"
      :open="serverDownloadOpen"
      :library-key="libraryStore.activeServerKey"
      :items="serverDownloadItems"
      @close="serverDownloadOpen = false"
    />

    <!-- 添加文件夹对话框 -->
    <AppModal
      v-model:open="addFolderModalVisible"
      :title="t('assetLib.folder.new')"
      @ok="handleAddFolderConfirm"
      @cancel="handleAddFolderCancel"
    >
      <a-form :model="addFolderForm" layout="vertical">
        <a-form-item :label="t('assetLib.folder.nameLabel')" required>
          <a-input
            v-model:value="addFolderForm.name"
            :placeholder="t('assetLib.folder.namePlaceholder')"
            @press-enter="handleAddFolderConfirm"
          />
        </a-form-item>
      </a-form>
    </AppModal>

    <!-- 重命名对话框 -->
    <AppModal
      v-model:open="renameFolderModalVisible"
      :title="t('assetLib.folder.rename')"
      @ok="handleRenameFolderConfirm"
      @cancel="handleRenameFolderCancel"
    >
      <a-form :model="renameFolderForm" layout="vertical">
        <a-form-item :label="t('assetLib.folder.nameLabel')" required>
          <a-input
            v-model:value="renameFolderForm.name"
            :placeholder="t('assetLib.folder.namePlaceholder')"
            @press-enter="handleRenameFolderConfirm"
          />
        </a-form-item>
      </a-form>
    </AppModal>

    <!-- 标签选择对话框 -->
    <TagSelectorModal
      v-model:open="folderTagSelectorVisible"
      :initial-selected-tag-ids="currentFolderTagIds"
      @confirm="handleAddFolderTagsConfirm"
    />

    <!-- 颜色选择器对话框 -->
    <ColorPickerModal
      v-model:open="colorPickerVisible"
      :current-color="colorPickerTarget?.currentColor"
      @confirm="handleColorPickerConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppModal from '@renderer/components/AppModal.vue'
import { ref, reactive, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { useI18n } from 'vue-i18n'
import {
  PhArrowsClockwise,
  PhCaretRight,
  PhDownloadSimple,
  PhFolder,
  PhFolderOpen,
  PhMagnifyingGlass,
  PhPalette,
  PhPencilSimple,
  PhPlus,
  PhTag,
  PhTrash
} from '@phosphor-icons/vue'
import TagSelectorModal from '@renderer/components/TagSelector/TagSelectorModal.vue'
import ColorPickerModal from './modals/ColorPickerModal.vue'
import ImportToProjectModal from './modals/ImportToProjectModal.vue'
import CatalogDownloadModal from '../catalog/CatalogDownloadModal.vue'
import { useAssetLibraryStore } from '@renderer/store/modules/assetLibraryStore'
import { getActiveLibrarySource } from '../data/activeLibrarySource'
import type { CatalogAssetSummary } from '@core/shared/catalogLibrary'

import icPluginsIcon from '@renderer/assets/icon/ic_plugins.svg'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import { useAssetContext } from '../composables/useAssetContext'
import { useAssetSelectionStore } from '@renderer/store/modules/assetSelectionStore'
import type { ShortcutKey } from '@renderer/store/modules/assetSelectionStore'
import VaultSwitcher from './VaultSwitcher.vue'
import type { TreeNode } from '../types'
import { useFavoriteStore } from '@renderer/store/modules/favoriteStore'
import { useVaultStore, VaultType } from '@renderer/store/modules/vaultStore'
import folderTagAPI from '@renderer/api/folderTag'
import { assetDataAPI } from '@renderer/api/assetData'
import assetFolderAPI from '@renderer/api/assetFolder'
import {
  buildBrowsePath,
  getNetworkBrowseBasePath,
  isHttpUrl,
  normalizeVaultRelativePath,
  openBrowsePath
} from '../utils/networkBrowsePath'
import { buildFolderSearchTree } from '../utils/folderSearchTree'
import { resolveErrorText } from '../utils/assetVaultHelpers'

interface Props {
  treeData: TreeNode[]
  selectedKeys: string[]
  expandedKeys: string[]
  loading?: boolean
}

interface Emits {
  (e: 'select', selectedKeys: string[], info: unknown): void
  (e: 'expand', expandedKeys: string[], info: unknown): void
  (e: 'manageVaults'): void
  (e: 'vaultChanged', vault: unknown): void
  (
    e: 'baiduyun-drag-enter',
    payload: { targetKey: string; targetTitle: string; itemCount: number }
  ): void
  (e: 'baiduyun-drag-leave'): void
  // 下载任务事件
  (
    e: 'download-task-add',
    task: {
      id: string
      type: 'file' | 'folder'
      name: string
      progress: number
      stageText: string
      /** 下载任务所属的目标文件夹 key，用于按目录过滤显示 */
      folderKey?: string
    }
  ): void
  (e: 'download-task-update', id: string, updates: { progress?: number; stageText?: string }): void
  (e: 'download-task-complete', id: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const { t } = useI18n()

// 添加搜索相关的状态
const searchQuery = ref('')
const searchTreeData = ref<TreeNode[]>([])
const searchExpandedKeys = ref<string[]>([])
const searchLoading = ref(false)
const isFolderSearchActive = computed(() => searchQuery.value.trim().length > 0)
const effectiveLoading = computed(() => props.loading || searchLoading.value)
const folderEmptyTitle = computed(() =>
  isFolderSearchActive.value
    ? t('assetLib.folder.searchEmpty', '未找到匹配目录')
    : t('assetLib.folder.empty')
)
const folderEmptyDescription = computed(() =>
  isFolderSearchActive.value
    ? t('assetLib.folder.searchEmptyDesc', '换个关键词试试')
    : t('assetLib.folder.emptyDesc')
)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchRequestId = 0

const parseFolderKeyArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean)
  }
  if (typeof value !== 'string' || !value.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

const collectSearchFoldersWithAncestors = async (
  matches: AssetFolder[]
): Promise<AssetFolder[]> => {
  const folderMap = new Map<string, AssetFolder>()

  const rememberFolder = (folder?: AssetFolder | null): void => {
    if (folder?.folderKey) {
      folderMap.set(folder.folderKey, folder)
    }
  }

  const loadFolder = async (folderKey?: string | null): Promise<AssetFolder | undefined> => {
    if (!folderKey || folderKey === 'ALL') return undefined
    const cached = folderMap.get(folderKey)
    if (cached) return cached
    const folder = await assetFolderAPI.getByKey(folderKey)
    rememberFolder(folder)
    return folder
  }

  for (const folder of matches) {
    rememberFolder(folder)
  }

  for (const folder of matches) {
    const explicitAncestorKeys = [
      ...parseFolderKeyArray(folder.pathArray),
      ...parseFolderKeyArray(folder.ancestorKeys)
    ].filter((key) => key && key !== 'ALL' && key !== folder.folderKey)

    for (const ancestorKey of explicitAncestorKeys) {
      await loadFolder(ancestorKey)
    }

    const seenKeys = new Set<string>([folder.folderKey])
    let current: AssetFolder | undefined = folder
    while (current?.fatherKey && current.fatherKey !== 'ALL' && !seenKeys.has(current.fatherKey)) {
      seenKeys.add(current.fatherKey)
      current = await loadFolder(current.fatherKey)
    }
  }

  return [...folderMap.values()]
}

const runGlobalFolderSearch = async (keyword: string, requestId: number): Promise<void> => {
  if (!keyword) return
  searchLoading.value = true
  try {
    const matches = await assetFolderAPI.search({
      keyword,
      sortBy: 'folderName',
      sortOrder: 'asc',
      limit: 300
    })
    const folders = await collectSearchFoldersWithAncestors(matches || [])
    if (requestId !== searchRequestId) return

    const result = buildFolderSearchTree(folders)
    searchTreeData.value = result.treeData
    searchExpandedKeys.value = result.expandedKeys
  } catch (error) {
    if (requestId !== searchRequestId) return
    console.error('[AssetTree] 全局搜索目录失败:', error)
    searchTreeData.value = []
    searchExpandedKeys.value = []
  } finally {
    if (requestId === searchRequestId) {
      searchLoading.value = false
    }
  }
}

watch(searchQuery, (value) => {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }

  const keyword = value.trim()
  const requestId = ++searchRequestId
  if (!keyword) {
    searchLoading.value = false
    searchTreeData.value = []
    searchExpandedKeys.value = []
    return
  }

  searchLoading.value = true
  searchTimer = setTimeout(() => {
    void runGlobalFolderSearch(keyword, requestId)
  }, 250)
})

onBeforeUnmount(() => {
  if (searchTimer) {
    clearTimeout(searchTimer)
  }
})

// 过滤树节点并收集需要展开的 key
const filteredTreeData = computed(() => {
  return isFolderSearchActive.value ? searchTreeData.value : props.treeData
})

// 合并来自 props 的展开状态和搜索引起的展开状态
const mergedExpandedKeys = computed(() => {
  if (isFolderSearchActive.value) {
    return searchExpandedKeys.value
  }
  return props.expandedKeys
})

// 获取上下文
const assetContext = useAssetContext()

// 当前保管库
const vaultStore = useVaultStore()
const currentVault = computed(() => vaultStore.currentVault)
// 是否为网络库
const isNetworkVault = computed(() => currentVault.value?.vaultType === 'network')
const supportsDeletedShortcut = computed(
  () => !isNetworkVault.value || isHttpUrl(currentVault.value?.networkPath || '')
)

// 收藏计数（来自 store）
const favoriteStore = useFavoriteStore()
const favoriteCount = computed(() => favoriteStore.totalCount)
// 快捷区域选中状态
const selectedShortcut = ref<string | null>(null)
const selectionStore = useAssetSelectionStore()

// 当前数据源能做什么（服务器库时一些本地库功能在原位禁用，并给一句原因）
const libraryStore = useAssetLibraryStore()
const libraryCaps = computed(() => libraryStore.capabilities)
const capabilityReason = (name: string): string => {
  const key = libraryCaps.value.reasons[name]
  return key ? t(key) : ''
}
const serverDownloadOpen = ref(false)
const serverDownloadItems = ref<CatalogAssetSummary[]>([])

/** 服务器库的文件夹"下载到工程"：列出其下的资产（有上限），交给下载对话框 */
const openServerFolderDownload = async (folderKey: string): Promise<void> => {
  const items: CatalogAssetSummary[] = []
  for (let offset = 0; offset < 2000; offset += 200) {
    const rows = (await getActiveLibrarySource().search.assets({
      folderKey,
      includeSubfolders: true,
      limit: 200,
      offset
    })) as Array<Record<string, unknown>>
    for (const row of rows) {
      items.push({
        id: Number(row.catalogId),
        path: String(row.catalogPath ?? ''),
        name: String(row.name ?? ''),
        dirId: Number(row.catalogDirId ?? 0),
        repository: String(row.catalogRepository ?? ''),
        ext: String(row.ext ?? ''),
        class: (row.className as string) ?? null,
        engine: (row.engineVersion as string) ?? null,
        size: Number(row.fileSize ?? 0),
        modifiedMs: 0,
        tags: []
      })
    }
    if (rows.length < 200) break
  }
  if (items.length === 0) return
  serverDownloadItems.value = items
  serverDownloadOpen.value = true
}

// 折叠状态
const shortcutsCollapsed = ref(false)
const syncCollapsed = ref(false)

// 标签统计 store
// 供模板展示的标签总数

const getNetworkBrowseUnavailableMessage = (): string => {
  if (
    currentVault.value?.vaultType === 'network' &&
    isHttpUrl(currentVault.value?.networkPath || '') &&
    !currentVault.value?.browsePath
  ) {
    return t('assetTree.messages.networkBrowseUnavailable')
  }

  return t('assetLib.contextMenu.openLocalPathFailed')
}

const buildFolderBrowsePath = async (folderKey: string): Promise<string | null> => {
  const browseRoot = getNetworkBrowseBasePath(currentVault.value)
  if (!browseRoot) return null

  if (folderKey === 'ALL') {
    return buildBrowsePath(browseRoot)
  }

  const folder = await assetFolderAPI.getByKey(folderKey)
  const relativePath = normalizeVaultRelativePath(folder?.fullPath)
  return buildBrowsePath(browseRoot, relativePath)
}

/**
 * 自定义插件图标加载失败过的地址。
 *
 * 记下来而不是就地改 img.src —— 内置的兜底图标是白色单色字形，
 * 得走 mask 才能跟着主题变色，而 mask 改不了 <img> 里的颜色。
 * 记在这里，模板就能退回到那个 <span class="mono-icon">。
 */
const failedPluginIcons = ref(new Set<string>())

const handlePluginIconError = (src: string): void => {
  if (src) failedPluginIcons.value = new Set(failedPluginIcons.value).add(src)
}

// 树组件引用
const treeRef = ref()

// 右键菜单相关
const contextMenuRef = ref()
const currentRightClickNode = ref<string | null>(null)
const importProjectModalVisible = ref(false)
const importProjectSource = ref<(TreeNode & { id: string; name: string }) | null>(null)

// 右键菜单项配置
// 右键菜单项配置
const contextMenuItems = computed<MenuItem[]>(() => {
  // 检查当前右键节点是否为 ALL 目录（ALL 目录不允许重命名和删除）
  const isAllFolder = currentRightClickNode.value === 'ALL'

  // 不能改结构的库（服务器库）：只留"导入到工程"，走服务器下载
  if (!libraryCaps.value.canEditStructure) {
    return [
      {
        key: 'import-to-project',
        label: t('assetLib.contextMenu.importToProject'),
        icon: PhDownloadSimple,
        disabled: isAllFolder || !currentRightClickNode.value || !libraryCaps.value.canSendToProject
      }
    ]
  }

  const items: MenuItem[] = [
    {
      key: 'import-to-project',
      label: t('assetLib.contextMenu.importToProject'),
      icon: PhDownloadSimple,
      disabled: isAllFolder || !currentRightClickNode.value
    },
    {
      key: 'addFolder',
      label: t('assetLib.contextMenu.newSubFolder'),
      icon: PhPlus,
      shortcut: 'Ctrl+N'
    },
    {
      key: 'rename',
      label: t('assetLib.contextMenu.rename'),
      icon: PhPencilSimple,
      shortcut: 'F2',
      disabled: isAllFolder
    },
    {
      key: 'manageTags',
      label: t('assetLib.contextMenu.addTags'),
      icon: PhTag
    },
    {
      key: 'setColor',
      label: t('assetLib.contextMenu.setColor', '修改颜色'),
      icon: PhPalette
    },
    {
      key: 'reimport',
      label: t('assetLib.contextMenu.reimport', '修复资产'),
      icon: PhArrowsClockwise
    }
  ]

  // 网络保管库："打开本地目录"菜单项（已隐藏）
  // if (currentVault.value?.vaultType === 'network' && currentVault.value?.networkPath) {
  //   items.push(
  //     {
  //       key: 'divider-ctx-network',
  //       label: '',
  //       type: 'divider'
  //     },
  //     {
  //       key: 'openLocalPath',
  //       label: t('assetLib.contextMenu.openLocalPath'),
  //       icon: PhFolderOpen
  //     }
  //   )
  // }

  if (libraryCaps.value.vaultFeatures && currentVault.value?.vaultType === 'network') {
    items.push(
      {
        key: 'divider-ctx-network',
        label: '',
        type: 'divider'
      },
      {
        key: 'openLocalPath',
        label: t('assetLib.contextMenu.openLocalPath'),
        icon: PhFolderOpen
      }
    )
  }

  items.push(
    {
      key: 'divider-ctx-1',
      label: '',
      type: 'divider'
    },
    {
      key: 'delete',
      label: t('assetLib.contextMenu.deleteFolder'),
      icon: PhTrash,
      danger: true,
      shortcut: 'Delete',
      disabled: isAllFolder
    }
  )

  return items
})

// 添加文件夹对话框
const addFolderModalVisible = ref(false)
const addFolderForm = reactive({
  name: '',
  parentKey: null as string | null
})

// 文件夹标签选择
const folderTagSelectorVisible = ref(false)
const folderTagSelectorKey = ref('')
const currentFolderTagIds = ref<number[]>([])

// 确认标签选择
const handleAddFolderTagsConfirm = async (tagIds: number[]) => {
  const folderKey = folderTagSelectorKey.value
  if (!folderKey) return
  try {
    const cleanTagIds = Array.isArray(tagIds)
      ? tagIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : []
    const res = await folderTagAPI.setTagsForFolder(String(folderKey), cleanTagIds)
    if (res) {
      message.success(t('assetLib.tag.updateSuccess', '已更新标签'))
      folderTagSelectorVisible.value = false
    } else {
      message.error(t('assetTree.messages.updateTagsFailed'))
    }
  } catch (err) {
    message.error(resolveErrorText(err, t('assetTree.messages.updateTagsFailed')))
    console.error(err)
  }
}

// ==================== 颜色选择器相关 ====================
/**
 * 颜色选择器状态
 */
const colorPickerVisible = ref(false)
const colorPickerTarget = ref<{
  type: 'folder'
  key: string
  currentColor?: string
} | null>(null)

/**
 * 颜色选择确认：更新文件夹的颜色
 * @param color 选择的颜色值（十六进制格式），null 表示清除颜色
 */
const handleColorPickerConfirm = async (color: string | null): Promise<void> => {
  if (!colorPickerTarget.value) return

  const { key } = colorPickerTarget.value

  try {
    // 更新文件夹颜色
    const result = await (window as any).api.database.assetFolder.update(key, { color })
    // IPC 返回格式：{ success: boolean, data: boolean, error?: string }
    // data 表示数据库是否有行被更新，success 表示操作是否成功执行
    const ok = result?.success === true || result?.updated === true
    if (ok) {
      // 实时更新树节点颜色（不需要刷新整个树或文件列表）
      assetContext.updateTreeNodeColor(key, color)
      // message.success(
      //   color
      //     ? t('assetLib.contextMenu.colorUpdated', '颜色已更新')
      //     : t('assetLib.contextMenu.colorCleared', '颜色已清除')
      // )
      // 注意：不调用 refreshCurrentFolder()，避免重新加载导致排序变化
      // 颜色更新只需更新内存数据，已通过 updateTreeNodeColor 完成
    } else {
      console.error('[AssetTree] 更新颜色失败:', result?.error)
      message.error(t('assetLib.contextMenu.colorUpdateFailed', '颜色更新失败'))
    }
  } catch (err) {
    console.error('[AssetTree] 更新颜色失败:', err)
    message.error(
      resolveErrorText(err, t('assetLib.contextMenu.colorUpdateFailed', '颜色更新失败'))
    )
  } finally {
    colorPickerVisible.value = false
    colorPickerTarget.value = null
  }
}

// 重命名文件夹对话框
const renameFolderModalVisible = ref(false)
const renameFolderForm = reactive({
  name: '',
  folderKey: ''
})

const handleSelect = (selectedKeys: string[], info: any) => {
  // 当树形文件夹被选中时，清除快捷区域的选中状态
  selectedShortcut.value = null
  const emitInfo = isFolderSearchActive.value ? { ...info, globalFolderSearch: true } : info

  // 如果点击的是已经选中的节点（selectedKeys 为空表示取消选择），则重新选择它
  // 这样就不会取消选择，而是保持选中状态并进入目录
  if (selectedKeys.length === 0 && info.selected === false) {
    // 获取当前点击的节点 key
    // Ant Design Vue Tree 的 info 对象包含 node 属性
    const clickedNodeKey = info.node?.key

    // 如果点击的节点就是之前选中的节点，则重新选择它
    const previousSelectedKey = props.selectedKeys[0]
    if (clickedNodeKey && clickedNodeKey === previousSelectedKey) {
      // 重新选择该节点，保持选中状态
      const newSelectedKeys = [clickedNodeKey]
      // 更新 info 对象，标记为选中状态
      const newInfo = {
        ...emitInfo,
        selected: true,
        node: info.node
      }

      // 写入互斥选择：树节点优先
      selectionStore.setTreeKey(newSelectedKeys[0] || null)
      emit('select', newSelectedKeys, newInfo)
      return
    }
  }

  // 写入互斥选择：树节点优先
  selectionStore.setTreeKey(selectedKeys[0] || null)
  emit('select', selectedKeys, emitInfo)
}

// 处理快捷区域点击
const handleShortcutClick = (shortcutKey: string) => {
  // 设置快捷区域选中状态
  selectedShortcut.value = shortcutKey
  // 写入互斥选择：快捷项优先
  selectionStore.setShortcut(shortcutKey as ShortcutKey)
  // 清除树形文件夹的选中状态
  emit('select', [], { selected: false, shortcut: shortcutKey })
  // 切到收藏快捷时，刷新收藏计数（通知 store）
  if (shortcutKey === 'favorites') {
    void favoriteStore.refreshTotalCount(1, currentVault.value?.id)
  }
}

const handleExpand = (expandedKeys: string[], info: any) => {
  if (isFolderSearchActive.value) {
    searchExpandedKeys.value = expandedKeys
    return
  }
  emit('expand', expandedKeys, info)
}

// 处理双击展开/折叠（使用事件委托）
const handleTreeDoubleClick = (event: MouseEvent): void => {
  const target = event.target as HTMLElement

  // 查找最近的 ant-tree-node-content-wrapper
  const contentWrapper = target.closest('.ant-tree-node-content-wrapper') as HTMLElement
  if (!contentWrapper) return

  // 阻止事件冒泡和默认行为
  event.stopPropagation()
  event.preventDefault()

  // 查找对应的树节点
  const treeNode = contentWrapper.closest('.ant-tree-treenode') as HTMLElement
  if (!treeNode) return

  // 获取节点的 key（从 data-folder-key 属性获取）
  const titleEl = treeNode.querySelector('.tree-node-title') as HTMLElement | null
  const nodeKey = titleEl?.getAttribute('data-folder-key') || ''

  if (!nodeKey) return

  // 检查节点是否有子节点（是否可以展开）
  // 通过查找 switcher 图标来判断是否有子节点
  // 如果 switcher 不存在或者是叶子节点（ant-tree-switcher-noop），则不能展开
  const switcher = treeNode.querySelector('.ant-tree-switcher')
  if (!switcher) return

  // 检查是否是叶子节点（没有子节点或已标记为叶子节点）
  const isLeaf = switcher.classList.contains('ant-tree-switcher-noop')
  if (isLeaf) return

  // 切换展开状态
  const currentExpandedKeys = isFolderSearchActive.value
    ? searchExpandedKeys.value
    : props.expandedKeys
  const isExpanded = currentExpandedKeys.includes(nodeKey)
  const newExpandedKeys = isExpanded
    ? currentExpandedKeys.filter((key) => key !== nodeKey)
    : [...currentExpandedKeys, nodeKey]

  if (isFolderSearchActive.value) {
    searchExpandedKeys.value = newExpandedKeys
    return
  }

  // 触发 expand 事件
  emit('expand', newExpandedKeys, {
    expanded: !isExpanded,
    node: { key: nodeKey }
  })
}

// 处理右键点击
const handleRightClick = ({ event, node }: any) => {
  event.preventDefault()
  currentRightClickNode.value = node.key
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

// 处理右键菜单点击
const handleContextMenuClick = async (key: string, _item: MenuItem) => {
  switch (key) {
    case 'import-to-project': {
      const folderKey = currentRightClickNode.value
      if (!folderKey || folderKey === 'ALL') break
      if (!libraryCaps.value.canEditStructure) {
        await openServerFolderDownload(folderKey)
        break
      }
      const node = findNodeByKey(folderKey)
      if (!node) break
      importProjectSource.value = { ...node, id: folderKey, name: node.title }
      importProjectModalVisible.value = true
      break
    }
    case 'addFolder':
      addFolderForm.parentKey = currentRightClickNode.value
      addFolderForm.name = ''
      addFolderModalVisible.value = true
      break
    case 'rename': {
      const node = findNodeByKey(currentRightClickNode.value!)
      if (node) {
        renameFolderForm.folderKey = currentRightClickNode.value!
        renameFolderForm.name = node.title
        renameFolderModalVisible.value = true
      }
      break
    }
    case 'manageTags':
      if (currentRightClickNode.value) {
        const folderKey = currentRightClickNode.value
        folderTagSelectorKey.value = folderKey
        // 加载当前标签
        folderTagAPI
          .getTagIdsByFolderKey(folderKey)
          .then((ids) => {
            currentFolderTagIds.value = ids || []
            folderTagSelectorVisible.value = true
          })
          .catch(() => {
            currentFolderTagIds.value = []
            folderTagSelectorVisible.value = true
          })
      }
      break
    case 'setColor': {
      // 修改文件夹颜色
      if (currentRightClickNode.value) {
        const folderKey = currentRightClickNode.value
        const node = findNodeByKey(folderKey)
        colorPickerTarget.value = {
          type: 'folder',
          key: folderKey,
          currentColor: node?.color || undefined
        }
        colorPickerVisible.value = true
      }
      break
    }
    case 'reimport':
      if (currentRightClickNode.value) {
        try {
          handleReimportFolder(currentRightClickNode.value)
        } catch (error) {
          message.error(resolveErrorText(error, t('assetTree.messages.repairFolderAssetsFailed')))
        }
      }
      break
    case 'openLocalPath': {
      // 打开网络保管库的本地目录
      if (!currentRightClickNode.value || !currentVault.value?.networkPath) {
        message.error(t('assetLib.contextMenu.openLocalPathFailed'))
        break
      }
      try {
        const folderKey = currentRightClickNode.value
        const browsePhysicalPath = await buildFolderBrowsePath(folderKey)
        if (!browsePhysicalPath) {
          message.warning(getNetworkBrowseUnavailableMessage())
          break
        }

        console.log('[AssetTree] 打开文件夹物理路径:', browsePhysicalPath)
        await openBrowsePath(browsePhysicalPath, {
          openPath: (p) => window.api.shell.openPath(p),
          onNotFound: (p) =>
            message.warning(t('assetLib.contextMenu.openLocalPathNotFound', { path: p }), 8),
          onFailed: (p, err) =>
            message.error(
              t('assetLib.contextMenu.openLocalPathFailedAt', { path: p, error: err }),
              8
            )
        })
      } catch (err) {
        console.error('[AssetTree] 打开本地目录失败:', err)
        message.error(t('assetLib.contextMenu.openLocalPathFailed'))
      }
      break
    }
    case 'delete':
      handleDeleteFolder()
      break
  }
}

// 查找节点
const findNodeByKey = (key: string): TreeNode | null => {
  const findNode = (nodes: TreeNode[]): TreeNode | null => {
    for (const node of nodes) {
      if (node.key === key) return node
      if (node.children) {
        const found = findNode(node.children)
        if (found) return found
      }
    }
    return null
  }
  return findNode(filteredTreeData.value)
}

// 处理保管库管理
const handleManageVaults = () => {
  // 触发保管库管理事件，由父组件处理
  emit('manageVaults')
}

// 处理保管库切换
const handleVaultChanged = async (vault: any) => {
  // 触发保管库切换事件，由父组件处理数据刷新
  emit('vaultChanged', vault)
  // 保管库切换后刷新收藏计数（通知 store）
  await favoriteStore.refreshTotalCount(1, vault?.id || currentVault.value?.id)
}

// 确认添加文件夹
const handleAddFolderConfirm = async () => {
  const trimmedName = addFolderForm.name.trim()

  if (!trimmedName) {
    message.error(t('assetLib.folder.namePlaceholder'))
    return
  }

  // 检查是否为保留名称 "ALL"
  if (trimmedName.toUpperCase() === 'ALL') {
    message.error(t('assetLib.folder.invalidNameAll'))
    return
  }

  // 检查文件夹名称是否包含非法字符
  const invalidChars = /[<>:"/\\|?*]/
  if (invalidChars.test(trimmedName)) {
    message.error(t('assetLib.folder.invalidChars'))
    return
  }

  try {
    await assetContext.addFolder(addFolderForm.parentKey, trimmedName)
    addFolderModalVisible.value = false
  } catch (error) {
    // 只写 console 的话，用户看到的是弹窗还开着、文件夹没出现，不知道是没成功还是没点中
    console.error('添加文件夹失败:', error)
    message.error(t('assetFileList.folder.createFailed'))
  }
}

// 取消添加文件夹
const handleAddFolderCancel = () => {
  addFolderModalVisible.value = false
  addFolderForm.name = ''
  addFolderForm.parentKey = null
}

// 确认重命名文件夹
const handleRenameFolderConfirm = async () => {
  const trimmedName = renameFolderForm.name.trim()

  if (!trimmedName) {
    message.error(t('assetLib.folder.namePlaceholder'))
    return
  }

  // 检查是否为保留名称 "ALL"
  if (trimmedName.toUpperCase() === 'ALL') {
    message.error(t('assetLib.folder.invalidNameAll'))
    return
  }

  // 检查文件夹名称是否包含非法字符
  const invalidChars = /[<>:"/\\|?*]/
  if (invalidChars.test(trimmedName)) {
    message.error(t('assetLib.folder.invalidChars'))
    return
  }

  try {
    await assetContext.renameFolder(renameFolderForm.folderKey, trimmedName)
    renameFolderModalVisible.value = false
  } catch (error) {
    console.error('重命名文件夹失败:', error)
    message.error(t('assetFileList.folder.renameFailed'))
  }
}

// 取消重命名文件夹
const handleRenameFolderCancel = () => {
  renameFolderModalVisible.value = false
  renameFolderForm.name = ''
  renameFolderForm.folderKey = ''
}

// 删除文件夹
const handleDeleteFolder = () => {
  if (!currentRightClickNode.value) return

  const node = findNodeByKey(currentRightClickNode.value)
  if (!node) return

  // 共享库删的是 NAS 上团队共用的目录，硬删除、没有「最近删除」；
  // 本地库是软删除还能恢复。后果不一样，话就得分开说
  const isNetworkVault = vaultStore.currentVault?.vaultType === VaultType.NETWORK

  confirmDialog({
    title: t('assetLib.folder.deleteTitle'),
    content: t(
      isNetworkVault ? 'assetLib.folder.deleteConfirmNetwork' : 'assetLib.folder.deleteConfirm',
      { name: node.title }
    ),
    okText: t('common.delete'),
    cancelText: t('common.cancel'),
    danger: true,
    async onOk() {
      try {
        await assetContext.deleteFolder(currentRightClickNode.value!)
      } catch (error) {
        // 这里以前只 console.error。共享盘上的目录没删成时主进程会放弃整次删除，
        // 用户必须知道「什么都没删掉、可以重试」，否则他会以为删干净了
        console.error('删除文件夹失败:', error)
        message.error(
          t('assetLib.folder.deleteFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      }
    }
  })
}

// 修复文件夹（重新导入）
const handleReimportFolder = async (folderKey: string) => {
  try {
    const loadingMessage = message.loading(t('assetTree.messages.repairingAssets'), 0)
    const res = await assetDataAPI.reimportFolder(folderKey)
    loadingMessage() // 关闭 loading
    if (res.success) {
      message.success(
        t('assetTree.messages.repairDone', { success: res.successCount, failed: res.failed })
      )
      // 刷新列表
      if (props.selectedKeys.includes(folderKey)) {
        // 如果修复的是当前选中的文件夹，刷新列表
        assetContext.refreshCurrentFolder()
      }
    } else {
      message.error(t('assetTree.messages.repairFailedWithError', { error: res.error }))
    }
  } catch (error) {
    message.error(t('assetTree.messages.repairFailed', { error }))
  }
}

// 暴露方法给父组件
defineExpose({
  handleShortcutClick
})

// ========== 拖拽放置处理（从百度网盘拖入资产库） ==========
const dropTargetKey = ref<string | null>(null)
let nodeLeaveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 检查当前保管库是否为备份库
 */
function isBackupVault(): boolean {
  if (!currentVault.value) return false
  return currentVault.value.vaultType === 'backup'
}

// ========== 节点级别的拖拽处理 ==========

/**
 * 节点拖拽悬停处理
 */
function handleNodeDragOver(e: DragEvent): void {
  if (
    e.dataTransfer?.types.includes('application/x-baiduyun-items') ||
    e.dataTransfer?.types.includes('application/json')
  ) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

/**
 * 节点拖拽进入处理
 */
function handleNodeDragEnter(e: DragEvent, key: string): void {
  if (nodeLeaveTimer) {
    clearTimeout(nodeLeaveTimer)
    nodeLeaveTimer = null
  }
  dropTargetKey.value = key

  // 获取拖拽项数量并 emit 事件以显示 DragOverlay
  if (
    e.dataTransfer?.types.includes('application/x-baiduyun-items') ||
    e.dataTransfer?.types.includes('application/json')
  ) {
    try {
      // 从树数据中找到目标节点名称
      const findNodeTitle = (nodes: TreeNode[], targetKey: string): string | null => {
        for (const node of nodes) {
          if (node.key === targetKey) return node.title
          if (node.children) {
            const found = findNodeTitle(node.children, targetKey)
            if (found) return found
          }
        }
        return null
      }
      const targetTitle = findNodeTitle(props.treeData, key) || key

      // 尝试获取拖拽项数量（在 dragenter 时可能无法获取 data，只能获取 types）
      // 我们需要在 BaiduyunFileList 的 dragstart 时存储项数量到一个全局变量或自定义属性
      emit('baiduyun-drag-enter', {
        targetKey: key,
        targetTitle,
        itemCount: 1 // 默认值，实际数量需要从拖拽源获取
      })
    } catch (err) {
      console.warn('获取拖拽信息失败:', err)
    }
  }
}

/**
 * 节点拖拽离开处理
 */
function handleNodeDragLeave(_e: DragEvent, key: string): void {
  // 使用定时器避免在节点内部切换时频繁触发
  if (nodeLeaveTimer) {
    clearTimeout(nodeLeaveTimer)
  }
  nodeLeaveTimer = setTimeout(() => {
    if (dropTargetKey.value === key) {
      dropTargetKey.value = null
      emit('baiduyun-drag-leave')
    }
    nodeLeaveTimer = null
  }, 50)
}

/**
 * 节点拖拽放置处理
 */
async function handleNodeDrop(e: DragEvent, targetKey: string): Promise<void> {
  if (nodeLeaveTimer) {
    clearTimeout(nodeLeaveTimer)
    nodeLeaveTimer = null
  }
  dropTargetKey.value = null
  emit('baiduyun-drag-leave')

  // 检查是否为百度网盘数据
  const baiduyunData = e.dataTransfer?.getData('application/x-baiduyun-items')
  if (baiduyunData) {
    // 检查当前保管库类型
    if (!isBackupVault()) {
      message.warning(t('assetTree.messages.backupVaultRequired'))
      return
    }

    try {
      const parsed = JSON.parse(baiduyunData) as {
        source: string
        items: Array<{
          fs_id: number
          path: string
          server_filename: string
          size: number
          isdir: 0 | 1
        }>
      }

      if (
        parsed.source !== 'baiduyun' ||
        !Array.isArray(parsed.items) ||
        parsed.items.length === 0
      ) {
        return
      }

      // 使用目标节点的 key 作为目标文件夹
      await downloadBaiduyunItemsToVault(parsed.items, targetKey)
    } catch (err) {
      console.error('解析拖拽数据失败:', err)
      message.error(t('assetTree.messages.dragParseFailed'))
    }
    return
  }

  // 检查是否为WebDav数据
  const webdavData = e.dataTransfer?.getData('application/json')
  if (webdavData) {
    try {
      const parsed = JSON.parse(webdavData)
      if (parsed.type === 'webdav-file') {
        await downloadWebdavFileToVault(parsed, targetKey)
      }
    } catch (err) {
      console.error('解析WebDav拖拽数据失败:', err)
      message.error(t('assetTree.messages.dragParseFailed'))
    }
  }
}

/**
 * 从百度网盘下载文件到本地资产库
 */
async function downloadBaiduyunItemsToVault(
  items: Array<{
    fs_id: number
    path: string
    server_filename: string
    size: number
    isdir: 0 | 1
  }>,
  targetFolderKey?: string
): Promise<void> {
  // 获取访问令牌
  const { useBaiduyunStore } = await import('@renderer/store/modules/baiduyun')
  const baiduyunStore = useBaiduyunStore()
  const accessToken = baiduyunStore.token?.accessToken

  if (!accessToken) {
    message.error(t('assetTree.messages.baiduyunNotAuthorized'))
    return
  }

  // 获取保管库路径
  const vaultResult = await (
    window as unknown as {
      api: { invoke: (channel: string) => Promise<{ success: boolean; path?: string }> }
    }
  ).api.invoke('vault:getCurrentPath')
  if (!vaultResult?.success || !vaultResult.path) {
    message.error(t('assetTree.messages.noVaultSelected'))
    return
  }
  const vaultPath = vaultResult.path
  const sep = vaultPath.includes('\\') ? '\\' : '/'

  // 构建目标目录
  let targetRelative = 'assetData'
  const folderKey = targetFolderKey || selectionStore.selectedTreeKey || 'ALL'
  if (folderKey && folderKey !== 'ALL') {
    try {
      const { default: assetFolderAPI } = await import('@renderer/api/assetFolder')
      const folder = await assetFolderAPI.getByKey(folderKey)
      if (folder?.fullPath) {
        const normalized = folder.fullPath.replace(/^[/\\]+/, '').replace(/[\\/]+/g, sep)
        targetRelative = `assetData${sep}${normalized}`
      }
    } catch (err) {
      console.warn('获取文件夹路径失败，使用默认路径', err)
    }
  }
  const targetDir = `${vaultPath}${sep}${targetRelative}`

  // 确保目录存在
  await (
    window as unknown as { api: { invoke: (channel: string, path: string) => Promise<void> } }
  ).api.invoke('fs:ensureDir', targetDir)

  // 批量下载
  const successCount = { files: 0, folders: 0 }
  const failedItems: string[] = []

  for (const item of items) {
    try {
      if (item.isdir === 1) {
        // 文件夹：递归下载（简化处理：暂不支持，提示用户）
        message.info(
          t('assetTree.messages.folderDragDownloadUnsupported', { name: item.server_filename })
        )
        continue
      }

      // 生成下载任务 ID
      const downloadId = `baiduyun-${item.fs_id}-${Date.now()}`
      const filePath = `${targetDir}${sep}${item.server_filename}`

      // 通知父组件添加下载任务（显示占位 item）
      emit('download-task-add', {
        id: downloadId,
        type: 'file',
        name: item.server_filename,
        progress: 0,
        stageText: t('assetTree.stages.preparingDownload'),
        folderKey // 传入目标文件夹 key，用于按目录过滤显示
      })

      // 异步执行下载（不阻塞 UI）
      ;(async () => {
        try {
          emit('download-task-update', downloadId, { stageText: t('assetTree.stages.downloading') })

          const result = await window.api.baiduYun.downloadByFsId({
            downloadId,
            accessToken: accessToken!,
            fsId: item.fs_id,
            filename: item.server_filename,
            savePath: filePath
          })

          if (!result?.success) {
            throw new Error(result?.error || '下载失败')
          }

          // 下载完成，更新状态
          emit('download-task-update', downloadId, {
            progress: 100,
            stageText: t('assetTree.stages.writingIndex')
          })

          // 写入资产索引
          const { default: assetDataAPI } = await import('@renderer/api/assetData')
          try {
            const stats = await (
              window as unknown as {
                api: {
                  getFileStats: (path: string) => Promise<{ size?: number; mtime?: string } | null>
                }
              }
            ).api.getFileStats(filePath)
            const name = filePath.split(/[/\\]/).pop() || filePath
            const fileInfo = {
              name,
              path: filePath,
              type: 'file' as const,
              size: stats?.size ?? null,
              modifiedTime: stats?.mtime ?? new Date().toISOString(),
              depth: 0,
              relativePath: name
            }
            await assetDataAPI.importFolderStructureWithMetadata([fileInfo], 'ALL', folderKey)
          } catch (err) {
            console.warn('写入资产索引失败（可稍后手动导入）:', err)
          }

          // 索引写入完成后立即移除占位符，避免和真实资产同时显示
          // 注意：importFolderStructureWithMetadata 完成后会触发 IPC 事件刷新列表
          // 如果不立即移除占位符，会导致同一个资产显示两次（一个占位符，一个真实资产）
          emit('download-task-complete', downloadId)
          message.success(t('assetTree.messages.downloadCompleted', { name: item.server_filename }))
        } catch (err) {
          console.error(`下载失败: ${item.server_filename}`, err)
          emit('download-task-update', downloadId, {
            stageText: t('assetTree.stages.downloadFailed')
          })
          setTimeout(() => {
            emit('download-task-complete', downloadId)
          }, 2000)
          message.error(t('assetTree.messages.downloadFailed', { name: item.server_filename }))
        }
      })()

      successCount.files++
    } catch (err) {
      console.error(`下载失败: ${item.server_filename}`, err)
      failedItems.push(item.server_filename)
    }
  }

  // 显示启动信息
  if (successCount.files > 0) {
    message.info(t('assetTree.messages.downloadStarted', { count: successCount.files }))
  }
  if (failedItems.length > 0) {
    message.warning(
      t('assetTree.messages.downloadFailedItems', {
        count: failedItems.length,
        names: failedItems.join(', ')
      })
    )
  }
}

/**
 * 从WebDav下载文件到本地资产库
 */
async function downloadWebdavFileToVault(
  webdavFile: {
    serverUrl: string
    username: string
    password: string
    remotePath: string
    basename: string
    size?: number
  },
  targetFolderKey?: string
): Promise<void> {
  // 获取保管库路径
  const vaultResult = await (
    window as unknown as {
      api: { invoke: (channel: string) => Promise<{ success: boolean; path?: string }> }
    }
  ).api.invoke('vault:getCurrentPath')
  if (!vaultResult?.success || !vaultResult.path) {
    message.error(t('assetTree.messages.noVaultSelected'))
    return
  }
  const vaultPath = vaultResult.path
  const sep = vaultPath.includes('\\') ? '\\' : '/'

  // 构建目标目录
  let targetRelative = 'assetData'
  const folderKey = targetFolderKey || selectionStore.selectedTreeKey || 'ALL'
  if (folderKey && folderKey !== 'ALL') {
    try {
      const { default: assetFolderAPI } = await import('@renderer/api/assetFolder')
      const folder = await assetFolderAPI.getByKey(folderKey)
      if (folder?.fullPath) {
        const normalized = folder.fullPath.replace(/^[/\\]+/, '').replace(/[\\/]+/g, sep)
        targetRelative = `assetData${sep}${normalized}`
      }
    } catch (err) {
      console.warn('获取文件夹路径失败，使用默认路径', err)
    }
  }
  const targetDir = `${vaultPath}${sep}${targetRelative}`

  // 确保目录存在
  await (
    window as unknown as { api: { invoke: (channel: string, path: string) => Promise<void> } }
  ).api.invoke('fs:ensureDir', targetDir)

  // 生成唯一文件名
  const fileName = webdavFile.basename || 'download'

  // 工具函数：由于通知栏宽度有限，截断过长的文件名
  const truncate = (str: string, len: number = 20): string => {
    if (str.length <= len) return str
    const extIndex = str.lastIndexOf('.')
    // 如果有扩展名且不太长（通常不超过 6 位），保留扩展名
    if (extIndex > 0 && str.length - extIndex <= 6) {
      const base = str.slice(0, extIndex)
      const ext = str.slice(extIndex)
      return `${base.slice(0, len - ext.length - 3)}...${ext}`
    }
    return `${str.slice(0, len)}...`
  }
  const safeDisplayPath = truncate(fileName)

  // 生成下载任务 ID
  const downloadId = `webdav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  // 异步执行下载（不阻塞 UI）
  ;(async () => {
    try {
      let finalPath = `${targetDir}${sep}${fileName}`

      // 检查文件是否存在，如果存在则添加数字后缀
      for (let i = 0; i < 50; i++) {
        const extIndex = fileName.lastIndexOf('.')
        const base = extIndex > 0 ? fileName.slice(0, extIndex) : fileName
        const ext = extIndex > 0 ? fileName.slice(extIndex) : ''
        const testName = i === 0 ? fileName : `${base} (${i})${ext}`
        const testPath = `${targetDir}${sep}${testName}`

        const existsRes = await (
          window as unknown as {
            api: { invoke: (channel: string, path: string) => Promise<{ exists: boolean }> }
          }
        ).api.invoke('fs:exists', testPath)
        const exists = existsRes?.exists === true

        if (!exists) {
          finalPath = testPath
          break
        }
      }

      // 添加下载任务（显示占位 item）
      emit('download-task-add', {
        id: downloadId,
        type: 'file',
        name: finalPath.split(/[/\\]/).pop() || fileName,
        progress: 0,
        stageText: t('assetTree.stages.waiting'),
        folderKey // 传入目标文件夹 key，用于按目录过滤显示
      })

      // 显示下载提示
      // message.loading({ content: `正在下载 ${safeDisplayPath}...`, key: 'webdav-download' })
      emit('download-task-update', downloadId, { stageText: t('assetTree.stages.downloading') })

      // 调用WebDav下载
      const result = await (
        window as unknown as {
          api: {
            webdav: {
              downloadFile: (params: {
                serverUrl: string
                username: string
                password: string
                remotePath: string
                savePath: string
              }) => Promise<{ success: boolean; error?: string; data?: { localPath: string } }>
            }
          }
        }
      ).api.webdav.downloadFile({
        serverUrl: webdavFile.serverUrl,
        username: webdavFile.username,
        password: webdavFile.password,
        remotePath: webdavFile.remotePath,
        savePath: finalPath
      })

      if (result.success) {
        emit('download-task-update', downloadId, {
          progress: 100,
          stageText: t('assetTree.stages.parsing')
        })

        // 将文件导入到资产数据库
        try {
          const stats = await (
            window as unknown as {
              api: {
                getFileStats: (path: string) => Promise<{ size: number; mtime: string } | undefined>
              }
            }
          ).api.getFileStats(finalPath)
          const name = finalPath.split(/[/\\]/).pop() || fileName
          const safeName = truncate(name)
          const fileInfo = {
            name,
            path: finalPath,
            type: 'file' as const,
            size: stats?.size ?? null,
            modifiedTime: stats?.mtime ?? new Date().toISOString(),
            depth: 0,
            relativePath: name
          }

          const { default: assetDataAPI } = await import('@renderer/api/assetData')
          await assetDataAPI.importFolderStructureWithMetadata([fileInfo], 'ALL', folderKey)

          // 刷新文件夹
          await assetContext.refreshCurrentFolder()

          // message.success({ content: `已下载到资产库：${safeName}`, key: 'webdav-download' })
        } catch (error) {
          console.warn('写入资产索引失败（可稍后手动导入）:', error)
          message.success({
            content: t('assetTree.messages.downloadedRefreshManually'),
            key: 'webdav-download'
          })
        }
        // 索引写入完成后立即移除占位符
        emit('download-task-complete', downloadId)
      } else {
        message.error({
          content:
            result.error || t('assetTree.messages.downloadFailed', { name: safeDisplayPath }),
          key: 'webdav-download'
        })
        emit('download-task-update', downloadId, {
          stageText: t('assetTree.stages.downloadFailed')
        })
        setTimeout(() => {
          emit('download-task-complete', downloadId)
        }, 2000)
      }
    } catch (error) {
      console.error('WebDav文件下载失败:', error)
      const msg =
        error instanceof Error
          ? error.message
          : t('assetTree.messages.downloadFailed', { name: safeDisplayPath })
      message.error({ content: msg, key: 'webdav-download' })
      emit('download-task-update', downloadId, { stageText: t('assetTree.stages.downloadError') })
      setTimeout(() => {
        emit('download-task-complete', downloadId)
      }, 2000)
    }
  })()
}

// 初始化：从持久化 store 恢复快捷高亮（树高亮由父组件通过 selectedKeys 控制）
onMounted(() => {
  if (selectionStore.hasShortcut) {
    selectedShortcut.value = selectionStore.selectedShortcut as string
  }
  // 初始化收藏计数（通知 store）
  void favoriteStore.refreshTotalCount(1, currentVault.value?.id)
})
</script>

<style lang="less" scoped>
.asset-tree {
  height: 100%;
  display: flex;
  flex-direction: column;

  .tree-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface-hover);
    display: flex;
    justify-content: space-between;
    align-items: center;

    h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text-primary);
    }
  }

  // 保管库切换器样式
  .vault-switcher-container {
    padding: 8px;

    background: var(--color-bg-surface);
  }

  // 快捷目录样式
  .shortcuts-section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface);

    .shortcuts-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
      cursor: pointer;
      user-select: none;

      .collapse-icon {
        font-size: 12px;
        color: var(--color-text-muted);
        transition: transform 0.2s;

        &.collapsed {
          transform: rotate(-90deg);
        }
      }

      &::before {
        content: '';
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--gradient-accent);
        box-shadow: 0 0 0 3px var(--color-accent-border);
      }

      .shortcuts-icon {
        font-size: 14px;
        color: var(--color-accent-text);
      }

      .shortcuts-title {
        font-size: 11px;
        font-weight: 700;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
    }

    .shortcuts-list {
      display: flex;
      flex-direction: column;
      gap: 2px;

      .shortcut-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border-radius: var(--radius-xs);
        cursor: pointer;
        transition: all var(--motion-fast) var(--easing-standard);

        &:hover {
          background: var(--color-bg-surface-hover);
        }

        &.disabled {
          cursor: not-allowed;
          color: var(--color-text-disabled);

          &:hover {
            background: transparent;
          }
        }

        // 标签和计数各有自己的文字色，得分别压成禁用色才看得出点不了
        &.disabled .shortcut-label,
        &.disabled .shortcut-badge {
          color: var(--color-text-disabled);
        }

        &.selected {
          background: var(--color-bg-selected);
          color: var(--color-text-primary);

          .shortcut-label {
            color: var(--color-text-primary);
          }

          .shortcut-badge {
            color: var(--color-text-primary);
            background: var(--color-bg-selected);
          }
        }

        .shortcut-label {
          flex: 1;
          font-size: 14px;
          color: var(--color-text-secondary);
        }

        .shortcut-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 18px;
          height: 18px;
          padding: 0 6px;
          margin-left: 8px;
          border-radius: 999px;
          font-size: 11px;
          line-height: 1;
          color: var(--color-accent-text);
          background: var(--color-accent-bg);
          border: 1px solid var(--color-border-subtle);
        }
      }
    }
  }

  // 同步section样式
  .sync-section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface);

    .sync-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
      cursor: pointer;
      user-select: none;

      .collapse-icon {
        font-size: 12px;
        color: var(--color-text-muted);
        transition: transform 0.2s;

        &.collapsed {
          transform: rotate(-90deg);
        }
      }

      &::before {
        content: '';
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--gradient-accent);
        box-shadow: 0 0 0 3px var(--color-accent-border);
      }

      .sync-title {
        font-size: 11px;
        font-weight: 700;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
    }

    .sync-list {
      display: flex;
      flex-direction: column;
      gap: 2px;

      .sync-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border-radius: var(--radius-xs);
        cursor: pointer;
        transition: all var(--motion-fast) var(--easing-standard);

        &:hover {
          background: var(--color-bg-surface-hover);
        }

        &.selected {
          background: var(--color-bg-selected);
          color: var(--color-text-primary);

          .sync-label {
            color: var(--color-text-primary);
          }
        }

        .sync-label {
          flex: 1;
          font-size: 14px;
          color: var(--color-text-secondary);
        }
      }
    }
  }

  // 资产文件夹标题样式
  .folder-section {
    padding: 12px 16px 8px;
    background: var(--color-bg-surface);

    .folder-header {
      display: flex;
      align-items: center;
      gap: 6px;

      &::before {
        content: '';
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--gradient-accent);
        box-shadow: 0 0 0 3px var(--color-accent-border);
      }

      .folder-icon {
        font-size: 14px;
        color: var(--color-accent-text);
      }

      .folder-title {
        font-size: 11px;
        font-weight: 700;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
    }

    .folder-search {
      margin-top: 12px;
      padding: 0 4px;

      :deep(.ant-input-affix-wrapper) {
        background: var(--color-bg-surface-hover);
        border: 1px solid var(--color-border-subtle);
        border-radius: 6px;
        padding: 4px 10px;
        box-shadow: 0 2px 4px var(--shadow-color-weak);
        transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);

        &:hover {
          background: var(--color-bg-surface-hover);
          border-color: var(--color-border);
        }

        &.ant-input-affix-wrapper-focused {
          background: var(--color-bg-surface-hover);
          border-color: var(--color-accent-border);
          box-shadow:
            0 0 0 3px var(--color-accent-border),
            0 2px 6px var(--shadow-color-weak);
        }

        .ant-input {
          background: transparent;
          color: var(--color-text-primary);
          font-size: 13px;

          &::placeholder {
            color: var(--color-text-disabled);
            transition: color 0.3s ease;
          }
        }

        .search-icon {
          color: var(--color-text-muted);
          font-size: 14px;
          transition: color 0.3s ease;
        }

        &.ant-input-affix-wrapper-focused .search-icon {
          color: var(--color-accent-text);
        }

        .ant-input-clear-icon {
          color: var(--color-text-muted);
          transition: color 0.2s ease;
          &:hover {
            color: var(--color-text-primary);
          }
        }
      }
    }
  }

  .tree-content {
    flex: 1;
    padding: 8px 12px;
    overflow-y: auto;
    transition:
      background 0.2s ease,
      box-shadow 0.2s ease;

    // 拖拽目标激活状态
    &.drop-target-active {
      background: var(--color-accent-bg);
      box-shadow: inset 0 0 0 2px var(--color-accent-border);
      border-radius: 8px;
    }

    :deep(.ant-tree) {
      .ant-tree-treenode {
        .ant-tree-node-content-wrapper {
          padding-left: 8px;

          .ant-tree-title {
            padding-left: 0;
          }
        }

        // 子级缩进增加到 16px
        .ant-tree-child-tree {
          .ant-tree-node-content-wrapper {
            padding-left: 24px; // 16px 缩进 + 8px 基础
          }
        }
      }

      // 叶子节点的空 switcher 样式
      .empty-switcher {
        display: inline-block;
        width: 14px; // 与箭头图标宽度一致
      }

      // 隐藏叶子节点的默认文件图标（show-line 模式下的 noop switcher）
      .ant-tree-switcher-noop {
        .ant-tree-switcher-leaf-line {
          display: none !important;
        }

        // 隐藏所有子元素（包括默认的文件图标）
        > * {
          visibility: hidden;
        }
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--color-text-muted);

      .empty-icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.6;
      }

      .empty-text {
        font-size: 16px;
        font-weight: 500;
        margin-bottom: 8px;
      }

      .empty-desc {
        font-size: 14px;
        opacity: 0.8;
      }
    }

    .loading-state {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100px;
    }

    :deep(.ant-tree) {
      background: transparent;
      color: var(--color-text-primary);

      .ant-tree-treenode {
        width: 100%;

        .ant-tree-node-content-wrapper {
          flex: 1;
          border-radius: var(--radius-xs);
          transition: all var(--motion-fast) var(--easing-standard);
          padding: 2px 6px; // 更矮的高度
          user-select: none; // 防止文本选择，确保双击事件能够触发
          cursor: pointer; // 添加指针样式

          &:hover {
            background: var(--color-bg-surface-hover);
          }

          &.ant-tree-node-selected {
            // 选中态有专门的角色色。原来这里是两个近白色的半透明渐变，只在深色底上看得见。
            background: var(--color-bg-selected);
            color: var(--color-text-primary);
            border-radius: 4px; // 更小的圆角
          }

          .tree-node-title {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            margin: -2px -6px; // 抵消父级 padding，扩大可点击/放置区域
            border-radius: var(--radius-xs);
            transition: all 0.15s ease;
            width: calc(100% + 12px); // 扩展到完整宽度

            // 节点拖拽目标高亮
            &.node-drop-target {
              background: var(--color-accent-bg);
              outline: 2px dashed var(--color-border-focus);
              outline-offset: -1px;
            }

            // 子元素不拦截拖拽事件，由父元素统一处理
            .tree-node-icon,
            .tree-node-text {
              pointer-events: none;
            }

            .tree-node-icon {
              position: relative;
              display: flex;
              align-items: center;
              font-size: 14px;

              .folder-icon {
                color: var(--color-folder); // Amber-400: 温暖的黄色实心文件夹
                filter: drop-shadow(0 2px 4px var(--shadow-color)); // 给图标一点立体投影
              }

              // 插件文件夹图标
              .plugin-folder-icon {
                width: 14px;
                height: 14px;
                filter: drop-shadow(0 2px 4px var(--shadow-color));
              }

              // 文件夹类型徽章（居中显示）
              .folder-type-badge {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 40%;
                height: auto;
                max-width: 10px;
                max-height: 10px;
                z-index: 1;
                pointer-events: none;
              }

              // 自定义颜色文件夹 - 使用 CSS 变量覆盖默认颜色
              &.has-custom-color {
                .folder-icon {
                  color: var(--custom-folder-color) !important;
                }
              }
            }

            .tree-node-text {
              flex: 1;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
          }
        }
      }
    }
  }
}

:deep(.app-menu) {
  .danger-item {
    color: var(--color-danger-text);

    &:hover {
      background: var(--color-danger-bg);
    }
  }
}
:deep(.ant-tree-node-content-wrapper.drop-target) {
  background: var(--color-accent-bg);
  border: 2px dashed var(--color-border);
  transform: scale(1.02);
  border-radius: var(--radius-xs);
}

:deep(.ant-tree-treenode.drag-over .ant-tree-node-content-wrapper) {
  background: var(--color-bg-surface-hover);
  border-radius: var(--radius-xs);
  outline: 1px dashed var(--color-border-focus);
}
</style>
