// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatBytes, summarizeCacheStats, summarizeProjects, zenTicksToIso } from './zenStats'

// 字段取自 Zen 5.8.13 上 `/stats/z$` 的真实返回
const REAL_STATS = {
  requests: { count: 357, t_p95: 0.66117165, t_p99: 1.183 },
  cache: {
    hits: 571,
    misses: 71,
    writes: 23,
    hit_ratio: 0.88940809968847356,
    size: { disk: 6899329071, memory: 174568 }
  },
  cid: { size: { total: 1461978732 } }
}

describe('summarizeCacheStats', () => {
  it('把真实返回整理成百分比、毫秒和字节', () => {
    const s = summarizeCacheStats(REAL_STATS)
    expect(s.hit_ratio_percent).toBe(88.9)
    expect(s.hits).toBe(571)
    expect(s.misses).toBe(71)
    expect(s.sample_too_small).toBe(false)
    expect(s.cache_disk_bytes).toBe(6899329071)
    expect(s.cas_disk_bytes).toBe(1461978732)
    expect(s.request_p95_ms).toBe(661)
  })

  it('刚启动、查了没几次时标出样本太少', () => {
    const s = summarizeCacheStats({ cache: { hits: 3, misses: 1, hit_ratio: 0.75 } })
    expect(s.sample_too_small).toBe(true)
  })

  it('字段缺失时报 null，不编数字', () => {
    const s = summarizeCacheStats({})
    expect(s.hit_ratio_percent).toBeNull()
    expect(s.cache_disk_bytes).toBeNull()
    expect(s.request_p95_ms).toBeNull()
  })
})

describe('zenTicksToIso', () => {
  it('按 Unix 纪元起的 100 纳秒刻度解', () => {
    expect(zenTicksToIso(17689793810067232)).toBe('2026-01-21T07:09:41.006Z')
  })

  it('非法值给 null', () => {
    expect(zenTicksToIso(0)).toBeNull()
    expect(zenTicksToIso('x')).toBeNull()
  })
})

describe('summarizeProjects', () => {
  const raw = [
    { Id: 'Old.1', ProjectFilePath: 'D:/Gone/Old.uproject', LastAccessTime: 17512773212097750 },
    {
      Id: 'Recent.2',
      ProjectFilePath: 'D:/XG/Recent/Recent.uproject',
      LastAccessTime: 17689793810067232
    },
    { Id: 'Mine.3', ProjectFilePath: 'I:/CG Game/Mine/Mine.uproject', LastAccessTime: 1 }
  ]
  const exists = (p: string): boolean => !p.includes('Gone')

  it('当前工程排第一，其余按最近访问倒序', () => {
    // 会话里记的是工程目录，Zen 记的是 .uproject，大小写和斜杠也不同
    const rows = summarizeProjects(raw, 'i:\\cg game\\mine', exists)
    expect(rows.map((r) => r.id)).toEqual(['Mine.3', 'Recent.2', 'Old.1'])
    expect(rows[0]!.is_current_project).toBe(true)
  })

  it('工程文件不在磁盘上的标出来', () => {
    const rows = summarizeProjects(raw, null, exists)
    expect(rows.find((r) => r.id === 'Old.1')!.project_file_missing).toBe(true)
    expect(rows.find((r) => r.id === 'Recent.2')!.project_file_missing).toBe(false)
  })

  it('不是数组时给空列表', () => {
    expect(summarizeProjects(null, null, exists)).toEqual([])
  })
})

describe('formatBytes', () => {
  it('GB 以上保留一位，以下按 MB', () => {
    expect(formatBytes(6899329071)).toBe('6.4 GB')
    expect(formatBytes(174568)).toBe('0 MB')
    expect(formatBytes(null)).toBe('未知')
  })
})
