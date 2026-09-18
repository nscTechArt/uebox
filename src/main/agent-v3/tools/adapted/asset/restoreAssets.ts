/**
 * 把回收站里的资产恢复回素材库。
 *
 * ## 为什么它必须和删除同时存在
 *
 * `delete_assets` 上线的那一刻，agent 就有了删错东西的能力，却没有把它捡回来的
 * 能力 —— 用户只能自己去界面里翻回收站。**给了删除不给恢复，等于让人在没有
 * 撤销键的编辑器里干活**：agent 认错 assetKey 删掉一条，它自己连补救都做不了，
 * 只能干说一句「你去界面里恢复一下」。
 *
 * 回收站里有什么，用 `search_assets` 加 `deleted: true` 看 —— 那是只读，不用审批。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { getAppWindows } from '../../../../appWindows'
import { getCurrentRemoteHttpVaultContext } from '../../../../networkV2/currentRemoteHttpVault'
import { pushAssetUpdate } from '../../../../networkV2/NetworkSyncBridge'
import { getVaultDatabase } from '../../../../sqliteDataBase'
import { getAssetDataByKey, restoreAssetData } from '../../../../sqliteDataBase/models/assetData'

/** 一次最多恢复多少 */
const MAX_BATCH = 200

type RestoreStatus = 'restored' | 'not_in_trash' | 'failed' | 'unconfirmed'

interface RestoreOutcome {
  assetKey: string
  name?: string
  status: RestoreStatus
  reason?: string
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createRestoreAssetsTool(): V2Tool {
  return defineV2Tool({
    description: `把回收站里的资产恢复回素材库。

【使用场景】删错了要捡回来，或者用户说「刚才那个还是留着吧」。
【必填】assetKeys —— 回收站里那条记录的 assetKey。
【回收站里有什么】用 search_assets 加 deleted: true 列出来，从结果里拿 assetKey。
【删错了立刻恢复】delete_assets 的返回里有每一条的 assetKey，发现删错就直接拿它恢复，
  不要让用户自己去界面里翻。
【所在文件夹也被删了的话】会把它头顶那条已删的文件夹链一起恢复出来，否则资产回来了
  却不在目录树的任何位置。整个文件夹要拿回来用 restore_folders，那个连里面的东西一起恢复。
【一次最多 ${MAX_BATCH} 个】`,

    inputSchema: z.object({
      assetKeys: z
        .array(z.string())
        .min(1)
        .describe(
          '要恢复的资产 assetKey 列表，来自 search_assets（deleted: true）或 delete_assets 的返回。'
        )
    }),

    execute: async (input) => {
      const keys = Array.from(
        new Set((input.assetKeys ?? []).map((key) => String(key ?? '').trim()).filter(Boolean))
      )
      if (keys.length === 0) {
        return { success: false, error: '没有给出任何 assetKey。' }
      }
      if (keys.length > MAX_BATCH) {
        return {
          success: false,
          error: `一次最多恢复 ${MAX_BATCH} 个，这次给了 ${keys.length} 个。请分批。`
        }
      }

      const db = getVaultDatabase()
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      const results: RestoreOutcome[] = []

      for (const assetKey of keys) {
        // getAssetDataByKey 只看未删除的行：查得到说明它压根不在回收站里
        if (getAssetDataByKey(db, assetKey)) {
          results.push({
            assetKey,
            status: 'not_in_trash',
            reason: '这条记录没有被删除，本来就在库里'
          })
          continue
        }

        try {
          if (remoteHttpCtx) {
            await remoteHttpCtx.client.restoreAsset(assetKey)
            await remoteHttpCtx.client.pullChanges()
          } else {
            restoreAssetData(db, assetKey)
            // 不推的话服务端那行还是 isDelete=1，下一次对账会把它又软删回去
            await pushAssetUpdate(assetKey, { isDelete: 0, updated_at: new Date().toISOString() })
          }
        } catch (error) {
          results.push({ assetKey, status: 'failed', reason: errText(error) })
          continue
        }

        // 回读校验：恢复完必须查得到，查不到就是没成
        const after = getAssetDataByKey(db, assetKey)
        if (!after) {
          results.push({
            assetKey,
            status: 'unconfirmed',
            reason:
              '恢复命令跑完了，但回读时库里还是没有这条记录 —— 没有确认恢复成功（也可能这个 assetKey 从来不存在）'
          })
          continue
        }

        results.push({ assetKey, name: after.assetName, status: 'restored' })
      }

      const restored = results.filter((r) => r.status === 'restored')
      if (restored.length > 0) {
        getAppWindows()[0]?.webContents.send('asset:changed', {
          source: 'agent',
          op: 'restore',
          tableName: 'assetData',
          count: restored.length
        })
      }

      const failed = results.filter((r) => r.status !== 'restored')
      return {
        success: restored.length > 0 || failed.length === 0,
        message:
          `已恢复 ${restored.length}/${keys.length} 个资产` +
          (failed.length > 0 ? `，${failed.length} 个没恢复成` : ''),
        restored_count: restored.length,
        requested_count: keys.length,
        results
      }
    }
  })
}
