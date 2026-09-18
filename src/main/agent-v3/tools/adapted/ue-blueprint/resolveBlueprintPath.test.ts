import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * V3 改造：不再打桩 V2 的 `ContextManager` 黑板，改为打桩 `focusContext`。
 *
 * 原因见 `core/focusContext.ts` —— 「当前开着什么」是引擎状态，V3 按需直接问
 * 引擎（`editor.get_focus_context`），不再维护一份会过期的 per-session 缓存。
 */
const getFocusContext = vi.fn()

vi.mock('../../../core/focusContext', () => ({ getFocusContext }))

const FOCUS_ON_CURRENT = {
  focusedEditor: {
    type: 'blueprint',
    name: 'BP_Current',
    path: '/Game/Blueprints/BP_Current'
  },
  openEditors: [
    { type: 'blueprint', name: 'BP_Older', path: '/Game/Blueprints/BP_Older' },
    { type: 'material', name: 'M_Wood', path: '/Game/Materials/M_Wood' }
  ]
}

beforeEach(() => {
  getFocusContext.mockReset().mockResolvedValue(FOCUS_ON_CURRENT)
})

describe('resolveBlueprintPath', () => {
  it('识别「当前蓝图」这类占位符', async () => {
    const { isCurrentBlueprintPlaceholder } = await import('./resolveBlueprintPath')

    expect(isCurrentBlueprintPlaceholder('CURRENT')).toBe(true)
    expect(isCurrentBlueprintPlaceholder('current_blueprint')).toBe(true)
    expect(isCurrentBlueprintPlaceholder('当前蓝图')).toBe(true)
    expect(isCurrentBlueprintPlaceholder('/Game/Blueprints/BP_Test')).toBe(false)
  })

  it('CURRENT 解析成引擎当前聚焦的蓝图', async () => {
    const { resolveBlueprintPathInput } = await import('./resolveBlueprintPath')

    const resolved = await resolveBlueprintPathInput('CURRENT')

    expect(getFocusContext).toHaveBeenCalled()
    expect(resolved.blueprintPath).toBe('/Game/Blueprints/BP_Current')
    expect(resolved.wasPlaceholder).toBe(true)
    expect(resolved.source).toBe('current_context')
  })

  it('聚焦的不是蓝图时，退而从已打开的编辑器里找', async () => {
    getFocusContext.mockResolvedValue({
      focusedEditor: { type: 'material', name: 'M_Wood', path: '/Game/Materials/M_Wood' },
      openEditors: [{ type: 'blueprint', name: 'BP_Fallback', path: '/Game/BP_Fallback' }]
    })
    const { resolveBlueprintPathInput } = await import('./resolveBlueprintPath')

    const resolved = await resolveBlueprintPathInput('当前蓝图')

    expect(resolved.blueprintPath).toBe('/Game/BP_Fallback')
  })

  it('引擎没连上时不炸，返回空路径让调用方给出明确报错', async () => {
    getFocusContext.mockResolvedValue({})
    const { resolveBlueprintPathInput } = await import('./resolveBlueprintPath')

    const resolved = await resolveBlueprintPathInput('CURRENT')

    expect(resolved.blueprintPath).toBeUndefined()
    expect(resolved.wasPlaceholder).toBe(true)
  })

  it('完整路径直接透传，不去问引擎', async () => {
    const { resolveBlueprintPathInput } = await import('./resolveBlueprintPath')

    const resolved = await resolveBlueprintPathInput('/Game/Blueprints/BP_Explicit')

    expect(resolved.blueprintPath).toBe('/Game/Blueprints/BP_Explicit')
    expect(resolved.source).toBe('explicit')
    expect(getFocusContext).not.toHaveBeenCalled()
  })

  it('只给资产名时，在已打开的编辑器里模糊匹配', async () => {
    const { resolveBlueprintPathInput } = await import('./resolveBlueprintPath')

    const resolved = await resolveBlueprintPathInput('BP_Older')

    expect(resolved.blueprintPath).toBe('/Game/Blueprints/BP_Older')
    expect(resolved.source).toBe('context_match')
  })
})

describe('pickBestBlueprintCandidate', () => {
  it('精确短名优先于模糊匹配', async () => {
    const { pickBestBlueprintCandidate } = await import('./resolveBlueprintPath')

    const matched = pickBestBlueprintCandidate('BP_Target', [
      { name: 'BP_Target_Helper', path: '/Game/Blueprints/BP_Target_Helper' },
      { name: 'BP_Target', path: '/Game/Blueprints/BP_Target' }
    ])

    expect(matched?.path).toBe('/Game/Blueprints/BP_Target')
  })

  it('不会漂移到更长的前缀匹配', async () => {
    const { pickBestBlueprintCandidate } = await import('./resolveBlueprintPath')

    const matched = pickBestBlueprintCandidate('BP-Player', [
      { name: 'BP_PlayerController', path: '/Game/Blueprints/BP_PlayerController' }
    ])

    expect(matched).toBeUndefined()
  })

  it('跨分隔符的归一化精确匹配', async () => {
    const { pickBestBlueprintCandidate } = await import('./resolveBlueprintPath')

    const matched = pickBestBlueprintCandidate('BP-Player', [
      { name: 'BP_Player', path: '/Game/Blueprints/BP_Player' }
    ])

    expect(matched?.path).toBe('/Game/Blueprints/BP_Player')
  })

  it('同分时保持传入顺序 —— 聚焦的编辑器在最前', async () => {
    // V2 这里比 timestamp（黑板记的最近使用时间），V3 靠候选顺序表达优先级
    const { pickBestBlueprintCandidate } = await import('./resolveBlueprintPath')

    const matched = pickBestBlueprintCandidate('BP_Same', [
      { name: 'BP_Same', path: '/Game/A/BP_Same' },
      { name: 'BP_Same', path: '/Game/B/BP_Same' }
    ])

    expect(matched?.path).toBe('/Game/A/BP_Same')
  })
})
