import { describe, expect, it } from 'vitest'
import { applySessionClick, pruneSelection, resolveSelectionRange } from './chatSessionSelection'

const VISIBLE = ['a', 'b', 'c', 'd', 'e']

describe('resolveSelectionRange', () => {
  it('selects from anchor to target in both directions', () => {
    expect(resolveSelectionRange(VISIBLE, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(resolveSelectionRange(VISIBLE, 'd', 'b')).toEqual(['b', 'c', 'd'])
  })

  it('includes the anchor itself when it equals the target', () => {
    expect(resolveSelectionRange(VISIBLE, 'c', 'c')).toEqual(['c'])
  })

  it('falls back to only the target when the anchor left the list', () => {
    expect(resolveSelectionRange(VISIBLE, 'gone', 'd')).toEqual(['d'])
  })
})

describe('applySessionClick', () => {
  it('opens the chat on a plain click when nothing is selected', () => {
    const result = applySessionClick([], '', VISIBLE, 'c', {})

    expect(result).toEqual({ selected: [], anchor: 'c', open: true })
  })

  it('keeps the plain-click-open behaviour even with a stale anchor around', () => {
    const result = applySessionClick([], 'b', VISIBLE, 'c', {})

    expect(result).toEqual({ selected: [], anchor: 'c', open: true })
  })

  it('selects only the target on a plain click while a multi-select is active', () => {
    const result = applySessionClick(['a', 'c'], 'a', VISIBLE, 'd', {})

    expect(result).toEqual({ selected: ['d'], anchor: 'd', open: false })
  })

  it('toggles the target into the selection on Ctrl+click and moves the anchor', () => {
    const result = applySessionClick(['b'], 'b', VISIBLE, 'd', { ctrlKey: true })

    expect(result).toEqual({ selected: ['b', 'd'], anchor: 'd', open: false })
  })

  it('toggles the target out of the selection on a repeated Ctrl+click', () => {
    const result = applySessionClick(['b', 'd'], 'b', VISIBLE, 'b', { ctrlKey: true })

    expect(result).toEqual({ selected: ['d'], anchor: 'b', open: false })
  })

  it('treats Cmd+click like Ctrl+click', () => {
    const result = applySessionClick([], '', VISIBLE, 'a', { metaKey: true })

    expect(result).toEqual({ selected: ['a'], anchor: 'a', open: false })
  })

  it('replaces the selection with the anchor range on Shift+click and keeps the anchor', () => {
    const result = applySessionClick(['a'], 'b', VISIBLE, 'e', { shiftKey: true })

    expect(result).toEqual({ selected: ['b', 'c', 'd', 'e'], anchor: 'b', open: false })
  })

  it('uses the target as its own anchor on the first Shift+click', () => {
    const result = applySessionClick([], '', VISIBLE, 'c', { shiftKey: true })

    expect(result).toEqual({ selected: ['c'], anchor: 'c', open: false })
  })

  it('falls back to the target when the Shift anchor is no longer visible', () => {
    const result = applySessionClick(['x'], 'x', VISIBLE, 'c', { shiftKey: true })

    expect(result).toEqual({ selected: ['c'], anchor: 'x', open: false })
  })
})

describe('pruneSelection', () => {
  it('drops ids that no longer exist and keeps the rest in order', () => {
    expect(pruneSelection(['a', 'gone', 'c', 'also-gone'], new Set(['a', 'b', 'c']))).toEqual([
      'a',
      'c'
    ])
  })

  it('returns an empty list when nothing survives', () => {
    expect(pruneSelection(['gone'], new Set())).toEqual([])
  })
})
