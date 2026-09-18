/**
 * 材质 → 库浏览器的适配层。跟 `BlueprintLibrary/services/blueprintBrowser.ts` 一个套路：
 * 把领域对象翻译成浏览器认识的形状，原对象挂在 `source` 上带走。
 *
 * 集合暂时当文件夹用（`collectionId` 直接当 `folderKey`），不改 store、不做迁移；
 * 等材质落成保管库里的 `.uematerial` 包之后，只有 {@link toBrowserFolders} 一处要改。
 */

import type {
  MaterialCollection,
  MaterialEntry
} from '@renderer/views/MaterialLibrary/types/material'
import { getMaterialEntryLabel } from '@renderer/views/MaterialLibrary/types/material'
import type {
  BrowserFacet,
  BrowserFolder,
  BrowserItem
} from '@renderer/views/library-common/browser'

/** 卡片第二行：类型 · 混合模式 · 着色模型 */
function subtitleOf(entry: MaterialEntry): string {
  return [getMaterialEntryLabel(entry.entryType), entry.blendMode, entry.shadingModel]
    .filter(Boolean)
    .join(' · ')
}

export interface MaterialStatsText {
  /** 「3 参数 · 2 依赖」这类统计行，调用方用 i18n 拼好传进来 */
  (entry: MaterialEntry): string
}

export function toBrowserItems(
  entries: readonly MaterialEntry[],
  statsText: MaterialStatsText
): BrowserItem[] {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: 'material',
    thumbnail: entry.thumbnail,
    coverStyle: entry.coverStyle,
    // 没归到任何集合的落在根目录
    folderKey: entry.collectionId || '',
    tags: entry.tags ?? [],
    isFavorite: entry.isFavorite,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    subtitle: subtitleOf(entry),
    meta: [statsText(entry)],
    source: entry
  }))
}

export function toBrowserFolders(collections: readonly MaterialCollection[]): BrowserFolder[] {
  return collections.map((collection) => ({
    key: collection.id,
    name: collection.name,
    parentKey: null
  }))
}

/**
 * 材质专属的筛选字段。
 *
 * 选项从现有条目里现算 —— 混合模式、着色模型这些取值来自引擎，
 * 代码里写死一张表迟早跟不上新版本。
 */
export function buildMaterialFacets(
  entries: readonly MaterialEntry[],
  labels: { entryType: string; blendMode: string; shadingModel: string }
): BrowserFacet[] {
  const collect = (pick: (entry: MaterialEntry) => string): string[] =>
    [...new Set(entries.map(pick).filter(Boolean))].sort()

  return [
    {
      key: 'entryType',
      label: labels.entryType,
      options: collect((entry) => entry.entryType).map((value) => ({
        value,
        label: getMaterialEntryLabel(value as MaterialEntry['entryType'])
      }))
    },
    {
      key: 'blendMode',
      label: labels.blendMode,
      options: collect((entry) => entry.blendMode).map((value) => ({ value, label: value }))
    },
    {
      key: 'shadingModel',
      label: labels.shadingModel,
      options: collect((entry) => entry.shadingModel).map((value) => ({ value, label: value }))
    }
  ]
}
