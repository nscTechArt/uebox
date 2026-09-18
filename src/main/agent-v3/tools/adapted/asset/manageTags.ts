/**
 * 标签的改名、改色、常用标记，以及下线（可选带合并）。
 *
 * ## 为什么补
 *
 * 标签这条路原来只有「看」和「加」：`list_tags` 列出来，`annotate_asset` 打上去 ——
 * 而且**名字不存在就自动新建**。于是 agent 有能力把标签体系越搅越碎（树 / 树木 /
 * Tree），却没有任何办法把它收拾回来：改不了名、合并不了、删不掉。
 * 「帮我把标签整理一下」这句最普通的请求，它只能回一句「你自己去界面里点」。
 *
 * 底层一直是齐的（`models/tag.ts` 的 updateTag / deleteTag，界面在用的同一段），
 * 缺的还是一个 agent 够得着的入口。
 *
 * ## 为什么拆成两个工具
 *
 * 改名/改色是可逆的日常整理，删除和合并会**不可逆地丢掉信息**（标签没有回收站）。
 * 混在一个工具里只有两种下场：要么按低风险登记、删标签时静默放行；要么按高风险
 * 登记、连改个颜色都弹窗，把用户练成无脑点确认。所以照 project_list /
 * project_manage 的老规矩按风险拆开。
 *
 * ## 两个库
 *
 * 标签本身在**公共库**（tags 表），资产↔标签的关联在**保管库**（asset_tags）。
 * 跨库没有外键级联，所以删标签必须自己清关联行 —— 不清就是一堆指向不存在
 * 标签的孤儿行。（界面上的删除至今没清，这里顺手补上。）
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { getAppWindows } from '../../../../appWindows'
import { getPublicDatabase, getVaultDatabase } from '../../../../sqliteDataBase'
import {
  addAssetTag,
  getAssetKeysByTagId,
  removeAllAssetTagsByTagId
} from '../../../../sqliteDataBase/models/assetTag'
import {
  deleteTag,
  getAllTags,
  getTagById,
  updateTag,
  type Tag
} from '../../../../sqliteDataBase/models/tag'

/** 一次最多下线多少个标签 */
const MAX_BATCH = 50

/** 和界面上的取色器一致：六位十六进制 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 标签变更会改到资产上显示的标签，所以照样走 asset:changed ——
 * 不通知的话用户开着素材库页面，agent 说「合并好了」而列表纹丝不动。
 */
function notifyTags(count: number): void {
  getAppWindows()[0]?.webContents.send('asset:changed', {
    source: 'agent',
    op: 'tag',
    tableName: 'tags',
    count
  })
}

/**
 * 按名字找标签。
 *
 * 先精确匹配，再忽略大小写 —— 库里 name 是 UNIQUE，但「Tree」和「tree」是两条，
 * 这时候**不猜**：把候选列出来让人选。猜错的后果是改错/删错一个标签，
 * 而两个名字看上去几乎一样。
 */
function resolveTag(tags: Tag[], input: string): { tag?: Tag; error?: string } {
  const raw = String(input ?? '').trim()
  if (!raw) return { error: '给了个空的标签名。' }

  const exact = tags.find((t) => t.name === raw)
  if (exact) return { tag: exact }

  const loose = tags.filter((t) => String(t.name ?? '').toLowerCase() === raw.toLowerCase())
  if (loose.length === 1) return { tag: loose[0] }
  if (loose.length > 1) {
    return {
      error:
        `库里有 ${loose.length} 个只差大小写的标签：${loose.map((t) => `「${t.name}」`).join('、')}。` +
        '照着 list_tags 里的原样把名字写全，或者问用户要哪一个。'
    }
  }

  return { error: `库里没有标签「${raw}」。用 list_tags 看看都有哪些，名字要完全一致。` }
}

export function createManageTagsTool(): V2Tool {
  return defineV2Tool({
    description: `改标签本身：改名、换颜色、标记常用。

【使用场景】整理标签体系：名字打错了、命名不统一（「贴图」和「材质贴图」）、
  想给主力分类挑个显眼的颜色。
【必填】tag（要改的标签名，来自 list_tags，必须完全一致）+ 下面至少一项。
- newName: 新名字。**改名不会丢关联** —— 打过这个标签的资产照样带着它。
- color: 十六进制颜色，如 "#1890ff"。
- favorite: true 标为常用（界面上会排在前面），false 取消。
【改名 vs 合并】新名字如果已经是另一个标签，改名会失败 —— 那种情况要的是
  **合并**，用 delete_tags 的 mergeInto。
【新建标签】这里不新建。打标签时给个新名字，annotate_asset 会自动建。`,

    inputSchema: z.object({
      tag: z.string().describe('要改的标签名，来自 list_tags 的结果。'),
      newName: z.string().optional().describe('新名字。已经存在的名字会报错 —— 那种情况用合并。'),
      color: z.string().optional().describe('十六进制颜色，如 #1890ff'),
      favorite: z.boolean().optional().describe('true = 标为常用，false = 取消常用')
    }),

    execute: async (input) => {
      const newName = input.newName === undefined ? undefined : String(input.newName).trim()
      if (newName === undefined && input.color === undefined && input.favorite === undefined) {
        return {
          success: false,
          error: '至少要给 newName、color 或 favorite 其中之一，否则这次调用什么都不会改变。'
        }
      }
      if (newName !== undefined && !newName) {
        return { success: false, error: '新名字不能为空。' }
      }
      if (input.color !== undefined && !HEX_COLOR.test(input.color)) {
        return {
          success: false,
          error: `颜色要写成 #1890ff 这样的六位十六进制，收到的是「${input.color}」。`
        }
      }

      const db = getPublicDatabase()
      const tags = getAllTags(db)
      const resolved = resolveTag(tags, input.tag)
      if (resolved.error || !resolved.tag?.id) {
        return { success: false, error: resolved.error ?? '标签解析失败' }
      }
      const target = resolved.tag
      const id = target.id as number

      // 改名撞上已有标签：这是合并，不是改名。直接指路，别让底层的 UNIQUE 报一句看不懂的错
      if (newName !== undefined) {
        const clash = tags.find(
          (t) => t.id !== id && String(t.name ?? '').toLowerCase() === newName.toLowerCase()
        )
        if (clash) {
          return {
            success: false,
            error:
              `已经有一个叫「${clash.name}」的标签了，改名会撞上它。` +
              `如果你要的是把两个合并成一个，用 delete_tags: { tags: ["${target.name}"], mergeInto: "${clash.name}" }。`
          }
        }
      }

      const updates: Partial<Tag> = {
        ...(newName !== undefined ? { name: newName } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.favorite !== undefined ? { is_favorite: input.favorite } : {})
      }

      try {
        updateTag(db, id, updates)
      } catch (error) {
        return { success: false, error: `改标签失败：${errText(error)}` }
      }

      // 回读校验：改完再查一次，没改上就不许报成功
      const after = getTagById(db, id)
      if (newName !== undefined && after?.name !== newName) {
        return {
          success: false,
          error: `改名命令跑完了，但回读时它还叫「${after?.name ?? '查不到'}」—— 没有确认改成功。`
        }
      }
      if (input.color !== undefined && after?.color !== input.color) {
        return {
          success: false,
          error: `改色命令跑完了，但回读时颜色还是「${after?.color ?? '查不到'}」—— 没有确认改成功。`
        }
      }

      notifyTags(1)
      return {
        success: true,
        message:
          `标签「${target.name}」已更新：` +
          [
            newName !== undefined ? `改名为「${newName}」` : '',
            input.color !== undefined ? `颜色 ${input.color}` : '',
            input.favorite !== undefined ? (input.favorite ? '标为常用' : '取消常用') : ''
          ]
            .filter(Boolean)
            .join('、'),
        tag: { name: after?.name, color: after?.color, favorite: after?.is_favorite === true }
      }
    }
  })
}

export function createDeleteTagsTool(): V2Tool {
  return defineV2Tool({
    description: `下线标签：删掉它们，可选先把资产改挂到另一个标签上（= 合并）。

【合并】mergeInto 给目标标签名，就是「把这几个标签合并成那一个」：
  打过这些标签的资产会先都打上目标标签，再把旧标签删掉。资产一个都不会少标签。
  例：{ tags: ["树木", "Tree"], mergeInto: "树" }
【纯删除】不给 mergeInto 就是直接删：标签没了，打过它的资产**就少了这个标签**。
  资产本身一个都不动，但这个标签的分类信息就此丢失。
【没有回收站】标签删了恢复不了（不像资产和文件夹）。删之前把清单和每个标签下
  挂了多少资产念给用户听，得到确认再删 —— list_tags 里有资产数。
【目标标签要先存在】mergeInto 指向的标签必须已经在库里；只是想改个名字用 manage_tags。
【一次最多 ${MAX_BATCH} 个】`,

    inputSchema: z.object({
      tags: z
        .array(z.string())
        .min(1)
        .describe('要下线的标签名列表，来自 list_tags 的结果，必须完全一致。'),
      mergeInto: z
        .string()
        .optional()
        .describe('合并目标标签名。给了就先把资产改挂到它上面再删；不给就是直接删。')
    }),

    execute: async (input) => {
      const publicDb = getPublicDatabase()
      const vaultDb = getVaultDatabase()
      const all = getAllTags(publicDb)

      const wanted = Array.from(
        new Set((input.tags ?? []).map((t) => String(t ?? '').trim()).filter(Boolean))
      )
      if (wanted.length === 0) return { success: false, error: '没有给出任何标签名。' }
      if (wanted.length > MAX_BATCH) {
        return {
          success: false,
          error: `一次最多下线 ${MAX_BATCH} 个，这次给了 ${wanted.length} 个。请分批。`
        }
      }

      // 合并目标先认准，认不准就整批不动 —— 不然会变成「资产没搬走，标签先删了」
      let mergeTarget: Tag | undefined
      if (input.mergeInto !== undefined) {
        const resolved = resolveTag(all, input.mergeInto)
        if (resolved.error || !resolved.tag?.id) {
          return {
            success: false,
            error:
              (resolved.error ?? '合并目标解析失败') +
              ' 合并目标必须是库里已有的标签；只是想改名的话用 manage_tags。'
          }
        }
        mergeTarget = resolved.tag
      }

      // 源标签同样整批先解析
      const targets: Tag[] = []
      for (const raw of wanted) {
        const resolved = resolveTag(all, raw)
        if (resolved.error || !resolved.tag?.id) {
          return { success: false, error: resolved.error ?? `标签「${raw}」解析失败` }
        }
        if (mergeTarget && resolved.tag.id === mergeTarget.id) {
          return {
            success: false,
            error: `「${resolved.tag.name}」既是要删的又是合并目标，那会把它自己删掉。把它从 tags 里去掉。`
          }
        }
        targets.push(resolved.tag)
      }

      const results: Array<{
        tag: string
        status: 'deleted' | 'failed' | 'unconfirmed'
        assets_moved?: number
        assets_untagged?: number
        reason?: string
      }> = []

      for (const tag of targets) {
        const id = tag.id as number
        // 回收站里的资产也算 —— 漏掉它们，标签一删那些关联行就指向不存在的标签
        const assetKeys = getAssetKeysByTagId(vaultDb, id)

        try {
          if (mergeTarget?.id) {
            for (const assetKey of assetKeys) {
              addAssetTag(vaultDb, { assetKey, tagId: mergeTarget.id })
            }
          }
          removeAllAssetTagsByTagId(vaultDb, id)
          deleteTag(publicDb, id)
        } catch (error) {
          results.push({ tag: tag.name, status: 'failed', reason: errText(error) })
          continue
        }

        // 回读校验：还查得到就说明没删成
        if (getTagById(publicDb, id)) {
          results.push({
            tag: tag.name,
            status: 'unconfirmed',
            reason: '删除命令跑完了，但回读时这个标签还在 —— 没有确认删掉，请让用户在界面里核实'
          })
          continue
        }

        results.push({
          tag: tag.name,
          status: 'deleted',
          ...(mergeTarget
            ? { assets_moved: assetKeys.length }
            : { assets_untagged: assetKeys.length })
        })
      }

      const deleted = results.filter((r) => r.status === 'deleted')
      const affected = deleted.reduce(
        (sum, r) => sum + (r.assets_moved ?? r.assets_untagged ?? 0),
        0
      )
      if (deleted.length > 0) notifyTags(deleted.length)

      return {
        success: deleted.length === results.length,
        message: mergeTarget
          ? `已把 ${deleted.length}/${targets.length} 个标签合并进「${mergeTarget.name}」，涉及 ${affected} 个资产`
          : `已删除 ${deleted.length}/${targets.length} 个标签，${affected} 个资产因此少了一个标签（标签删了恢复不了）`,
        deleted_count: deleted.length,
        ...(mergeTarget ? { merged_into: mergeTarget.name } : {}),
        results
      }
    }
  })
}
