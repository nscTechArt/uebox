/**
 * 把资产从素材库里删掉。
 *
 * ## 为什么补这个工具
 *
 * 素材库这边原来只有搜索、备注/标签、建文件夹三件事 —— **能往里写，不能往外删**。
 * 于是「帮我把重复的清理了」这种最普通的整理请求，agent 只能回一句「我做不了，
 * 你自己去界面里删」：它明明已经把哪两条是重复的都列出来了，却少了最后一步。
 *
 * 后端一直是有的（`db:assetData:delete` 走的就是下面这段逻辑），缺的只是
 * 一个 agent 够得着的入口。
 *
 * ## 这是软删除
 *
 * 和界面上的删除完全一致：`isDelete = 1`，资产进回收站，用户可以在界面里恢复，
 * **磁盘上的文件一个都不动**。所以风险等级虽然登记成 destructive（每次都要用户
 * 确认），真删错了也还有救。
 *
 * 唯一要当心的是**重复登记共用同一个文件**：两条记录指向同一个 filePath 时，
 * 删掉一条没事，但用户接着在界面里「清空回收站」，那个文件会被真的删掉，
 * 留下来的那条就指空了。所以删完要回读一次共用情况，明确告诉调用方。
 */

import path from 'path'

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { getAppWindows } from '../../../../appWindows'
import { getCurrentRemoteHttpVaultContext } from '../../../../networkV2/currentRemoteHttpVault'
import { pushAssetDelete } from '../../../../networkV2/NetworkSyncBridge'
import { getVaultDatabase } from '../../../../sqliteDataBase'
import {
  deleteAssetData,
  getAssetDataByKey,
  getLiveAssetsByFilePath
} from '../../../../sqliteDataBase/models/assetData'
import { PathManager } from '../../../../utils/PathManager'
import { isInsideDirectory } from '../../../../utils/pathContainment'
import { explainVaultMiss } from './vaultScope'

/** 一次最多删多少个。再多就该分批跟用户确认，而不是一口气清库 */
const MAX_BATCH = 100

type DeleteStatus = 'deleted' | 'not_found' | 'failed' | 'unconfirmed'

interface DeleteOutcome {
  assetKey: string
  name?: string
  status: DeleteStatus
  reason?: string
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 这个文件是不是保管库自己复制出来的副本。
 *
 * 只有副本才会被「清空回收站」真删掉（见 `deleteVaultBackupAndThumbnail`）；
 * 用户原地引用的文件在保管库外面，怎么删记录都不会掉。判不出来就当不是 ——
 * 宁可少报一次共用提醒，也不要凭空吓唬人。
 */
function isVaultCopy(filePath?: string | null): boolean {
  if (!filePath) return false
  try {
    const pm = PathManager.getInstance()
    const root = path.resolve(pm.getAssetDataPath())
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.join(path.resolve(pm.getCurrentVaultPath()), filePath)
    return isInsideDirectory(absolute, root)
  } catch {
    return false
  }
}

export function createDeleteAssetsTool(): V2Tool {
  return defineV2Tool({
    description: `把资产从素材库里删掉（移入回收站）。

【使用场景】用户要清理素材库：删重复登记、删不要的素材、删导错的东西。
【必填】assetKeys —— 来自 search_assets 结果里的 assetKey，猜不出来。
【是软删除】资产进回收站，用户能在界面里恢复；**磁盘上的原文件不动**。
  真正抹掉文件要用户自己在界面里「彻底删除 / 清空回收站」。
【一次最多 ${MAX_BATCH} 个】超过就分批，每批之前跟用户核对清单。
【删之前先核对】assetKey 认错就删错人。批量删同名资产前，先把清单
  （名字 + 路径 + assetKey）念给用户听，得到确认再删。
【共用文件的提醒】返回里的 shared_file_warnings 说明被删的记录和库里另一条
  记录指向同一个文件（重复导入的典型样子）。这种情况下要告诉用户：留在回收站
  就行，**别去清空回收站**，否则那个文件会被真删掉，另一条记录就指空了。
【删的是盒子素材库的登记】虚幻工程里的资产用 ue_content_delete，磁盘上的
  散装文件这里删不了。`,

    inputSchema: z.object({
      assetKeys: z
        .array(z.string())
        .min(1)
        .describe('要删除的资产 assetKey 列表，来自 search_assets 的结果。')
    }),

    execute: async (input) => {
      const keys = Array.from(
        new Set((input.assetKeys ?? []).map((key) => String(key ?? '').trim()).filter(Boolean))
      )

      if (keys.length === 0) {
        return { success: false, error: '没有给出任何 assetKey —— 先用 search_assets 拿到它们。' }
      }
      if (keys.length > MAX_BATCH) {
        return {
          success: false,
          error: `一次最多删 ${MAX_BATCH} 个，这次给了 ${keys.length} 个。请分批，并在每批之前跟用户核对清单。`
        }
      }

      const db = getVaultDatabase()
      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      const results: DeleteOutcome[] = []
      const sharedFileWarnings: string[] = []

      for (const assetKey of keys) {
        const asset = getAssetDataByKey(db, assetKey)
        if (!asset) {
          results.push({
            assetKey,
            status: 'not_found',
            // 搜索是跨库的，所以模型手上可能拿着别的库的 assetKey。
            // 删除只在活跃库里做（见 vaultScope 的说明），但话要说准
            reason: await explainVaultMiss(
              '当前保管库里没有这条记录（可能已经删过了，也可能 assetKey 不对）',
              (other) => Boolean(getAssetDataByKey(other, assetKey))
            )
          })
          continue
        }

        const name = asset.assetName

        try {
          if (remoteHttpCtx) {
            await remoteHttpCtx.client.deleteAsset(assetKey)
            await remoteHttpCtx.client.pullChanges()
          } else {
            deleteAssetData(db, assetKey)
            await pushAssetDelete(assetKey)
          }
        } catch (error) {
          results.push({ assetKey, name, status: 'failed', reason: errText(error) })
          continue
        }

        // 回读校验：删完再查一次。查得到就不许报成功 —— 宁可说「没确认上」，
        // 也不能让用户以为清干净了，回头在界面里发现原样还在。
        if (getAssetDataByKey(db, assetKey)) {
          results.push({
            assetKey,
            name,
            status: 'unconfirmed',
            reason: '删除命令跑完了，但回读时这条记录还在库里 —— 没有确认删掉，请让用户在界面里核实'
          })
          continue
        }

        results.push({ assetKey, name, status: 'deleted' })

        const twins = getLiveAssetsByFilePath(db, asset.filePath, assetKey)
        if (twins.length > 0 && isVaultCopy(asset.filePath)) {
          sharedFileWarnings.push(
            `「${name}」和库里还在的 ${twins
              .map((t) => `「${t.assetName}」(${t.assetKey})`)
              .join('、')} 指向同一个文件。留在回收站没事，` +
              '但清空回收站会把这个文件真删掉，那几条记录会一起指空。'
          )
        }
      }

      const deleted = results.filter((r) => r.status === 'deleted')

      // 删掉的东西要让界面立刻反映出来，否则用户看着列表没变、以为工具在骗他
      if (deleted.length > 0) {
        const mainWindow = getAppWindows()[0]
        mainWindow?.webContents.send('asset:changed', {
          source: 'agent',
          op: 'delete',
          tableName: 'assetData',
          count: deleted.length
        })
      }

      const failed = results.filter((r) => r.status !== 'deleted')
      const message =
        `已把 ${deleted.length}/${keys.length} 个资产移入回收站（可在界面里恢复，磁盘文件未动）` +
        (failed.length > 0 ? `，${failed.length} 个没删成` : '')

      return {
        success: deleted.length > 0 || failed.length === 0,
        message,
        deleted_count: deleted.length,
        requested_count: keys.length,
        results,
        ...(sharedFileWarnings.length > 0 ? { shared_file_warnings: sharedFileWarnings } : {})
      }
    }
  })
}
