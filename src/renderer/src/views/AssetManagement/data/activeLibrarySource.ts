/**
 * 资产库页面当前在用的数据源（本地库 or 某个服务器库）。
 *
 * 放在模块级的 shallowRef 里，而不是只放 pinia：useAssetTree 这类 hook 和它们的单测
 * 不该为了取一个数据源而依赖一个活着的 pinia。切换由 assetLibraryStore 负责。
 */
import { shallowRef } from 'vue'
import type { AssetLibrarySource } from './AssetLibrarySource'
import { localLibrarySource } from './LocalLibrarySource'

const current = shallowRef<AssetLibrarySource>(localLibrarySource)

export function getActiveLibrarySource(): AssetLibrarySource {
  return current.value
}

export function setActiveLibrarySource(source: AssetLibrarySource | null): void {
  current.value = source ?? localLibrarySource
}

/** 给模板 / computed 用的响应式引用 */
export const activeLibrarySource = current
