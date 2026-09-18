/**
 * 「这个包此刻在磁盘上吗」—— 不问引擎。
 *
 * ## 为什么必须能绕开引擎
 *
 * 这套判断存在的唯一理由，就是**引擎不在的时候**要能回答问题：
 * `content.batch_move` 执行到一半把编辑器搞崩了（真机三次），
 * RPC 抛一个异常就没了，「搬到哪一步了」在那一刻只有磁盘知道。
 * 走引擎查一律不可行 —— 引擎正是坏掉的那个东西。
 *
 * 所以这里只做一件事：包路径 → 磁盘文件 → 在不在、多大、什么时候改的。
 *
 * ## 只认 `/Game/`
 *
 * 插件挂载的 `/PluginName/...` 要解析 `.uplugin` 才知道落在哪个目录，
 * 等于在盒子侧重做一遍 `FPackageName`。查不了就如实说查不了 ——
 * 报一个「文件不存在」比说「不知道」危险得多：调用方会据此以为资产没搬过去。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { contentPathToDiskPath } from '../../core/assetSnapshotPaths'

export interface DiskFileInfo {
  path: string
  bytes: number
  mtime: string
}

export type DiskProbe =
  | { kind: 'found'; file: DiskFileInfo }
  | { kind: 'absent' }
  /** 映射不出磁盘路径（不是 /Game 下的包）。**不等于不存在** */
  | { kind: 'unknown'; reason: string }

/** 关卡是 `.umap`，别的资产是 `.uasset`；两个都试，先中的算 */
const EXTENSIONS = ['.uasset', '.umap']

/**
 * 一个包路径在磁盘上的现状。
 *
 * @param projectDir 工程目录（不是 .uproject 文件），用 `resolveProjectDir` 取
 */
export async function probePackageOnDisk(
  projectDir: string,
  packagePath: string
): Promise<DiskProbe> {
  const assetPath = contentPathToDiskPath(projectDir, packagePath)
  if (!assetPath) {
    return {
      kind: 'unknown',
      reason: `${packagePath} 不在 /Game 下，盒子侧算不出它的磁盘位置（插件挂载点要引擎才解析得了）`
    }
  }

  const base = assetPath.slice(0, -'.uasset'.length)
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) {
        return {
          kind: 'found',
          file: {
            path: candidate,
            bytes: stat.size,
            mtime: new Date(stat.mtimeMs).toISOString()
          }
        }
      }
    } catch {
      // 下一个扩展名
    }
  }
  return { kind: 'absent' }
}

/** 一条搬迁在磁盘上到底走到哪一步了 */
export type MoveDiskState =
  /** 目标在、源没了 —— 搬完了 */
  | 'moved'
  /** 源还在、目标没有 —— 没开始（或者已经被撤销了） */
  | 'not_moved'
  /** 两边都在 —— 源那边多半是引擎留下的重定向器（很小的一个文件） */
  | 'both'
  /** 两边都没有 —— 被删了、又被搬走了，或者路径本来就不对 */
  | 'neither'
  /** 算不出磁盘路径，查不了 */
  | 'unknown'

export interface MoveDiskCheck {
  from: string
  to: string
  state: MoveDiskState
  source?: DiskFileInfo
  destination?: DiskFileInfo
  /** 源文件还在、但小得像个重定向器（引擎留下的转发桩通常 1–2 KB） */
  source_looks_like_redirector?: boolean
  detail?: string
}

/**
 * 重定向器的体积阈值。
 *
 * 一个只存「我指向谁」的转发桩，实测在 1–2 KB；真资产极少有这么小的。
 * 这条只用来在摘要里加一句提示（「源那边剩下的看着像重定向器」），
 * **不作为判据** —— 判据永远是「文件在不在」，猜大小只是给人看的线索。
 */
const REDIRECTOR_MAX_BYTES = 4096

export async function checkMoveOnDisk(
  projectDir: string,
  from: string,
  to: string
): Promise<MoveDiskCheck> {
  const [source, destination] = await Promise.all([
    probePackageOnDisk(projectDir, from),
    probePackageOnDisk(projectDir, to)
  ])

  if (source.kind === 'unknown' || destination.kind === 'unknown') {
    const reason =
      source.kind === 'unknown' ? source.reason : (destination as { reason: string }).reason
    return { from, to, state: 'unknown', detail: reason }
  }

  const base: MoveDiskCheck = {
    from,
    to,
    state: 'neither',
    ...(source.kind === 'found' ? { source: source.file } : {}),
    ...(destination.kind === 'found' ? { destination: destination.file } : {})
  }

  if (destination.kind === 'found' && source.kind === 'found') {
    return {
      ...base,
      state: 'both',
      source_looks_like_redirector: source.file.bytes <= REDIRECTOR_MAX_BYTES,
      detail:
        source.file.bytes <= REDIRECTOR_MAX_BYTES
          ? `资产已经在新位置；旧位置剩下一个 ${source.file.bytes} 字节的文件，大小像引擎留的重定向器（工程照常能用，要清理走 ue_fixup_redirectors）`
          : '两个位置都有文件，旧位置那个不像重定向器 —— 要人看一眼是不是同名的另一个资产'
    }
  }
  if (destination.kind === 'found') {
    return { ...base, state: 'moved', detail: '资产在新位置，旧位置已经没有文件了' }
  }
  if (source.kind === 'found') {
    return { ...base, state: 'not_moved', detail: '资产还在原位置，这一条没有搬过去' }
  }
  return {
    ...base,
    state: 'neither',
    detail: '两个位置都没有文件 —— 可能被删了、被搬到了第三个地方，或者账本里的路径本身就不对'
  }
}

/**
 * 整目录搬迁在磁盘上走到哪一步了。
 *
 * 和资产版的区别只在于查的是**目录里有没有文件**：`/Game/Temp/Props` 映射到
 * `<工程>/Content/Temp/Props`，存在且非空就算「还在原处」。
 * 拿资产那套去查目录（找 `Props.uasset`）永远查不到，一次成功的目录搬迁
 * 会被核对成「两边都没有」，正好把恢复流程带到反方向。
 */
export async function checkFolderMoveOnDisk(
  projectDir: string,
  from: string,
  to: string
): Promise<MoveDiskCheck> {
  const [sourceCount, destCount] = await Promise.all([
    countFilesUnder(projectDir, from),
    countFilesUnder(projectDir, to)
  ])

  if (sourceCount === undefined || destCount === undefined) {
    return {
      from,
      to,
      state: 'unknown',
      detail: `${from} 或 ${to} 不在 /Game 下，盒子侧算不出目录位置`
    }
  }

  const base: MoveDiskCheck = { from, to, state: 'neither' }
  if (destCount > 0 && sourceCount > 0) {
    return {
      ...base,
      state: 'both',
      detail:
        `目标目录有 ${destCount} 个文件、源目录还剩 ${sourceCount} 个。` +
        '剩下的多半是重定向器（引擎留的转发桩），也可能是没搬完 —— 这一条要人看一眼。'
    }
  }
  if (destCount > 0) {
    return { ...base, state: 'moved', detail: `目标目录有 ${destCount} 个文件，源目录已经空了` }
  }
  if (sourceCount > 0) {
    return { ...base, state: 'not_moved', detail: `源目录还有 ${sourceCount} 个文件，没有搬过去` }
  }
  return { ...base, state: 'neither', detail: '两个目录都不存在或都是空的' }
}

/** 目录下有多少个 .uasset / .umap（递归）。算不出目录位置返回 undefined */
async function countFilesUnder(
  projectDir: string,
  packagePath: string
): Promise<number | undefined> {
  // 借资产版的映射：给它补一个假名字取到目录，再把那一段去掉
  const probe = contentPathToDiskPath(projectDir, `${packagePath.replace(/\/+$/, '')}/__dir__`)
  if (!probe) return undefined
  const dir = path.dirname(probe)

  let count = 0
  const walk = async (current: string, depth: number): Promise<void> => {
    // 深度兜底：工程目录里出现循环符号链接时别走到天荒地老
    if (depth > 16) return
    let items: import('node:fs').Dirent[]
    try {
      items = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.isDirectory()) {
        await walk(path.join(current, item.name), depth + 1)
      } else if (item.name.endsWith('.uasset') || item.name.endsWith('.umap')) {
        count += 1
      }
    }
  }
  await walk(dir, 0)
  return count
}

/** `resolveProjectDir` 的同款逻辑，避免为了一行去 import 扫描模块 */
export function projectDirOf(projectPath: string): string {
  const trimmed = projectPath.trim()
  return trimmed.toLowerCase().endsWith('.uproject') ? path.dirname(trimmed) : trimmed
}
