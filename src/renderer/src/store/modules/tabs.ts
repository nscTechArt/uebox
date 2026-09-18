import { defineStore } from 'pinia'
import { ref, computed, watch, nextTick } from 'vue'
import type { RouteLocationNormalized } from 'vue-router'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import { resolveTabRoute } from '../../common/tabRoute'

export interface TabItem {
  key: string
  title: string
  path: string
  sort: number
  fixed?: boolean
  isCanDelete?: boolean
}

/**
 * 一个标签页都没有时的兜底落点 —— 项目库（路由 `/`）。
 *
 * 项目库不再是固定标签页：能关、能拖、能取消固定，和别的页面一视同仁。
 * 「关不掉」和「关光了还有地方去」是两件事，这里只保证后者。
 */
export const DEFAULT_TAB_KEY = '/'

export const useTabsStore = defineStore(
  'tabs',
  () => {
    // 状态
    const historyTabs = ref<TabItem[]>([])

    const activeTab = ref(DEFAULT_TAB_KEY)

    // 标签页访问历史（按访问顺序存储，最后访问的在数组末尾）
    const tabVisitHistory = ref<string[]>([])

    // 迁移旧数据：将硬编码的中文标题更新为多语言键
    const migrateTabTitles = () => {
      // 硬编码标题到多语言键的映射
      const titleMigrationMap: Record<string, string> = {
        // 「首页」改名成「项目库」，键也跟着换了。
        // 老用户 localStorage 里存着旧标题，不迁的话标签上会显示 `menu.home` 这串原文
        'menu.home': 'menu.projectLib',
        首页: 'menu.projectLib',
        资产库: 'menu.assetLib',
        资产依赖关系图: 'menu.assetDependency',
        蓝图库: 'menu.blueprintLib',
        蓝图详情: 'menu.blueprintDetail',
        材质库: 'menu.materialLib',
        材质详情: 'menu.materialDetail',
        共创市场: 'menu.coCreateMarket',
        探索: 'menu.explore',
        资产: 'menu.assets',
        开发者: 'menu.talents',
        个人中心: 'menu.marketConsumer',
        创作者中心: 'menu.marketCreator',
        '3D 查看器': 'menu.modelViewer',
        笔记: 'menu.notes',
        AI会话: 'menu.aiAssistant',
        '和 AGENT 对话': 'menu.newChat',
        工具: 'menu.tools',
        'AI 对话': 'menu.aiChat',
        需求: 'menu.requirements'
      }

      let migrated = false
      historyTabs.value.forEach((tab) => {
        if (titleMigrationMap[tab.title]) {
          tab.title = titleMigrationMap[tab.title]
          migrated = true
        }
      })

      return migrated
    }

    /**
     * 解锁老用户存下来的项目库标签页。
     *
     * `addTab` 只在标签不存在时才按路由 meta 建它，已经躺在 localStorage 里的那个
     * 不会被重新初始化 —— 光把路由 meta 的 `fixed` 改成 false，老用户的项目库
     * 还是关不掉、拖不动。这里按 key 把它就地改回普通标签页。
     */
    const unlockProjectLibTab = (): boolean => {
      let changed = false
      historyTabs.value.forEach((tab) => {
        const isProjectLib =
          tab.key === DEFAULT_TAB_KEY || tab.key === '' || tab.key.startsWith('/home')
        if (!isProjectLib) return
        if (tab.fixed) {
          tab.fixed = false
          changed = true
        }
        if (tab.isCanDelete === false) {
          tab.isCanDelete = true
          changed = true
        }
      })
      return changed
    }

    // 在初始化时执行迁移（持久化数据恢复后还会由 afterHydrate 再跑一次）
    if (historyTabs.value.length > 0) {
      migrateTabTitles()
      unlockProjectLibTab()
    }

    // 计算属性
    //
    // 一律按 sort 排：项目库不再被钉在第一位，它和别的标签页一样能拖走。
    const sortedTabs = computed(() => {
      return [...historyTabs.value].sort((a, b) => a.sort - b.sort)
    })

    /**
     * 应用启动时该落在哪个标签页。
     *
     * 上次关掉应用时开着的标签页会被持久化下来，所以优先回到上次激活的那个；
     * 一个都没留下（比如用户把标签全关了）才落到项目库。
     */
    const resolveStartupTab = (): string => {
      const tabs = sortedTabs.value
      if (tabs.length === 0) return DEFAULT_TAB_KEY
      const lastActive = tabs.find((tab) => tab.key === activeTab.value)
      return (lastActive || tabs[0]).key
    }

    /**
     * 添加标签页
     * 支持嵌套路由：如果子路由的 isShowInTab === false，
     * 则查找父路由中第一个 isShowInTab === true 的路由来创建/激活 tab
     * @returns 成功时返回 tabKey，失败时返回 null
     */
    const addTab = (route: RouteLocationNormalized): string | null => {
      const resolved = resolveTabRoute(route)
      if (!resolved) return null

      const targetMeta = resolved.meta
      const tabKey = resolved.key

      // 使用目标路由的配置
      const tabTitle = (targetMeta.title as string) || route.name?.toString() || route.path

      // 检查是否已存在（使用 tabKey 匹配）
      const existingTab = historyTabs.value.find((tab) => tab.key === tabKey)
      if (!existingTab) {
        historyTabs.value.push({
          key: tabKey,
          title: tabTitle,
          path: tabKey,
          sort: (targetMeta.sort as number) || Math.max(1, historyTabs.value.length),
          fixed: !!targetMeta.fixed || false,
          isCanDelete: targetMeta.isCanDelete !== false
        })
        // 新标签页添加到访问历史
        if (tabVisitHistory.value.indexOf(tabKey) === -1) {
          tabVisitHistory.value.push(tabKey)
        }
      }
      // 注意：不再在 Tab 已存在时覆盖标题
      // 原因：AI助手等模块会动态设置标题（如根据会话内容），
      // 如果在点击 Tab 时用路由的静态 meta.title 覆盖，会导致动态标题丢失

      return tabKey
    }

    // 更新指定路径对应标签页的标题
    const updateTabTitleByPath = (path: string, title: string) => {
      const t = String(title || '').trim()
      if (!t) return false
      const tab = historyTabs.value.find((tab) => tab.key === path)
      if (!tab) return false
      tab.title = t
      return true
    }

    // 设置当前激活的tab
    const setActiveTab = (key: string) => {
      // 更新访问历史：如果key已存在，先移除，然后添加到末尾
      const historyIndex = tabVisitHistory.value.indexOf(key)
      if (historyIndex > -1) {
        tabVisitHistory.value.splice(historyIndex, 1)
      }
      tabVisitHistory.value.push(key)

      activeTab.value = key
    }

    // 删除标签页
    const removeTab = (targetKey: string) => {
      const targetTab = historyTabs.value.find((tab) => tab.key === targetKey)

      // 检查是否可以删除
      if (!targetTab || !targetTab.isCanDelete) {
        return null
      }

      const index = historyTabs.value.findIndex((tab) => tab.key === targetKey)
      if (index > -1) {
        // 从访问历史中找到该标签页的位置（在删除前查找，用于找到前一个标签页）
        const historyIndex = tabVisitHistory.value.indexOf(targetKey)

        // 如果关闭的是当前激活的标签页，需要在删除前找到最近访问的前一个tab
        let newActiveTabKey: string | null = null
        if (targetKey === activeTab.value && historyTabs.value.length > 1) {
          if (historyIndex > 0) {
            // 有前一个访问的标签页，从后往前找第一个仍然存在的标签页
            for (let i = historyIndex - 1; i >= 0; i--) {
              const prevKey = tabVisitHistory.value[i]
              const prevTab = historyTabs.value.find((tab) => tab.key === prevKey)
              if (prevTab) {
                newActiveTabKey = prevKey
                break
              }
            }
          }

          // 如果访问历史中没有找到前一个标签页，则按sort排序选择前一个或后一个
          if (!newActiveTabKey) {
            const sortedTabsList = [...historyTabs.value].sort((a, b) => a.sort - b.sort)
            const currentIndex = sortedTabsList.findIndex((tab) => tab.key === targetKey)

            if (currentIndex > 0) {
              // 有前一个tab，选择前一个
              newActiveTabKey = sortedTabsList[currentIndex - 1].key
            } else if (currentIndex < sortedTabsList.length - 1) {
              // 没有前一个，但有后一个，选择后一个
              newActiveTabKey = sortedTabsList[currentIndex + 1].key
            }
          }
        }

        // 从访问历史中移除该标签页
        if (historyIndex > -1) {
          tabVisitHistory.value.splice(historyIndex, 1)
        }

        // 删除标签页
        historyTabs.value.splice(index, 1)

        // 返回需要切换到的新tab
        return newActiveTabKey
      }

      return null
    }

    // 重新排序标签页
    const reorderTabs = (sourceTabKey: string, targetTabKey: string) => {
      const sourceTab = historyTabs.value.find((t) => t.key === sourceTabKey)
      const targetTab = historyTabs.value.find((t) => t.key === targetTabKey)

      // 固定标签页不参与拖拽排序
      if (sourceTab?.fixed || targetTab?.fixed) {
        return false
      }

      // 重新排序标签页
      const newTabs = [...sortedTabs.value]
      const sourceIndex = newTabs.findIndex((tab) => tab.key === sourceTabKey)
      const targetIndex = newTabs.findIndex((tab) => tab.key === targetTabKey)

      if (sourceIndex !== -1 && targetIndex !== -1) {
        // 移动标签页
        const [movedTab] = newTabs.splice(sourceIndex, 1)
        newTabs.splice(targetIndex, 0, movedTab)

        // 更新sort字段，但保持固定标签页的sort不变
        // 非固定标签页的sort从1开始，确保不与固定标签页的负数sort冲突
        let nonFixedIndex = 1
        const reorderedTabs = newTabs.map((tab) => {
          if (tab.fixed) {
            return { ...tab }
          } else {
            return { ...tab, sort: nonFixedIndex++ }
          }
        })

        historyTabs.value = reorderedTabs
        return true
      }

      return false
    }

    // 清空所有非固定标签页
    const clearNonFixedTabs = () => {
      const fixedTabKeys = historyTabs.value.filter((tab) => tab.fixed).map((tab) => tab.key)
      historyTabs.value = historyTabs.value.filter((tab) => tab.fixed)
      // 从访问历史中移除所有非固定标签页
      tabVisitHistory.value = tabVisitHistory.value.filter((key) => fixedTabKeys.includes(key))
      // 如果当前激活的tab被清除了，切换到第一个固定tab
      if (!historyTabs.value.find((tab) => tab.key === activeTab.value)) {
        const firstFixedTab = historyTabs.value.find((tab) => tab.fixed)
        if (firstFixedTab) {
          activeTab.value = firstFixedTab.key
        }
      }
    }

    // 关闭其他标签页（保留目标标签页和固定标签页）
    const closeOtherTabs = (targetKey: string) => {
      const targetTab = historyTabs.value.find((tab) => tab.key === targetKey)
      if (!targetTab) return null

      // 保留目标标签页和所有固定标签页
      const keptTabKeys = historyTabs.value
        .filter((tab) => tab.key === targetKey || tab.fixed)
        .map((tab) => tab.key)
      historyTabs.value = historyTabs.value.filter((tab) => tab.key === targetKey || tab.fixed)

      // 从访问历史中移除被关闭的标签页
      tabVisitHistory.value = tabVisitHistory.value.filter((key) => keptTabKeys.includes(key))

      // 如果当前激活的tab被关闭了，或者目标tab不是当前激活的，切换到目标tab
      if (
        !historyTabs.value.find((tab) => tab.key === activeTab.value) ||
        activeTab.value !== targetKey
      ) {
        return targetKey
      }
      return null
    }

    // 关闭右侧标签页
    const closeRightTabs = (targetKey: string) => {
      const sortedTabsList = [...sortedTabs.value]
      const targetIndex = sortedTabsList.findIndex((tab) => tab.key === targetKey)
      if (targetIndex === -1) return null

      // 获取目标标签页右侧的所有标签页（不包括固定标签页）
      const tabsToRemove = sortedTabsList
        .slice(targetIndex + 1)
        .filter((tab) => !tab.fixed)
        .map((tab) => tab.key)

      // 移除这些标签页
      historyTabs.value = historyTabs.value.filter((tab) => !tabsToRemove.includes(tab.key))

      // 从访问历史中移除被关闭的标签页
      tabVisitHistory.value = tabVisitHistory.value.filter((key) => !tabsToRemove.includes(key))

      // 如果当前激活的tab被关闭了，切换到目标tab
      if (!historyTabs.value.find((tab) => tab.key === activeTab.value)) {
        return targetKey
      }
      return null
    }

    // 切换标签页固定状态
    const toggleTabFixed = (targetKey: string) => {
      const tab = historyTabs.value.find((tab) => tab.key === targetKey)
      if (!tab) return false

      if (tab.fixed) {
        // 取消固定：将sort设置为非固定标签页的最大值+1
        const maxSort = Math.max(...historyTabs.value.filter((t) => !t.fixed).map((t) => t.sort), 0)
        tab.fixed = false
        tab.sort = maxSort + 1
      } else {
        // 固定：将sort设置为负数，确保排在前面
        const minSort = Math.min(...historyTabs.value.filter((t) => t.fixed).map((t) => t.sort), 0)
        tab.fixed = true
        tab.sort = minSort - 1
      }
      return true
    }

    // 复制标签页（创建新的标签页实例）
    const duplicateTab = (targetKey: string) => {
      const sourceTab = historyTabs.value.find((tab) => tab.key === targetKey)
      if (!sourceTab) return null

      // 创建一个新的标签页，使用唯一的 key（原 path + 时间戳作为查询参数）
      // 这样即使路径相同，也能区分不同的标签页实例
      const timestamp = Date.now()

      // 从被复制的标签页的key中提取tabId（而不是从当前路由）
      // 标签页的key格式可能是：path?_tab_id=xxx 或 path?other=value&_tab_id=xxx
      let sourceTabId = 'default'
      try {
        const url = new URL(sourceTab.key, 'http://dummy')
        const tabIdParam = url.searchParams.get('_tab_id')
        if (tabIdParam) {
          sourceTabId = tabIdParam
        }
      } catch {
        // 如果解析失败，尝试手动解析
        const match = sourceTab.key.match(/[?&]_tab_id=([^&]+)/)
        if (match && match[1]) {
          sourceTabId = match[1]
        }
      }

      // 从被复制的标签页的key中提取基础路径（不包含查询参数）和查询参数（除了_tab_id）
      let basePath = sourceTab.path
      let queryParams = ''

      // 从 sourceTab.key 中提取基础路径（移除所有查询参数）
      try {
        const url = new URL(sourceTab.key, 'http://dummy')
        basePath = url.pathname

        // 提取所有查询参数（除了_tab_id）
        const params: string[] = []
        url.searchParams.forEach((value, key) => {
          if (key !== '_tab_id') {
            params.push(`${key}=${encodeURIComponent(value)}`)
          }
        })
        // 添加新的 _tab_id
        params.push(`_tab_id=${timestamp}`)
        if (params.length > 0) {
          queryParams = `?${params.join('&')}`
        } else {
          queryParams = `?_tab_id=${timestamp}`
        }
      } catch {
        // 如果解析失败，尝试手动解析
        const pathMatch = sourceTab.key.match(/^([^?]+)/)
        if (pathMatch) {
          basePath = pathMatch[1]
        }

        const queryMatch = sourceTab.key.match(/\?(.+)$/)
        if (queryMatch && queryMatch[1]) {
          const existingParams = queryMatch[1]
            .split('&')
            .filter((param) => !param.startsWith('_tab_id='))
          existingParams.push(`_tab_id=${timestamp}`)
          queryParams = `?${existingParams.join('&')}`
        } else {
          queryParams = `?_tab_id=${timestamp}`
        }
      }

      const newTabKey = `${basePath}${queryParams}`
      const newTabPath = newTabKey // path 和 key 保持一致，确保路由系统能识别不同的实例

      // 计算新的 sort 值（放在源标签页后面）
      const sortedTabsList = [...sortedTabs.value]
      const sourceIndex = sortedTabsList.findIndex((tab) => tab.key === targetKey)
      const nextTab = sortedTabsList[sourceIndex + 1]
      const newSort = nextTab ? (nextTab.sort + sourceTab.sort) / 2 : sourceTab.sort + 1

      const newTab: TabItem = {
        key: newTabKey,
        title: sourceTab.title,
        path: newTabPath, // path 包含 _tab_id 参数，确保路由系统创建新的组件实例
        sort: newSort,
        fixed: false, // 复制的标签页不固定
        isCanDelete: sourceTab.isCanDelete
      }

      historyTabs.value.push(newTab)

      // 复制所有 store 的状态到新的 tabId
      const newTabId = String(timestamp)

      // 异步复制状态，避免阻塞
      Promise.all([
        import('../../store/modules/assetViewStore')
          .then(({ useAssetViewStore }) => {
            const assetViewStore = useAssetViewStore()
            // 确保源状态已保存
            const currentMode = assetViewStore.mode
            assetViewStore.setTabId(sourceTabId)
            assetViewStore.setMode(currentMode)
            // 复制状态
            assetViewStore.copyStateToTabId(sourceTabId, newTabId)
          })
          .catch(() => {
            // 如果导入失败，忽略（可能在非资产库页面）
          }),

        import('../../store/modules/assetNavigationStore')
          .then(({ useAssetNavigationStore }) => {
            const navStore = useAssetNavigationStore()
            // 确保源状态已保存
            navStore.setTabId(sourceTabId)
            // 复制状态
            navStore.copyStateToTabId(sourceTabId, newTabId)
          })
          .catch(() => {
            // 如果导入失败，忽略
          }),

        import('../../store/modules/assetSelectionStore')
          .then(({ copySelectionStateToTabId }) => {
            // 复制状态
            copySelectionStateToTabId(sourceTabId, newTabId)
          })
          .catch(() => {
            // 如果导入失败，忽略
          }),

        import('../../store/modules/blueprintLibraryStore')
          .then(({ useBlueprintLibraryStore }) => {
            useBlueprintLibraryStore().copyEditorStateToTabId(sourceTabId, newTabId)
          })
          .catch(() => {
            // 如果导入失败，忽略
          }),

        import('../../store/modules/notebookStore')
          .then(({ useNotebookStore }) => {
            useNotebookStore().copyStateToTabId(sourceTabId, newTabId)
          })
          .catch(() => {
            // 如果导入失败，忽略
          }),

        // 复制树状态
        import('../../views/AssetManagement/utils/tabStateManager')
          .then(({ copyTreeStateToTabId, copyDependencyGraphStateToTabId }) => {
            copyTreeStateToTabId(sourceTabId, newTabId)
            // 复制依赖关系图状态
            copyDependencyGraphStateToTabId(sourceTabId, newTabId)
          })
          .catch(() => {
            // 如果导入失败，忽略（可能在非资产库页面）
          })
      ]).catch(() => {
        // 忽略错误
      })

      return newTabKey
    }

    // 清理 Spotlight 相关的 tab（用于初始化时清理已保存的 Spotlight tab）
    const cleanupSpotlightTabs = () => {
      const beforeCount = historyTabs.value.length
      historyTabs.value = historyTabs.value.filter(
        (tab) => !tab.path.startsWith('/spotlight') && !tab.key.startsWith('/spotlight')
      )
      // 从访问历史中移除 Spotlight 相关的 tab
      tabVisitHistory.value = tabVisitHistory.value.filter((key) => !key.startsWith('/spotlight'))
      // 如果当前激活的 tab 是 Spotlight，切换到项目库
      if (activeTab.value.startsWith('/spotlight')) {
        activeTab.value = DEFAULT_TAB_KEY
      }
      const afterCount = historyTabs.value.length
      if (beforeCount !== afterCount) {
        console.log(`[TabsStore] 清理了 ${beforeCount - afterCount} 个 Spotlight 相关的 tab`)
      }
    }

    // 初始化时清理 Spotlight 相关的 tab
    cleanupSpotlightTabs()

    // 监听 historyTabs 变化，确保在数据恢复后也清理 Spotlight tab
    // 使用 watch 来捕获持久化插件恢复数据后的情况
    let cleanupScheduled = false
    watch(
      historyTabs,
      () => {
        // 只在首次检测到 Spotlight tab 时清理一次，避免无限循环
        if (!cleanupScheduled) {
          const hasSpotlightTab = historyTabs.value.some(
            (tab) => tab.path.startsWith('/spotlight') || tab.key.startsWith('/spotlight')
          )
          if (hasSpotlightTab) {
            cleanupScheduled = true
            nextTick(() => {
              cleanupSpotlightTabs()
              cleanupScheduled = false
            })
          }
        }
      },
      { deep: true, immediate: false }
    )

    /**
     * 清理嵌套路由模块的污染 tab（Notebooks 等）
     * 这些模块的详情页 isShowInTab === false，tab key 应该只是基础路径
     * 但由于某些原因可能被持久化为带 ID 的路径，需要修正
     */
    const cleanupNestedRouteTabs = () => {
      const hasDedicatedTabInstance = (key: string) => key.includes('_tab_id=')

      // 需要清理的嵌套路由模块基础路径
      const nestedRoutePatterns = [{ base: '/notebooks', pattern: /^\/notebooks\/[^/?]+/ }]

      let modified = false

      for (const { base, pattern } of nestedRoutePatterns) {
        // 查找被污染的 tab（key 包含子路由 ID）
        const pollutedTabs = historyTabs.value.filter(
          (tab) => pattern.test(tab.key) && tab.key !== base && !hasDedicatedTabInstance(tab.key)
        )

        if (pollutedTabs.length > 0) {
          // 检查是否已存在基础路径的 tab
          const baseTab = historyTabs.value.find((tab) => tab.key === base)

          if (baseTab) {
            // 已存在基础 tab，删除所有污染的 tabs
            historyTabs.value = historyTabs.value.filter(
              (tab) => !pattern.test(tab.key) || tab.key === base
            )
            console.log(`[TabsStore] 清理了 ${pollutedTabs.length} 个污染的 ${base} tab`)
          } else {
            // 不存在基础 tab，将第一个污染的 tab 修正为基础路径，删除其他的
            const [firstPolluted, ...restPolluted] = pollutedTabs
            if (firstPolluted) {
              firstPolluted.key = base
              firstPolluted.path = base
              console.log(`[TabsStore] 修正 ${base} tab key`)
            }
            // 删除其他污染的 tabs
            if (restPolluted.length > 0) {
              const restKeys = new Set(restPolluted.map((t) => t.key))
              historyTabs.value = historyTabs.value.filter((tab) => !restKeys.has(tab.key))
            }
          }

          // 从访问历史中清理污染的 keys
          tabVisitHistory.value = tabVisitHistory.value.filter(
            (key) => !pattern.test(key) || key === base || hasDedicatedTabInstance(key)
          )

          // 如果当前激活的 tab 是污染的，修正为基础路径
          if (
            pattern.test(activeTab.value) &&
            activeTab.value !== base &&
            !hasDedicatedTabInstance(activeTab.value)
          ) {
            activeTab.value = base
          }

          modified = true
        }
      }

      return modified
    }

    /**
     * Normalize static library tabs so persisted legacy paths do not open the wrong page.
     * These tabs should always point to their canonical list route.
     *
     * 匹配靠 title 而不是 key —— 所以老装机里存下来的 `/blueprint-manager`
     * （那条路由已随旧版画布蓝图库一起删掉）也会在这里被改写成 `/blueprint-library`，
     * 不会变成一个点开是空白的死标签。
     */
    const cleanupLibraryTabs = () => {
      const libraryTabSpecs = [
        {
          title: 'menu.blueprintLib',
          canonicalKey: '/blueprint-library'
        },
        {
          title: 'menu.materialLib',
          canonicalKey: '/material-library'
        }
      ]

      let modified = false

      for (const { title, canonicalKey } of libraryTabSpecs) {
        const matchingTabs = historyTabs.value.filter((tab) => tab.title === title)
        if (matchingTabs.length === 0) continue

        const canonicalTab = matchingTabs.find((tab) => tab.key === canonicalKey)
        const misplacedTabs = matchingTabs.filter((tab) => tab.key !== canonicalKey)

        if (misplacedTabs.length === 0) continue

        if (canonicalTab) {
          const misplacedTabSet = new Set(misplacedTabs)
          historyTabs.value = historyTabs.value.filter((tab) => !misplacedTabSet.has(tab))

          const removableKeys = new Set(
            misplacedTabs
              .map((tab) => tab.key)
              .filter((key) => !historyTabs.value.some((tab) => tab.key === key))
          )
          if (removableKeys.size > 0) {
            tabVisitHistory.value = tabVisitHistory.value.filter((key) => !removableKeys.has(key))
          }
        } else {
          const [firstMisplaced, ...restMisplaced] = misplacedTabs
          if (firstMisplaced) {
            const previousKey = firstMisplaced.key
            firstMisplaced.key = canonicalKey
            firstMisplaced.path = canonicalKey

            const hasOtherTabsUsingPreviousKey = historyTabs.value.some(
              (tab) => tab !== firstMisplaced && tab.key === previousKey
            )
            if (!hasOtherTabsUsingPreviousKey) {
              tabVisitHistory.value = tabVisitHistory.value.map((key) =>
                key === previousKey ? canonicalKey : key
              )
            }

            if (activeTab.value === previousKey) {
              activeTab.value = canonicalKey
            }
          }

          if (restMisplaced.length > 0) {
            const extraTabSet = new Set(restMisplaced)
            historyTabs.value = historyTabs.value.filter((tab) => !extraTabSet.has(tab))

            const removableKeys = new Set(
              restMisplaced
                .map((tab) => tab.key)
                .filter((key) => !historyTabs.value.some((tab) => tab.key === key))
            )
            if (removableKeys.size > 0) {
              tabVisitHistory.value = tabVisitHistory.value.filter((key) => !removableKeys.has(key))
            }
          }
        }

        if (activeTab.value !== canonicalKey) {
          const hasCanonicalTab = historyTabs.value.some((tab) => tab.key === canonicalKey)
          const activeMisplacedTab = misplacedTabs.some((tab) => tab.key === activeTab.value)
          if (hasCanonicalTab && activeMisplacedTab) {
            activeTab.value = canonicalKey
          }
        }

        modified = true
      }

      tabVisitHistory.value = [...new Set(tabVisitHistory.value)]

      return modified
    }

    // 初始化时清理污染的嵌套路由 tabs
    cleanupNestedRouteTabs()
    cleanupLibraryTabs()

    // 监听 historyTabs 变化，也检查嵌套路由污染
    let nestedCleanupScheduled = false
    watch(
      historyTabs,
      () => {
        if (!nestedCleanupScheduled) {
          const hasDedicatedTabInstance = (key: string) => key.includes('_tab_id=')
          const nestedRoutePatterns = [{ base: '/notebooks', pattern: /^\/notebooks\/[^/?]+/ }]

          const hasPollutedTab = historyTabs.value.some((tab) =>
            nestedRoutePatterns.some(
              ({ base, pattern }) =>
                pattern.test(tab.key) && tab.key !== base && !hasDedicatedTabInstance(tab.key)
            )
          )

          if (hasPollutedTab) {
            nestedCleanupScheduled = true
            nextTick(() => {
              cleanupNestedRouteTabs()
              nestedCleanupScheduled = false
            })
          }
        }
      },
      { deep: true, immediate: false }
    )

    let libraryCleanupScheduled = false
    watch(
      historyTabs,
      () => {
        if (libraryCleanupScheduled) return

        const hasMisplacedLibraryTab = historyTabs.value.some(
          (tab) =>
            (tab.title === 'menu.blueprintLib' && tab.key !== '/blueprint-library') ||
            (tab.title === 'menu.materialLib' && tab.key !== '/material-library')
        )

        if (hasMisplacedLibraryTab) {
          libraryCleanupScheduled = true
          nextTick(() => {
            cleanupLibraryTabs()
            libraryCleanupScheduled = false
          })
        }
      },
      { deep: true, immediate: false }
    )

    return {
      // 状态
      historyTabs,
      activeTab,

      // 计算属性
      sortedTabs,

      // 方法
      resolveStartupTab,
      migrateTabTitles,
      unlockProjectLibTab,
      addTab,
      setActiveTab,
      removeTab,
      reorderTabs,
      clearNonFixedTabs,
      updateTabTitleByPath,
      closeOtherTabs,
      closeRightTabs,
      toggleTabFixed,
      duplicateTab,
      cleanupSpotlightTabs,
      cleanupNestedRouteTabs,
      cleanupLibraryTabs
    }
  },
  {
    // 持久化配置
    // 使用类型断言绕过 pinia-plugin-persistedstate 类型定义不完整的问题
    persist: {
      key: 'tabs-store',
      paths: ['historyTabs', 'activeTab'],
      storage: localStorage,
      /**
       * 数据恢复后的钩子
       * 确保在持久化数据被恢复后执行清理逻辑
       */
      afterHydrate: (ctx: { store: Record<string, unknown> }) => {
        console.log('[TabsStore] 持久化数据已恢复，执行清理...')
        // 延迟执行确保 store 完全初始化
        setTimeout(() => {
          const store = ctx.store
          // 标题迁移必须在这里跑：setup 阶段 historyTabs 还是空的，
          // 老数据要等持久化插件恢复完才看得见
          if (typeof store.migrateTabTitles === 'function') {
            ;(store.migrateTabTitles as () => void)()
          }
          // 老数据里的项目库还带着 fixed / isCanDelete=false，就地解锁
          if (typeof store.unlockProjectLibTab === 'function') {
            ;(store.unlockProjectLibTab as () => void)()
          }
          // 调用清理函数
          if (typeof store.cleanupSpotlightTabs === 'function') {
            ;(store.cleanupSpotlightTabs as () => void)()
          }
          if (typeof store.cleanupNestedRouteTabs === 'function') {
            ;(store.cleanupNestedRouteTabs as () => void)()
          }
          if (typeof store.cleanupLibraryTabs === 'function') {
            ;(store.cleanupLibraryTabs as () => void)()
          }
        }, 0)
      }
    } as unknown as boolean
  }
)
