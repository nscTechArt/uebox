import Database from 'better-sqlite3'

import type { VaultFileRef } from './vaultFileCleanup'

/**
 * 缩略图文件的「还有没有别人在用」判断。
 *
 * 素材文件（filePath）早就有这道闸（models/assetData 的 getRetainedFilePaths），
 * 缩略图一直没有 —— 于是彻底删除一个资产会把**别人的封面图**一起 unlink 掉。
 *
 * 这不是理论问题，触发路径很短：批量封面上传（BatchThumbnailUploadModal）
 * 把**同一个文件名**同时写进一个文件夹的 img 和它下面 N 个资产的 customPoster；
 * 网络库同步下来的封面（ipc/networkVault）也是同一批文件名。删掉其中一个资产，
 * 剩下 N-1 个还活着的资产和那个文件夹的封面当场全变成裂图，而且找不回来。
 *
 * 判断按**文件名**而不是字段原值：同一个文件在不同字段里可能存成
 * `custom-1.png`、`file:///.../thumbnails/custom-1.png` 两种形态，比原值会漏。
 *
 * 软删除的记录**也算占用者** —— 它们还在回收站里等着被恢复，恢复出来的东西
 * 不该是一个裂图。只有「这一次真的要删掉的那些行」才不算。
 */

/**
 * 字段值 → thumbnails 目录里的文件名。
 *
 * customPoster 允许存外链（用户直接填了一个网图地址），那种情况下保管库里
 * 压根没有对应文件 —— 返回 null，既不用保护也不用删。
 */
export function thumbnailFilenameOf(value?: string | null): string | null {
  if (!value) return null
  const raw = String(value)
  if (/^https?:\/\//i.test(raw)) return null

  let pathname = raw
  if (/^file:\/\//i.test(raw)) {
    try {
      pathname = decodeURI(new URL(raw).pathname || '')
    } catch {
      pathname = raw.replace(/^file:\/\//i, '')
    }
  }

  const parts = pathname.split(/[/\\]/).filter(Boolean)
  const filename = parts.length ? parts[parts.length - 1] : ''
  return filename || null
}

/**
 * 原图文件名 → 压缩缩略图文件名（`a.png` → `a_thumb.jpg`）。
 *
 * 和 ThumbnailManager.toThumbFilename 同一套约定，这里重写一遍是为了让本模块
 * 保持纯字符串逻辑：它被 IPC 层直接引用，不该顺带把 electron 拖进测试进程。
 */
export function toThumbVariant(filename: string): string {
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx <= 0) return `${filename}_thumb.jpg`
  return `${filename.substring(0, dotIdx)}_thumb.jpg`
}

export interface ThumbnailRetentionScope {
  /** 这一次要彻底删掉的资产（它们不算占用者） */
  excludeAssetKeys?: readonly string[]
  /** 这一次要彻底删掉的文件夹（它们的封面也不算占用者） */
  excludeFolderKeys?: readonly string[]
}

/**
 * 删完这一批之后，仍然被别人指着的缩略图文件名。
 *
 * 返回值只承诺 `has()` 可用（调用方 retainSharedThumbnails / isRetained 只用它）。
 *
 * 原来是一次 `SELECT … FROM assetData WHERE imgLocalPath != '' OR customPoster != ''`
 * 把整库读进 JS 建一个 Set。52 万行的镜像库上这是 7 秒的全表扫 + 上百 MB 的字符串集合，
 * 每次彻底删除 / 清空回收站都来一遍，而且 crud.ts 里那次还在写事务里。
 *
 * 现在按需查：`has(filename)` 走 imgLocalPath / customPoster 的部分索引做等值查找，
 * 每次 0.1 ms 以内。字段值存成路径形态（`file:///…/x.png`）的比不了等值，
 * 这部分只扫一遍索引挑出来放进内存 —— 正常情况下寥寥无几。
 * 文件夹封面表很小，照旧全量读。
 */
export function getRetainedThumbnailFilenames(
  db: Database.Database,
  scope: ThumbnailRetentionScope = {}
): Set<string> {
  const excludedAssets = new Set(scope.excludeAssetKeys ?? [])
  const excludedFolders = new Set(scope.excludeFolderKeys ?? [])
  const retained = new LazyRetainedThumbnailSet(db, excludedAssets)

  const folderRows = db
    .prepare(`SELECT folderKey, img FROM assetFolder WHERE img IS NOT NULL AND img != ''`)
    .all() as Array<{ folderKey: string; img: string | null }>
  for (const row of folderRows) {
    if (excludedFolders.has(row.folderKey)) continue
    retained.keepValue(row.img)
  }

  // 路径形态的值：带目录分隔符或 file: 前缀。第一步只扫索引不回表（52 万行约 0.3 s），
  // 第二步只对命中的那几个值回表取 assetKey 做排除判断。
  const SEP = String.fromCharCode(92)
  for (const col of ['imgLocalPath', 'customPoster'] as const) {
    const pathFormValues = db
      .prepare(
        `SELECT DISTINCT ${col} AS value FROM assetData
          WHERE ${col} IS NOT NULL
            AND (instr(${col}, '/') > 0 OR instr(${col}, '${SEP}') > 0 OR ${col} LIKE 'file:%')`
      )
      .all() as Array<{ value: string }>
    if (pathFormValues.length === 0) continue
    const ownersStmt = db.prepare(`SELECT assetKey FROM assetData WHERE ${col} = ?`)
    for (const { value } of pathFormValues) {
      const owners = ownersStmt.all(value) as Array<{ assetKey: string }>
      if (owners.some((row) => !excludedAssets.has(row.assetKey))) retained.keepValue(value)
    }
  }

  return retained
}

/**
 * 按需判断「这个缩略图文件名还有没有别人在用」的集合。
 *
 * 只实现了 has()。size / 遍历只反映预加载的那一小部分（文件夹封面、路径形态的值），
 * 别拿它当完整清单用。
 */
class LazyRetainedThumbnailSet extends Set<string> {
  private readonly memo = new Map<string, boolean>()
  /** 字段值精确等于某个文件名的行 */
  private readonly exactLookup: Database.Statement
  /** 字段值以 `stem.` 开头的行（同名不同扩展名的原图，它们的 _thumb 变体就是被问的那个名字） */
  private readonly stemLookup: Database.Statement

  constructor(
    db: Database.Database,
    private readonly excludedAssets: ReadonlySet<string>
  ) {
    super()
    this.exactLookup = db.prepare(
      `SELECT assetKey FROM assetData WHERE imgLocalPath = ?
       UNION ALL
       SELECT assetKey FROM assetData WHERE customPoster = ?`
    )
    // '/' 是 '.' 的下一个字符，[stem., stem/) 恰好覆盖 stem.<任意扩展名>；走同一个部分索引的范围扫描
    this.stemLookup = db.prepare(
      `SELECT assetKey, imgLocalPath AS value FROM assetData WHERE imgLocalPath >= ? AND imgLocalPath < ?
       UNION ALL
       SELECT assetKey, customPoster AS value FROM assetData WHERE customPoster >= ? AND customPoster < ?`
    )
  }

  private ownedByOthers(rows: Array<{ assetKey: string }>): boolean {
    return rows.some((row) => !this.excludedAssets.has(row.assetKey))
  }

  /** 把一个字段原值（可能是路径）登记成受保护的文件名及其 _thumb 变体 */
  keepValue(value?: string | null): void {
    const filename = thumbnailFilenameOf(value)
    if (!filename) return
    super.add(filename)
    super.add(toThumbVariant(filename))
  }

  /**
   * 和原来全量建集合的口径一致：某个存活引用 V（按文件名 base(V)）同时保护
   * base(V) 和 toThumbVariant(base(V)) 两个名字。所以问 X 时要查两种情况：
   *   1. 有人的字段值就是 X；
   *   2. X 形如 `stem_thumb.jpg`，而有人的字段值是 `stem`（无扩展名）或 `stem.<ext>`。
   */
  override has(filename: string): boolean {
    if (super.has(filename)) return true
    const cached = this.memo.get(filename)
    if (cached !== undefined) return cached
    let hit = false
    try {
      hit = this.ownedByOthers(
        this.exactLookup.all(filename, filename) as Array<{ assetKey: string }>
      )
      const suffix = '_thumb.jpg'
      if (!hit && filename.endsWith(suffix) && filename.length > suffix.length) {
        const stem = filename.slice(0, -suffix.length)
        hit = this.ownedByOthers(this.exactLookup.all(stem, stem) as Array<{ assetKey: string }>)
        if (!hit) {
          const rows = this.stemLookup.all(
            `${stem}.`,
            `${stem}/`,
            `${stem}.`,
            `${stem}/`
          ) as Array<{
            assetKey: string
            value: string
          }>
          hit = rows.some((row) => {
            if (this.excludedAssets.has(row.assetKey)) return false
            const base = thumbnailFilenameOf(row.value)
            return !!base && toThumbVariant(base) === filename
          })
        }
      }
    } catch {
      hit = false
    }
    this.memo.set(filename, hit)
    return hit
  }
}

/** 这个缩略图还被别人用着吗 */
function isRetained(value: string | null | undefined, retained: Set<string>): boolean {
  const filename = thumbnailFilenameOf(value)
  if (!filename) return false
  return retained.has(filename) || retained.has(toThumbVariant(filename))
}

/**
 * 把清理清单里「别人还用着」的缩略图字段抹掉。
 *
 * 和 filePath 那边同一个套路：**数据库行照删，文件留给幸存者**。等最后一个
 * 用它的人也走了，那一次自然会把它删干净，不会永久残留。
 */
export function retainSharedThumbnails(ref: VaultFileRef, retained: Set<string>): VaultFileRef {
  return {
    filePath: ref.filePath,
    imgLocalPath: isRetained(ref.imgLocalPath, retained) ? null : ref.imgLocalPath,
    customPoster: isRetained(ref.customPoster, retained) ? null : ref.customPoster
  }
}
