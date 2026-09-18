/**
 * 基于标签页的状态管理器
 * 用于管理组件级别的状态，确保每个标签页的状态独立
 */

// 树状态存储
const treeStates = new Map<
  string,
  {
    selectedKeys: string[]
    expandedKeys: string[]
    currentPath: string
    treeData: any[]
  }
>()

// 依赖关系图状态存储
const dependencyGraphStates = new Map<
  string,
  {
    currentAssetKey: string | undefined
  }
>()

/**
 * 保存树状态
 */
export function saveTreeState(
  tabId: string,
  state: {
    selectedKeys: string[]
    expandedKeys: string[]
    currentPath: string
    treeData: any[]
  }
): void {
  treeStates.set(tabId, {
    selectedKeys: [...state.selectedKeys],
    expandedKeys: [...state.expandedKeys],
    currentPath: state.currentPath,
    treeData: JSON.parse(JSON.stringify(state.treeData)) // 深拷贝
  })
}

/**
 * 恢复树状态
 */
export function restoreTreeState(tabId: string): {
  selectedKeys: string[]
  expandedKeys: string[]
  currentPath: string
  treeData: any[]
} | null {
  const state = treeStates.get(tabId)
  if (state) {
    return {
      selectedKeys: [...state.selectedKeys],
      expandedKeys: [...state.expandedKeys],
      currentPath: state.currentPath,
      treeData: JSON.parse(JSON.stringify(state.treeData)) // 深拷贝
    }
  }
  return null
}

/**
 * 复制树状态到新的 tabId
 */
export function copyTreeStateToTabId(sourceTabId: string, targetTabId: string): void {
  const sourceState = treeStates.get(sourceTabId)
  if (sourceState) {
    treeStates.set(targetTabId, {
      selectedKeys: [...sourceState.selectedKeys],
      expandedKeys: [...sourceState.expandedKeys],
      currentPath: sourceState.currentPath,
      treeData: JSON.parse(JSON.stringify(sourceState.treeData)) // 深拷贝
    })
  }
}

/**
 * 获取所有树状态（用于调试）
 */
export function getAllTreeStates() {
  return treeStates
}

/**
 * 保存依赖关系图状态
 */
export function saveDependencyGraphState(
  tabId: string,
  state: {
    currentAssetKey: string | undefined
  }
): void {
  dependencyGraphStates.set(tabId, {
    currentAssetKey: state.currentAssetKey
  })
}

/**
 * 恢复依赖关系图状态
 */
export function restoreDependencyGraphState(tabId: string): {
  currentAssetKey: string | undefined
} | null {
  const state = dependencyGraphStates.get(tabId)
  if (state) {
    return {
      currentAssetKey: state.currentAssetKey
    }
  }
  return null
}

/**
 * 复制依赖关系图状态到新的 tabId
 */
export function copyDependencyGraphStateToTabId(sourceTabId: string, targetTabId: string): void {
  const sourceState = dependencyGraphStates.get(sourceTabId)
  if (sourceState) {
    dependencyGraphStates.set(targetTabId, {
      currentAssetKey: sourceState.currentAssetKey
    })
  }
}
