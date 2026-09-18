import { promises as fs } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep, basename } from 'path'
import { AssetBackupManager, type BackupAssetInfo } from '../../../utils/assetBackup'
import { calculateFullFileHash } from './fileUtils'
import { normalizeSourcePath } from './importDedup'
import type { ImportFailureEntry } from '../../../../shared/assetImport'

type ExistingCopy = { filePath?: string; originPath?: string }

/** Owns only files created by this attempt; existing archives are never deleted. */
export class LocalBackupSession {
  readonly paths = new Map<string, string>()
  readonly failures: ImportFailureEntry[] = []
  /**
   * 找不到的软引用。不拦截导入，但也不许悄悄吞掉 —— 调用方把它报成警告，
   * 用户至少知道这批资产的某些弱引用没跟着进库。
   */
  readonly softMisses = new Set<string>()
  private batch?: string
  private created = new Set<string>()
  private retained = new Set<string>()
  private groups = new Map<string, string[]>()
  private copied = new Map<string, string>()
  private manager = new AssetBackupManager()

  constructor(private vaultRoot: string) {}

  async prepare(
    roots: readonly string[],
    assets: readonly BackupAssetInfo[],
    existing: readonly ExistingCopy[],
    signal: AbortSignal,
    progress: (done: number, total: number) => void
  ): Promise<void> {
    const primaryPackages = new Map(
      assets
        .filter((asset) => /\.(uasset|umap)$/i.test(asset.sourcePath))
        .map((asset) => [normalizeSourcePath(asset.sourcePath.replace(/\.[^.]+$/, '')), asset])
    )
    const planned = assets.map((asset) => {
      const primary = primaryPackages.get(
        normalizeSourcePath(asset.sourcePath.replace(/\.[^.]+$/, ''))
      )
      return primary && /\.(uexp|ubulk|uptnl)$/i.test(asset.sourcePath)
        ? { ...asset, softPath: primary.softPath }
        : asset
    })
    const bySource = new Map(planned.map((asset) => [asset.sourcePath, asset]))
    const softKey = (path: string): string => path.replace(/\.[^/]+$/, '')
    const bySoft = new Map(
      planned
        .filter((asset) => /\.(uasset|umap)$/i.test(asset.sourcePath))
        .map((asset) => [softKey(asset.softPath), asset])
    )
    const companions = new Map<string, BackupAssetInfo[]>()
    for (const asset of planned) {
      if (!/\.(uasset|umap|uexp|ubulk|uptnl)$/i.test(asset.sourcePath)) continue
      const key = normalizeSourcePath(asset.sourcePath.replace(/\.[^.]+$/, ''))
      const group = companions.get(key) ?? []
      group.push(asset)
      companions.set(key, group)
    }
    const copiesBySource = new Map<string, ExistingCopy[]>()
    for (const copy of existing) {
      const key = normalizeSourcePath(copy.originPath || '')
      const copies = copiesBySource.get(key) ?? []
      copies.push(copy)
      copiesBySource.set(key, copies)
    }
    for (const [index, source] of roots.entries()) {
      signal.throwIfAborted()
      const root = bySource.get(source)
      if (!root) continue
      try {
        const required = new Map<string, BackupAssetInfo>()
        const visit = (asset: BackupAssetInfo): void => {
          if (required.has(asset.sourcePath)) return
          required.set(asset.sourcePath, asset)
          for (const companion of /\.(uasset|umap|uexp|ubulk|uptnl)$/i.test(asset.sourcePath)
            ? (companions.get(normalizeSourcePath(asset.sourcePath.replace(/\.[^.]+$/, ''))) ?? [])
            : []) {
            visit(companion)
          }
          // 只有硬引用缺失才判死。软引用（SoftPackageReferences）在 UE 里本来就允许
          // 指向工程里没有的资产 —— 例如引用 Epic 默认 Mannequin 的姿势资产 —— 拿它
          // 拦截会把一批能用的资产整组拒收。没给 importsStrong 的调用方按老行为处理。
          const strong = new Set(asset.importsStrong ?? asset.imports ?? [])
          for (const path of asset.imports ?? []) {
            const dependency = bySoft.get(softKey(path))
            if (dependency) visit(dependency)
            else if (path.startsWith('/Game/')) {
              if (strong.has(path)) throw new Error(`缺少依赖：${path}`)
              this.softMisses.add(path)
            }
          }
        }
        visit(root)
        const group = [...required.values()]
        const reused = await this.findReusableGroup(
          root,
          group,
          copiesBySource.get(normalizeSourcePath(source)) ?? [],
          signal
        )
        if (reused) {
          this.paths.set(root.assetKey, relative(this.vaultRoot, reused))
          this.groups.set(source, [])
        } else {
          const saved: string[] = []
          for (const asset of group) {
            signal.throwIfAborted()
            let target = this.copied.get(asset.sourcePath)
            if (!target) {
              this.batch ??= await this.manager.createTimestampFolder()
              try {
                target = await this.manager.backupAssetFile(
                  asset.sourcePath,
                  this.batch,
                  asset.softPath
                )
              } catch (error) {
                throw new Error(`${asset.sourcePath}: ${String(error)}`)
              }
              this.created.add(target)
              this.copied.set(asset.sourcePath, target)
            }
            saved.push(target)
          }
          this.paths.set(root.assetKey, relative(this.vaultRoot, saved[0]))
          this.groups.set(source, saved)
        }
      } catch (error) {
        signal.throwIfAborted()
        this.failures.push({
          stage: 'backup',
          fileName: basename(source),
          path: source,
          error: String(error),
          retriable: true
        })
      }
      progress(index + 1, roots.length)
    }
  }

  private async findReusableGroup(
    root: BackupAssetInfo,
    group: BackupAssetInfo[],
    existing: readonly ExistingCopy[],
    signal: AbortSignal
  ): Promise<string | undefined> {
    const rootRelative = this.manager.getTargetRelativePath(root.sourcePath, root.softPath)
    for (const candidate of existing) {
      signal.throwIfAborted()
      if (
        !candidate.filePath ||
        normalizeSourcePath(candidate.originPath || '') !== normalizeSourcePath(root.sourcePath)
      )
        continue
      const file = resolve(this.vaultRoot, candidate.filePath)
      let base = file
      for (let depth = 0; depth < rootRelative.split(sep).length; depth++) base = dirname(base)
      const within = relative(resolve(this.vaultRoot), base)
      if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within))
        continue
      if (normalizeSourcePath(join(base, rootRelative)) !== normalizeSourcePath(file)) continue
      try {
        let matches = true
        for (const asset of group) {
          signal.throwIfAborted()
          const target = join(
            base,
            this.manager.getTargetRelativePath(asset.sourcePath, asset.softPath)
          )
          const [sourceStat, targetStat] = await Promise.all([
            fs.stat(asset.sourcePath),
            fs.stat(target)
          ])
          if (
            !sourceStat.isFile() ||
            !targetStat.isFile() ||
            sourceStat.size !== targetStat.size ||
            (await calculateFullFileHash(asset.sourcePath)) !==
              (await calculateFullFileHash(target))
          ) {
            matches = false
            break
          }
        }
        if (matches) return file
      } catch {
        signal.throwIfAborted()
      }
    }
    return undefined
  }

  retain(source: string): void {
    for (const file of this.groups.get(source) ?? []) this.retained.add(file)
  }

  async cleanup(): Promise<void> {
    if (!this.batch) return
    const batch = resolve(this.batch)
    for (const file of this.created) {
      if (this.retained.has(file)) continue
      const inside = relative(batch, resolve(file))
      if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
        throw new Error('拒绝清理归档目录外的文件')
      }
      await fs.unlink(file)
    }
    // Only remove empty directories under this newly allocated batch. Never recurse through links.
    const prune = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) await prune(join(directory, entry.name))
      }
      await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
      })
    }
    await prune(batch)
  }
}
