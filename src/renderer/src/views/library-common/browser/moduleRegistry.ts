import type { Component } from 'vue'
import type { BrowserContext, BrowserItem } from './types'

/** 动作被触发时能拿到的东西 */
export interface BrowserActionContext extends BrowserContext {
  /** 触发这次动作的条目。右键菜单里是被右键的那个，工具栏动作可能为空。 */
  target: BrowserItem | null
}

/** 工具栏按钮 / 右键菜单项 / 批量操作，三者形状一样 */
export interface BrowserAction {
  id: string
  /** i18n key */
  label: string
  icon?: string
  /** 小的排前面。不填按注册顺序。 */
  order?: number
  /** 不满足就整个不显示（跟「显示但灰掉」区分开） */
  isVisible?: (ctx: BrowserActionContext) => boolean
  /** 显示但点不动，比如「没选中任何东西」 */
  isEnabled?: (ctx: BrowserActionContext) => boolean
  run: (ctx: BrowserActionContext) => void | Promise<void>
}

/** 挂在侧栏 / 状态条上的一小块界面 */
export interface BrowserPanel {
  id: string
  component: Component
  order?: number
  isVisible?: (ctx: BrowserContext) => boolean
}

/** 详情面板上多出来的一个页签 */
export interface BrowserDetailTab extends BrowserPanel {
  /** i18n key */
  label: string
}

export interface BrowserModule {
  /** 全局唯一。也是开关状态的存储键，改名等于把用户的开关重置。 */
  id: string
  /** i18n key */
  title: string
  /** i18n key。设置页里告诉用户这个模块是干嘛的。 */
  description: string
  /**
   * 默认开不开。
   *
   * 默认值应该保守 —— 一个新装的应用不该一上来就摆满云盘按钮。
   * 「人人都要」的东西根本不该做成模块，应该留在壳里。
   */
  enabledByDefault: boolean
  /**
   * 在当前场景下适不适用。
   *
   * 跟「开关」是两件事：网络库同步状态在本地保管库里**不适用**（不该显示），
   * 而不是「用户关掉了」。分开之后设置页可以显示「已启用（当前保管库不适用）」，
   * 而不是让用户以为开关坏了。
   */
  isAvailable?: (ctx: BrowserContext) => boolean

  toolbarActions?: BrowserAction[]
  contextMenuItems?: BrowserAction[]
  /** 选中多个条目时可用的操作 */
  bulkActions?: BrowserAction[]
  sidebarPanels?: BrowserPanel[]
  statusPanels?: BrowserPanel[]
  detailTabs?: BrowserDetailTab[]
}

/** 从模块里摊出来的一条动作，带上它的来源 */
export interface ResolvedAction extends BrowserAction {
  moduleId: string
}

export interface ResolvedPanel extends BrowserPanel {
  moduleId: string
}

export interface ResolvedDetailTab extends BrowserDetailTab {
  moduleId: string
}

const registry = new Map<string, BrowserModule>()

/**
 * 注册一个模块。重复 id 直接抛 —— 静默覆盖会让「我的按钮怎么没了」
 * 变成一个查半天的问题。
 */
export function registerBrowserModule(module: BrowserModule): void {
  if (!module?.id) throw new Error('[BrowserModule] 模块必须有 id')
  if (registry.has(module.id)) {
    throw new Error(`[BrowserModule] 模块 id 重复: ${module.id}`)
  }
  registry.set(module.id, module)
}

/** 测试用。生产代码不该需要它 —— 模块是启动时注册一次的。 */
export function resetBrowserModules(): void {
  registry.clear()
}

export function getRegisteredModules(): BrowserModule[] {
  return [...registry.values()]
}

/** 默认开启的模块 id，用来给「用户从没设置过」时兜底 */
export function getDefaultEnabledModuleIds(): string[] {
  return getRegisteredModules()
    .filter((module) => module.enabledByDefault)
    .map((module) => module.id)
}

/**
 * 当前真正生效的模块 = 已启用 ∩ 当前场景适用。
 *
 * `isAvailable` 抛异常时按「不适用」处理：一个模块的判断写崩了，
 * 顶多是它自己不出现，不该把整个浏览器带下水。
 */
export function resolveActiveModules(
  ctx: BrowserContext,
  enabledIds: readonly string[]
): BrowserModule[] {
  const enabled = new Set(enabledIds)
  return getRegisteredModules().filter((module) => {
    if (!enabled.has(module.id)) return false
    if (!module.isAvailable) return true
    try {
      return module.isAvailable(ctx)
    } catch (error) {
      console.warn(`[BrowserModule] ${module.id}.isAvailable 抛了异常，按不适用处理`, error)
      return false
    }
  })
}

/** `order` 小的在前；没填的按注册顺序排在同组末尾 */
function byOrder<T extends { order?: number }>(list: T[]): T[] {
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const orderA = a.item.order ?? Number.MAX_SAFE_INTEGER
      const orderB = b.item.order ?? Number.MAX_SAFE_INTEGER
      return orderA === orderB ? a.index - b.index : orderA - orderB
    })
    .map(({ item }) => item)
}

function collect<T extends { order?: number }>(
  modules: BrowserModule[],
  pick: (module: BrowserModule) => T[] | undefined
): Array<T & { moduleId: string }> {
  const out: Array<T & { moduleId: string }> = []
  for (const module of modules) {
    for (const entry of pick(module) ?? []) {
      out.push({ ...entry, moduleId: module.id })
    }
  }
  return byOrder(out)
}

/**
 * 过滤掉 `isVisible` 说不显示的。
 *
 * 同样吃掉异常：一个模块的可见性判断写崩了，只让它自己消失。
 */
function visibleOnly<T extends { isVisible?: (ctx: never) => boolean; moduleId: string }>(
  list: T[],
  ctx: unknown
): T[] {
  return list.filter((entry) => {
    if (!entry.isVisible) return true
    try {
      return (entry.isVisible as (c: unknown) => boolean)(ctx)
    } catch (error) {
      console.warn(`[BrowserModule] ${entry.moduleId} 的 isVisible 抛了异常，隐藏它`, error)
      return false
    }
  })
}

export function collectToolbarActions(
  modules: BrowserModule[],
  ctx: BrowserActionContext
): ResolvedAction[] {
  return visibleOnly(
    collect(modules, (module) => module.toolbarActions),
    ctx
  )
}

export function collectContextMenuItems(
  modules: BrowserModule[],
  ctx: BrowserActionContext
): ResolvedAction[] {
  return visibleOnly(
    collect(modules, (module) => module.contextMenuItems),
    ctx
  )
}

/** 没选中东西时批量操作一律不出现 —— 显示一个必然点不动的按钮只是噪音 */
export function collectBulkActions(
  modules: BrowserModule[],
  ctx: BrowserActionContext
): ResolvedAction[] {
  if (ctx.selection.length === 0) return []
  return visibleOnly(
    collect(modules, (module) => module.bulkActions),
    ctx
  )
}

export function collectSidebarPanels(
  modules: BrowserModule[],
  ctx: BrowserContext
): ResolvedPanel[] {
  return visibleOnly(
    collect(modules, (module) => module.sidebarPanels),
    ctx
  )
}

export function collectStatusPanels(
  modules: BrowserModule[],
  ctx: BrowserContext
): ResolvedPanel[] {
  return visibleOnly(
    collect(modules, (module) => module.statusPanels),
    ctx
  )
}

export function collectDetailTabs(
  modules: BrowserModule[],
  ctx: BrowserContext
): ResolvedDetailTab[] {
  return visibleOnly(
    collect(modules, (module) => module.detailTabs),
    ctx
  )
}

/**
 * 一个动作现在能不能点。
 *
 * `isEnabled` 抛异常时按「点不动」处理 —— 让用户点一个会炸的按钮更糟。
 */
export function isActionEnabled(action: BrowserAction, ctx: BrowserActionContext): boolean {
  if (!action.isEnabled) return true
  try {
    return action.isEnabled(ctx)
  } catch (error) {
    console.warn(`[BrowserModule] ${action.id} 的 isEnabled 抛了异常，禁用它`, error)
    return false
  }
}
