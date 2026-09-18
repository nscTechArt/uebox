import { RouteRecordRaw } from 'vue-router'
import { markRaw } from 'vue'
import {
  PhBooks,
  PhGear,
  PhCube,
  PhSphere,
  PhHouse,
  PhFolders,
  PhRobot,
  PhSparkle,
  PhStorefront,
  PhGraph,
  PhUser
} from '@phosphor-icons/vue'

export interface MenuItem {
  key: string
  icon: any
  label: string
  path: string
  sort?: number
  isBeta?: boolean
  isAIGC?: boolean
  children?: MenuItem[]
}

/**
 * 从路由配置生成菜单数据
 * 按 meta.sort 值排序，确保菜单顺序与路由配置一致。
 *
 * 不做区域过滤：公开核心的每一项功能对所有区域一视同仁。
 */
export function generateMenuFromRoutes(
  routes: RouteRecordRaw[],
  t: (key: string) => string
): MenuItem[] {
  const menuItems: MenuItem[] = []

  routes.forEach((route) => {
    if (!route.children || route.children.length === 0) return

    route.children.forEach((child) => {
      // 跳过不在菜单展示的项
      if (child.meta?.isShowInMenu === false) return

      const sortValue = (child.meta?.sort as number) ?? 999

      // 存在子路由，生成可展开的二级菜单
      if (child.children && child.children.length > 0) {
        const subItems: MenuItem[] = []
        child.children.forEach((grand) => {
          if (grand.meta?.title && grand.name && grand.meta?.isShowInMenu !== false) {
            const fullPath = joinRoutePaths(child.path || '', grand.path || '')
            subItems.push({
              key: grand.name as string,
              icon: markRaw(getIconByPath(fullPath)),
              label: t(grand.meta.title as string),
              path: fullPath,
              sort: (grand.meta?.sort as number) ?? 999
            })
          }
        })

        // 子菜单也按 sort 排序
        subItems.sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999))

        if (child.meta?.title && child.name) {
          menuItems.push({
            key: child.name as string,
            icon: markRaw(getIconByPath(child.path || '')),
            label: t(child.meta.title as string),
            path: child.path || '',
            sort: sortValue,
            isBeta: (child.meta?.isBeta as boolean) ?? false,
            isAIGC: (child.meta?.isAIGC as boolean) ?? false,
            children: subItems
          })
        }
      } else if (child.meta?.title && child.name) {
        // 仅一级菜单项
        menuItems.push({
          key: child.name as string,
          icon: markRaw(getIconByPath(child.path || '')),
          label: t(child.meta.title as string),
          path: child.path || '',
          sort: sortValue,
          isBeta: (child.meta?.isBeta as boolean) ?? false,
          isAIGC: (child.meta?.isAIGC as boolean) ?? false
        })
      }
    })
  })

  // 按 sort 值排序
  menuItems.sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999))

  return menuItems
}

// 根据路径获取对应图标
function getIconByPath(path: string): any {
  // 项目库
  if (path === '' || path === '/') {
    return PhFolders
  }

  // 可以根据路径匹配不同图标
  if (path.includes('user')) {
    return PhUser
  }

  if (path.includes('setting')) {
    return PhGear
  }
  // 虚幻AI助手图标
  if (path.includes('dev-assistant') || path.includes('assistant')) {
    return PhRobot
  }
  // 共创市场图标
  if (path.includes('co-create-market')) {
    return PhStorefront
  }

  // 资产库图标
  if (path.includes('asset-management')) {
    return PhCube
  }

  // 知识库图标
  if (path.includes('notebooks')) {
    return PhBooks
  }

  // 蓝图库图标
  if (path.includes('blueprint-library')) {
    return PhGraph
  }

  // Material Library icon
  if (path.includes('material-library')) {
    return PhSphere
  }

  // AIGC工作室图标
  if (path.includes('aigc-studio')) {
    return PhSparkle
  }

  // 默认图标
  return PhHouse
}

function normalizeRoutePath(path: string): string {
  if (!path) return '/'
  const normalized = path.startsWith('/') ? path : `/${path}`
  const compact = normalized.replace(/\/+/g, '/')
  if (compact !== '/' && compact.endsWith('/')) {
    return compact.slice(0, -1)
  }
  return compact
}

export function findMenuTargetByKey(menuItems: MenuItem[], key: string): string | null {
  for (const item of menuItems) {
    if (item.key === key) {
      return normalizeRoutePath(item.path)
    }
    if (item.children && item.children.length > 0) {
      const childTarget = findMenuTargetByKey(item.children, key)
      if (childTarget) {
        return childTarget
      }
    }
  }
  return null
}

function joinRoutePaths(parentPath: string, childPath: string): string {
  if (!childPath) return normalizeRoutePath(parentPath)
  if (childPath.startsWith('/')) return normalizeRoutePath(childPath)
  return normalizeRoutePath(`${parentPath}/${childPath}`)
}

function escapeRegexSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchMenuPath(menuPath: string, currentPath: string): boolean {
  const normalizedMenuPath = normalizeRoutePath(menuPath)
  const normalizedCurrentPath = normalizeRoutePath(currentPath)

  if (normalizedMenuPath === '/') {
    return normalizedCurrentPath === '/'
  }

  if (normalizedMenuPath.includes('/:')) {
    const pattern = normalizedMenuPath
      .split('/')
      .map((segment) => {
        if (!segment) return ''
        return segment.startsWith(':') ? '[^/]+' : escapeRegexSegment(segment)
      })
      .join('/')
    return new RegExp(`^${pattern}$`).test(normalizedCurrentPath)
  }

  return (
    normalizedCurrentPath === normalizedMenuPath ||
    normalizedCurrentPath.startsWith(`${normalizedMenuPath}/`)
  )
}

// 根据当前路由获取选中的菜单key
export function getSelectedMenuKeys(currentPath: string, menuItems: MenuItem[]): string[] {
  for (const item of menuItems) {
    if (item.children && item.children.length > 0) {
      for (const child of item.children) {
        if (matchMenuPath(child.path, currentPath)) {
          return [child.key]
        }
      }
      if (matchMenuPath(item.path, currentPath)) {
        return [item.key]
      }
    } else {
      if (matchMenuPath(item.path, currentPath)) {
        return [item.key]
      }
    }
  }
  return []
}

/**
 * 根据当前路由获取需要展开的菜单key（用于 SubMenu 展开）
 */
export function getOpenMenuKeys(currentPath: string, menuItems: MenuItem[]): string[] {
  for (const item of menuItems) {
    if (item.children && item.children.length > 0) {
      for (const child of item.children) {
        if (matchMenuPath(child.path, currentPath)) {
          return [item.key]
        }
      }
    }
  }
  return []
}
