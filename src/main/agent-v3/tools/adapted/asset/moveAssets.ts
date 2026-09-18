/**
 * 把素材库里的资产搬到另一个文件夹。
 *
 * ## 为什么补这个
 *
 * `create_folders` 能建文件夹，但**建完没有任何办法把资产放进去** ——
 * skill 里甚至专门写了一句「no assets move into the new folders by themselves」
 * 来解释这件事。于是「帮我把素材库整理一下」这条最常见的请求，agent 能建目录、
 * 能打标签，唯独做不了最后那一步搬运，整条链断在终点。
 *
 * ## 搬的是登记，不是文件
 *
 * 和界面上拖拽完全一致（见 `dragMoveService.moveFile`）：只改这条记录的
 * folderKey，**磁盘上的文件不动**。素材库的文件夹是库里的分类，不是磁盘目录。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { getAppWindows } from '../../../../appWindows'
import { getCurrentRemoteHttpVaultContext } from '../../../../networkV2/currentRemoteHttpVault'
import { pushAssetUpdate } from '../../../../networkV2/NetworkSyncBridge'
import { getVaultDatabase } from '../../../../sqliteDataBase'
import { getAssetDataByKey, updateAssetData } from '../../../../sqliteDataBase/models/assetData'
import { selectFolderAssetKeys } from './folderAssets'
import { resolveFolder } from './folderLookup'
import { explainVaultMiss } from './vaultScope'

/** 一次最多搬多少。再多就分批，别一口气重排整个库 */
const MAX_BATCH = 200

type MoveStatus = 'moved' | 'already_there' | 'not_found' | 'failed' | 'unconfirmed'

interface MoveOutcome {
  assetKey: string
  name?: string
  status: MoveStatus
  reason?: string
}

/** 按 sourceFolder 搬时，这一批取的是哪些 —— 还有没有下一批全在这里说清楚 */
interface SourceFolderInfo {
  folder: string
  folderKey?: string
  total: number
  offset: number
  batch_count: number
  hasMore: boolean
  nextOffset?: number
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createMoveAssetsTool(): V2Tool {
  return defineV2Tool({
    description: `把素材库里的资产移动到另一个文件夹。

【使用场景】整理素材库：把散在各处的资产归类到文件夹里。
【必填】targetFolder（目标文件夹）+ assetKeys **或** sourceFolder 其中之一。
【整个文件夹搬】sourceFolder 填源文件夹，就不用先把里面的 assetKey 一个个翻出来。
  默认**只搬这一层**：子文件夹里的资产不动，因为搬过去会被拍平成一堆平铺的资产，
  原来的层级就没了。真要连子文件夹一起搬，显式给 includeSubfolders: true。
【文件夹怎么写】folderKey、完整路径（/ALL/角色/武器）或文件夹名（角色）都行。
  同名文件夹有多个时会报错并把候选列出来 —— 那时候要问用户要哪一个，不要自己挑。
  文件夹不存在就先用 create_folders 建。
【搬的是分类，不是文件】只改资产在库里的归属，**磁盘上的文件一个都不动**。
【一次最多 ${MAX_BATCH} 个】assetKeys 超了就分批；sourceFolder 超了会先搬这一批，
  返回里 source_folder.hasMore 为 true 时**用完全一样的参数再调一次**就接着搬
  （搬走的已经不在源文件夹里了，不用也不能给偏移量）。
  批量整理前先把「哪些搬到哪里」说给用户听。`,

    inputSchema: z.object({
      assetKeys: z
        .array(z.string())
        .optional()
        .describe('要移动的资产 assetKey 列表，来自 search_assets 的结果。'),
      sourceFolder: z
        .string()
        .optional()
        .describe(
          '把这个文件夹里的资产整批搬走：文件夹名、完整路径或 folderKey。和 assetKeys 至少给一个。'
        ),
      includeSubfolders: z
        .boolean()
        .optional()
        .describe('sourceFolder 是否连子文件夹里的资产一起搬，默认 false（搬过去会被拍平）'),
      targetFolder: z
        .string()
        .describe('目标文件夹：folderKey、完整路径（/ALL/角色）或文件夹名（角色）。')
    }),

    execute: async (input) => {
      const db = getVaultDatabase()

      // 源文件夹展开成 assetKey：用户说的是「把 Trees 里的搬到 X」，
      // 不该逼着调用方先把里面几百个 key 翻出来
      let sourceInfo: SourceFolderInfo | undefined
      let fromFolder: string[] = []
      if (input.sourceFolder) {
        // 不做 offset 翻页：搬走的资产**已经不在源文件夹里了**，下一批天然就是
        // 剩下的前 MAX_BATCH 个。这里再按 offset 往后跳会把中间那批整个跳过去。
        const selection = selectFolderAssetKeys(db, input.sourceFolder, {
          includeSubfolders: input.includeSubfolders === true,
          limit: MAX_BATCH
        })
        if (selection.error || !selection.assetKeys) {
          return { success: false, error: selection.error ?? '源文件夹解析失败' }
        }
        fromFolder = selection.assetKeys
        sourceInfo = {
          folder: selection.folderLabel || input.sourceFolder,
          folderKey: selection.folderKey,
          total: selection.total ?? 0,
          offset: selection.offset ?? 0,
          batch_count: fromFolder.length,
          hasMore: selection.hasMore === true,
          ...(selection.nextOffset !== undefined ? { nextOffset: selection.nextOffset } : {})
        }
        if (fromFolder.length === 0) {
          return {
            success: false,
            error:
              `「${sourceInfo.folder}」里没有可搬的资产` +
              (input.includeSubfolders === true
                ? '（连子文件夹一起算）。'
                : '（只看这一层；子文件夹里的要加 includeSubfolders: true）。'),
            source_folder: sourceInfo
          }
        }
      }

      const keys = Array.from(
        new Set(
          [...(input.assetKeys ?? []), ...fromFolder]
            .map((key) => String(key ?? '').trim())
            .filter(Boolean)
        )
      )
      if (keys.length === 0) {
        return {
          success: false,
          error: '没有给出任何 assetKey，也没给 sourceFolder —— 先用 search_assets 拿到它们。'
        }
      }
      if (keys.length > MAX_BATCH) {
        return {
          success: false,
          error: `一次最多搬 ${MAX_BATCH} 个，这次给了 ${keys.length} 个。请分批。`
        }
      }

      const target = resolveFolder(db, input.targetFolder)
      if (target.error || !target.folderKey) {
        return { success: false, error: target.error ?? '目标文件夹解析失败' }
      }
      const targetKey = target.folderKey
      const targetName = target.folder?.fullPath || target.folder?.folderName || targetKey

      const remoteHttpCtx = getCurrentRemoteHttpVaultContext()
      const results: MoveOutcome[] = []

      for (const assetKey of keys) {
        const asset = getAssetDataByKey(db, assetKey)
        if (!asset) {
          results.push({
            assetKey,
            status: 'not_found',
            // 搜索是跨库的，所以模型手上可能拿着别的库的 assetKey。
            // 移动只在活跃库里做（见 vaultScope 的说明），但话要说准
            reason: await explainVaultMiss(
              '当前保管库里没有这条记录（可能已删除，也可能 assetKey 不对）',
              (other) => Boolean(getAssetDataByKey(other, assetKey))
            )
          })
          continue
        }

        const name = asset.assetName
        if (asset.folderKey === targetKey) {
          results.push({ assetKey, name, status: 'already_there', reason: '本来就在这个文件夹里' })
          continue
        }

        const updates = { folderKey: targetKey, updated_at: new Date().toISOString() }

        try {
          if (remoteHttpCtx) {
            await remoteHttpCtx.client.updateAsset(assetKey, updates)
            await remoteHttpCtx.client.pullChanges()
          } else {
            updateAssetData(db, assetKey, updates)
            await pushAssetUpdate(assetKey, updates)
          }
        } catch (error) {
          results.push({ assetKey, name, status: 'failed', reason: errText(error) })
          continue
        }

        // 回读校验：搬完再查一次，folderKey 没变就不算成功
        const after = getAssetDataByKey(db, assetKey)
        if (after?.folderKey !== targetKey) {
          results.push({
            assetKey,
            name,
            status: 'unconfirmed',
            reason: `移动命令跑完了，但回读时它还在原来的文件夹（${after?.folderKey ?? '查不到'}）—— 没有确认搬过去`
          })
          continue
        }

        results.push({ assetKey, name, status: 'moved' })
      }

      const moved = results.filter((r) => r.status === 'moved')
      if (moved.length > 0) {
        getAppWindows()[0]?.webContents.send('asset:changed', {
          source: 'agent',
          op: 'move',
          tableName: 'assetData',
          count: moved.length
        })
      }

      // 这一批一个都没搬动就别再喊「还有下一批」——目标文件夹本身在源文件夹树里
      // 的时候（搬到自己的子目录），资产搬完还留在选取范围内，照着 hasMore 重试
      // 会一直转圈。
      if (sourceInfo && moved.length === 0) sourceInfo.hasMore = false

      const failed = results.filter((r) => r.status !== 'moved' && r.status !== 'already_there')
      return {
        success: failed.length === 0,
        message:
          `已把 ${moved.length}/${keys.length} 个资产移动到「${targetName}」` +
          (failed.length > 0 ? `，${failed.length} 个没搬成` : '') +
          (sourceInfo?.hasMore
            ? `。「${sourceInfo.folder}」里一共 ${sourceInfo.total} 个，这批搬了 ${sourceInfo.batch_count} 个，` +
              '剩下的用**完全一样的参数**再调一次就行（搬走的已经不在源文件夹里了）'
            : ''),
        moved_count: moved.length,
        requested_count: keys.length,
        target_folder: { folderKey: targetKey, name: targetName },
        ...(sourceInfo ? { source_folder: sourceInfo } : {}),
        results
      }
    }
  })
}
