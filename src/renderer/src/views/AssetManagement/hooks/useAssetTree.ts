import { ref, triggerRef } from 'vue'
import type { TreeNode } from '../types'
import assetDataAPI from '@renderer/api/assetData'
import { assetFolderAPI } from '@renderer/api/assetFolder'
import { message } from '@renderer/utils/messageManager'

/**
 * 资产树形菜单 Hook
 * 专门处理文件夹树形结构的展示和交互
 */
export function useAssetTree() {
  // 响应式数据
  const selectedKeys = ref<string[]>([])
  const expandedKeys = ref<string[]>([])
  const currentPath = ref<string>('/')
  const treeData = ref<TreeNode[]>([])
  const loading = ref(false)

  /**
   * 加载根文件夹数据
   * 确保 ALL 文件夹始终排在第一位
   * 使用后端返回的 hasChildren 字段设置 isLeaf
   */
  const loadRootFolders = async () => {
    try {
      loading.value = true
      console.log('[loadRootFolders] 开始加载根文件夹...')
      const folders = await assetFolderAPI.getRootFolders()
      console.log('[loadRootFolders] 获取到的文件夹数据:', folders, '数量:', folders?.length || 0)
      const mappedFolders = (folders || []).map((folder) => ({
        key: folder.folderKey,
        title: folder.folderName,
        type: 'folder' as const,
        folderType: folder.type,
        path: `/${folder.folderName}`,
        color: folder.color,
        img: folder.img, // 插件图标路径
        childrenLoaded: false,
        // 使用后端返回的 hasChildren 判断是否为叶子节点
        isLeaf: folder.hasChildren === false
      }))
      // 将 ALL 文件夹固定排在第一位
      mappedFolders.sort((a, b) => {
        if (a.title === 'ALL') return -1
        if (b.title === 'ALL') return 1
        return 0 // 保持其他文件夹的原有顺序
      })
      treeData.value = mappedFolders

      // 🔧 自动展开 ALL 文件夹并加载其子文件夹
      const allNode = mappedFolders.find((n) => n.key === 'ALL' || n.title === 'ALL')
      if (allNode && !allNode.isLeaf) {
        if (!expandedKeys.value.includes('ALL')) {
          expandedKeys.value = [...expandedKeys.value, 'ALL']
        }
        const children = await loadChildFolders('ALL')
        if (children.length > 0) {
          updateNodeChildren(treeData.value, 'ALL', children)
        } else {
          allNode.childrenLoaded = true
        }
      }
    } catch (error) {
      console.error('加载根文件夹失败:', error)
      treeData.value = []
    } finally {
      loading.value = false
    }
  }

  /**
   * 加载子文件夹数据
   * 使用后端返回的 hasChildren 字段设置 isLeaf
   */
  const loadChildFolders = async (parentKey: string) => {
    try {
      const folders = await assetFolderAPI.getByFatherKey(parentKey)
      return (folders || []).map((folder) => ({
        key: folder.folderKey,
        title: folder.folderName,
        type: 'folder' as const,
        folderType: folder.type,
        path: `${getNodePath(parentKey)}/${folder.folderName}`,
        color: folder.color,
        img: folder.img, // 插件图标路径
        childrenLoaded: false,
        // 使用后端返回的 hasChildren 判断是否为叶子节点
        isLeaf: folder.hasChildren === false
      }))
    } catch (error) {
      console.error('加载子文件夹失败:', error)
      return []
    }
  }

  // 获取节点路径
  const getNodePath = (key: string): string => {
    const node = findNodeByKey(treeData.value, key)
    return node ? node.path : '/'
  }

  // 处理树节点选择
  const handleTreeSelect = async (selectedKeysParam: string[], _info: any) => {
    // 处理清空选中的情况
    if (selectedKeysParam.length === 0) {
      selectedKeys.value = []
      currentPath.value = '/'
      return
    }

    const selectedKey = selectedKeysParam[0]
    if (selectedKey) {
      selectedKeys.value = [selectedKey]
      const node = findNodeByKey(treeData.value, selectedKey)
      if (node) {
        currentPath.value = node.path

        // 如果子节点还没完整加载，尝试加载子节点
        if (!node.childrenLoaded && !node.isLeaf) {
          const children = await loadChildFolders(selectedKey)
          if (children.length > 0) {
            updateNodeChildren(treeData.value, selectedKey, children)
            // 🔧 自动展开选中的文件夹，让子文件夹可见
            if (!expandedKeys.value.includes(selectedKey)) {
              expandedKeys.value = [...expandedKeys.value, selectedKey]
            }
          } else {
            // 没有子文件夹，标记为叶子节点（隐藏展开箭头）
            node.isLeaf = true
            node.childrenLoaded = true
          }
          // 强制触发响应式更新，确保 a-tree 组件检测到深层数据变化
          triggerRef(treeData)
        }
      }
    }
  }

  // 处理树节点展开/收起
  const handleTreeExpand = async (expandedKeysParam: string[], info: any) => {
    expandedKeys.value = expandedKeysParam

    // 如果是展开操作，自动加载子文件夹数据
    if (info.expanded && info.node) {
      const nodeKey = info.node.key
      const node = findNodeByKey(treeData.value, nodeKey)

      // 如果节点存在且还没有完整加载过子节点，则加载子文件夹数据
      if (node && !node.childrenLoaded && !node.isLeaf) {
        try {
          const children = await loadChildFolders(nodeKey)
          updateNodeChildren(treeData.value, nodeKey, children)
          // 如果没有子文件夹，标记为叶子节点（隐藏展开箭头）
          if (children.length === 0) {
            node.isLeaf = true
            node.childrenLoaded = true
          }
          // 强制触发响应式更新，确保 a-tree 组件检测到深层数据变化
          triggerRef(treeData)
        } catch (error) {
          console.error('加载子文件夹失败:', error)
        }
      }
    }
  }

  // 更新节点的子节点
  const updateNodeChildren = (nodes: TreeNode[], key: string, children: TreeNode[]) => {
    for (const node of nodes) {
      if (node.key === key) {
        node.children = children
        node.childrenLoaded = true
        return true
      }
      if (node.children && updateNodeChildren(node.children, key, children)) {
        return true
      }
    }
    return false
  }

  /**
   * 确保某个节点连同它的整条祖先链都已经在树里（必要时从数据库补齐并展开祖先）
   *
   * 后台刚建出来的文件夹（虚幻插件导入会一次建出「版本/项目/包路径」整条链）
   * 在树里一个节点都没有，updateNodeChildren 找不到落点会静默失败 —— 界面看着就是没刷新。
   *
   * @param expandTarget 是否连目标节点一起展开
   */
  const ensureBranchLoaded = async (
    targetFolderKey: string,
    expandTarget = false
  ): Promise<boolean> => {
    const pathChain = await getPathToNode(targetFolderKey)
    if (!pathChain || pathChain.length === 0) {
      console.warn('[ensureBranchLoaded] 无法获取文件夹路径链:', targetFolderKey)
      return false
    }

    // 根节点数据还没加载时先补上，否则祖先无处安放
    if (treeData.value.length === 0) {
      await loadRootFolders()
    }

    for (let i = 0; i < pathChain.length; i++) {
      const currentKey = pathChain[i]
      const isTarget = i === pathChain.length - 1

      await ensureNodeExists(currentKey, i > 0 ? pathChain[i - 1] : null)

      if ((!isTarget || expandTarget) && !expandedKeys.value.includes(currentKey)) {
        expandedKeys.value.push(currentKey)
      }

      const node = findNodeByKey(treeData.value, currentKey)
      if (node && !node.childrenLoaded && !node.isLeaf) {
        const children = await loadChildFolders(currentKey)
        if (children.length > 0) {
          updateNodeChildren(treeData.value, currentKey, children)
        } else {
          node.isLeaf = true
          node.childrenLoaded = true
        }
      }
    }

    triggerRef(treeData)
    return findNodeByKey(treeData.value, targetFolderKey) !== null
  }

  // 新增：刷新指定节点的子节点
  const refreshNodeChildren = async (parentKey: string) => {
    try {
      // 节点本身可能是后台刚创建的，树里还没有它 —— 先把祖先链补齐再刷新
      if (!findNodeByKey(treeData.value, parentKey)) {
        await ensureBranchLoaded(parentKey)
      }

      const children = await loadChildFolders(parentKey)
      updateNodeChildren(treeData.value, parentKey, children)

      // 🔧 修复：刷新后更新父节点的 isLeaf 状态
      // 如果有子节点，父节点不是叶子节点（应该显示展开箭头）
      // 如果没有子节点，父节点是叶子节点（应该隐藏展开箭头）
      const parentNode = findNodeByKey(treeData.value, parentKey)
      if (parentNode) {
        parentNode.isLeaf = children.length === 0
      }
      // 强制触发响应式更新，确保 a-tree 组件检测到深层数据变化
      triggerRef(treeData)
    } catch (error) {
      console.error('刷新子文件夹失败:', error)
    }
  }

  /**
   * 更新指定节点的颜色
   * 用于实时更新树节点颜色，无需刷新整个树
   * @param nodeKey 节点 key
   * @param color 新颜色值，null 表示清除颜色
   */
  const updateNodeColor = (nodeKey: string, color: string | null): boolean => {
    const node = findNodeByKey(treeData.value, nodeKey)
    if (node) {
      node.color = color || undefined
      // 使用 triggerRef 触发响应式更新，避免重建数组导致排序变化
      triggerRef(treeData)
      return true
    }
    return false
  }

  /**
   * 更新指定节点的图标
   * 用于实时更新树节点图标，无需刷新整个树
   * @param nodeKey 节点 key
   * @param img 新图标路径
   */
  const updateNodeImg = (nodeKey: string, img: string): boolean => {
    const node = findNodeByKey(treeData.value, nodeKey)
    if (node) {
      node.img = img
      // 使用 triggerRef 触发响应式更新
      triggerRef(treeData)
      return true
    }
    return false
  }

  // 根据key查找节点
  const findNodeByKey = (nodes: TreeNode[], key: string): TreeNode | null => {
    for (const node of nodes) {
      if (node.key === key) {
        return node
      }
      if (node.children) {
        const found = findNodeByKey(node.children, key)
        if (found) return found
      }
    }
    return null
  }

  // 获取当前路径的面包屑 - 暂时未使用，保留以备后续功能扩展
  // const getBreadcrumbs = (path: string) => {
  //   const parts = path.split('/').filter(Boolean)
  //   const breadcrumbs = [{ name: '项目资产', path: '/' }]

  //   let currentPath = ''
  //   for (const part of parts) {
  //     currentPath += `/${part}`
  //     const node = findNodeByPath(treeData.value, currentPath)
  //     if (node) {
  //       breadcrumbs.push({ name: node.title, path: currentPath })
  //     }
  //   }

  //   return breadcrumbs
  // }

  // 根据路径查找节点
  const findNodeByPath = (nodes: TreeNode[], path: string): TreeNode | null => {
    for (const node of nodes) {
      if (node.path === path) {
        return node
      }
      if (node.children) {
        const found = findNodeByPath(node.children, path)
        if (found) return found
      }
    }
    return null
  }

  // 添加新文件夹
  const addFolder = async (parentKey: string | null, folderName: string) => {
    try {
      // 用户创建的文件夹始终属于 ALL 下面，null 表示在 ALL 根下创建
      const resolvedParentKey = parentKey || 'ALL'
      const folderData = {
        folderKey: `folder_${Date.now()}`,
        fatherKey: resolvedParentKey,
        folderName,
        type: 'normal' as const,
        img: ''
      }

      const createResult = await assetFolderAPI.create(folderData)
      const newFolderKey = createResult.folderKey

      // 构造树节点
      const parentPath = getNodePath(resolvedParentKey)
      const newNode: TreeNode = {
        key: newFolderKey,
        title: folderName,
        type: 'folder',
        path: `${parentPath}/${folderName}`.replace(/\/+/, '/'),
        childrenLoaded: false,
        isLeaf: false
      }

      // 记录添加前是否已有子数据（用于决定是否首次拉取）
      const parentNodeBefore = findNodeByKey(treeData.value, resolvedParentKey)
      const hadChildrenBefore = !!(
        parentNodeBefore &&
        parentNodeBefore.children &&
        parentNodeBefore.children.length > 0
      )

      // 父节点现在有子文件夹了，更新 isLeaf 状态显示箭头
      if (parentNodeBefore && parentNodeBefore.isLeaf) {
        parentNodeBefore.isLeaf = false
      }

      // 若未展开，则先标记为展开（但不强制拉取）
      const isExpanded = expandedKeys.value.includes(resolvedParentKey)
      if (!isExpanded) {
        expandedKeys.value.push(resolvedParentKey)
      }

      if (!hadChildrenBefore) {
        // 首次无子数据：拉取一次子数据（将包含新创建的文件夹）
        const children = await loadChildFolders(resolvedParentKey)
        updateNodeChildren(treeData.value, resolvedParentKey, children)
      } else {
        // 已有子数据：不拉取，只手动追加到 children
        const parentNode = findNodeByKey(treeData.value, resolvedParentKey)
        if (parentNode) {
          if (!parentNode.children) parentNode.children = []
          const exists = parentNode.children.some((c) => c.key === newNode.key)
          if (!exists) parentNode.children.push(newNode)
        }
      }

      // 返回新建文件夹的key
      return newFolderKey
    } catch (error) {
      console.error('添加文件夹失败:', error)
      return null
    }
  }

  // 删除文件夹
  const deleteFolder = async (folderKey: string) => {
    try {
      const result = await assetFolderAPI.delete(folderKey)
      console.log(result)

      if (result.deleted) {
        // 从展开列表中移除
        const expandedIndex = expandedKeys.value.indexOf(folderKey)
        if (expandedIndex !== -1) {
          expandedKeys.value.splice(expandedIndex, 1)
        }

        // 递归从树数据中移除该节点，并返回其父节点key（用于后续联动）
        const removeNodeByKey = (
          nodes: TreeNode[],
          key: string
        ): { removed: boolean; parentKey?: string } => {
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i]
            if (node.key === key) {
              nodes.splice(i, 1)
              return { removed: true }
            }
            if (node.children && node.children.length > 0) {
              const res = removeNodeByKey(node.children, key)
              if (res.removed) {
                return { removed: true, parentKey: node.key }
              }
            }
          }
          return { removed: false }
        }

        const { removed, parentKey: deletedParentKey } = removeNodeByKey(treeData.value, folderKey)
        // 强制触发渲染更新（确保第三方树组件在深层变更时也能立即刷新）
        treeData.value = [...treeData.value]

        // 如果删除后父节点没有子文件夹了，更新父节点的 isLeaf 状态
        if (deletedParentKey) {
          const parentNode = findNodeByKey(treeData.value, deletedParentKey)
          if (parentNode && (!parentNode.children || parentNode.children.length === 0)) {
            parentNode.isLeaf = true
          }
        }

        // 若删除的是当前选中的文件夹，清空选中与路径（右侧列表由外层刷新）
        if (selectedKeys.value.includes(folderKey)) {
          selectedKeys.value = []
          currentPath.value = '/'
        }

        // 保持其他树结构不变，不再全量刷新根节点
        if (removed) {
          return true
        }
      }
      return false
    } catch (error) {
      console.error('删除文件夹失败:', error)
      return false
    }
  }

  // 重命名文件夹
  const renameFolder = async (folderKey: string, newName: string) => {
    try {
      const result = await assetFolderAPI.update(folderKey, { folderName: newName })
      // 库里改成了、共享盘上没改成：这是成功的一种，但得说出来 ——
      // 之后所有资产路径都指向 NAS 上一个已经不存在的目录名
      if (result.warning) {
        message.warning(result.warning.message)
      }
      if (result.updated) {
        const node = findNodeByKey(treeData.value, folderKey)
        if (node) {
          // 更新标题
          node.title = newName

          // 更新路径：保持父路径不变，只替换最后一部分
          const pathParts = node.path.split('/')
          pathParts[pathParts.length - 1] = newName
          const newPath = pathParts.join('/')
          const oldPath = node.path
          node.path = newPath

          // 级联更新所有子节点的路径
          const updateChildPaths = (
            children: TreeNode[] | undefined,
            oldPrefix: string,
            newPrefix: string
          ) => {
            if (!children) return
            for (const child of children) {
              child.path = child.path.replace(oldPrefix, newPrefix)
              updateChildPaths(child.children, oldPrefix, newPrefix)
            }
          }
          updateChildPaths(node.children, oldPath, newPath)

          // 触发响应式更新
          triggerRef(treeData)
        }
        return true
      }
      return false
    } catch (error) {
      console.error('重命名文件夹失败:', error)
      return false
    }
  }

  // 组件挂载时不再自动加载根文件夹，由主组件控制加载时机
  // 这样可以优先渲染界面骨架，提升首屏加载速度

  // 根据文件夹key加载资产数据
  const loadAssetsByFolder = async (
    folderKey: string,
    sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
    sortOrder?: 'asc' | 'desc',
    showDependencies?: boolean,
    limit?: number,
    offset?: number
  ) => {
    try {
      console.log('[loadAssetsByFolder] 开始加载资产, folderKey:', folderKey)
      const assets = await assetDataAPI.getByFolderKey(
        folderKey,
        sortBy,
        sortOrder,
        showDependencies,
        limit,
        offset
      )
      console.log('[loadAssetsByFolder] 获取到资产数量:', assets?.length || 0)
      return assets || []
    } catch (error) {
      console.error('加载文件夹资产失败:', error)
      return []
    }
  }

  // 获取指定文件夹的子文件夹
  const getSubFolders = async (
    folderKey: string,
    sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
    sortOrder?: 'asc' | 'desc',
    limit?: number,
    offset?: number
  ) => {
    try {
      const folders = await assetFolderAPI.getByFatherKey(
        folderKey,
        sortBy,
        sortOrder,
        limit,
        offset
      )
      // 过滤掉 ALL 虚拟文件夹，它只应该出现在树形菜单中，不应该显示在子文件夹列表中
      const filteredFolders = (folders || []).filter((folder) => folder.folderName !== 'ALL')
      return filteredFolders.map((folder) => ({
        key: folder.folderKey,
        title: folder.folderName,
        name: folder.folderName,
        type: 'folder' as const,
        folderType: folder.type,
        path: `${currentPath.value}/${folder.folderName}`,
        id: folder.folderKey,
        isLeaf: false,
        modifiedTime: folder.updated_at || folder.created_at || '',
        extension: '',
        color: folder.color,
        img: folder.img // 插件图标路径
      }))
    } catch (error) {
      console.error('获取子文件夹失败:', error)
      return []
    }
  }

  /**
   * 智能导航到指定文件夹
   * 该方法会：
   * 1. 获取目标文件夹的完整路径链
   * 2. 逐级展开所有父级文件夹并加载其子文件夹
   * 3. 展开目标文件夹并加载其子文件夹
   * 4. 避免重复操作已展开的文件夹
   * 5. 确保树结构的完整性和一致性
   */
  const navigateToFolder = async (
    targetFolderKey: string,
    isCurrent: () => boolean = () => true
  ): Promise<boolean> => {
    try {
      console.log('开始导航到文件夹:', targetFolderKey)

      // 1~6. 补齐并展开整条路径链
      if (!(await ensureBranchLoaded(targetFolderKey, true))) {
        return false
      }

      if (!isCurrent()) return false

      // 7. 选中目标文件夹
      selectedKeys.value = [targetFolderKey]

      // 8. 更新当前路径
      const targetNode = findNodeByKey(treeData.value, targetFolderKey)
      if (targetNode) {
        currentPath.value = targetNode.path
      }

      console.log('成功导航到文件夹:', targetFolderKey)
      return true
    } catch (error) {
      console.error('导航到文件夹失败:', error)
      return false
    }
  }

  /**
   * 确保指定节点在树结构中存在
   * 如果节点不存在，会尝试从数据库加载并添加到树中
   */
  const ensureNodeExists = async (nodeKey: string, parentKey: string | null) => {
    // 检查节点是否已存在
    const existingNode = findNodeByKey(treeData.value, nodeKey)
    if (existingNode) {
      return existingNode
    }

    console.log('节点不存在，尝试加载:', nodeKey)

    try {
      // 从数据库获取节点信息
      const folderData = await assetFolderAPI.getByKey(nodeKey)
      if (!folderData) {
        console.warn('无法从数据库获取节点信息:', nodeKey)
        return null
      }
      const nodePath = parentKey
        ? `${getNodePath(parentKey)}/${folderData.folderName}`
        : `/${folderData.folderName}`
      const newNode: TreeNode = {
        key: folderData.folderKey,
        title: folderData.folderName,
        type: 'folder',
        path: nodePath,
        childrenLoaded: false,
        isLeaf: folderData.hasChildren === false
      }

      // 将节点添加到正确的位置
      // 🔧 修复：只有 ALL 才能放在根级，其他节点必须放到正确的父级下面
      const resolvedParentKey = parentKey || folderData.fatherKey || 'ALL'
      if (folderData.folderKey === 'ALL' || folderData.folderName === 'ALL') {
        // ALL 节点放在根级（避免重复）
        const existsAtRoot = treeData.value.some((n) => n.key === newNode.key)
        if (!existsAtRoot) {
          treeData.value.push(newNode)
        }
      } else {
        // 非 ALL 节点：找到父节点并添加为子级
        const effectiveParent = resolvedParentKey === 'ALL' ? 'ALL' : resolvedParentKey
        const parentNode = findNodeByKey(treeData.value, effectiveParent)
        if (parentNode) {
          if (!parentNode.children) {
            parentNode.children = []
          }
          parentNode.childrenLoaded = false
          // 避免重复添加
          const exists = parentNode.children.some((child) => child.key === nodeKey)
          if (!exists) {
            parentNode.children.push(newNode)
          }
        } else {
          // 父节点不在树中，尝试放到 ALL 下面作为兜底
          const allNode = findNodeByKey(treeData.value, 'ALL')
          if (allNode) {
            if (!allNode.children) allNode.children = []
            allNode.childrenLoaded = false
            const exists = allNode.children.some((child) => child.key === nodeKey)
            if (!exists) {
              allNode.children.push(newNode)
            }
          }
        }
      }

      console.log('成功添加节点到树:', nodeKey)
      return newNode
    } catch (error) {
      console.error('加载节点失败:', nodeKey, error)
      return null
    }
  }

  /**
   * 重置树状态
   * 清空所有展开状态和选中状态，重新加载根数据
   */
  const resetTreeState = async () => {
    expandedKeys.value = []
    selectedKeys.value = []
    currentPath.value = '/'
    treeData.value = []
    await loadRootFolders()
  }

  /**
   * 水合已展开节点的子数据
   * 页面刷新后，expandedKeys 可能被恢复，但 treeData 中对应节点的 children 未加载
   * 此函数遍历所有已展开的 key，确保它们的子节点数据已加载
   */
  const hydrateExpandedNodes = async () => {
    if (expandedKeys.value.length === 0) return

    console.log('[hydrateExpandedNodes] 开始水合展开节点:', expandedKeys.value)

    const pendingKeys = new Set(expandedKeys.value)
    let madeProgress = true

    while (pendingKeys.size > 0 && madeProgress) {
      madeProgress = false

      const sortedKeys = [...pendingKeys].sort((a, b) => {
        const nodeA = findNodeByKey(treeData.value, a)
        const nodeB = findNodeByKey(treeData.value, b)
        const pathLenA = nodeA?.path?.split('/').length ?? Number.MAX_SAFE_INTEGER
        const pathLenB = nodeB?.path?.split('/').length ?? Number.MAX_SAFE_INTEGER
        return pathLenA - pathLenB
      })

      for (const nodeKey of sortedKeys) {
        const node = findNodeByKey(treeData.value, nodeKey)
        if (!node) continue

        pendingKeys.delete(nodeKey)
        madeProgress = true

        // 如果节点存在但子数据还没完整加载，则加载
        if (!node.childrenLoaded && !node.isLeaf) {
          try {
            const children = await loadChildFolders(nodeKey)
            if (children.length > 0) {
              updateNodeChildren(treeData.value, nodeKey, children)
              console.log(
                `[hydrateExpandedNodes] 为节点 ${nodeKey} 加载了 ${children.length} 个子节点`
              )
            } else {
              // 没有子文件夹，标记为叶子节点
              node.isLeaf = true
              node.childrenLoaded = true
            }
          } catch (error) {
            console.error(`[hydrateExpandedNodes] 加载节点 ${nodeKey} 的子数据失败:`, error)
          }
        }
      }
    }

    // 清理无效的展开 keys（节点在 treeData 中不存在的）
    const validExpandedKeys = expandedKeys.value.filter((key) => {
      const node = findNodeByKey(treeData.value, key)
      return node && !node.isLeaf
    })

    if (validExpandedKeys.length !== expandedKeys.value.length) {
      console.log(
        '[hydrateExpandedNodes] 清理无效展开 keys:',
        expandedKeys.value.filter((k) => !validExpandedKeys.includes(k))
      )
      expandedKeys.value = validExpandedKeys
    }

    console.log('[hydrateExpandedNodes] 水合完成')
  }

  /**
   * 批量展开多个文件夹路径
   * 适用于需要同时展开多个文件夹的场景
   */
  const batchNavigateToFolders = async (folderKeys: string[]) => {
    const results: Array<{ folderKey: string; success: boolean }> = []
    for (const folderKey of folderKeys) {
      const result = await navigateToFolder(folderKey)
      results.push({ folderKey, success: result })
    }
    return results
  }

  // 递归获取从根节点到目标节点的路径（高效版本）
  const getPathToNode = async (targetFolderKey: string): Promise<string[]> => {
    console.log('getPathToNode 开始执行，目标文件夹:', targetFolderKey)

    // 🔧 修复：如果目标是 ALL 文件夹，直接返回 ['ALL']
    // 原因：ALL 是虚拟根节点，部分情况下 DB 中它可能没有完整的 pathArray 数据，导致导航解析出空路径从而报错
    if (targetFolderKey === 'ALL') {
      return ['ALL']
    }

    try {
      // 使用新的高效API获取路径数组
      const pathArray = await assetFolderAPI.getPathArray(targetFolderKey)
      console.log('获取到路径数组:', pathArray)

      // 🔧 修复：pathArray 为空时也需要回退到递归方式
      // 原因：部分导入的文件夹在数据库中 pathArray 字段为 NULL，API 会返回 []
      if (pathArray && pathArray.length > 0) {
        return pathArray
      }
      console.warn('pathArray 为空，回退到递归方式获取路径')
    } catch (error) {
      console.error('获取节点路径失败，回退到递归方式:', error)
    }

    // 回退：通过 fatherKey 链递归构建路径
    try {
      const folderData = await assetFolderAPI.getByKey(targetFolderKey)
      console.log('获取到文件夹数据:', folderData)

      if (!folderData) {
        console.log('文件夹数据为空，返回空路径')
        return []
      }

      // 如果是根节点或 fatherKey 为 ALL，返回合适的路径
      if (!folderData.fatherKey || folderData.fatherKey === 'ALL') {
        console.log('到达根节点，返回路径:', ['ALL', targetFolderKey])
        return ['ALL', targetFolderKey]
      }

      // 递归获取父节点路径
      console.log('递归获取父路径，父节点:', folderData.fatherKey)
      const parentPath = await getPathToNode(folderData.fatherKey)
      const fullPath = [...parentPath, targetFolderKey]
      console.log('getPathToNode 完成，完整路径:', fullPath)
      return fullPath
    } catch (fallbackError) {
      console.error('回退方式也失败:', fallbackError)
      return []
    }
  }

  return {
    // 响应式数据
    treeData,
    selectedKeys,
    expandedKeys,
    currentPath,
    loading,

    // 方法
    handleTreeSelect,
    handleTreeExpand,
    findNodeByKey: (key: string) => findNodeByKey(treeData.value, key),
    findNodeByPath,
    loadRootFolders,
    loadAssetsByFolder,
    getSubFolders,
    addFolder,
    deleteFolder,
    renameFolder,

    // 新的导航方法
    navigateToFolder,
    ensureNodeExists,
    resetTreeState,
    batchNavigateToFolders,

    // 新增：刷新指定节点的子节点
    refreshNodeChildren,

    // 新增：更新节点颜色（用于实时更新）
    updateNodeColor,
    // 新增：更新节点图标
    updateNodeImg,

    // 新增：水合已展开节点的子数据（用于页面刷新后恢复）
    hydrateExpandedNodes,

    // 保留原有方法以兼容现有代码
    expandToPath: navigateToFolder
  }
}
