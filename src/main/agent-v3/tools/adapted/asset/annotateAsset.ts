/**
 * 给素材库里的资产加备注和标签。
 *
 * ## 为什么是一个工具而不是两个
 *
 * 原来是 `add_asset_note` 和 `add_asset_tags` 两个：同一个 `assetKey`、同样的
 * mutating 风险、都是"给这个资产补点信息"。而且 `add_asset_note` 的 schema 里
 * **本来就有 `tagNames`** —— 两者从一开始就是重叠的，`add_asset_tags` 唯一独有
 * 的只是按数字 id 打标签。
 *
 * 模型要在两个描述之间选，而选错的代价是白跑一轮。合成一个之后它只需要说
 * "我要给这个资产写什么"。
 *
 * ## 为什么能一次给一批
 *
 * 原来一次只认一个 `assetKey`。可用户说的从来不是「给这一个打标签」，而是
 * 「把 SoStylized 这个包都标上」—— 几百个资产就是几百次调用、几百次审批，
 * 实际上等于做不了。批量和按文件夹这两条路补上之后，「给这个文件夹都打上
 * 标签」才是一次调用的事。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import {
  addAssetNote,
  addAssetTags
} from '../../../../agent/tools/app-control/asset-manager/AssetController'
import type { AppControlResult } from '../../../../agent/tools/app-control/types'
import { getAppWindows } from '../../../../appWindows'
import { getVaultDatabase } from '../../../../sqliteDataBase'
import { selectFolderAssetKeys } from './folderAssets'

/** 一次最多写多少个。再多就分批，别一口气重写整个库 */
const MAX_BATCH = 200

interface AnnotateOutcome {
  assetKey: string
  success: boolean
  message?: string
  error?: string
}

/**
 * 写完通知界面刷新。
 *
 * 不通知的后果不是「稍后才更新」，而是**用户以为工具在骗他**：他正开着素材库
 * 页面，agent 说「已经给这 8 个资产写好备注了」，列表上一点变化都没有。
 * 建文件夹（`asset-tree:refresh`）和笔记（`agent:note:changed`）早就在通知，
 * 只有备注/标签这条路一直是哑的。
 */
function notifyRenderer(count: number): void {
  getAppWindows()[0]?.webContents.send('asset:changed', {
    source: 'agent',
    op: 'annotate',
    tableName: 'assetData',
    count
  })
}

const toOutcome = (assetKey: string, result: AppControlResult | undefined): AnnotateOutcome =>
  result?.success === true
    ? { assetKey, success: true, message: result.message }
    : { assetKey, success: false, error: result?.error ?? '写入失败' }

/** 给一个资产写备注/标签。备注和标签都要时走 addAssetNote，它自己带 tagNames */
async function annotateOne(
  assetKey: string,
  input: { note?: string; tagNames?: string[]; tagIds?: number | number[] }
): Promise<AnnotateOutcome> {
  if (input.note !== undefined) {
    const result = await addAssetNote({
      assetKey,
      note: input.note,
      ...(input.tagNames ? { tagNames: input.tagNames } : {})
    })
    // tagIds 只有标签那条路径认，需要的话补一次
    if (input.tagIds !== undefined) {
      await addAssetTags({ assetKey, tagIds: input.tagIds })
    }
    return toOutcome(assetKey, result)
  }

  return toOutcome(
    assetKey,
    await addAssetTags({
      assetKey,
      ...(input.tagNames ? { tagNames: input.tagNames } : {}),
      ...(input.tagIds !== undefined ? { tagIds: input.tagIds } : {})
    })
  )
}

export function createAnnotateAssetTool(): V2Tool {
  return defineV2Tool({
    description: `给素材库里的资产写备注、打标签。

【使用场景】用户要给素材加说明、分类、打标签时使用。
【写谁】assetKey（一个）、assetKeys（一批）或 folder（整个文件夹）三选一，
  都来自 search_assets 的结果 —— assetKey 猜不出来。
  「把 SoStylized 这个包都标上」用 folder，别一个一个调。
【至少给一个】note（备注文本）、tagNames（标签名数组）、tagIds（标签数字 id）。
  同一份 note / 标签会写给这一批里的每一个资产。
【标签用名字就行】tagNames 里的标签不存在会自动创建；tagIds 是给已知 id 的场景用的。
【一次最多 ${MAX_BATCH} 个】folder 超了会先写这一批，返回里 folder_selection.hasMore
  为 true 时加上 folderOffset=nextFolderOffset 再调一次。
【备注是覆盖写】note 会替换掉资产原有的备注，不是追加。批量写之前想清楚。`,
    inputSchema: z.object({
      assetKey: z
        .string()
        .optional()
        .describe('单个资产的唯一标识（assetKey），来自 search_assets 的结果。'),
      assetKeys: z
        .array(z.string())
        .optional()
        .describe('一批资产的 assetKey，来自 search_assets 的结果。'),
      folder: z
        .string()
        .optional()
        .describe(
          '按素材库文件夹整批写：文件夹名（SoStylized）、完整路径（/ALL/SoStylized）或 folderKey。'
        ),
      includeSubfolders: z
        .boolean()
        .optional()
        .describe('folder 是否连子文件夹里的资产一起写，默认 true'),
      folderOffset: z
        .number()
        .optional()
        .describe(
          `folder 分批时跳过前几个，填上一次返回的 folder_selection.nextFolderOffset。一次最多 ${MAX_BATCH} 个。`
        ),
      note: z.string().optional().describe('备注内容。会覆盖这些资产原有的备注。'),
      tagNames: z.array(z.string()).optional().describe('标签名称数组，例如 ["角色", "武器"]'),
      tagIds: z
        .union([z.number(), z.array(z.number())])
        .optional()
        .describe('标签 ID，可以是单个数字或数字数组。一般用 tagNames 就够了。')
    }),
    execute: async (input) => {
      if (input.note === undefined && !input.tagNames && input.tagIds === undefined) {
        return {
          success: false,
          error: '至少要提供 note、tagNames 或 tagIds 其中之一，否则这次调用什么都不会改变'
        }
      }

      // 文件夹展开成 assetKey —— 用户说的是「这个包都标上」，不是几百个 uuid
      let folderSelection:
        | {
            folder: string
            folderKey?: string
            total: number
            offset: number
            batch_count: number
            hasMore: boolean
            nextFolderOffset?: number
          }
        | undefined
      let fromFolder: string[] = []
      if (input.folder) {
        const selection = selectFolderAssetKeys(getVaultDatabase(), input.folder, {
          includeSubfolders: input.includeSubfolders,
          limit: MAX_BATCH,
          offset: input.folderOffset
        })
        if (selection.error || !selection.assetKeys) {
          return { success: false, error: selection.error ?? '文件夹解析失败' }
        }
        fromFolder = selection.assetKeys
        folderSelection = {
          folder: selection.folderLabel || input.folder,
          folderKey: selection.folderKey,
          total: selection.total ?? 0,
          offset: selection.offset ?? 0,
          batch_count: fromFolder.length,
          hasMore: selection.hasMore === true,
          ...(selection.nextOffset !== undefined ? { nextFolderOffset: selection.nextOffset } : {})
        }
        if (fromFolder.length === 0) {
          return {
            success: false,
            error: `「${folderSelection.folder}」里没有资产，没有可写的对象。`,
            folder_selection: folderSelection
          }
        }
      }

      const keys = Array.from(
        new Set(
          [input.assetKey, ...(input.assetKeys ?? []), ...fromFolder]
            .map((key) => String(key ?? '').trim())
            .filter(Boolean)
        )
      )
      if (keys.length === 0) {
        return { success: false, error: '必须提供 assetKey、assetKeys 或 folder 其中之一' }
      }
      if (keys.length > MAX_BATCH) {
        return {
          success: false,
          error: `一次最多写 ${MAX_BATCH} 个，这次给了 ${keys.length} 个。请分批。`
        }
      }

      const results: AnnotateOutcome[] = []
      for (const assetKey of keys) {
        results.push(await annotateOne(assetKey, input))
      }

      const ok = results.filter((r) => r.success)
      if (ok.length > 0) notifyRenderer(ok.length)

      const failed = results.filter((r) => !r.success)
      return {
        success: ok.length > 0 && failed.length === 0,
        written_count: ok.length,
        requested_count: keys.length,
        message:
          `已给 ${ok.length}/${keys.length} 个资产写好` +
          (input.note !== undefined ? '备注' : '') +
          (input.note !== undefined && (input.tagNames || input.tagIds !== undefined) ? '和' : '') +
          (input.tagNames || input.tagIds !== undefined ? '标签' : '') +
          (failed.length > 0 ? `，${failed.length} 个没写成` : '') +
          (folderSelection?.hasMore
            ? `。「${folderSelection.folder}」里一共 ${folderSelection.total} 个，` +
              `剩下的用同样参数加 folderOffset=${folderSelection.nextFolderOffset} 再调一次`
            : ''),
        // 一个资产时把底层的错误原样带出来，别让调用方只看到一句「1 个没写成」
        ...(keys.length === 1 && failed.length === 1 ? { error: failed[0].error } : {}),
        ...(folderSelection ? { folder_selection: folderSelection } : {}),
        results
      }
    }
  })
}
