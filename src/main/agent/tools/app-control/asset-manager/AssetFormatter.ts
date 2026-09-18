// 资产格式化工具
//
// 这里原来还有一对 `estimateTokenCount` / `compressResults`：按字符数估 token，
// 把搜索结果裁到 4096 token 以内。那是 Router 时代的口径 —— 当时每个专家分到的
// 上下文只有几千 token，裁是唯一的活路。
//
// 现在裁不再省事，而是**制造往返**：调用方拿到「还有 N 个被压缩了」，
// 却没有任何参数能翻到下一页，唯一的出路是换更窄的关键词重搜一次。
// 改成 limit / offset 显式分页（见 AssetSearcher），返回多少由调用方说了算。

import path from 'path'
import { fileURLToPath } from 'url'
import type { FormattedAsset } from './types'
import type { AssetData } from '../../../../sqliteDataBase/models/assetData'
import { PathManager } from '../../../../utils/PathManager'

/**
 * 库里查出来的一行。`AssetData` 自带 `[key: string]: unknown`，
 * 所以 tagNames 这类由上层临时挂上去的字段也接得住。
 */
type AssetRow = AssetData

export interface FormatAssetsOptions {
  /**
   * 这批资产来自哪个保管库（保管库根目录的绝对路径）。
   *
   * **跨库搜索时必须传**：search_assets 默认搜遍所有库，而相对路径要拼回
   * 资产自己那个库。不传就按当前活跃库算 —— 用户站在 AIGC 库里搜到的
   * 默认库资产，路径会被拼到 AIGC 库目录下，指向一个不存在的文件。
   */
  vaultPath?: string
}

/** 当前活跃保管库的根目录。拿不到（没选库、测试环境）就返回 undefined */
function currentVaultPath(): string | undefined {
  try {
    return PathManager.getInstance().getCurrentVaultPath()
  } catch {
    return undefined
  }
}

/** 缩略图目录。给了库路径就用那个库的，否则走 PathManager（它还管网络库的 .thumbnails） */
function thumbnailsDir(vaultPath?: string): string | undefined {
  if (vaultPath) return path.join(vaultPath, 'thumbnails')
  try {
    return PathManager.getInstance().getThumbnailsPath()
  } catch {
    return undefined
  }
}

/** 取出一个能当本地路径用的字符串。http / data: 这类不是路径，file:// 转成本地路径 */
function toLocalPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('data:')
  ) {
    return undefined
  }
  if (trimmed.startsWith('file://')) {
    try {
      return path.normalize(fileURLToPath(trimmed))
    } catch {
      return undefined
    }
  }
  return trimmed
}

/**
 * 解析资产在磁盘上的真实路径。
 *
 * ## 顺序是 filePath → originPath → 缩略图，这三步的先后**都是有代价的**
 *
 * 1. `filePath` 是**保管库里那一份**。备份类型的库（默认保管库、AIGC 资产库都是）
 *    导入时会把文件复制进库，数据库里存的是**相对保管库的路径**
 *    （`20260906_.../Game/.../SM_x.uasset`），所以相对路径要拼回库根目录 ——
 *    原来这里只认绝对路径，相对的直接跳过。
 *
 * 2. `originPath` 是**当初从哪儿导入的**，不是库里的落点。它排在第二位是兜底：
 *    引用类型的库不复制文件，那时它就是唯一的真路径。
 *
 *    跳过第 1 步的后果真机上出现过：用户把 `I:\tmp\KawaiiAnimations` 导进默认
 *    保管库，库里明明有自己的副本，工具却一路回退到 originPath，于是 agent 告诉
 *    用户「素材落盘在 I:\tmp\KawaiiAnimations」—— 那只是他解压包的临时目录，
 *    删掉就成了死路径，而库其实好好的。
 *
 * 3. 缩略图（`imgLocalPath` / `customPoster`）只能垫底。它是导入时压出来的
 *    **1024 以内、quality 80 的副本**，不是原文件。而 search_assets 明写着
 *    「把 real_path 填进 ue_content_import 的 files」—— 把它排在前面，
 *    用户要导 4K 贴图，进工程的会是那张压缩缩略图。
 */
function resolveRealPath(asset: AssetRow, vaultPath?: string): string | undefined {
  try {
    const vaultRoot = vaultPath || currentVaultPath()

    // 1. 保管库里的那一份
    const filePath = toLocalPath(asset?.filePath)
    if (filePath) {
      if (path.isAbsolute(filePath)) return path.normalize(filePath)
      if (vaultRoot) return path.normalize(path.join(vaultRoot, filePath))
    }

    // 2. 导入来源
    const originPath = toLocalPath(asset?.originPath)
    if (originPath && path.isAbsolute(originPath)) return path.normalize(originPath)

    // 3. 缩略图兜底
    const poster = toLocalPath(asset?.imgLocalPath || asset?.customPoster)
    if (poster) {
      if (path.isAbsolute(poster)) return path.normalize(poster)
      const thumbnails = thumbnailsDir(vaultPath)
      if (thumbnails) return path.normalize(path.join(thumbnails, poster))
    }
  } catch (error) {
    console.warn('[AssetFormatter] 解析资产真实路径失败:', error)
  }

  return undefined
}

/**
 * 标签字段在库里可能是 JSON 数组字符串，也可能是逗号分隔，还可能已经是数组。
 * 统一成一个逗号分隔的短字符串 —— 调用方要的是「有哪些标签」，不是结构。
 */
function formatTags(raw: unknown): string | undefined {
  if (!raw) return undefined
  if (Array.isArray(raw)) {
    const names = raw
      .map((t) => (typeof t === 'string' ? t : (t as { name?: string })?.name))
      .filter(Boolean)
    return names.length ? names.join(', ') : undefined
  }
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('[')) {
    try {
      return formatTags(JSON.parse(trimmed))
    } catch {
      return trimmed
    }
  }
  return trimmed
}

/**
 * 格式化资产数据为 LLM 友好的结构
 */
export function formatAssets(assets: AssetRow[], options?: FormatAssetsOptions): FormattedAsset[] {
  return assets.map((asset) => {
    const realPath = resolveRealPath(asset, options?.vaultPath)
    return {
      name: asset.assetName || '',
      type: asset.assetType || asset.classNameCn || '',
      path: asset.softPath || asset.assetKey || '',
      assetKey: asset.assetKey,
      folderKey: asset.folderKey,
      folder: asset.folderName,
      size: asset.size || asset.fileSize,
      // 备注和标签是这个素材库存在的意义 —— 用户攒下来的信息全在这两处。
      //
      // 原来搜索结果里两个都不带，于是「写得进去读不出来」：调用方问
      // 「这个资产我之前记了什么」答不上来，更糟的是 annotate_asset 的 note 是
      // **覆盖**语义，看不到旧备注就会把用户写的东西直接盖掉。
      //
      // 只在真有内容时才带上，空的就不占 token。
      ...(asset.note ? { note: String(asset.note) } : {}),
      ...(formatTags(asset.tagNames ?? asset.tags)
        ? { tags: formatTags(asset.tagNames ?? asset.tags)! }
        : {}),
      // 引擎版本：.uasset 能不能进目标工程全看它（只能平进或往高版本进）。
      // 库里早就存着、搜索也早就能按它过滤，唯独结果里不给 —— 挑素材那一步因此
      // 完全是盲的，撞上版本墙只能等导入失败了才知道（见 FormattedAsset.engineVersion）
      ...(asset.engineVersion ? { engineVersion: String(asset.engineVersion) } : {}),
      // 添加图片 URL，用于图生图功能
      imageUrl: asset.customPoster || asset.imgLocalPath || undefined,
      // 返回本地真实路径，供图生图等场景直接读取文件
      realPath,
      real_path: realPath
    }
  })
}
