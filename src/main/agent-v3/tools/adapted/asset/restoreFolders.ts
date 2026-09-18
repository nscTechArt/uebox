/**
 * 把回收站里的文件夹恢复回素材库。
 *
 * ## 为什么必须有
 *
 * `delete_folders` 是整个素材库这边影响面最大的一次操作：删一个文件夹，
 * 它的子孙**和里面所有资产**一起进回收站。而它上线时配的撤销只有
 * `restore_assets` —— 那个只捞资产，捞不回文件夹本身。于是 agent 删错一个
 * 包，能把 776 个资产一条条恢复出来，却**恢复不出它们原来待的那棵目录树**，
 * 只能让用户自己去界面里点。
 *
 * 底层一直是齐的：`restoreAssetFolder` 递归恢复文件夹树和里面的资产，
 * `getDeletedAssetFolders` 列回收站，两个都是界面在用的同一段代码。
 * 缺的只是一个 agent 够得着的入口。这和 [delete_assets ↔ restore_assets]
 * 是同一条规矩：**给了删除就必须给恢复**，否则等于让人在没有撤销键的
 * 编辑器里干活。
 *
 * ## 不给参数就是列回收站
 *
 * 资产那边看回收站走 `search_assets(deleted: true)`，文件夹这边原来没有任何
 * 只读入口 —— 模型连「回收站里有什么文件夹」都问不出来，更没法拿到 folderKey。
 * 所以这个工具不给 folders 时就是列出来，给了才动手。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { getAppWindows } from '../../../../appWindows'
import { getVaultDatabase } from '../../../../sqliteDataBase'
import {
  findDeletedAssetFolder,
  getAssetFolderByKey,
  getDeletedAssetFolders,
  restoreAssetFolder,
  type AssetFolder
} from '../../../../sqliteDataBase/models/assetFolder'
import { folderWriteBlockReason } from './networkVaultGuard'

/** 一次最多恢复多少个文件夹。每个都是递归恢复整棵树，多了就分批 */
const MAX_BATCH = 50

/** 列回收站时最多回几条 */
const LIST_LIMIT = 200

type RestoreStatus = 'restored' | 'not_in_trash' | 'ambiguous' | 'failed' | 'unconfirmed'

interface RestoreOutcome {
  folder: string
  folderKey?: string
  status: RestoreStatus
  reason?: string
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const describe = (folder: AssetFolder): string =>
  folder.fullPath || folder.folderName || folder.folderKey

function notifyTree(): void {
  getAppWindows()[0]?.webContents.send('asset:changed', {
    source: 'agent',
    op: 'folder',
    tableName: 'assetFolder'
  })
}

/**
 * 在**已删除**的文件夹里找一个。
 *
 * 不能用 `resolveFolder`：它查的是活着的文件夹（`getAssetFolderByKey` 写死了
 * `isDelete = 0`），回收站里的一个都找不到。
 *
 * 同名一律报错不猜 —— 和 `folderLookup` 同一条规矩：恢复错文件夹会把一批
 * 用户已经决定删掉的东西又搬回库里，而且没有任何提示。
 */
function resolveDeleted(
  deleted: AssetFolder[],
  input: string
): { folder?: AssetFolder; error?: string } {
  const raw = input.trim()
  if (!raw) return { error: '给了个空的文件夹标识。' }

  const byKey = deleted.find((f) => f.folderKey === raw)
  if (byKey) return { folder: byKey }

  const byPath = deleted.filter((f) => (f.fullPath || '').toLowerCase() === raw.toLowerCase())
  if (byPath.length === 1) return { folder: byPath[0] }
  if (byPath.length > 1) {
    return {
      error: `回收站里有 ${byPath.length} 个路径都是「${raw}」的文件夹，用 folderKey 指定：${byPath
        .map((f) => f.folderKey)
        .join('、')}`
    }
  }

  const byName = deleted.filter((f) => (f.folderName || '').toLowerCase() === raw.toLowerCase())
  if (byName.length === 1) return { folder: byName[0] }
  if (byName.length > 1) {
    return {
      error:
        `回收站里有 ${byName.length} 个叫「${raw}」的文件夹，不知道你要哪一个：` +
        `${byName.map((f) => `${describe(f)}（${f.folderKey}）`).join('、')}。` +
        '把完整路径或 folderKey 给我，或者问用户要哪一个。'
    }
  }

  return { error: `回收站里没有「${raw}」。不带参数调一次这个工具就能看到里面都有什么。` }
}

export function createRestoreFoldersTool(): V2Tool {
  return defineV2Tool({
    description: `把回收站里的文件夹恢复回素材库（连同里面的子文件夹和资产）。

【不给参数 = 列回收站】先这么调一次，看看里面有哪些文件夹、拿到 folderKey。
  列的是**每一次删除的那个根文件夹**，它的子孙不单独列（跟着一起恢复）；
  真要只恢复里面的某个子文件夹，直接把那个 folderKey 填进来也认。
【恢复】folders 填文件夹名、完整路径或 folderKey 的列表。
  同名的有多个时会报错并列出候选 —— 要问用户，不要自己挑。
【是递归恢复】目标文件夹、它的子孙、以及里面被一起软删的资产都会回来。
【删错了立刻恢复】delete_folders 的返回里有每一个的 folderKey，发现删错直接拿它恢复，
  不要让用户自己去界面里翻。
【和 restore_assets 的分工】那个只恢复单个资产；整个文件夹被删掉了要用这个 ——
  光恢复资产不恢复文件夹，资产回来了也没有原来的目录结构。
【一次最多 ${MAX_BATCH} 个】
【网络库不行】远程/网络保管库的恢复还要动真实目录，请让用户在界面里做。`,

    inputSchema: z.object({
      folders: z
        .array(z.string())
        .optional()
        .describe(
          '要恢复的文件夹：名字、完整路径或 folderKey。留空 = 只列出回收站里有什么，不动手。'
        )
    }),

    execute: async (input) => {
      const db = getVaultDatabase()
      const { list, total } = getDeletedAssetFolders(db, 1, LIST_LIMIT)

      const wanted = Array.from(
        new Set((input.folders ?? []).map((f) => String(f ?? '').trim()).filter(Boolean))
      )

      // ── 只读：回收站里有什么 ────────────────────────────────────────────
      if (wanted.length === 0) {
        return {
          success: true,
          count: total,
          returnedCount: list.length,
          folders: list.map((f) => ({
            folderKey: f.folderKey,
            name: f.folderName,
            fullPath: f.fullPath,
            // 老库里 deletedAt 可能还是空的，退回 updated_at
            deletedAt: f.deletedAt ?? f.updated_at
          })),
          message:
            total === 0
              ? '回收站里没有已删除的文件夹。'
              : `回收站里有 ${total} 个已删除的文件夹` +
                (total > list.length ? `（这里列了前 ${list.length} 个）` : '') +
                '。要恢复哪个就把它的 folderKey 或完整路径填进 folders 再调一次。'
        }
      }

      const blocked = folderWriteBlockReason('恢复文件夹')
      if (blocked) return { success: false, error: blocked }

      if (wanted.length > MAX_BATCH) {
        return {
          success: false,
          error: `一次最多恢复 ${MAX_BATCH} 个，这次给了 ${wanted.length} 个。请分批。`
        }
      }

      // 先整批解析，有一个认不准就整批不动 —— 恢复错文件夹是无声的错误
      const targets: Array<{ input: string; folder: AssetFolder }> = []
      for (const raw of wanted) {
        const resolved = resolveDeleted(list, raw)
        // 列表里只有「这一次删除的根」；子孙层要单独恢复的话，按 key / 路径再找一次
        const fallback = resolved.folder ? undefined : findDeletedAssetFolder(db, raw)
        if (fallback) {
          targets.push({ input: raw, folder: fallback })
          continue
        }
        if (resolved.error || !resolved.folder) {
          return {
            success: false,
            error: resolved.error ?? `文件夹「${raw}」解析失败`,
            trash_count: total
          }
        }
        targets.push({ input: raw, folder: resolved.folder })
      }

      const results: RestoreOutcome[] = []
      for (const target of targets) {
        const name = describe(target.folder)
        try {
          restoreAssetFolder(db, target.folder.folderKey)
        } catch (error) {
          results.push({
            folder: name,
            folderKey: target.folder.folderKey,
            status: 'failed',
            reason: errText(error)
          })
          continue
        }

        // 回读校验：查得到（未删除的）才算恢复成功。查不到就明说没确认上，
        // 不能让用户以为东西回来了、回头在界面里发现回收站里还躺着。
        if (!getAssetFolderByKey(db, target.folder.folderKey)) {
          results.push({
            folder: name,
            folderKey: target.folder.folderKey,
            status: 'unconfirmed',
            reason: '恢复命令跑完了，但回读时它还在回收站里 —— 没有确认恢复，请让用户在界面里核实'
          })
          continue
        }

        results.push({ folder: name, folderKey: target.folder.folderKey, status: 'restored' })
      }

      const restored = results.filter((r) => r.status === 'restored')
      if (restored.length > 0) notifyTree()

      return {
        success: restored.length === results.length,
        message:
          `已恢复 ${restored.length}/${targets.length} 个文件夹（连同里面的子文件夹和资产）` +
          (restored.length < results.length
            ? `，${results.length - restored.length} 个没恢复成`
            : ''),
        restored_count: restored.length,
        requested_count: targets.length,
        results
      }
    }
  })
}
