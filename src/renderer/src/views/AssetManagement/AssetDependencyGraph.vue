<template>
  <div class="asset-dependency-graph-page">
    <div class="page-header">
      <div class="header-content">
        <h1 class="page-title">{{ $t('assetDependencyGraphPage.header.title') }}</h1>
        <div v-if="assetInfo" class="asset-info">
          <span class="asset-name">{{ assetInfo.assetName }}</span>
          <span class="asset-type">{{
            assetInfo.classNameCn ||
            assetInfo.className ||
            $t('assetDependencyGraphPage.header.defaultAssetType')
          }}</span>
        </div>
      </div>
      <AppButton variant="text" @click="handleClose">
        <template #icon>
          <PhX />
        </template>
        {{ $t('assetDependencyGraphPage.header.close') }}
      </AppButton>
    </div>

    <div class="page-body">
      <div v-if="loadingGraph" class="graph-loading">
        <AppSpin size="large" />
        <div class="loading-text">{{ $t('assetDependencyGraphPage.loading') }}</div>
      </div>
      <div v-else-if="!dependencyGraphData" class="graph-empty">
        <div class="empty-text">{{ $t('assetDependencyGraphPage.empty') }}</div>
      </div>
      <div v-else class="graph-wrapper">
        <!-- 左侧控制面板：只有搜索和层级常驻，调参数的都收进「显示设置」 -->
        <div class="graph-control-panel">
          <div class="control-section">
            <div class="section-title">{{ $t('assetDependencyGraphPage.panel.searchTitle') }}</div>
            <!-- 边打边过滤。旁边的层级/类型筛选都是即时生效的，
                 单给搜索配个按钮说不通 -->
            <a-input
              v-model:value="searchKeyword"
              :placeholder="$t('assetDependencyGraphPage.panel.searchPlaceholder')"
              allow-clear
            >
              <template #prefix>
                <PhMagnifyingGlass />
              </template>
            </a-input>
            <div v-if="searchKeyword.trim() && !searchMatchedNode" class="hint-text hint-warning">
              {{ $t('assetDependencyGraphPage.messages.noMatchingNode') }}
            </div>
          </div>

          <div class="control-section">
            <div class="section-title">
              {{ $t('assetDependencyGraphPage.panel.levelFilterTitle') }}
            </div>
            <!-- 全仓只有这一处成组的复选框，不值得为它做一个 AppCheckboxGroup 组件；
                 直接把「在不在数组里」摊开成每个框自己的 checked/change -->
            <div class="level-filter-group">
              <AppCheckbox
                v-for="level in LEVEL_FILTERS"
                :key="level.value"
                :checked="visibleLevels.includes(level.value)"
                @change="toggleLevel(level.value)"
              >
                {{ $t(level.labelKey) }}
              </AppCheckbox>
            </div>
            <AppButton
              variant="link"
              size="small"
              style="padding: 0; margin-top: 8px"
              @click="handleSelectAllLevels"
            >
              {{ $t('assetDependencyGraphPage.panel.selectAll') }}
            </AppButton>
          </div>

          <div class="control-section">
            <button class="settings-toggle" @click="displaySettingsOpen = !displaySettingsOpen">
              <PhCaretRight class="settings-caret" :class="{ open: displaySettingsOpen }" />
              {{ $t('assetDependencyGraphPage.panel.displaySettingsTitle') }}
            </button>

            <div v-if="displaySettingsOpen" class="settings-body">
              <div class="sub-section">
                <div class="sub-title">
                  {{ $t('assetDependencyGraphPage.panel.typeFilterTitle') }}
                </div>
                <a-select
                  v-model:value="selectedTypes"
                  mode="multiple"
                  :placeholder="$t('assetDependencyGraphPage.panel.typeFilterPlaceholder')"
                  :options="assetTypeOptions"
                  style="width: 100%"
                  :max-tag-count="2"
                />
                <AppButton
                  variant="link"
                  size="small"
                  style="padding: 0; margin-top: 8px"
                  @click="handleClearTypeFilter"
                >
                  {{ $t('assetDependencyGraphPage.panel.clearTypeFilter') }}
                </AppButton>
              </div>

              <div class="sub-section">
                <div class="sub-title">
                  {{ $t('assetDependencyGraphPage.panel.displayOptionsTitle') }}
                </div>
                <AppCheckbox v-model:checked="showThumbnails">{{
                  $t('assetDependencyGraphPage.panel.showThumbnails')
                }}</AppCheckbox>
                <AppCheckbox v-model:checked="showMissingAssets">{{
                  $t('assetDependencyGraphPage.panel.showMissingAssets')
                }}</AppCheckbox>
                <AppCheckbox v-model:checked="enableCollision">{{
                  $t('assetDependencyGraphPage.panel.enableCollision')
                }}</AppCheckbox>
              </div>

              <div class="sub-section">
                <div class="sub-title">
                  {{ $t('assetDependencyGraphPage.panel.maxNodesTitle') }}
                </div>
                <a-input-number
                  v-model:value="maxNodes"
                  :min="10"
                  :max="MAX_NODE_LIMIT"
                  :step="10"
                  style="width: 100%"
                  :placeholder="$t('assetDependencyGraphPage.panel.maxNodesPlaceholder')"
                />
                <div class="hint-text">
                  {{
                    $t('assetDependencyGraphPage.panel.nodeCountHint', {
                      shown: limitedNodes.length,
                      total: totalNodesCount
                    })
                  }}
                </div>
              </div>

              <AppButton variant="default" block @click="handleResetView">
                <template #icon>
                  <PhArrowClockwise />
                </template>
                {{ $t('assetDependencyGraphPage.panel.resetView') }}
              </AppButton>
            </div>
          </div>
        </div>

        <!-- 图表区域 -->
        <div class="graph-content">
          <!-- 节点被截断必须说出来：砍节点会连带砍掉边，图的拓扑是错的，
               不是「少画了几个点」这么轻 -->
          <div v-if="isTruncated" class="truncation-notice">
            <PhWarningCircle class="truncation-icon" />
            <span class="truncation-text">
              {{
                $t('assetDependencyGraphPage.truncated', {
                  shown: limitedNodes.length,
                  total: filteredNodes.length
                })
              }}
            </span>
            <AppButton variant="link" size="small" @click="handleShowAllNodes">
              {{ $t('assetDependencyGraphPage.showAllNodes') }}
            </AppButton>
          </div>

          <AssetDependencyGraph
            ref="graphRef"
            :nodes="limitedNodes"
            :edges="limitedEdges"
            :root-asset-key="currentAssetKey"
            :show-labels="true"
            :show-thumbnails="showThumbnails"
            :enable-collision="enableCollision"
            @node-hover="handleNodeHover"
            @node-double-click="handleNodeDoubleClick"
            @node-click="handleNodeClick"
          />
        </div>
      </div>
    </div>

    <!-- 右下角资产简介框 -->
    <div v-if="displayAsset || assetInfo" class="asset-info-panel">
      <div class="info-panel-header">
        <span class="info-panel-title">
          {{ $t('assetDependencyGraphPage.infoPanel.title') }}
          <!-- 选中之后再悬停别的节点，这个框是不会变的。把「钉住了」说出来，
               并且给条退路，否则用户只会觉得悬停坏了 -->
          <span v-if="selectedAsset" class="info-panel-state">
            {{ $t('assetDependencyGraphPage.infoPanel.pinned') }}
          </span>
        </span>
        <div class="info-panel-actions">
          <AppButton v-if="selectedAsset" variant="link" size="small" @click="handleUnpinAsset">
            {{ $t('assetDependencyGraphPage.infoPanel.unpin') }}
          </AppButton>
          <AppButton
            v-if="!(displayAsset || assetInfo)?.isExternal"
            variant="link"
            size="small"
            class="jump-btn"
            :disabled="!(displayAsset?.folderKey || assetInfo?.folderKey)"
            @click="handleJumpToAssetFolder"
          >
            <template #icon>
              <PhExport />
            </template>
            {{ $t('assetDependencyGraphPage.infoPanel.jumpToFolder') }}
          </AppButton>
        </div>
      </div>
      <div class="info-panel-content">
        <div class="info-item">
          <span class="info-label">{{ $t('assetDependencyGraphPage.infoPanel.nameLabel') }}</span>
          <span class="info-value">{{ (displayAsset || assetInfo)?.assetName || '—' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">{{ $t('assetDependencyGraphPage.infoPanel.typeLabel') }}</span>
          <span class="info-value">{{
            (displayAsset || assetInfo)?.classNameCn ||
            (displayAsset || assetInfo)?.className ||
            '—'
          }}</span>
        </div>
        <div v-if="(displayAsset || assetInfo)?.fileSize" class="info-item">
          <span class="info-label">{{ $t('assetDependencyGraphPage.infoPanel.sizeLabel') }}</span>
          <span class="info-value">{{ formatFileSize((displayAsset || assetInfo).fileSize) }}</span>
        </div>
        <div v-if="(displayAsset || assetInfo)?.softPath" class="info-item">
          <span class="info-label">{{ $t('assetDependencyGraphPage.infoPanel.pathLabel') }}</span>
          <span class="info-value soft-path" :title="(displayAsset || assetInfo)?.softPath">
            {{ (displayAsset || assetInfo)?.softPath }}
          </span>
        </div>
        <div v-if="(displayAsset || assetInfo)?.engineVersion" class="info-item">
          <span class="info-label">{{ $t('assetDependencyGraphPage.infoPanel.engineLabel') }}</span>
          <span class="info-value">{{ (displayAsset || assetInfo)?.engineVersion }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, onMounted, onActivated, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import {
  PhArrowClockwise,
  PhCaretRight,
  PhExport,
  PhMagnifyingGlass,
  PhWarningCircle,
  PhX
} from '@phosphor-icons/vue'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { formatFileSize } from '@renderer/utils/tool'
import AssetDependencyGraph from '@renderer/components/AssetDependencyGraph.vue'
import { saveDependencyGraphState, restoreDependencyGraphState } from './utils/tabStateManager'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const tabsStore = useTabsStore()

// 使用本地状态管理当前资产key，避免路由变化触发新tab
const currentAssetKey = ref<string | undefined>(undefined)
const assetInfo = ref<any>(null)
const dependencyGraphData = ref<{ nodes: any[]; edges: any[] } | null>(null)
const loadingGraph = ref(false)
const hoveredAsset = ref<any>(null)
const selectedAsset = ref<any>(null)
const graphRef = ref<any>(null)

// 过滤控制
const searchKeyword = ref('')
// 三层全开。「引用它的」原来默认不勾，可「谁引用了我」恰恰是判断能不能删、
// 能不能改的关键信息，不该默认藏着
const visibleLevels = ref<number[]>([-1, 0, 1])
/** 调参数的那几项默认收起来，首屏把地方让给图 */
const displaySettingsOpen = ref(false)
const MAX_NODE_LIMIT = 500

/** 层级筛选的三个选项：引用它的 / 它自己 / 它引用的 */
const LEVEL_FILTERS = [
  { value: -1, labelKey: 'assetDependencyGraphPage.panel.levelReferencing' },
  { value: 0, labelKey: 'assetDependencyGraphPage.panel.levelCurrent' },
  { value: 1, labelKey: 'assetDependencyGraphPage.panel.levelReferenced' }
] as const

function toggleLevel(level: number): void {
  const next = new Set(visibleLevels.value)
  if (next.has(level)) next.delete(level)
  else next.add(level)
  visibleLevels.value = [...next]
}
const selectedTypes = ref<string[]>([])
const showThumbnails = ref(true) // 默认显示缩略图
const showMissingAssets = ref(true)
const enableCollision = ref(true) // 默认启用碰撞
const maxNodes = ref(30) // 默认最多显示30个节点

// 计算属性：优先显示选中的资产，然后是悬停的资产，最后是主资产信息
const displayAsset = computed(() => {
  return selectedAsset.value || hoveredAsset.value
})

// 获取所有资产类型选项
const assetTypeOptions = computed(() => {
  if (!dependencyGraphData.value?.nodes) return []
  const types = new Set<string>()
  dependencyGraphData.value.nodes.forEach((node: any) => {
    if (node.classNameCn) {
      types.add(node.classNameCn)
    } else if (node.className) {
      types.add(node.className)
    }
  })
  return Array.from(types).map((type) => ({ label: type, value: type }))
})

// 过滤后的节点
const filteredNodes = computed(() => {
  if (!dependencyGraphData.value?.nodes) return []

  return dependencyGraphData.value.nodes.filter((node: any) => {
    // 层级过滤
    const nodeLevel = node.level ?? 0
    if (!visibleLevels.value.includes(nodeLevel)) {
      return false
    }

    // 类型过滤
    if (selectedTypes.value.length > 0) {
      const nodeType = node.classNameCn || node.className || ''
      if (!selectedTypes.value.includes(nodeType)) {
        return false
      }
    }

    // 缺失资产过滤
    if (!showMissingAssets.value && node.isMissing) {
      return false
    }

    return true
  })
})

// 过滤后的边（只保留两个端点都可见的边）
const filteredEdges = computed(() => {
  if (!dependencyGraphData.value?.edges) return []

  const visibleNodeIds = new Set(filteredNodes.value.map((node: any) => node.id))

  return dependencyGraphData.value.edges.filter((edge: any) => {
    return visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)
  })
})

// 总节点数
const totalNodesCount = computed(() => {
  return dependencyGraphData.value?.nodes?.length || 0
})

// 限制节点数量（优先保留根节点和重要节点）
const limitedNodes = computed(() => {
  const nodes = filteredNodes.value
  if (nodes.length <= maxNodes.value) {
    return nodes
  }

  // 优先保留：根节点、缺失资产、然后按层级排序
  const sortedNodes = [...nodes].sort((a: any, b: any) => {
    // 根节点优先
    if (a.isRoot && !b.isRoot) return -1
    if (!a.isRoot && b.isRoot) return 1
    // 缺失资产其次
    if (a.isMissing && !b.isMissing) return -1
    if (!a.isMissing && b.isMissing) return 1
    // 按层级排序
    const levelA = a.level ?? 0
    const levelB = b.level ?? 0
    return Math.abs(levelA) - Math.abs(levelB)
  })

  return sortedNodes.slice(0, maxNodes.value)
})

// 限制后的边（只保留两个端点都在限制节点中的边）
const limitedEdges = computed(() => {
  const limitedNodeIds = new Set(limitedNodes.value.map((node: any) => node.id))

  return filteredEdges.value.filter((edge: any) => {
    return limitedNodeIds.has(edge.from) && limitedNodeIds.has(edge.to)
  })
})

/** 有没有节点被上限砍掉。砍了就得在图上说出来，不能只在面板角落写一行 */
const isTruncated = computed(() => limitedNodes.value.length < filteredNodes.value.length)

const handleShowAllNodes = (): void => {
  maxNodes.value = Math.min(MAX_NODE_LIMIT, filteredNodes.value.length)
}

/** 边打边找。为空就不找，避免每敲一个字都弹一次提示 */
const searchMatchedNode = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  if (!keyword) return null
  return (
    filteredNodes.value.find((node: any) => {
      const label = (node.label || '').toLowerCase()
      const classNameCn = (node.classNameCn || '').toLowerCase()
      const className = (node.className || '').toLowerCase()
      return label.includes(keyword) || classNameCn.includes(keyword) || className.includes(keyword)
    }) || null
  )
})

watch(searchMatchedNode, (node) => {
  if (node) graphRef.value?.focusNode?.(node.id)
})

// 从路由路径中解析 assetKey 的辅助函数
const getAssetKeyFromRoute = (routePath: string): string | undefined => {
  if (!routePath) return undefined

  // 手动解析查询参数（更可靠）
  const match = routePath.match(/[?&]assetKey=([^&]+)/)
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return match[1]
    }
  }
  return undefined
}

// 加载数据的辅助函数
const loadDataForAssetKey = async (assetKey: string | undefined) => {
  if (!assetKey) return
  currentAssetKey.value = assetKey
  await loadAssetInfo()
  await loadDependencyGraph()
}

// 已移除未使用的 initializeAssetKey 函数，避免类型检查告警

// 处理Tab切换和数据加载的核心函数
const handleTabChange = async () => {
  const tabId = (route.query._tab_id as string) || 'default'
  const routeAssetKey = getAssetKeyFromRoute(route.fullPath)

  console.log('[AssetDependencyGraph] handleTabChange', {
    tabId,
    routeAssetKey,
    currentAssetKey: currentAssetKey.value,
    fullPath: route.fullPath
  })

  // 恢复新标签页的状态
  const savedState = restoreDependencyGraphState(tabId)
  if (savedState && savedState.currentAssetKey) {
    // 如果保存的状态与当前不同，则恢复
    if (savedState.currentAssetKey !== currentAssetKey.value) {
      console.log('[AssetDependencyGraph] 恢复保存的状态:', savedState.currentAssetKey)
      await loadDataForAssetKey(savedState.currentAssetKey)
    }
  } else if (routeAssetKey) {
    // 如果没有保存的状态，先清空当前显示
    if (routeAssetKey !== currentAssetKey.value) {
      console.log('[AssetDependencyGraph] 使用路由参数加载:', routeAssetKey)
      currentAssetKey.value = undefined
      assetInfo.value = null
      dependencyGraphData.value = null
      hoveredAsset.value = null
      selectedAsset.value = null

      // 从当前路由路径中解析 assetKey 并加载
      await loadDataForAssetKey(routeAssetKey)
      // 保存状态
      saveDependencyGraphState(tabId, {
        currentAssetKey: routeAssetKey
      })
    }
  } else {
    // 如果既没有保存状态，也没有路由参数，清空显示
    if (currentAssetKey.value) {
      console.log('[AssetDependencyGraph] 清空显示')
      currentAssetKey.value = undefined
      assetInfo.value = null
      dependencyGraphData.value = null
      hoveredAsset.value = null
      selectedAsset.value = null
    }
  }
}

// 监听 tabId 变化，保存和恢复状态
watch(
  () => route.query._tab_id,
  async (newTabId, oldTabId) => {
    const currentTabId = (newTabId as string) || 'default'
    const previousTabId = oldTabId ? (oldTabId as string) || 'default' : null

    // 保存旧标签页的状态（仅在tabId实际变化且不是首次加载时）
    if (previousTabId !== null && previousTabId !== currentTabId && currentAssetKey.value) {
      saveDependencyGraphState(previousTabId, {
        currentAssetKey: currentAssetKey.value
      })
    }

    // 等待路由完全更新
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 处理Tab切换
    await handleTabChange()
  }
)

// 监听路由完整路径变化，确保能捕获到 assetKey 的变化
watch(
  () => route.fullPath,
  async (newFullPath, oldFullPath) => {
    // 等待路由完全更新
    await nextTick()

    // 如果只是 assetKey 变化，需要重新加载数据
    const newAssetKey = getAssetKeyFromRoute(newFullPath)
    const oldAssetKey = oldFullPath ? getAssetKeyFromRoute(oldFullPath) : undefined

    // 如果 assetKey 真的变化了
    if (newAssetKey && newAssetKey !== oldAssetKey) {
      const tabId = (route.query._tab_id as string) || 'default'

      // 检查是否有保存的状态
      const savedState = restoreDependencyGraphState(tabId)

      // 如果当前显示的 assetKey 与新的不同，需要更新
      if (currentAssetKey.value !== newAssetKey) {
        // 如果保存的状态与新的 assetKey 不同，或者没有保存的状态，则使用新的 assetKey
        if (!savedState || savedState.currentAssetKey !== newAssetKey) {
          // 先清空当前显示
          currentAssetKey.value = undefined
          assetInfo.value = null
          dependencyGraphData.value = null
          hoveredAsset.value = null
          selectedAsset.value = null

          // 加载新的数据
          await loadDataForAssetKey(newAssetKey)
          // 保存状态
          saveDependencyGraphState(tabId, {
            currentAssetKey: newAssetKey
          })
        } else {
          // 如果有保存的状态且与新的 assetKey 相同，使用保存的状态
          await handleTabChange()
        }
      }
    }
  },
  { immediate: false }
)

// 监听 currentAssetKey 变化，自动保存状态
watch(
  () => currentAssetKey.value,
  (newAssetKey) => {
    const tabId = (route.query._tab_id as string) || 'default'
    saveDependencyGraphState(tabId, {
      currentAssetKey: newAssetKey
    })
  }
)

// 加载资产信息
const loadAssetInfo = async () => {
  if (!currentAssetKey.value) return

  try {
    const res = await (window as any).api.database.assetData.getById(currentAssetKey.value)
    if (res?.success && res.data) {
      assetInfo.value = res.data
    }
  } catch (err) {
    console.error('加载资产信息失败:', err)
  }
}

// 加载依赖关系图
const loadDependencyGraph = async () => {
  if (!currentAssetKey.value) {
    message.warning(t('assetDependencyGraphPage.messages.noAssetInfo'))
    return
  }

  loadingGraph.value = true
  dependencyGraphData.value = null

  try {
    const res = await (window as any).api.database.assetData.getAssetDependencyGraph(
      currentAssetKey.value
    )
    if (res?.success && res.data) {
      dependencyGraphData.value = res.data
    } else {
      message.error(res?.error || t('assetDependencyGraphPage.messages.loadFailed'))
      dependencyGraphData.value = null
    }
  } catch (err) {
    console.error('加载依赖关系图异常', err)
    message.error(t('assetDependencyGraphPage.messages.loadFailed'))
    dependencyGraphData.value = null
  } finally {
    loadingGraph.value = false
  }
}

// 获取节点资产信息的辅助函数
const getNodeAssetInfo = async (node: any): Promise<any> => {
  if (!node) return null

  // 缺失的资产不去查库。「缺失的引用」这个说法归 i18n，主进程只给 isMissing
  if (node.isMissing) {
    return {
      assetName: node.label || t('assetDependencyGraphPage.messages.unknownAsset'),
      classNameCn: t('assetDependencyGraphPage.messages.missingReference'),
      softPath: node.softPath || '—',
      fileSize: undefined,
      engineVersion: undefined,
      folderKey: undefined
    }
  }

  try {
    const res = await (window as any).api.database.assetData.getById(node.assetKey || node.id)
    if (res?.success && res.data) {
      return res.data
    }
  } catch (err) {
    console.error('获取资产信息失败:', err)
  }
  return null
}

// Hover节点时更新显示
const handleNodeHover = async (node: any) => {
  if (!node) {
    hoveredAsset.value = null
    return
  }

  hoveredAsset.value = await getNodeAssetInfo(node)
}

// 点击节点时更新选中状态
const handleNodeClick = async (node: any) => {
  if (!node) {
    selectedAsset.value = null
    return
  }

  selectedAsset.value = await getNodeAssetInfo(node)
}

// 双击节点钻取（直接在当前页面更新，不跳转，不更新路由）
const handleNodeDoubleClick = async (node: any) => {
  // 缺失的资产不能钻取
  if (node.isMissing) {
    message.warning(t('assetDependencyGraphPage.messages.assetNotFoundLocally'))
    return
  }

  // 外部依赖不能钻取
  if (node.isExternal) {
    // message.warning('外部引用资产无法下钻')
    return
  }

  const newAssetKey = node.assetKey || node.id
  if (!newAssetKey) {
    message.warning(t('assetDependencyGraphPage.messages.noAssetInfo'))
    return
  }

  // 直接更新本地状态，不更新路由，避免触发新tab
  currentAssetKey.value = newAssetKey

  // 清空选中和悬停状态
  selectedAsset.value = null
  hoveredAsset.value = null

  // 重新加载数据
  await loadAssetInfo()
  await loadDependencyGraph()
  message.success(t('assetDependencyGraphPage.messages.switchedToNewNode'))
}

/** 取消钉住，信息框回到跟随悬停 */
const handleUnpinAsset = (): void => {
  selectedAsset.value = null
}

// 全选层级
const handleSelectAllLevels = () => {
  visibleLevels.value = [-1, 0, 1]
}

// 清除类型过滤
const handleClearTypeFilter = () => {
  selectedTypes.value = []
}

// 重置视图
const handleResetView = () => {
  // 仅重置视图位置，不重置过滤条件
  if (graphRef.value) {
    graphRef.value.resetView?.()
  }
  message.success(t('assetDependencyGraphPage.messages.viewReset'))
}

// 跳转到资产库页面的资产目录
const handleJumpToAssetFolder = async () => {
  const asset = displayAsset.value || assetInfo.value

  if (asset?.isExternal) {
    message.warning(t('assetDependencyGraphPage.messages.externalAssetNotInVault'))
    return
  }

  if (!asset?.folderKey) {
    message.warning(t('assetDependencyGraphPage.messages.noFolderInfo'))
    return
  }

  const folderKey = asset.folderKey

  // 验证文件夹是否存在
  try {
    const folderRes = await (window as any).api.database.assetFolder.getByKey(folderKey)
    if (!folderRes?.success || !folderRes.data) {
      message.error(t('assetDependencyGraphPage.messages.folderNotFound'))
      return
    }
  } catch (err) {
    console.error('验证文件夹失败:', err)
    message.error(t('assetDependencyGraphPage.messages.folderVerifyFailed'))
    return
  }

  // 跳转到资产库页面，并传递folderKey参数
  router.push({
    name: 'AssetManagement',
    query: {
      folderKey: folderKey
    }
  })
}

// 关闭页面（销毁tab）
const handleClose = () => {
  const currentPath = route.fullPath
  const newActiveTabKey = tabsStore.removeTab(currentPath)

  if (newActiveTabKey) {
    tabsStore.setActiveTab(newActiveTabKey)
    router.push(newActiveTabKey)
  } else {
    // 如果没有其他tab，跳转到资产库页面
    router.push({ name: 'AssetManagement' })
  }
}

// 组件挂载时初始化
onMounted(async () => {
  // 延迟执行，确保 watch 已经处理完 tabId 的变化
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await handleTabChange()
})

// 组件激活时（keep-alive 场景）也重新加载
onActivated(async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await handleTabChange()
})
</script>

<style lang="less" scoped>
.asset-dependency-graph-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-surface);
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  background: var(--color-bg-page);
  border-bottom: 1px solid var(--color-border-subtle);

  .header-content {
    display: flex;
    align-items: center;
    gap: 16px;

    .page-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--color-text-primary);
      margin: 0;
    }

    .asset-info {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-left: 16px;
      border-left: 1px solid var(--color-border-subtle);

      .asset-name {
        font-size: 14px;
        color: var(--color-text-primary);
        font-weight: 500;
      }

      .asset-type {
        font-size: 12px;
        color: var(--color-text-secondary);
        padding: 2px 8px;
        background: var(--color-bg-surface-hover);
        border-radius: 4px;
      }
    }
  }
}

.page-body {
  flex: 1;
  overflow: hidden;
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.graph-wrapper {
  display: flex;
  gap: 16px;
  height: 100%;
  overflow: hidden;
}

.graph-control-panel {
  width: 280px;
  flex-shrink: 0;
  background: var(--color-bg-page);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;

  .control-section {
    .section-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--color-text-primary);
      margin-bottom: 8px;
    }

    // 原来是 a-checkbox-group 上的内联 style，拆成普通容器后挪到这里
    .level-filter-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
  }
}

// 「显示设置」折叠组
.settings-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;

  &:hover {
    color: var(--color-accent-text);
  }
}

.settings-caret {
  font-size: 12px;
  color: var(--color-text-muted);
  transition: transform 0.2s ease;

  &.open {
    transform: rotate(90deg);
  }
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 12px;

  .sub-section {
    .sub-title {
      font-size: 12px;
      color: var(--color-text-secondary);
      margin-bottom: 8px;
    }
  }
}

.graph-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

// 节点被砍了就在图上方常驻一条，别让用户以为看到的是全貌
.truncation-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-bottom: 8px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
  font-size: 12px;

  .truncation-icon {
    flex-shrink: 0;
    font-size: 14px;
  }

  .truncation-text {
    flex: 1;
  }
}

.hint-text {
  font-size: 11px;
  color: var(--color-text-secondary);
  margin-top: 4px;

  &.hint-warning {
    color: var(--color-warning-text);
  }
}

.graph-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;

  .loading-text {
    color: var(--color-text-secondary);
    font-size: 14px;
  }
}

.graph-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;

  .empty-text {
    color: var(--color-text-muted);
    font-size: 14px;
  }
}

// 右下角资产简介框
.asset-info-panel {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 320px;
  max-height: 400px;
  background: var(--color-bg-page);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  box-shadow: 0 4px 16px var(--shadow-color);
  backdrop-filter: blur(20px);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  overflow: hidden;

  .info-panel-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface-hover);
    display: flex;
    justify-content: space-between;
    align-items: center;

    .info-panel-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text-primary);
    }

    .info-panel-state {
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--color-accent-bg);
      color: var(--color-accent-text);
      font-size: 11px;
      font-weight: 500;
    }

    .info-panel-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .jump-btn {
      padding: 0;
      height: auto;
      font-size: 12px;
      color: var(--color-text-secondary);

      &:hover {
        color: var(--color-accent-text);
      }

      &:disabled {
        color: var(--color-text-disabled);
        cursor: not-allowed;
      }
    }
  }

  .info-panel-content {
    padding: 12px 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;

    .info-item {
      display: flex;
      flex-direction: column;
      gap: 4px;

      .info-label {
        font-size: 11px;
        color: var(--color-text-secondary);
        font-weight: 500;
      }

      .info-value {
        font-size: 12px;
        color: var(--color-text-primary);
        word-break: break-all;
        line-height: 1.5;

        &.soft-path {
          font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
          font-size: 11px;
          color: var(--color-text-secondary);
          max-height: 60px;
          overflow-y: auto;
        }
      }
    }
  }
}
</style>
