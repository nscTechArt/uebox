import { existsSync } from 'node:fs'
import path from 'path'

/**
 * 快照的纯逻辑：路径映射、存放位置、类型定义。
 *
 * 和引擎打交道的部分在 `assetSnapshot.ts` —— 拆开是为了能直接测：
 * 那边一 import 就把主进程的服务容器拽进来了，测试环境里跑不起来。
 */

/** 一条快照记录。回滚要的所有信息都在这里 */
export interface AssetSnapshotEntry {
  /** 引擎里的路径，如 /Game/Materials/M_Wood */
  contentPath: string
  /** 磁盘上的 .uasset 绝对路径 */
  diskPath: string
  /** 快照文件的绝对路径 */
  snapshotPath: string
  /**
   * `modified`：快照时资产已存在，回滚 = 拷回去；
   * `created`：快照时还不存在（这一步是新建），回滚 = 删掉。
   */
  kind: 'modified' | 'created'
  bytes: number
  at: number
}

export type SnapshotSkipReason = 'not-a-game-path' | 'too-large' | 'save-failed' | 'copy-failed'

export interface SnapshotOutcome {
  ok: boolean
  entry?: AssetSnapshotEntry
  skipped?: SnapshotSkipReason
  detail?: string
}

/** 单个资产的快照上限。蓝图/材质都在几 MB 内，关卡和大网格体不在原型范围里 */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024

/** 资产包的两种扩展名。关卡是 `.umap`，其余都是 `.uasset` */
export const PACKAGE_EXTENSIONS = ['.uasset', '.umap'] as const

/**
 * `/Game/Materials/M_Wood` → `<工程>/Content/Materials/M_Wood.uasset`
 *
 * 只认 `/Game/` 开头的路径：插件路径（`/PluginName/...`）和引擎内容
 * （`/Engine/...`）不在工程 Content 下，映射规则不一样，原型阶段直接拒。
 *
 * **仓库里只该有这一份 `/Game/` → 磁盘路径的映射。** 只读位那层
 * （`assetReadonlyGuard.ts`）也走这里 —— 两份各自演化的话，将来加新的内容根
 * 只会改到其中一份，而漏掉的那条路上的后果（资产没被保护 / 快照存错地方）
 * 都不会立刻暴露。
 *
 * @param ext 默认 `.uasset`。关卡传 `.umap`
 */
export function contentPathToDiskPath(
  projectDir: string,
  contentPath: string,
  ext: string = '.uasset'
): string | null {
  const normalized = String(contentPath || '')
    .trim()
    .replace(/\\/g, '/')
  if (!normalized.startsWith('/Game/')) return null

  // 引擎路径可能带对象名后缀：/Game/A/M_Wood.M_Wood —— 只取包路径那一段
  const packagePath = normalized.split('.')[0]
  const relative = packagePath.slice('/Game/'.length)
  if (!relative) return null

  const contentRoot = path.join(projectDir, 'Content')
  const full = path.join(contentRoot, ...relative.split('/')) + ext

  // 越界检查放在拼完之后。`relative.includes('..')` 挡不住盘符
  // （`/Game/../../X` 在 Windows 上能拼出 Content 之外的绝对路径），
  // 而这个函数的调用方会拿结果去 chmod。
  const rel = path.relative(contentRoot, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null

  return full
}

/**
 * 同上，但**要求文件真的在磁盘上**，并且两种扩展名都试。
 *
 * 只读位要的是「现在能 chmod 的那个文件」；新建还没落盘的资产没有位可翻，
 * 关卡则是 `.umap`。快照那条路不用这个 —— 它连「还不存在」的目标路径都要
 * （`kind: 'created'` 回滚时要按那个路径删）。
 */
export function resolveExistingPackageFile(projectDir: string, contentPath: string): string | null {
  for (const ext of PACKAGE_EXTENSIONS) {
    const candidate = contentPathToDiskPath(projectDir, contentPath, ext)
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

/** 快照根目录：跟着工程走，且在版本控制忽略范围内 */
export function snapshotRootFor(projectDir: string, sessionId: string): string {
  const safeSession = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(projectDir, 'Saved', 'UnrealBox', 'Snapshots', safeSession)
}

/** 快照文件路径：镜像 Content 的层级，和 AutoSave 的做法一致，出问题时人能看懂 */
export function snapshotPathFor(
  projectDir: string,
  sessionId: string,
  contentPath: string,
  stamp: number
): string | null {
  const diskPath = contentPathToDiskPath(projectDir, contentPath)
  if (!diskPath) return null

  const relative = path.relative(path.join(projectDir, 'Content'), diskPath)
  return path.join(snapshotRootFor(projectDir, sessionId), String(stamp), relative)
}
