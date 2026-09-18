import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import { StorageUtils } from '../../common/utils/storage'

export type ShortcutKey =
  | 'recent' // 保留 'recent' 作为 'deleted' 的别名，用于兼容
  | 'deleted'
  | 'favorites'
  | 'tagManagement'
  | 'baiduyun'
  | 'webdav'

// 基于标签页的状态存储
const tabStates = new Map<
  string,
  { selectedShortcut: ShortcutKey | null; selectedTreeKey: string | null }
>()

// 导出 tabStates 以便外部访问（用于复制状态）
export function getTabStates() {
  return tabStates
}

// 复制状态到新的 tabId
export function copySelectionStateToTabId(sourceTabId: string, targetTabId: string): void {
  const sourceState = tabStates.get(sourceTabId)
  if (sourceState) {
    tabStates.set(targetTabId, {
      selectedShortcut: sourceState.selectedShortcut,
      selectedTreeKey: sourceState.selectedTreeKey
    })
  }
}

export const useAssetSelectionStore = defineStore(
  'assetSelection',
  () => {
    const selectedShortcut = ref<ShortcutKey | null>(null)
    const selectedTreeKey = ref<string | null>(null)
    const _tabId = ref<string>('default') // 当前标签页 ID

    const hasShortcut = computed(() => !!selectedShortcut.value)
    const hasTreeKey = computed(() => !!selectedTreeKey.value)

    const setTabId = (tabId: string): void => {
      _tabId.value = tabId
      // 恢复该标签页的状态
      const savedState = tabStates.get(tabId)
      if (savedState) {
        selectedShortcut.value = savedState.selectedShortcut
        selectedTreeKey.value = savedState.selectedTreeKey
      } else {
        // 保存当前状态
        tabStates.set(tabId, {
          selectedShortcut: selectedShortcut.value,
          selectedTreeKey: selectedTreeKey.value
        })
      }
    }

    const setShortcut = (shortcut: ShortcutKey | null): void => {
      selectedShortcut.value = shortcut
      // 互斥：选择快捷项时清除树选中
      if (shortcut) {
        selectedTreeKey.value = null
      }
      // 保存当前标签页的状态
      const tabId = _tabId.value || 'default'
      tabStates.set(tabId, {
        selectedShortcut: selectedShortcut.value,
        selectedTreeKey: selectedTreeKey.value
      })
    }

    const setTreeKey = (key: string | null): void => {
      selectedTreeKey.value = key
      // 互斥：选择树节点时清除快捷项
      if (key) {
        selectedShortcut.value = null
      }
      // 保存当前标签页的状态
      const tabId = _tabId.value || 'default'
      tabStates.set(tabId, {
        selectedShortcut: selectedShortcut.value,
        selectedTreeKey: selectedTreeKey.value
      })
    }

    const clear = (): void => {
      selectedShortcut.value = null
      selectedTreeKey.value = null
      // 保存当前标签页的状态
      const tabId = _tabId.value || 'default'
      tabStates.set(tabId, {
        selectedShortcut: null,
        selectedTreeKey: null
      })
    }

    return {
      selectedShortcut,
      selectedTreeKey,
      hasShortcut,
      hasTreeKey,
      setTabId,
      setShortcut,
      setTreeKey,
      clear
    }
  },
  {
    persist: usePersistOptions<{
      selectedShortcut: ShortcutKey | null
      selectedTreeKey: string | null
    }>({
      key: 'asset-selection-store',
      paths: ['selectedShortcut', 'selectedTreeKey'],
      storage: 'localStorage',
      serializer: StorageUtils.createCustomSerializer()
    })
  }
)
