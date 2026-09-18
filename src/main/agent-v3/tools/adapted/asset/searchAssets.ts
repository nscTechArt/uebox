/**
 * 资产搜索原子工具
 * 封装 AssetSearcher 的能力供 Agent 使用
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { searchAssets } from '../../../../agent/tools/app-control/asset-manager/AssetSearcher'
import { formatAssets } from '../../../../agent/tools/app-control/asset-manager/AssetFormatter'
import type { AssetSearchParams } from '../../../../agent/tools/app-control/asset-manager/types'
import { getPublicDatabase, getVaultDatabase } from '../../../../sqliteDataBase'
import { getDeletedAssetData } from '../../../../sqliteDataBase/models/assetData'
import { getTagByName } from '../../../../sqliteDataBase/models/tag'
import { resolveFolder } from './folderLookup'
import { runAcrossVaults, VAULT_SCOPE_DESCRIPTION } from './vaultScope'

/**
 * 中文关键词落空时，**工具自己把库里有什么捞出来**，而不是只丢一句提示。
 *
 * 真机上量到的问题：虚幻资产名基本都是英文（SM_Chair_Wood、T_Wood_Diffuse），
 * 而用户用中文提问。实测「椅子」0 条 /「chair」2 条，「木头」0 条 /「wood」4 条，
 * 「贴图」0 条 /「texture」2 条。
 *
 * 这里**不塞中英词表** —— 那种表永远补不完。但只回一句「请换英文词再搜」也不够：
 * 那等于把这条知识摊派给每一次对话（skill 里为此专门写了一节加一张实测表），
 * 而调用方拿到的仍然是零信息，只能凭空猜一个英文词，猜不中就再猜。
 *
 * 现在的做法是零结果时**自动去掉关键词再查一次**，把库里真实存在的名字回给调用方。
 * 它看着真名挑，比猜词准得多，也不需要任何词表。这和类型/格式过滤落空时
 * 自动放宽是同一个套路 —— 连同那条铁律一起继承：**放宽了必须说出来。**
 */
const SAMPLE_LIMIT = 20

const KEYWORD_MISS_HINT =
  '中文关键词没有命中任何资产 —— 库里的名字基本是英文（SM_Chair_Wood、T_Wood_Diffuse）。' +
  '下面 library_sample 是库里真实存在的资产，照着它挑一个英文词再搜，不要凭空猜。' +
  '想先看清楚库里有哪些类型、哪些文件夹、哪些标签，用 library_overview —— ' +
  '它回的是全量分布，比这 20 个样本有代表性得多。' +
  '注意：中文**标签**是搜得到的，只有名字是英文。' +
  '另外：资产库设置里可以打开**语义搜索**，打开之后中文查询能直接对上英文资产名。'

const hasChinese = (value: unknown): boolean => typeof value === 'string' && /[一-龥]/.test(value)

/** 日期两端的兜底。底层 dateRange 要求两端都有值，缺一端整条筛选会被忽略 */
const DATE_MIN = '0001-01-01 00:00:00'
const DATE_MAX = '9999-12-31 23:59:59'

const dayStart = (value: string): string => `${value.trim().slice(0, 10)} 00:00:00`
const dayEnd = (value: string): string => `${value.trim().slice(0, 10)} 23:59:59`

interface SearchOutcome {
  success?: boolean
  count?: number
  error?: string
  assets?: Array<{ name?: string; assetType?: string }>
}

/** 一个库搜完的账：总数是多少、这一页取走了哪几个 */
interface VaultPage {
  count: number
  taken: Array<Record<string, unknown>>
  /** 这个库里没有这个文件夹。不算失败，别的库可能有 */
  folderMiss?: string
  folderLabel?: string
}

/**
 * 这一页里有哪些引擎版本 —— 只在真有 .uasset 版本记录时才说一句。
 *
 * `.uasset` 只能导进**同版本或更高版本**的工程，所以这一栏是「能不能进我这个工程」
 * 的唯一判据。它一度既不在结果里、也没人提过，而 `engineVersion` 过滤参数早就存在：
 * 实测批量导入时，失败里绝大多数都是同一句
 * 「资产引擎版本 (UE 5.7) 高于目标项目版本 (UE 5.5)」，事后重搜替代件又花了 7 次往返。
 *
 * 放在返回里而不是工具描述里：描述是每一轮、每个用户都要付的前缀，
 * 而这件事只有真的搜到东西时才用得上。
 */
function describeEngineVersionSpread(assets: Array<Record<string, unknown>>): string {
  const counts = new Map<string, number>()
  for (const asset of assets) {
    const version = asset.engineVersion
    if (typeof version === 'string' && version.trim()) {
      counts.set(version, (counts.get(version) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return ''

  const spread = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([version, n]) => `${version} ${n} 个`)
    .join('、')

  return (
    `这一页的引擎版本：${spread}。` +
    '.uasset **只能导进同版本或更高版本的工程**（5.7 的资产进不了 5.5 的工程），' +
    '给某个工程挑素材时用 engineVersion 参数先筛一遍，别等导入失败了才发现。'
  )
}

/** 标签名换 id。查不到的原样回给调用方，绝不静默丢掉 */
function resolveTagIds(names: string[]): { ids: number[]; unknown: string[] } {
  const ids: number[] = []
  const unknown: string[] = []
  if (names.length === 0) return { ids, unknown }

  const db = getPublicDatabase()
  for (const raw of names) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    const tag = getTagByName(db, name)
    if (tag && typeof tag.id === 'number') ids.push(tag.id)
    else unknown.push(name)
  }
  return { ids, unknown }
}

/**
 * 创建资产搜索工具
 * @returns 资产搜索工具实例
 */
export function createSearchAssetsTool(): V2Tool {
  return defineV2Tool({
    description: `搜索或浏览**盒子素材库**里的资产（跨工程的素材仓库，不是某个 UE 工程）。

【使用场景】用户要找素材、问「库里有什么」、要整理资产时使用。
【搜的是素材库，不是工程】要找**当前打开的工程里已有的**资产（/Game/... 那些），
  用 ue_content_search；要找关卡里摆着的实例，用 ue_get_actor。
【「我库里有什么」不要用这个工具】那个问题用 library_overview —— 它回的是全量精确分布，
  几百字就说完。这里一页最多 500 个，几十万个资产的库靠翻页是数不完的，
  拿前一页去总结全库会得出错误结论，而且看不出错。
【浏览】不带任何条件调用 = 按名字列出整个库，只在需要具体资产清单时用。
【翻页】一次最多回 500 个，默认 100。返回里的 count 是符合条件的**总数**，
  hasMore 为 true 说明后面还有 —— 用同样的条件加上返回的 nextOffset 再调一次
  就能接着往下看。要清点全库时照这个翻，不要靠换关键词去猜。
【按文件夹】folder 填文件夹名（角色）、完整路径（/ALL/角色）或 folderKey 都行，
  默认连子文件夹一起搜。「Trees 文件夹里有什么」用它，别去全库翻。
【按标签】tags 填标签名（中文标签也行）。tagsMatch: "all" 要求全都有，默认任意一个命中。
  标签名库里不存在会直接报错并把名字列出来 —— 不会假装筛过了。
【收藏 / 时间】favorite: true 只看收藏；changedAfter / changedBefore 按**最近一次变动**
  的时间筛（格式 2026-08-31）—— 注意那是改动时间，不等于「导入时间」，
  给资产写过备注、打过标签都会刷新它。
【回收站】deleted: true 列出回收站里的资产（配合 restore_assets 恢复）。
  这个模式只支持翻页，不能和其他筛选一起用。
【默认搜遍所有保管库】用户的资产分散在多个库里（默认保管库、AIGC 资产库、
  他自己建的、网络协作库），**不是一个库**。这个工具默认全搜，结果里的 vault
  字段说明每条来自哪个库，by_vault 说明各库各有多少。
  「没搜到」之前先确认你没有把范围收窄到某一个库 —— 只在用户明确说
  「只看某个库」时才填 vault。
【AI 生成的素材也在里面】AI 出的图/视频/模型/音乐在「AIGC 资产库」。
  用户说「刚才生成的那张图」「之前 AI 出的模型」就用这个工具找。
  **它们要导进虚幻工程，用 ue_content_import，把 real_path 填进 files** ——
  是 png / mp4 / glb 这类外部文件，不是 .uasset，走不了 project_manage。
【名字是英文】虚幻资产名几乎都是英文（SM_Chair_Wood、T_Wood_Diffuse）。
  中文关键词搜不到时**不用自己猜英文词**：这个工具会自动去掉关键词再查一次，
  在 library_sample 里把库里真实存在的资产回给你，照着挑就行。
  中文**标签**是搜得到的 —— 只有名字是英文。
【与其他搜索的区别】
- 这个搜的是**盒子的素材库**（用户自己收集整理的，带标签和备注）
- 虚幻工程里的资产用 ue_content_search
- 磁盘上的散装文件用 find_local_files`,
    inputSchema: z.object({
      query: z.string().optional().describe('搜索关键词（英文资产名效果最好）。留空则浏览全库。'),
      vault: z.string().optional().describe(VAULT_SCOPE_DESCRIPTION),
      fileFormat: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('文件格式。支持扩展名（png, fbx）或别名（"模型"、"贴图"、"材质"）'),
      assetType: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('虚幻引擎资产类型，如 StaticMesh、SkeletalMesh、Texture2D 等。'),
      fileSize: z
        .object({
          min: z.number().optional().describe('最小文件大小（字节）'),
          max: z.number().optional().describe('最大文件大小（字节）')
        })
        .optional()
        .describe('文件大小范围'),
      engineVersion: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('引擎版本，如 5.3.0、5.4'),
      folder: z
        .string()
        .optional()
        .describe('只搜这个文件夹：文件夹名（角色）、完整路径（/ALL/角色）或 folderKey。'),
      includeSubfolders: z
        .boolean()
        .optional()
        .describe('搜文件夹时是否连子文件夹一起搜，默认 true'),
      tags: z.array(z.string()).optional().describe('必须带这些标签（标签名）。'),
      tagsMatch: z
        .enum(['any', 'all'])
        .optional()
        .describe('tags 的匹配方式：any = 命中任意一个（默认），all = 必须全都有'),
      excludeTags: z.array(z.string()).optional().describe('排除带这些标签的资产。'),
      favorite: z.boolean().optional().describe('true = 只看收藏的，false = 只看没收藏的'),
      changedAfter: z.string().optional().describe('最近变动时间不早于这天，格式 2026-08-31'),
      changedBefore: z.string().optional().describe('最近变动时间不晚于这天，格式 2026-08-31'),
      deleted: z
        .boolean()
        .optional()
        .describe('true = 列出回收站里已删除的资产。只支持翻页，不能和其他筛选一起用。'),
      hasNoTags: z.boolean().optional().describe('是否只搜索无标签的资产'),
      limit: z.number().optional().describe('这一页要几个，默认 100，最多 500'),
      offset: z.number().optional().describe('跳过前几个。翻页时填上一次返回的 nextOffset')
    }),
    execute: async (input) => {
      const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 100)), 500)
      const offset = Math.max(0, Math.floor(input.offset ?? 0))

      // ── 回收站：走另一条查询（普通搜索的 SQL 写死了 isDelete = 0）──────────
      if (input.deleted === true) {
        const otherFilters = (
          [
            'query',
            'fileFormat',
            'assetType',
            'fileSize',
            'engineVersion',
            'folder',
            'tags',
            'excludeTags',
            'favorite',
            'changedAfter',
            'changedBefore',
            'hasNoTags',
            // 回收站只查当前保管库。显式给了 vault 却被悄悄忽略，
            // 调用方会把主库的回收站当成 AIGC 库的回收站念给用户听。
            'vault'
          ] as const
        ).filter((key) => input[key] !== undefined)

        if (otherFilters.length > 0) {
          return {
            success: false,
            error:
              `回收站列表只支持翻页（limit / offset），不能和 ${otherFilters.join('、')} 一起用。` +
              '先把回收站列出来，再自己在结果里挑。'
          }
        }

        const page = Math.floor(offset / limit) + 1
        const { list, total } = getDeletedAssetData(getVaultDatabase(), page, limit)
        const nextOffset = offset + list.length
        return {
          success: true,
          count: total,
          returnedCount: list.length,
          offset,
          limit,
          hasMore: nextOffset < total,
          ...(nextOffset < total ? { nextOffset } : {}),
          // 删除时间是这个列表里唯一有意义的时间，单独带上（老库里可能是空的）
          assets: formatAssets(list).map((asset, index) => ({
            ...asset,
            deletedAt: list[index]?.deletedAt ?? list[index]?.updated_at
          })),
          message:
            `回收站里有 ${total} 个已删除的资产（按删除时间倒序）。` +
            '它们还能用 restore_assets 恢复；在界面里「清空回收站」之后就彻底没了。' +
            '删掉的**文件夹**不在这个列表里，用 restore_folders 不带参数列。'
        }
      }

      const params: AssetSearchParams = {
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.fileFormat !== undefined ? { fileFormat: input.fileFormat } : {}),
        ...(input.assetType !== undefined ? { assetType: input.assetType } : {}),
        ...(input.fileSize !== undefined ? { fileSize: input.fileSize } : {}),
        ...(input.engineVersion !== undefined ? { engineVersion: input.engineVersion } : {}),
        ...(input.hasNoTags !== undefined ? { hasNoTags: input.hasNoTags } : {}),
        limit,
        offset
      }

      // ── 标签：名字换 id。含标签名不存在时**必须报错** ────────────────────
      // 不报的话筛选条件会变成空数组、被底层当成「没筛」，于是整个库原样回来 ——
      // 调用方会把全库当成「带这个标签的资产」念给用户听。
      const include = resolveTagIds(input.tags ?? [])
      const exclude = resolveTagIds(input.excludeTags ?? [])
      if (include.unknown.length > 0) {
        return {
          success: false,
          error:
            `库里没有这些标签：${include.unknown.join('、')}。` +
            '标签名要和库里的完全一致；不确定就把它当关键词放进 query 搜一次（中文标签是搜得到的）。'
        }
      }
      if (include.ids.length > 0 || exclude.ids.length > 0) {
        params.tagFilter = {
          ...(include.ids.length ? { includeTagIds: include.ids } : {}),
          ...(exclude.ids.length ? { excludeTagIds: exclude.ids } : {}),
          matchMode: input.tagsMatch ?? 'any'
        }
      }

      if (input.favorite !== undefined) {
        params.favoriteStatus = input.favorite ? 'favorite' : 'unfavorite'
      }

      if (input.changedAfter || input.changedBefore) {
        params.dateRange = {
          start: input.changedAfter ? dayStart(input.changedAfter) : DATE_MIN,
          end: input.changedBefore ? dayEnd(input.changedBefore) : DATE_MAX
        }
      }

      // ── 每个保管库跑一趟 ──────────────────────────────────────────────────
      //
      // 不带条件 = 浏览全库。
      //
      // 原来这里直接报错「搜索需要至少提供一个条件」，于是「我素材库里有
      // 什么」这个**最自然的第一个问题**没法回答 —— 调用方只能搜它已经
      // 知道存在的东西，没有任何办法先看一眼库里有些啥。
      //
      // 分页是**首尾相接**的：当前库排最前，它这一页没占满才轮到下一个库。
      // `skip` / `remaining` 在回调里逐库递减 —— runAcrossVaults 保证顺序执行。
      let skip = offset
      let remaining = limit
      let total = 0
      let folderLabel: string | undefined
      const collected: Array<Record<string, unknown>> = []
      const perVault: Record<string, number> = {}
      const folderMisses: string[] = []

      const { runs, error: scopeError } = await runAcrossVaults<VaultPage>(
        input.vault,
        async (db, vault) => {
          const scoped: AssetSearchParams = {
            ...params,
            // 这一页占满了也照跑：不跑的话 count 会漏掉后面几个库，
            // hasMore / nextOffset 跟着算错，翻页就永远翻不到它们
            limit: Math.max(1, remaining),
            offset: skip
          }

          // 文件夹：用户说的是名字，底层认的是 folderKey。
          // folderKey 是**每个库各一套**的，所以必须逐库解析，不能跨库复用。
          if (input.folder) {
            const resolved = resolveFolder(db, input.folder)
            if (resolved.error || !resolved.folderKey) {
              const miss = resolved.error ?? '文件夹解析失败'
              folderMisses.push(`${vault.name}：${miss}`)
              return { count: 0, taken: [], folderMiss: miss }
            }
            scoped.folderKey = resolved.folderKey
            scoped.includeSubfolders = input.includeSubfolders !== false
            folderLabel ??=
              resolved.folder?.fullPath || resolved.folder?.folderName || resolved.folderKey
          }

          // vault.path 一定要跟着 db 一起传：备份库里资产的 filePath 是相对
          // 保管库的，不给库根目录就会按**当前活跃库**去拼，跨库搜到的资产
          // 路径就指到了另一个库的目录下
          const outcome = (await searchAssets(scoped, db, vault.path)) as SearchOutcome
          // 这一个库炸了就只算它自己失败（helper 会接住），别的库照常出结果
          if (outcome.success === false) throw new Error(outcome.error ?? '搜索失败')

          const count = outcome.count ?? 0
          total += count
          perVault[vault.name] = count

          const taken: Array<Record<string, unknown>> = []
          if (remaining > 0) {
            for (const asset of (outcome.assets ?? []).slice(0, remaining)) {
              taken.push({ ...asset, vault: vault.name })
            }
            remaining -= taken.length
            collected.push(...taken)
          }
          skip = Math.max(0, skip - count)

          return { count, taken, folderLabel }
        }
      )

      if (scopeError) return { success: false, error: scopeError }

      // 一个库都认不出这个文件夹才算失败 —— 只在其中一个库里存在是正常的
      if (input.folder && !folderLabel) {
        return {
          success: false,
          error: `所有保管库里都没有文件夹「${input.folder}」。${folderMisses.join('；')}`
        }
      }

      const failed = runs.filter((run) => run.error)
      const searched = runs.filter((run) => !run.error).map((run) => run.vault.name)

      // 一个库都没搜成 = 这次搜索失败，不是「库里没有」。
      // 报成 0 结果的话，调用方会告诉用户「你库里没这东西」—— 而真相是压根没查。
      if (runs.length > 0 && searched.length === 0) {
        return {
          success: false,
          error: `所有保管库都没能搜到：${failed.map((r) => `${r.vault.name}：${r.error}`).join('；')}`
        }
      }

      const extras: Record<string, unknown> = {
        ...(folderLabel ? { searched_folder: folderLabel } : {}),
        searched_vaults: searched,
        ...(Object.keys(perVault).length > 1 ? { by_vault: perVault } : {}),
        ...(failed.length > 0
          ? {
              // 哪个库没搜成必须说出来。不说的话「没找到」和「没搜」长得一模一样
              unsearched_vaults: failed.map((run) => `${run.vault.name}：${run.error}`)
            }
          : {}),
        ...(exclude.unknown.length > 0
          ? {
              ignored_exclude_tags: exclude.unknown,
              hint: `排除标签里有库里不存在的名字（${exclude.unknown.join('、')}），这几个没起作用。`
            }
          : {})
      }

      const nextOffset = offset + collected.length
      const hasMore = nextOffset < total

      if (total > 0) {
        return {
          success: true,
          count: total,
          returnedCount: collected.length,
          offset,
          limit,
          assets: collected,
          ...(hasMore ? { hasMore, nextOffset } : {}),
          ...extras,
          message:
            `共 ${total} 个` +
            (Object.keys(perVault).length > 1
              ? `（${Object.entries(perVault)
                  .filter(([, n]) => n > 0)
                  .map(([name, n]) => `${name} ${n} 个`)
                  .join('，')}）`
              : '') +
            `，这是第 ${offset + 1}~${nextOffset} 个。` +
            (hasMore ? `要看后面的，用同样的条件加 offset=${nextOffset} 再调一次。` : '') +
            '「AIGC 资产库」里的是 AI 生成的图/视频/模型，要导进虚幻工程走 ue_content_import（把 real_path 填进 files），不是 project_manage。' +
            // 版本这一句放在**返回里**而不是工具描述里：描述是每一轮都要付的前缀，
            // 而这件事只有真的搜到 .uasset 时才用得上。
            // 不说的话，挑素材那一步完全是盲的 —— 真机上 51 个导进 5.5 工程，
            // 16 个因为是 5.7 存的被整条挡回来，而事前没有任何入口看得见
            describeEngineVersionSpread(collected)
        }
      }

      // ── 一个都没搜到 ──────────────────────────────────────────────────────
      const emptyMessage =
        `${searched.join('、')} 里都没有符合条件的资产。` +
        (failed.length > 0 ? '注意上面 unsearched_vaults 里的库这次没能搜到。' : '')

      // 中文关键词一无所获：去掉关键词再查一次，把库里真有的名字捞给调用方。
      //
      // 这一次也要**照样搜遍所有库** —— 样本只从当前库取的话，就又回到了
      // 「用户站在 AIGC 库里，看到的样本全是 AI 图」那个错觉。
      if (hasChinese(input.query)) {
        const rest = { ...params }
        delete rest.query
        delete rest.folderKey
        delete rest.includeSubfolders
        delete rest.limit
        delete rest.offset

        let sampleTotal = 0
        const sample: Array<{ name?: string; assetType?: string; vault: string }> = []
        await runAcrossVaults(input.vault, async (db, vault) => {
          const one = (await searchAssets(
            { ...rest, limit: SAMPLE_LIMIT },
            db,
            vault.path
          )) as SearchOutcome
          sampleTotal += one.count ?? 0
          for (const asset of (one.assets ?? []).slice(0, SAMPLE_LIMIT - sample.length)) {
            sample.push({ name: asset.name, assetType: asset.assetType, vault: vault.name })
          }
        })

        return {
          success: true,
          count: 0,
          assets: [],
          ...extras,
          hint: KEYWORD_MISS_HINT,
          dropped_query: input.query,
          library_sample: sample,
          library_total: sampleTotal
        }
      }

      return { success: true, count: 0, assets: [], ...extras, message: emptyMessage }
    }
  })
}
