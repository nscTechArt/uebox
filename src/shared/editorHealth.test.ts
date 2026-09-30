import { describe, expect, it } from 'vitest'
import {
  evaluateEditorHealth,
  MIN_HITCH_SAMPLES,
  type EditorHealthItem,
  type EditorHealthRaw
} from './editorHealth'

// 数字取自用户截图里 5.5 的「编辑器诊断」窗口（启动 2 分 28 秒、扫描 1 分 40 秒、本地效率 98%）
const HEALTHY: EditorHealthRaw = {
  startup_seconds: 148,
  asset_registry_seconds: 100,
  enabled_plugin_count: 180,
  editor_hitch_pct: 0,
  editor_hitch_samples: 3000,
  pie_hitch_pct: null,
  pie_hitch_samples: 0,
  pie_first_enter_seconds: null,
  pie_last_enter_seconds: null,
  pie_enter_count: 0,
  ddc_supported: true,
  local_ddc_hit_pct: 98.06,
  local_ddc_lookups: 5000,
  available_memory_gb: 76.9,
  total_memory_gb: 128
}

const byId = (raw: EditorHealthRaw, extras = {}): Record<string, EditorHealthItem> =>
  Object.fromEntries(evaluateEditorHealth(raw, extras).items.map((i) => [i.id, i]))

describe('evaluateEditorHealth', () => {
  it('截图里那台机器：没有一项偏离 Epic 的预期', () => {
    const r = evaluateEditorHealth(HEALTHY)
    expect(r.issueCount).toBe(0)
  })

  it('按 Epic 的默认预期判：启动 160 秒、本地缓存 85%、可用内存 16 GB', () => {
    const items = byId({
      ...HEALTHY,
      startup_seconds: 200,
      local_ddc_hit_pct: 62,
      available_memory_gb: 8
    })
    expect(items.startup!.status).toBe('bad')
    expect(items.localCacheHit!.status).toBe('bad')
    expect(items.availableMemory!.status).toBe('bad')
    expect(evaluateEditorHealth({ ...HEALTHY, startup_seconds: 200 }).issueCount).toBe(1)
  })

  it('没有预期值的项只显示数值，不判好坏', () => {
    const items = byId(HEALTHY, { cacheDiskBytes: 7.8e9 })
    expect(items.pluginCount!.status).toBe('none')
    expect(items.cacheDisk!).toMatchObject({ status: 'none', value: 7.8e9 })
  })

  it('卡顿采样不够 10 秒时不下结论，哪怕比例很高', () => {
    const items = byId({
      ...HEALTHY,
      editor_hitch_pct: 60,
      editor_hitch_samples: MIN_HITCH_SAMPLES - 1
    })
    expect(items.editorHitch!.status).toBe('pending')
  })

  it('采样够了、卡顿率超过 25% 才算异常', () => {
    const items = byId({ ...HEALTHY, editor_hitch_pct: 30, editor_hitch_samples: 500 })
    expect(items.editorHitch!.status).toBe('bad')
  })

  it('没进过 PIE：PIE 各项是「暂无数据」，不算异常', () => {
    const items = byId(HEALTHY)
    expect(items.pieFirstEnter!.status).toBe('pending')
    expect(items.pieEnter!.status).toBe('pending')
  })

  it('只进过一次 PIE 时不重复报「最近一次」', () => {
    const items = byId({
      ...HEALTHY,
      pie_enter_count: 1,
      pie_first_enter_seconds: 8,
      pie_last_enter_seconds: 8
    })
    expect(items.pieFirstEnter!.status).toBe('good')
    expect(items.pieEnter!.status).toBe('pending')
  })

  it('5.0–5.2 没有本地缓存统计：标「不支持」，不算异常', () => {
    const items = byId({ ...HEALTHY, ddc_supported: false, local_ddc_hit_pct: null })
    expect(items.localCacheHit!.status).toBe('unsupported')
  })

  it('字段缺失（旧插件、半截响应）按暂无数据处理，不抛', () => {
    const r = evaluateEditorHealth({})
    expect(r.issueCount).toBe(0)
    expect(r.items.every((i) => i.status === 'pending' || i.status === 'none')).toBe(true)
  })
})
