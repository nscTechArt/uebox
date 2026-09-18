import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useStudioOutputStore } from './studioOutputStore'

/**
 * 保管库类型枚举
 */
export enum VaultType {
  REFERENCE = 'reference', // 引用类型
  BACKUP = 'backup', // 备份类型
  NETWORK = 'network' // 网络协作库
}

/**
 * 保管库信息接口
 */
export interface VaultInfo {
  id: string
  name: string
  description?: string
  path: string
  isSystem: boolean
  systemKey?: 'default' | 'aigc'
  isCustomLocation: boolean
  isActive: boolean
  vaultType: VaultType
  icon: string
  sortOrder: number
  assetCount: number
  totalSize: number
  diskInfo?: {
    totalSpace: number
    freeSpace: number
    usedSpace: number
  }
  createdAt: string
  updatedAt: string
  networkMigrationState?: 'ready' | 'legacy_pending'
  // 网络库专用字段
  networkPath?: string
  browsePath?: string
  requiresAuth?: boolean
  syncStatus?: 'synced' | 'syncing' | 'conflict' | 'offline' | 'error'
  lastSyncAt?: string
}

/**
 * 保管库创建配置
 */
export interface CreateVaultConfig {
  name: string
  description?: string
  customPath?: string
  isSystem?: boolean
  systemKey?: 'default' | 'aigc'
  vaultType?: VaultType
  icon?: string
  sortOrder?: number
  // 网络库专用
  networkPath?: string
  browsePath?: string
}

/**
 * 保管库状态管理
 */
export const useVaultStore = defineStore('vault', () => {
  // 状态
  const vaults = ref<VaultInfo[]>([])
  const currentVault = ref<VaultInfo | null>(null)
  const loading = ref(false)
  const switching = ref(false)

  // 计算属性
  const sortedVaults = computed(() => {
    return [...vaults.value].sort((a, b) => {
      // 首先按照sortOrder排序
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder
      }
      // 如果sortOrder相同，按照创建时间排序
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
  })
  const hasVaults = computed(() => vaults.value.length > 0)
  const activeVaultId = computed(() => currentVault.value?.id || null)
  const vaultCount = computed(() => vaults.value.length)

  /**
   * 加载所有保管库
   */
  const loadVaults = async (): Promise<void> => {
    try {
      loading.value = true
      const result = await window.api.invoke('vault:getAll')

      if (result.success) {
        vaults.value = result.data || []

        // 更新当前保管库信息
        const activeVault = vaults.value.find((v) => v.isActive)
        if (activeVault) {
          currentVault.value = activeVault
        }
      } else {
        console.error('加载保管库列表失败:', result.error)
        throw new Error(result.error)
      }
    } catch (error) {
      console.error('加载保管库失败:', error)
      throw error
    } finally {
      loading.value = false
    }
  }

  /**
   * 创建保管库
   */
  const createVault = async (config: CreateVaultConfig): Promise<VaultInfo> => {
    try {
      loading.value = true
      const result = await window.api.invoke('vault:create', config)

      if (result.success) {
        const newVault = result.data
        vaults.value.unshift(newVault)
        return newVault
      } else {
        throw new Error(result.error)
      }
    } catch (error) {
      console.error('创建保管库失败:', error)
      throw error
    } finally {
      loading.value = false
    }
  }

  /**
   * 换库了，把「按保管库存」的那些内存缓存清掉。
   *
   * 知识库产出存在 `<保管库>/Notebook/<id>/outputs.json`，切库之后内存里那份
   * 属于上一个库。不清的话用户会在新库里看到旧库的产出，而且再生成一份就会
   * 把旧库那些一起写进新库的目录。
   *
   * 同步调、顶部 import：这是防串库的那道闸，不能是个「失败了只在控制台留一行」的
   * 异步动作，也不该让紧跟其后的 `loadNotebook` 和它抢。
   * （`studioOutputStore` 的依赖只有 pinia、vue 和一个自己不 import 任何东西的
   * api 模块，顶部引进来没有启动开销可省。）
   */
  const dropVaultScopedCaches = (): void => {
    useStudioOutputStore().resetForVaultSwitch()
  }

  /**
   * 切换保管库
   */
  const switchVault = async (vaultId: string): Promise<void> => {
    try {
      switching.value = true
      const result = await window.api.invoke('vault:switch', vaultId)

      if (result.success) {
        // 更新本地状态
        vaults.value.forEach((vault) => {
          vault.isActive = vault.id === vaultId
        })

        const newActiveVault = vaults.value.find((v) => v.id === vaultId)
        if (newActiveVault) {
          currentVault.value = newActiveVault
        }
        dropVaultScopedCaches()
      } else {
        // 使用返回的具体错误信息
        throw new Error(result.error || '切换保管库失败')
      }
    } catch (error) {
      console.error('切换保管库失败:', error)
      throw error
    } finally {
      switching.value = false
    }
  }

  /**
   * 主进程那边把活跃库换了（agent 的 switch_vault、网络库迁移）时跟上。
   *
   * 不重新 invoke `vault:switch` —— 库那边已经切完了，再切一次是白跑一遍
   * 连接开关和网络服务重启。这里只把界面的状态对齐。
   */
  const applyExternalVaultSwitch = (vaultId: string): void => {
    if (!vaults.value.some((v) => v.id === vaultId)) return

    vaults.value.forEach((vault) => {
      vault.isActive = vault.id === vaultId
    })
    currentVault.value = vaults.value.find((v) => v.id === vaultId) ?? currentVault.value
    dropVaultScopedCaches()
  }

  /**
   * 重命名保管库
   */
  const renameVault = async (vaultId: string, newName: string): Promise<void> => {
    try {
      loading.value = true
      const result = await window.api.invoke('vault:rename', vaultId, newName)

      if (result.success) {
        // 更新本地状态
        const vault = vaults.value.find((v) => v.id === vaultId)
        if (vault) {
          vault.name = newName
        }

        // 如果重命名的是当前保管库，同步更新
        if (currentVault.value?.id === vaultId) {
          currentVault.value.name = newName
        }
      } else {
        throw new Error(result.error)
      }
    } catch (error) {
      console.error('重命名保管库失败:', error)
      throw error
    } finally {
      loading.value = false
    }
  }

  /**
   * 更新保管库图标
   */
  const updateVaultIcon = async (vaultId: string, iconPath: string): Promise<void> => {
    try {
      loading.value = true
      const result = await window.api.invoke('vault:updateIcon', vaultId, iconPath)

      if (result.success) {
        // 更新本地状态
        const vault = vaults.value.find((v) => v.id === vaultId)
        if (vault) {
          vault.icon = iconPath
        }

        // 如果更新的是当前保管库，同步更新
        if (currentVault.value?.id === vaultId) {
          currentVault.value.icon = iconPath
        }
      } else {
        throw new Error(result.error)
      }
    } catch (error) {
      console.error('更新保管库图标失败:', error)
      throw error
    } finally {
      loading.value = false
    }
  }

  /**
   * 更新网络保管库的共享浏览路径
   */
  const updateVaultBrowsePath = async (vaultId: string, browsePath?: string): Promise<void> => {
    try {
      loading.value = true
      const normalizedBrowsePath = browsePath?.trim() || undefined
      const result = await window.api.invoke(
        'vault:updateBrowsePath',
        vaultId,
        normalizedBrowsePath
      )

      if (result.success) {
        const vault = vaults.value.find((v) => v.id === vaultId)
        if (vault) {
          vault.browsePath = normalizedBrowsePath
        }

        if (currentVault.value?.id === vaultId) {
          currentVault.value.browsePath = normalizedBrowsePath
        }
      } else {
        throw new Error(result.error)
      }
    } catch (error) {
      console.error('更新共享浏览路径失败:', error)
      throw error
    } finally {
      loading.value = false
    }
  }

  /**
   * 更新网络保管库连接地址
   */
  const updateVaultNetworkPath = async (
    vaultId: string,
    networkPath: string
  ): Promise<{ networkError?: string }> => {
    try {
      loading.value = true
      const normalizedNetworkPath = networkPath.trim()
      const result = await window.api.invoke(
        'vault:updateNetworkPath',
        vaultId,
        normalizedNetworkPath
      )

      if (result.success) {
        await loadVaults()
        return result.data || {}
      } else {
        throw new Error(result.error)
      }
    } catch (error) {
      console.error('更新网络保管库地址失败:', error)
      throw error
    } finally {
      loading.value = false
    }
  }

  /**
   * 移动保管库
   */
  const moveVault = async (vaultId: string, newParentPath: string): Promise<void> => {
    try {
      loading.value = true
      const result = await window.api.invoke('vault:move', vaultId, newParentPath)

      if (result.success) {
        // 重新加载列表以获取新路径
        await loadVaults()
      } else {
        throw new Error(result.error)
      }
    } catch (error) {
      console.error('移动保管库失败:', error)
      throw error
    } finally {
      loading.value = false
    }
  }

  /**
   * 删除保管库
   */
  const deleteVault = async (vaultId: string): Promise<void> => {
    try {
      loading.value = true
      const result = await window.api.invoke('vault:delete', vaultId)

      if (result.success) {
        // 重新加载列表以确保状态同步（特别是可能发生的自动切换）
        await loadVaults()
      } else {
        throw new Error(result.error)
      }
    } catch (error) {
      console.error('删除保管库失败:', error)
      throw error
    } finally {
      loading.value = false
    }
  }

  /**
   * 获取保管库统计信息
   */
  const getVaultStats = async (
    vaultId: string
  ): Promise<{ assetCount: number; totalSize: number }> => {
    try {
      const result = await window.api.invoke('vault:getStats', vaultId)

      if (result.success) {
        return result.data
      } else {
        throw new Error(result.error)
      }
    } catch (error) {
      console.error('获取保管库统计失败:', error)
      return { assetCount: 0, totalSize: 0 }
    }
  }

  /**
   * 刷新保管库信息
   */
  const refreshVaults = async (): Promise<void> => {
    await loadVaults()
  }

  /**
   * 清理未使用的缩略图缓存
   */
  const cleanThumbnailCache = async (): Promise<{
    success: boolean
    deletedCount?: number
    freedBytes?: number
    error?: string
  }> => {
    try {
      const result = await window.api.invoke('vault:cleanThumbnailCache')

      if (result.success && result.data) {
        return {
          success: true,
          deletedCount: result.data.deletedCount,
          freedBytes: result.data.freedBytes
        }
      } else {
        return {
          success: false,
          error: result.error
        }
      }
    } catch (error) {
      console.error('清理缩略图缓存失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 根据ID获取保管库
   */
  const getVaultById = (vaultId: string): VaultInfo | undefined => {
    return vaults.value.find((v) => v.id === vaultId)
  }

  /**
   * 搜索保管库
   */
  const searchVaults = (keyword: string): VaultInfo[] => {
    if (!keyword.trim()) {
      return vaults.value
    }

    const lowerKeyword = keyword.toLowerCase()
    return vaults.value.filter(
      (vault) =>
        vault.name.toLowerCase().includes(lowerKeyword) ||
        (vault.description && vault.description.toLowerCase().includes(lowerKeyword))
    )
  }

  /**
   * 更新保管库排序
   */
  const updateVaultOrder = async (vaultIds: string[]): Promise<void> => {
    try {
      // 更新本地状态中的排序
      const updatedVaults = vaultIds
        .map((id, index) => {
          const vault = vaults.value.find((v) => v.id === id)
          if (vault) {
            return { ...vault, sortOrder: index }
          }
          return vault
        })
        .filter(Boolean) as VaultInfo[]

      // 保持其他未在排序列表中的保管库
      const remainingVaults = vaults.value.filter((v) => !vaultIds.includes(v.id))

      // 合并并更新状态
      vaults.value = [...updatedVaults, ...remainingVaults]

      // 调用后端API保存排序
      await window.electronAPI.vaultManager.updateVaultOrder(vaultIds)
    } catch (error) {
      console.error('更新保管库排序失败:', error)
      throw error
    }
  }

  /**
   * 重置状态
   */
  const resetState = (): void => {
    vaults.value = []
    currentVault.value = null
    loading.value = false
    switching.value = false
  }

  return {
    // 状态
    vaults,
    currentVault,
    loading,
    switching,

    // 计算属性
    sortedVaults,
    hasVaults,
    activeVaultId,
    vaultCount,

    // 方法
    loadVaults,
    createVault,
    switchVault,
    applyExternalVaultSwitch,
    renameVault,
    moveVault,
    deleteVault,
    getVaultStats,
    refreshVaults,
    getVaultById,
    searchVaults,
    updateVaultOrder,
    resetState,
    updateVaultIcon,
    updateVaultBrowsePath,
    updateVaultNetworkPath,
    cleanThumbnailCache
  }
})
