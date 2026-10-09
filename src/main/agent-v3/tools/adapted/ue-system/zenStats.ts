/**
 * ZenServer 返回数据的整理。
 *
 * 独立成模块是为了能直接测 —— 工具文件里有 fetch 和 fs，这里只有纯数据处理。
 *
 * 数据来源是 ZenServer 自己的 HTTP 接口（带 `Accept: application/json`，
 * 不带的话回的是二进制 CbObject）。字段名没有官方文档，是在 Zen 5.8.13 上
 * 实测 `/stats/z$` 和 `/prj/` 得到的：字段缺了就不报，不猜。
 */

import { isSameProjectPath } from '../../../core/projectPathKey'

/** `/stats/z$` 里我们用得到的那几个字段 */
export interface ZenCacheStatsRaw {
  requests?: { count?: number; t_p95?: number; t_p99?: number }
  cache?: {
    hits?: number
    misses?: number
    writes?: number
    hit_ratio?: number
    size?: { disk?: number; memory?: number }
  }
  cid?: { size?: { total?: number } }
}

/** `/prj/` 列表里的一项 */
export interface ZenProjectRaw {
  Id?: string
  ProjectFilePath?: string
  EngineRootDir?: string
  LastAccessTime?: number
}

export interface ZenCacheSummary {
  hits: number | null
  misses: number | null
  writes: number | null
  /** 0–100，保留一位小数 */
  hit_ratio_percent: number | null
  /** 命中 + 未命中太少时，命中率说明不了问题 */
  sample_too_small: boolean
  cache_disk_bytes: number | null
  /** 缓存记录引用的数据块（CAS），和 cache_disk_bytes 是两块不同的磁盘占用 */
  cas_disk_bytes: number | null
  request_count: number | null
  request_p95_ms: number | null
}

export interface ZenProjectSummary {
  id: string
  project_file: string | null
  engine_root: string | null
  last_access: string | null
  /** 工程文件已经不在磁盘上 —— 这份缓存大概率没人再用 */
  project_file_missing: boolean
  is_current_project: boolean
}

/** 命中 + 未命中低于这个数，命中率只是启动噪声 */
export const MIN_MEANINGFUL_LOOKUPS = 50

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function summarizeCacheStats(raw: ZenCacheStatsRaw | null | undefined): ZenCacheSummary {
  const hits = num(raw?.cache?.hits)
  const misses = num(raw?.cache?.misses)
  const ratio = num(raw?.cache?.hit_ratio)
  const p95 = num(raw?.requests?.t_p95)
  return {
    hits,
    misses,
    writes: num(raw?.cache?.writes),
    hit_ratio_percent: ratio == null ? null : Math.round(ratio * 1000) / 10,
    sample_too_small: (hits ?? 0) + (misses ?? 0) < MIN_MEANINGFUL_LOOKUPS,
    cache_disk_bytes: num(raw?.cache?.size?.disk),
    cas_disk_bytes: num(raw?.cid?.size?.total),
    request_count: num(raw?.requests?.count),
    // Zen 给的是秒
    request_p95_ms: p95 == null ? null : Math.round(p95 * 1000)
  }
}

/**
 * `LastAccessTime` 的单位：Unix 纪元起的 100 纳秒刻度。
 *
 * 实测值 17689793810067232 → 2026-01-21，和那个工程目录里文件的修改时间对得上；
 * 按 .NET / FDateTime 那种「公元 1 年起」的刻度解会落到公元 57 年。
 */
export function zenTicksToIso(ticks: unknown): string | null {
  const t = num(ticks)
  if (t == null || t <= 0) return null
  const d = new Date(t / 1e4)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * 按最后访问时间倒序；当前工程排最前。
 *
 * `fileExists` 由调用方注入，测试里不用碰磁盘。
 */
export function summarizeProjects(
  raw: ZenProjectRaw[] | null | undefined,
  currentProjectPath: string | null | undefined,
  fileExists: (p: string) => boolean
): ZenProjectSummary[] {
  const rows = (Array.isArray(raw) ? raw : []).map((p) => {
    const projectFile =
      typeof p.ProjectFilePath === 'string' && p.ProjectFilePath ? p.ProjectFilePath : null
    return {
      id: String(p.Id ?? ''),
      project_file: projectFile,
      engine_root: typeof p.EngineRootDir === 'string' ? p.EngineRootDir : null,
      last_access: zenTicksToIso(p.LastAccessTime),
      project_file_missing: projectFile != null && !fileExists(projectFile),
      // Zen 记的是 .uproject，对话记的可能是工程目录 —— 同一把尺子比
      is_current_project: isSameProjectPath(projectFile, currentProjectPath)
    }
  })
  return rows.sort((a, b) => {
    if (a.is_current_project !== b.is_current_project) return a.is_current_project ? -1 : 1
    return (b.last_access ?? '').localeCompare(a.last_access ?? '')
  })
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return '未知'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}
