/**
 * 蓝图 → 库浏览器的适配层。
 *
 * 浏览器只认 {@link BrowserItem}，不认识蓝图节点和图表。这里把领域对象翻译过去，
 * 原对象原样挂在 `source` 上带走 —— 编辑器和筛选还是拿它。
 *
 * ## 集合当文件夹用
 *
 * 蓝图现在还带着 `collectionId`（旧的「集合」模型）。这里直接把它当
 * `folderKey` 用，集合列表当成一层平铺的文件夹 —— **不改 store、不做迁移**。
 *
 * 等蓝图落成保管库里的 `.ueblueprint` 包之后，`folderKey` 换成真实目录路径，
 * 这个文件里只有 {@link toBrowserFolders} 那一处要改。
 */

import { toLocalResourceUrl } from '@renderer/utils/localResource'
import type {
  Blueprint,
  BlueprintCollection
} from '@renderer/views/BlueprintLibrary/types/blueprint'
import {
  getBlueprintCoverStyle,
  getBlueprintTypeLabel
} from '@renderer/views/BlueprintLibrary/types/blueprint'
import type {
  BrowserFacet,
  BrowserFolder,
  BrowserItem
} from '@renderer/views/library-common/browser'

/** 卡片第二行：类型 + 引擎版本 */
function subtitleOf(bp: Blueprint): string {
  const type = getBlueprintTypeLabel(bp.blueprintType)
  return bp.engineVersion ? `${type} · UE ${bp.engineVersion}` : type
}

export interface BlueprintStatsText {
  /** 「2 图表 · 3 函数」这类统计行，调用方用 i18n 拼好传进来 */
  (bp: Blueprint): string
}

export function toBrowserItems(
  blueprints: readonly Blueprint[],
  statsText: BlueprintStatsText
): BrowserItem[] {
  return blueprints.map((bp) => ({
    id: bp.id,
    name: bp.name,
    kind: 'blueprint',
    // 封面可能是历史遗留的 file:/// URL，渲染前统一转成 local-resource://
    thumbnail: toLocalResourceUrl(bp.thumbnail),
    coverStyle: getBlueprintCoverStyle(bp),
    // 没归到任何集合的落在根目录
    folderKey: bp.collectionId || '',
    tags: bp.tags ?? [],
    isFavorite: bp.isFavorite,
    createdAt: bp.createdAt,
    updatedAt: bp.updatedAt,
    subtitle: subtitleOf(bp),
    meta: [statsText(bp)],
    source: bp
  }))
}

/**
 * 集合 → 文件夹。
 *
 * 现在是平的（`parentKey` 恒为 null）—— 旧的集合模型本来就没有层级。
 * 换成真实目录之后这里会长出层级，浏览器那边的树早就支持了。
 */
export function toBrowserFolders(collections: readonly BlueprintCollection[]): BrowserFolder[] {
  return collections.map((collection) => ({
    key: collection.id,
    name: collection.name,
    parentKey: null
  }))
}

/**
 * 类型筛选。
 *
 * 选项从**现有蓝图**里现算，而不是写死一张枚举表：用户导入的旧数据里
 * 可能有代码里没列过的类型，写死的话那些蓝图会筛不出来。
 */
export function buildTypeFacet(
  blueprints: readonly Blueprint[],
  extraTypes: readonly string[] = []
): BrowserFacet {
  const types = new Set<string>(extraTypes)
  for (const bp of blueprints) {
    if (bp.blueprintType) types.add(bp.blueprintType)
  }

  return {
    key: 'blueprintType',
    label: 'blueprintGallery.list.colType',
    options: [...types].sort().map((value) => ({ value, label: getBlueprintTypeLabel(value) }))
  }
}
