/**
 * 引擎扫描回来之后怎么处理。
 *
 * 这三条守则之前一条测试都没有，代价是同一个 bug 连着两轮被修在错的层上，
 * 而其中「不许动用户存的默认引擎」是那条记录会不会被悄悄删掉的唯一防线 ——
 * 去掉 `syncSelections` 那个判断，整个仓库照样全绿。
 */
import { describe, expect, it } from 'vitest'

import { readEngineScan } from './engineScanResult'

const map = (info: unknown): { version: string } => ({
  version: String((info as { version?: string })?.version ?? '')
})

describe('readEngineScan', () => {
  it('读成了：用新列表，可以回收用户的选择', () => {
    const out = readEngineScan({ success: true, degraded: false, data: [{ version: '5.5' }] }, map)

    expect(out.ok).toBe(true)
    expect(out.engines).toEqual([{ version: '5.5' }])
    expect(out.syncSelections).toBe(true)
  })

  it('读成了、真的一个都没装：列表清空，这才是「没有引擎」', () => {
    const out = readEngineScan({ success: true, degraded: false, data: [] }, map)

    expect(out.ok).toBe(true)
    expect(out.engines).toEqual([])
    expect(out.syncSelections).toBe(true)
  })

  /*
   * 主菜之一：降级时主进程回的是上次的缓存，界面必须照样显示。
   * 首页没有 keepAlive，切个标签回来组件是全新的、列表是空的 —— 丢掉这份
   * 就等于对着装了四个引擎的用户说一个都没有。
   */
  it('降级但给了缓存：照样显示，但不许回收选择', () => {
    const out = readEngineScan({ success: true, degraded: true, data: [{ version: '5.5' }] }, map)

    expect(out.ok).toBe(false)
    expect(out.engines).toEqual([{ version: '5.5' }])
    expect(out.syncSelections).toBe(false)
  })

  /*
   * 主菜之二：降级且空 —— 保留界面上现有的，别清空。
   * syncSelections 必须是 false：syncEngineSelectionsWithList 把「不在列表里」
   * 当成「引擎没了」，一次读失败就会把 defaultEngineVersion 从磁盘删掉。
   */
  it('降级且空：保留现有列表，绝不回收选择', () => {
    const out = readEngineScan({ success: true, degraded: true, data: [] }, map)

    expect(out.ok).toBe(false)
    expect(out.engines).toBeNull()
    expect(out.syncSelections).toBe(false)
  })

  it('IPC 自己失败：什么都别动', () => {
    const out = readEngineScan({ success: false, error: 'boom' }, map)

    expect(out.ok).toBe(false)
    expect(out.engines).toBeNull()
    expect(out.syncSelections).toBe(false)
  })

  it('回了个 null/undefined 也当失败处理，不炸', () => {
    for (const reply of [null, undefined]) {
      const out = readEngineScan(reply, map)
      expect(out).toEqual({ ok: false, engines: null, syncSelections: false })
    }
  })

  it('data 不是数组时当空处理，不炸', () => {
    const out = readEngineScan(
      { success: true, degraded: false, data: 'nonsense' as unknown as unknown[] },
      map
    )

    expect(out.ok).toBe(true)
    expect(out.engines).toEqual([])
  })
})
