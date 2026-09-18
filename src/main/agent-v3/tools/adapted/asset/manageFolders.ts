/**
 * 素材库文件夹的改名和删除。
 *
 * ## 为什么补
 *
 * `create_folders` 能建，建错了却收拾不了 —— agent 自己拼错一个名字、
 * 或者按用户后来改口的分类建了一批空目录，都只能留在那儿，让用户自己去界面里删。
 * 建了不能改、不能删，是「只做了当次问到的那一半」的典型。
 *
 * ## 删文件夹会带走里面的资产
 *
 * `deleteAssetFolder` 是**递归软删**：目标文件夹、它的子孙、以及里面所有资产
 * 一起进回收站。所以删之前先数一遍会带走多少资产，并把这个数字写进返回值 ——
 * 用户听到的不能只是「文件夹删了」。资产可以用 `restore_assets` 单独捞回来。
 *
 * 网络库上这两件事还要动真实目录，工具做不了，直接说清楚让人去界面里做
 * （见 `networkVaultGuard`）。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { getAppWindows } from '../../../../appWindows'
import { getVaultDatabase } from '../../../../sqliteDataBase'
import {
  countAssetsInFolderTree,
  deleteAssetFolder,
  getAssetFolderByKey,
  updateAssetFolder,
  updateFolderPathsRecursively
} from '../../../../sqliteDataBase/models/assetFolder'
import { resolveFolder } from './folderLookup'
import { folderWriteBlockReason } from './networkVaultGuard'

/** 和 create_folders 保持一致的名称规则 */
const MAX_NAME_LENGTH = 20
const INVALID_CHARS = /[\\/:*?"<>|]/

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function notifyTree(): void {
  getAppWindows()[0]?.webContents.send('asset:changed', {
    source: 'agent',
    op: 'folder',
    tableName: 'assetFolder'
  })
}

export function createRenameFolderTool(): V2Tool {
  return defineV2Tool({
    description: `给素材库里的文件夹改名。

【使用场景】名字打错了、分类改口了、agent 自己建错了。
【怎么指定】folder 填文件夹名、完整路径（/ALL/角色）或 folderKey。
  同名文件夹有多个时会报错并列出候选 —— 要问用户，不要自己挑。
【名字规则】不能为空、不能叫 ALL、不能含 \\ / : * ? " < > |，最长 ${MAX_NAME_LENGTH} 个字。
【只改名字】文件夹里的资产一个都不动。`,

    inputSchema: z.object({
      folder: z.string().describe('要改名的文件夹：名字、完整路径或 folderKey。'),
      newName: z.string().describe('新名字。')
    }),

    execute: async (input) => {
      const newName = String(input.newName ?? '').trim()
      if (!newName) return { success: false, error: '新名字不能为空。' }
      if (newName.toUpperCase() === 'ALL') {
        return { success: false, error: 'ALL 是系统文件夹的名字，不能用。' }
      }
      if (INVALID_CHARS.test(newName)) {
        return { success: false, error: `文件夹名不能含 \\ / : * ? " < > | 这些字符。` }
      }
      if (newName.length > MAX_NAME_LENGTH) {
        return {
          success: false,
          error: `文件夹名最长 ${MAX_NAME_LENGTH} 个字，这个有 ${newName.length} 个。换个短的。`
        }
      }

      const blocked = folderWriteBlockReason('重命名文件夹')
      if (blocked) return { success: false, error: blocked }

      const db = getVaultDatabase()
      const target = resolveFolder(db, input.folder)
      if (target.error || !target.folderKey) {
        return { success: false, error: target.error ?? '文件夹解析失败' }
      }
      if (target.folderKey === 'ALL') {
        return { success: false, error: 'ALL 是系统根文件夹，不能改名。' }
      }
      const oldName = target.folder?.folderName

      try {
        updateAssetFolder(db, target.folderKey, { folderName: newName })
        // 子孙的 fullPath 里带着旧名字，不重算的话按路径就再也找不到它们
        updateFolderPathsRecursively(db, target.folderKey)
      } catch (error) {
        return { success: false, error: `改名失败：${errText(error)}` }
      }

      // 回读校验
      const after = getAssetFolderByKey(db, target.folderKey)
      if (after?.folderName !== newName) {
        return {
          success: false,
          error: `改名命令跑完了，但回读时它还叫「${after?.folderName ?? '查不到'}」—— 没有确认改成功。`
        }
      }

      notifyTree()
      return {
        success: true,
        message: `文件夹「${oldName}」已改名为「${newName}」`,
        folderKey: target.folderKey,
        fullPath: after.fullPath
      }
    }
  })
}

export function createDeleteFoldersTool(): V2Tool {
  return defineV2Tool({
    description: `删除素材库里的文件夹（连同里面的资产一起进回收站）。

【会带走资产】删一个文件夹 = 它、它的子文件夹、**以及里面所有资产**一起软删。
  返回里的 assets_removed 就是这一下带走了多少个资产。删之前把这个数说给用户听。
【可以恢复】整个文件夹（连同里面的资产）用 restore_folders 捞回来 —— 删错了立刻用
  返回里的 folderKey 恢复，别让用户自己去界面里翻。单个资产用 restore_assets。
【怎么指定】folders 填文件夹名、完整路径或 folderKey 的列表。
  同名文件夹有多个时会报错并列出候选 —— 要问用户，不要自己挑。
【ALL 删不了】那是系统根文件夹。
【网络库不行】网络保管库的文件夹删除还要动真实目录，请让用户在界面里做。`,

    inputSchema: z.object({
      folders: z
        .array(z.string())
        .min(1)
        .describe('要删除的文件夹列表：名字、完整路径或 folderKey。')
    }),

    execute: async (input) => {
      const blocked = folderWriteBlockReason('删除文件夹')
      if (blocked) return { success: false, error: blocked }

      const db = getVaultDatabase()
      const wanted = Array.from(
        new Set((input.folders ?? []).map((f) => String(f ?? '').trim()).filter(Boolean))
      )
      if (wanted.length === 0) return { success: false, error: '没有给出任何文件夹。' }

      // 先整批解析，有一个认不准就整批不动 —— 删错文件夹会连里面的资产一起带走
      const targets: Array<{ input: string; folderKey: string; name: string; assets: number }> = []
      for (const raw of wanted) {
        const resolved = resolveFolder(db, raw)
        if (resolved.error || !resolved.folderKey) {
          return { success: false, error: resolved.error ?? `文件夹「${raw}」解析失败` }
        }
        if (resolved.folderKey === 'ALL') {
          return { success: false, error: 'ALL 是系统根文件夹，不能删除。' }
        }
        targets.push({
          input: raw,
          folderKey: resolved.folderKey,
          name: resolved.folder?.fullPath || resolved.folder?.folderName || resolved.folderKey,
          assets: countAssetsInFolderTree(db, resolved.folderKey)
        })
      }

      const results: Array<{
        folder: string
        folderKey: string
        status: 'deleted' | 'failed' | 'unconfirmed'
        assets_removed?: number
        reason?: string
      }> = []

      for (const target of targets) {
        try {
          deleteAssetFolder(db, target.folderKey)
        } catch (error) {
          results.push({
            folder: target.name,
            folderKey: target.folderKey,
            status: 'failed',
            reason: errText(error)
          })
          continue
        }

        // 回读校验：查得到（未删除的）就说明没删成
        if (getAssetFolderByKey(db, target.folderKey)) {
          results.push({
            folder: target.name,
            folderKey: target.folderKey,
            status: 'unconfirmed',
            reason: '删除命令跑完了，但回读时这个文件夹还在 —— 没有确认删掉'
          })
          continue
        }

        results.push({
          folder: target.name,
          folderKey: target.folderKey,
          status: 'deleted',
          assets_removed: target.assets
        })
      }

      const deleted = results.filter((r) => r.status === 'deleted')
      const assetsRemoved = deleted.reduce((sum, r) => sum + (r.assets_removed ?? 0), 0)
      if (deleted.length > 0) notifyTree()

      return {
        success: deleted.length === results.length,
        message:
          `已删除 ${deleted.length}/${targets.length} 个文件夹` +
          (assetsRemoved > 0
            ? `，连带 ${assetsRemoved} 个资产一起进了回收站（删错了用 restore_folders 连目录一起捞回来）`
            : '（里面没有资产）'),
        deleted_count: deleted.length,
        assets_removed: assetsRemoved,
        results
      }
    }
  })
}
