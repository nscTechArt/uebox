/**
 * 「哪些模块开着」这件事的存储。
 *
 * 单独一个文件，是为了让 `moduleRegistry.ts` 保持纯函数 —— 它不碰 localStorage，
 * 因而能脱离浏览器环境单测。
 *
 * 存 localStorage 而不是保管库：这是**这台机器上这个人**的界面偏好，
 * 不是用户创作的内容，丢了顶多重新勾一次。合硬规则第 9 条对 `ui` 类的定义。
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'

import {
  getDefaultEnabledModuleIds,
  getRegisteredModules,
  resolveActiveModules,
  type BrowserModule
} from './moduleRegistry'
import type { BrowserContext } from './types'

/** 字面量键名是必须的：`scripts/check-local-storage.mjs` 要能看见它 */
const ENABLED_MODULES_KEY = 'library-browser-modules'

/**
 * 读用户勾了哪些。
 *
 * 从没设置过（`null`）和「全都关掉」（`[]`）必须区分开 ——
 * 前者要用默认值，后者是用户的明确选择，不能给他再打开。
 */
function readEnabledIds(): string[] | null {
  try {
    const raw = localStorage.getItem(ENABLED_MODULES_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return null
  }
}

function writeEnabledIds(ids: string[]): void {
  try {
    localStorage.setItem(ENABLED_MODULES_KEY, JSON.stringify(ids))
  } catch (error) {
    // 存不下不该拦住用户继续用，下次重启回到默认值而已
    console.warn('[BrowserModule] 模块开关存盘失败:', error)
  }
}

export interface BrowserModulesController {
  /** 用户勾选的 id（不代表当前一定生效，还要看场景适不适用） */
  enabledIds: Ref<string[]>
  /** 装了哪些模块，设置页用它列清单 */
  allModules: ComputedRef<BrowserModule[]>
  /** 当前场景下真正生效的 */
  activeModules: ComputedRef<BrowserModule[]>
  isEnabled: (moduleId: string) => boolean
  setEnabled: (moduleId: string, enabled: boolean) => void
  toggle: (moduleId: string) => void
  /** 恢复默认勾选 */
  reset: () => void
}

export function useBrowserModules(ctx: () => BrowserContext): BrowserModulesController {
  const stored = readEnabledIds()
  const enabledIds = ref<string[]>(stored ?? getDefaultEnabledModuleIds())

  const allModules = computed(() => getRegisteredModules())
  const activeModules = computed(() => resolveActiveModules(ctx(), enabledIds.value))

  function isEnabled(moduleId: string): boolean {
    return enabledIds.value.includes(moduleId)
  }

  function setEnabled(moduleId: string, enabled: boolean): void {
    const next = new Set(enabledIds.value)
    if (enabled) next.add(moduleId)
    else next.delete(moduleId)

    // 按注册顺序存，读回来时顺序稳定，diff 也好看
    enabledIds.value = getRegisteredModules()
      .map((module) => module.id)
      .filter((id) => next.has(id))
    writeEnabledIds(enabledIds.value)
  }

  function toggle(moduleId: string): void {
    setEnabled(moduleId, !isEnabled(moduleId))
  }

  function reset(): void {
    enabledIds.value = getDefaultEnabledModuleIds()
    writeEnabledIds(enabledIds.value)
  }

  return { enabledIds, allModules, activeModules, isEnabled, setEnabled, toggle, reset }
}
