import { ref, type Ref } from 'vue'

// 全局ContextMenu管理器
class ContextMenuManager {
  private static instance: ContextMenuManager
  private activeMenus: Set<string> = new Set()
  private menuInstances: Map<string, { hide: () => void }> = new Map()

  static getInstance(): ContextMenuManager {
    if (!ContextMenuManager.instance) {
      ContextMenuManager.instance = new ContextMenuManager()
    }
    return ContextMenuManager.instance
  }

  // 注册菜单实例
  register(id: string, instance: { hide: () => void }): void {
    this.menuInstances.set(id, instance)
  }

  // 注销菜单实例
  unregister(id: string): void {
    this.menuInstances.delete(id)
    this.activeMenus.delete(id)
  }

  // 显示菜单（隐藏其他所有菜单）
  show(id: string): void {
    // 隐藏所有其他菜单
    this.activeMenus.forEach((activeId) => {
      if (activeId !== id) {
        const instance = this.menuInstances.get(activeId)
        if (instance) {
          instance.hide()
        }
      }
    })

    // 清空活跃菜单列表，只保留当前菜单
    this.activeMenus.clear()
    this.activeMenus.add(id)
  }

  // 隐藏菜单
  hide(id: string): void {
    this.activeMenus.delete(id)
  }

  // 隐藏所有菜单
  hideAll(): void {
    this.activeMenus.forEach((activeId) => {
      const instance = this.menuInstances.get(activeId)
      if (instance) {
        instance.hide()
      }
    })
    this.activeMenus.clear()
  }

  // 检查是否有活跃菜单
  hasActiveMenu(): boolean {
    return this.activeMenus.size > 0
  }

  // 获取活跃菜单数量
  getActiveMenuCount(): number {
    return this.activeMenus.size
  }
}

// 生成唯一ID
let menuIdCounter = 0
const generateMenuId = (): string => {
  return `context-menu-${++menuIdCounter}-${Date.now()}`
}

// Hook函数
export function useContextMenuManager() {
  const manager = ContextMenuManager.getInstance()
  const menuId = ref<string>(generateMenuId())

  // 注册菜单实例
  const registerMenu = (instance: { hide: () => void }) => {
    manager.register(menuId.value, instance)
  }

  // 注销菜单实例
  const unregisterMenu = () => {
    manager.unregister(menuId.value)
  }

  // 显示菜单
  const showMenu = () => {
    manager.show(menuId.value)
  }

  // 隐藏菜单
  const hideMenu = () => {
    manager.hide(menuId.value)
  }

  // 隐藏所有菜单
  const hideAllMenus = () => {
    manager.hideAll()
  }

  return {
    menuId: menuId as Readonly<Ref<string>>,
    registerMenu,
    unregisterMenu,
    showMenu,
    hideMenu,
    hideAllMenus,
    hasActiveMenu: () => manager.hasActiveMenu(),
    getActiveMenuCount: () => manager.getActiveMenuCount()
  }
}
