import { ref, type Ref } from 'vue'
import type { MenuItem } from '@renderer/common/routeUtils'

/** 「更多」分组在菜单里的 key —— 不是路由，只用于 SubMenu 展开 */
export const MORE_TOOLS_SUBMENU_KEY = 'MoreTools'

/** 「自定义」入口的 key —— 点击后打开定制弹窗，不做路由跳转 */
export const SIDEBAR_TOOLS_CUSTOMIZE_KEY = 'SidebarToolsCustomize'

const SIDEBAR_TOOLS_PREFS_STORAGE_KEY = 'sidebar-tools-prefs'

/**
 * 默认常驻侧边栏的工具；名单之外的（知识库、AI 创作等）默认收进「更多」。
 *
 * key 是路由 name —— generateMenuFromRoutes 拿它当 MenuItem.key，
 * 不用路径，路径改了不影响用户已存的偏好。
 */
export const DEFAULT_PINNED_TOOLS: readonly string[] = [
  'Home',
  'AssetManagement',
  'BlueprintLibrary',
  'MaterialLibrary'
]

export interface SidebarToolsPrefs {
  /** 侧边栏工具的自定义顺序（路由 name）；缺失的按默认顺序补到末尾 */
  order: string[]
  /** 常驻显示的工具，其余收进「更多」 */
  pinned: string[]
}

export interface ResolvedSidebarTools {
  pinned: MenuItem[]
  more: MenuItem[]
}

export const DEFAULT_SIDEBAR_TOOLS_PREFS: SidebarToolsPrefs = {
  order: [],
  pinned: [...DEFAULT_PINNED_TOOLS]
}

/**
 * 清洗存储里的顺序：只保留当前还存在的工具、去重，新出现的工具按传入顺序补齐。
 *
 * knownKeys 传的是菜单项的默认顺序（路由 meta.sort），所以「缺失的补到末尾」
 * 实际是补在它本来该在的位置序列里。
 */
export function sanitizeToolOrder(stored: unknown, knownKeys: string[]): string[] {
  const ordered: string[] = []
  if (Array.isArray(stored)) {
    const seen = new Set<string>()
    for (const key of stored) {
      if (typeof key !== 'string' || !knownKeys.includes(key) || seen.has(key)) continue
      seen.add(key)
      ordered.push(key)
    }
  }
  for (const key of knownKeys) {
    if (!ordered.includes(key)) ordered.push(key)
  }
  return ordered
}

/**
 * 清洗常驻名单：去掉已不存在的工具、去重。
 * 存过数组（哪怕全空）就尊重用户的选择；没存过才落到默认名单。
 */
export function sanitizePinnedTools(stored: unknown, knownKeys: string[]): string[] {
  if (!Array.isArray(stored)) {
    return DEFAULT_PINNED_TOOLS.filter((key) => knownKeys.includes(key))
  }
  const pinned: string[] = []
  for (const key of stored) {
    if (typeof key === 'string' && knownKeys.includes(key) && !pinned.includes(key)) {
      pinned.push(key)
    }
  }
  return pinned
}

/** 把菜单项按偏好拆成「常驻」和「更多」两组 */
export function resolveSidebarTools(
  items: MenuItem[],
  prefs: SidebarToolsPrefs
): ResolvedSidebarTools {
  const knownKeys = items.map((item) => item.key)
  const order = sanitizeToolOrder(prefs.order, knownKeys)
  const pinnedSet = new Set(sanitizePinnedTools(prefs.pinned, knownKeys))
  const byKey = new Map(items.map((item) => [item.key, item]))

  const pinned: MenuItem[] = []
  const more: MenuItem[] = []
  for (const key of order) {
    const item = byKey.get(key)
    if (!item) continue
    if (pinnedSet.has(key)) {
      pinned.push(item)
    } else {
      more.push(item)
    }
  }
  return { pinned, more }
}

export function loadSidebarToolsPrefs(): SidebarToolsPrefs {
  try {
    const raw = localStorage.getItem(SIDEBAR_TOOLS_PREFS_STORAGE_KEY)
    if (!raw) return { order: [], pinned: [...DEFAULT_PINNED_TOOLS] }
    const parsed = JSON.parse(raw) as Partial<SidebarToolsPrefs> | null
    return {
      order: Array.isArray(parsed?.order) ? [...parsed.order] : [],
      pinned: Array.isArray(parsed?.pinned) ? [...parsed.pinned] : [...DEFAULT_PINNED_TOOLS]
    }
  } catch {
    return { order: [], pinned: [...DEFAULT_PINNED_TOOLS] }
  }
}

export function saveSidebarToolsPrefs(prefs: SidebarToolsPrefs): void {
  try {
    localStorage.setItem(
      SIDEBAR_TOOLS_PREFS_STORAGE_KEY,
      JSON.stringify({ order: prefs.order, pinned: prefs.pinned })
    )
  } catch {
    // localStorage 不可用（被策略禁掉等）时静默放弃 —— 只是记不住偏好，不该影响菜单本身
  }
}

/**
 * SideMenu 里的单一持有者：prefs 驱动菜单渲染，save 由定制弹窗「完成」时调用。
 */
export function useSidebarTools(): {
  prefs: Ref<SidebarToolsPrefs>
  save: (next: SidebarToolsPrefs) => void
} {
  const prefs = ref(loadSidebarToolsPrefs())
  const save = (next: SidebarToolsPrefs): void => {
    prefs.value = { order: [...next.order], pinned: [...next.pinned] }
    saveSidebarToolsPrefs(prefs.value)
  }
  return { prefs, save }
}
