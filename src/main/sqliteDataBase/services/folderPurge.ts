import type Database from 'better-sqlite3'

import { ALL_FOLDER } from '../../init/constants'
import { getRetainedFilePaths } from '../models/assetData'
import { updateFolderPathsRecursively } from '../models/assetFolder'
import type { VaultFileRef } from './vaultFileCleanup'
import { getRetainedThumbnailFilenames, retainSharedThumbnails } from './vaultThumbnailRefs'

/**
 * 文件夹的物理清除（清空回收站 / 彻底删除）。
 *
 * 为什么需要这个模块：assetData.folderKey 和 assetFolder.fatherKey 上都挂着
 * `ON DELETE CASCADE`，而 better-sqlite3 编译时带了 SQLITE_DEFAULT_FOREIGN_KEYS=1，
 * 外键默认就是开的。于是原来那句 `DELETE FROM assetFolder WHERE isDelete = 1`
 * 会连坐删掉：
 *   1. 用户已经单独恢复出来（isDelete = 0）的子资产和子文件夹 —— 真数据丢失；
 *   2. asset_tags / asset_favorites / folder_tags 没有外键，级联管不到它们，
 *      于是留下一堆指向已消失记录的孤儿行；
 *   3. 磁盘上的备份文件和缩略图永远不会被删除。
 *
 * 这里改成显式收集 + 幸存者改挂 + 连接表清理，不再依赖级联。
 *
 * 与 networkV2/folderDeleteHelper.ts 的 collectFolderSubtreeKeys **极性相反**：
 * 那个收集 isDelete = 0 的活跃子树用来发同步事件，这个收集 isDelete = 1 的
 * 待清除子树用来物理删除，所以没有复用而是各写各的。
 */

/** SQLite 变量数上限是 999，留点余量 */
const SQLITE_PARAM_BATCH = 500

export interface FolderPurgePlan {
  /** 要物理删除的文件夹（全部 isDelete = 1） */
  folderKeys: string[]
  /** 要物理删除的资产（folderKey ∈ folderKeys 且 isDelete = 1） */
  assetKeys: string[]
  /** 幸存的子文件夹 → 改挂到哪个父级 */
  reparentFolders: Array<{ folderKey: string; newFatherKey: string }>
  /** 幸存的资产 → 改挂到哪个文件夹 */
  reparentAssets: Array<{ assetKey: string; newFolderKey: string }>
  /**
   * 事务提交之后才允许删的磁盘文件。
   *
   * `filePath` 可能是 null —— 那条记录的文件还被本次清除以外的登记占着，不许 unlink，
   * 只清缩略图。缘由见 buildFolderPurgePlan 里的说明。
   */
  files: VaultFileRef[]
}

export interface FolderPurgeResult {
  deletedFolders: number
  deletedAssets: number
  reparentedFolders: number
  reparentedAssets: number
}

export const EMPTY_PURGE_PLAN: FolderPurgePlan = {
  folderKeys: [],
  assetKeys: [],
  reparentFolders: [],
  reparentAssets: [],
  files: []
}

const chunk = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += SQLITE_PARAM_BATCH) {
    out.push(items.slice(i, i + SQLITE_PARAM_BATCH))
  }
  return out
}

const placeholders = (count: number): string => new Array(count).fill('?').join(',')

/** 回收站里全部已软删除的文件夹（清空回收站用） */
export const collectAllDeletedFolderKeys = (db: Database.Database): string[] =>
  (
    db
      .prepare(`SELECT folderKey FROM assetFolder WHERE isDelete = 1 AND folderKey != ?`)
      .all(ALL_FOLDER) as Array<{ folderKey: string }>
  ).map((row) => row.folderKey)

/**
 * 以 rootFolderKey 为根、**只沿着 isDelete = 1 往下走**的连通子树（彻底删除单个文件夹用）。
 *
 * 中途遇到用户已恢复（isDelete = 0）的文件夹就停 —— 那棵子树整体保留并改挂，
 * 它下面仍处于删除态的孙节点继续留在回收站，等用户单独处理。
 *
 * 这比原来「无差别递归到底再 AND isDelete = 1」更保守：原实现会顺手清掉
 * 「活跃文件夹底下的已删除孙节点」，而用户从没点过那些。
 */
export const collectDeletedSubtreeKeys = (
  db: Database.Database,
  rootFolderKey: string
): string[] => {
  if (!rootFolderKey || rootFolderKey === ALL_FOLDER) return []
  const rows = db
    .prepare(
      `
      -- UNION（不是 UNION ALL）：fatherKey 一旦成环，UNION ALL 会无限产行，
      -- 而这条查询跑在同步事务里 —— 主进程直接冻死，只能杀进程。
      -- UNION 去重后递归自然终止。resolveSurvivingAncestor 那边也专门防了环，
      -- 说明这份数据里成环是被承认可能发生的。
      WITH RECURSIVE folder_tree AS (
        SELECT folderKey FROM assetFolder WHERE folderKey = ? AND isDelete = 1
        UNION
        SELECT af.folderKey FROM assetFolder af
        JOIN folder_tree ft ON af.fatherKey = ft.folderKey
        WHERE af.isDelete = 1
      )
      SELECT folderKey FROM folder_tree
    `
    )
    .all(rootFolderKey) as Array<{ folderKey: string }>
  return rows.map((row) => row.folderKey)
}

/** 兜底：确保 ALL 系统文件夹存在且活跃，它是改挂的最后落脚点 */
const ensureAllFolderRow = (db: Database.Database): void => {
  const row = db.prepare(`SELECT isDelete FROM assetFolder WHERE folderKey = ?`).get(ALL_FOLDER) as
    | { isDelete: number }
    | undefined

  if (!row) {
    db.prepare(
      `INSERT INTO assetFolder
         (folderKey, fatherKey, img, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES (?, NULL, '', 'system', 'ALL', '/', '["ALL"]', 0, '[]', 0)`
    ).run(ALL_FOLDER)
  } else if (row.isDelete === 1) {
    db.prepare(`UPDATE assetFolder SET isDelete = 0 WHERE folderKey = ?`).run(ALL_FOLDER)
  }
}

/**
 * 沿 fatherKey 往上找第一个「不在清除集合里、且自身 isDelete = 0」的祖先。
 *
 * 找不到就回 ALL。为什么不能挂到「还在回收站里的祖先」上：那等于把用户刚恢复
 * 出来的东西又藏回回收站，下次清空还得再挪一次。
 */
const resolveSurvivingAncestor = (
  startFatherKey: string | null | undefined,
  purged: ReadonlySet<string>,
  selectFolder: Database.Statement
): string => {
  let cursor: string | null = startFatherKey || null
  const seen = new Set<string>()

  while (cursor && cursor !== ALL_FOLDER && !seen.has(cursor)) {
    seen.add(cursor) // 防历史脏数据里的父子环
    const row = selectFolder.get(cursor) as
      | { fatherKey: string | null; isDelete: number }
      | undefined
    if (!row) break // 悬空 fatherKey → 兜底 ALL
    if (!purged.has(cursor) && row.isDelete === 0) return cursor
    cursor = row.fatherKey ?? null
  }
  return ALL_FOLDER
}

/**
 * 纯读：算出「删什么、改挂什么、删哪些文件」。
 *
 * 不写库，可以放心在事务里先跑一遍再决定要不要执行。
 *
 * ## 共用同一个文件的重复登记
 *
 * 同一个文件导入两遍会留下**两条记录、两个 assetKey，但 filePath 是同一个**。
 * 子树里那条已经进了回收站不代表这个文件没人用了 —— 库里别处还可能有
 * 活跃或仍可恢复的登记指着它。照着 filePath 直接 unlink，那条记录当场指向
 * 一个不存在的文件，界面上是一个打不开的空壳。
 *
 * 所以清单拼完之后统一过一道：还被占着的把 filePath 抹成 null ——
 * **数据库行照删，文件留给幸存者**，等最后一条登记也被清掉时自然会删干净。
 *
 * 只排除本次计划中的 assetKeys，其他回收站记录与要改挂的幸存资产都算占用者。
 * 不能只看 isDelete = 0，否则清除一棵子树会误删另一棵回收站子树需要的文件。
 *
 * 缩略图和 filePath 走同一道占用闸：批量封面上传会把同一个文件名写进一个文件夹的
 * img 和它下面 N 个资产的 customPoster，不判断就会把幸存者的封面一起削掉
 * （见 services/vaultThumbnailRefs）。imgLocalPath 和 customPoster 是**两个独立
 * 文件**，清单里必须都带上，否则自定义封面会永久残留。
 */
export const buildFolderPurgePlan = (
  db: Database.Database,
  purgedFolderKeys: readonly string[]
): FolderPurgePlan => {
  const purged = new Set(purgedFolderKeys.map(String).filter((k) => k && k !== ALL_FOLDER))
  if (purged.size === 0) return { ...EMPTY_PURGE_PLAN }

  const folderKeys = [...purged]
  const assetKeys: string[] = []
  const files: VaultFileRef[] = []
  const reparentFolders: FolderPurgePlan['reparentFolders'] = []
  const reparentAssets: FolderPurgePlan['reparentAssets'] = []

  const selectFolder = db.prepare(`SELECT fatherKey, isDelete FROM assetFolder WHERE folderKey = ?`)

  for (const batch of chunk(folderKeys)) {
    const marks = placeholders(batch.length)

    // 1) 被清除文件夹下、仍然存活的直接子文件夹 —— 必须改挂，否则会被 CASCADE 连坐
    const survivingFolders = db
      .prepare(
        `SELECT folderKey, fatherKey FROM assetFolder
         WHERE fatherKey IN (${marks}) AND isDelete = 0`
      )
      .all(...batch) as Array<{ folderKey: string; fatherKey: string | null }>

    for (const row of survivingFolders) {
      if (purged.has(row.folderKey)) continue
      reparentFolders.push({
        folderKey: row.folderKey,
        newFatherKey: resolveSurvivingAncestor(row.fatherKey, purged, selectFolder)
      })
    }

    // 2) 被清除文件夹下的资产：已删除的物理删，未删除的改挂
    const assets = db
      .prepare(
        `SELECT assetKey, folderKey, isDelete, filePath, imgLocalPath, customPoster
         FROM assetData WHERE folderKey IN (${marks})`
      )
      .all(...batch) as Array<{
      assetKey: string
      folderKey: string
      isDelete: number
      filePath?: string | null
      imgLocalPath?: string | null
      customPoster?: string | null
    }>

    for (const asset of assets) {
      if (asset.isDelete === 1) {
        assetKeys.push(asset.assetKey)
        files.push({
          filePath: asset.filePath,
          imgLocalPath: asset.imgLocalPath,
          customPoster: asset.customPoster
        })
      } else {
        reparentAssets.push({
          assetKey: asset.assetKey,
          newFolderKey: resolveSurvivingAncestor(asset.folderKey, purged, selectFolder)
        })
      }
    }
  }

  // 一次问完「哪些 filePath 还被剩余记录占着」，不逐条查：一个大文件夹几千条
  // 资产就是几千次 SELECT，而这里跑在同步事务里 —— 主进程会明显卡住
  const stillUsed = getRetainedFilePaths(
    db,
    files.map((file) => file.filePath),
    assetKeys
  )
  for (const file of files) {
    if (file.filePath && stillUsed.has(file.filePath)) file.filePath = null
  }

  // 封面图同理：这一批之外还有人指着的，一张都不能删
  const retainedThumbnails = getRetainedThumbnailFilenames(db, {
    excludeAssetKeys: assetKeys,
    excludeFolderKeys: folderKeys
  })
  const retainedFiles = files.map((file) => retainSharedThumbnails(file, retainedThumbnails))

  return { folderKeys, assetKeys, reparentFolders, reparentAssets, files: retainedFiles }
}

/**
 * 纯写：按计划执行。
 *
 * ⚠️ 必须在事务里调用（由调用方用 runInTransaction 包住）。
 * 顺序是关键：**先改挂幸存者**（把它们挪出 CASCADE 的射程）→ 再清连接表
 * → 再删资产 → 最后删文件夹。
 */
export const applyFolderPurgePlan = (
  db: Database.Database,
  plan: FolderPurgePlan
): FolderPurgeResult => {
  if (plan.folderKeys.length === 0) {
    return { deletedFolders: 0, deletedAssets: 0, reparentedFolders: 0, reparentedAssets: 0 }
  }

  // ── 1. 把幸存者挪出去，避免 ON DELETE CASCADE 连坐 ──────────────
  if (plan.reparentFolders.length > 0 || plan.reparentAssets.length > 0) {
    ensureAllFolderRow(db)
  }

  const reparentFolderStmt = db.prepare(
    `UPDATE assetFolder SET fatherKey = ?, updated_at = datetime('now', 'localtime')
     WHERE folderKey = ?`
  )
  for (const item of plan.reparentFolders) {
    reparentFolderStmt.run(item.newFatherKey, item.folderKey)
  }

  const reparentAssetStmt = db.prepare(
    `UPDATE assetData SET folderKey = ?, updated_at = datetime('now', 'localtime')
     WHERE assetKey = ?`
  )
  for (const item of plan.reparentAssets) {
    reparentAssetStmt.run(item.newFolderKey, item.assetKey)
  }

  // 改挂之后 fullPath / pathArray / depth / ancestorKeys 全部过期，就地重算
  for (const item of plan.reparentFolders) {
    updateFolderPathsRecursively(db, item.folderKey)
  }

  // ── 2. 清资产侧：连接表没有外键，级联管不到它们，必须显式删 ──────
  let deletedAssets = 0
  for (const batch of chunk(plan.assetKeys)) {
    const marks = placeholders(batch.length)
    db.prepare(`DELETE FROM asset_tags WHERE assetKey IN (${marks})`).run(...batch)
    db.prepare(
      `DELETE FROM asset_favorites
       WHERE assetKey IN (${marks}) AND (itemType IS NULL OR itemType = 'asset')`
    ).run(...batch)
    deletedAssets += Number(
      db.prepare(`DELETE FROM assetData WHERE assetKey IN (${marks})`).run(...batch).changes || 0
    )
  }

  // ── 3. 清文件夹侧 ────────────────────────────────────────────────
  let deletedFolders = 0
  for (const batch of chunk(plan.folderKeys)) {
    const marks = placeholders(batch.length)
    db.prepare(`DELETE FROM folder_tags WHERE folderKey IN (${marks})`).run(...batch)
    db.prepare(
      `DELETE FROM asset_favorites WHERE assetKey IN (${marks}) AND itemType = 'folder'`
    ).run(...batch)
    // AND isDelete = 1 是纵深防御：即使计划算错，活跃文件夹也不会被直接删掉
    deletedFolders += Number(
      db
        .prepare(`DELETE FROM assetFolder WHERE folderKey IN (${marks}) AND isDelete = 1`)
        .run(...batch).changes || 0
    )
  }

  return {
    deletedFolders,
    deletedAssets,
    reparentedFolders: plan.reparentFolders.length,
    reparentedAssets: plan.reparentAssets.length
  }
}
