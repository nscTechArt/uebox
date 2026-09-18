/**
 * 库浏览器的对外出口。
 *
 * 各库（资产库 / 蓝图库 / 材质库）和各模块只从这里 import，
 * 不要深链到内部文件 —— 那样以后拆分内部结构会牵一片。
 */

export { default as LibraryBrowser } from './LibraryBrowser.vue'
export { default as BrowserFolderTree } from './BrowserFolderTree.vue'

export {
  registerBrowserModule,
  resetBrowserModules,
  getRegisteredModules,
  getDefaultEnabledModuleIds,
  resolveActiveModules,
  isActionEnabled,
  type BrowserModule,
  type BrowserAction,
  type BrowserActionContext,
  type BrowserPanel,
  type BrowserDetailTab
} from './moduleRegistry'

export { useBrowserModules, type BrowserModulesController } from './useBrowserModules'

export type {
  BrowserItem,
  BrowserFolder,
  BrowserFacet,
  BrowserScope,
  BrowserContext,
  BrowserViewMode,
  BrowserSortType
} from './types'
