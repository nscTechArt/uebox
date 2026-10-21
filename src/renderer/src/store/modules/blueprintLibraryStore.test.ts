import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBlueprintLibraryStore } from './blueprintLibraryStore'

describe('blueprintLibrary store editor tab state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('isolates active blueprint and element state per editor tab', () => {
    const store = useBlueprintLibraryStore()

    store.setEditorTabId('tab-a')
    store.setActiveBlueprintId('bp-a')
    store.setActiveElement('graph-a', 'graph', 'tab-a')

    store.setEditorTabId('tab-b')
    expect(store.activeBlueprintId).toBeNull()
    expect(store.activeElementId).toBeNull()
    expect(store.activeElementType).toBeNull()

    store.setActiveBlueprintId('bp-b')
    store.setActiveElement('graph-b', 'graph', 'tab-b')

    store.setEditorTabId('tab-a')
    expect(store.activeBlueprintId).toBe('bp-a')
    expect(store.activeElementId).toBe('graph-a')
    expect(store.activeElementType).toBe('graph')

    store.setEditorTabId('tab-b')
    expect(store.activeBlueprintId).toBe('bp-b')
    expect(store.activeElementId).toBe('graph-b')
    expect(store.activeElementType).toBe('graph')
  })

  it('writes a background tab selection into its own saved state, not the foreground', () => {
    const store = useBlueprintLibraryStore()

    store.setEditorTabId('A')
    store.setActiveElement('g2', 'graph', 'B')
    expect(store.activeElementId).toBeNull()

    store.setEditorTabId('B')
    expect(store.activeElementId).toBe('g2')
    expect(store.activeElementType).toBe('graph')
  })

  it('copies editor state into a duplicated tab', () => {
    const store = useBlueprintLibraryStore()

    store.setEditorTabId('source-tab')
    store.setActiveBlueprintId('bp-source')
    store.setActiveElement('function-source', 'function', 'source-tab')

    store.copyEditorStateToTabId('source-tab', 'target-tab')
    store.setEditorTabId('target-tab')

    expect(store.activeBlueprintId).toBe('bp-source')
    expect(store.activeElementId).toBe('function-source')
    expect(store.activeElementType).toBe('function')
  })

  it('isolates renderer view state per editor tab', () => {
    const store = useBlueprintLibraryStore()

    store.setEditorTabId('tab-a')
    store.saveEditorViewState(
      'bp-a',
      'graph-a',
      'graph',
      {
        zoom: -2,
        scrollX: 1200,
        scrollY: 900,
        translateX: 800,
        translateY: 1200,
        centerX: 320,
        centerY: 480,
        selectedNodeNames: ['NodeA', 'NodeB']
      },
      'tab-a'
    )

    store.setEditorTabId('tab-b')
    expect(store.getEditorViewState('bp-a', 'graph-a', 'graph', 'tab-b')).toBeNull()

    store.saveEditorViewState(
      'bp-a',
      'graph-a',
      'graph',
      {
        zoom: 1,
        scrollX: 2400,
        scrollY: 1800,
        translateX: 400,
        translateY: 400,
        centerX: 1280,
        centerY: 960,
        selectedNodeNames: ['NodeC']
      },
      'tab-b'
    )

    store.setEditorTabId('tab-a')
    expect(store.getEditorViewState('bp-a', 'graph-a', 'graph', 'tab-a')).toEqual({
      zoom: -2,
      scrollX: 1200,
      scrollY: 900,
      translateX: 800,
      translateY: 1200,
      centerX: 320,
      centerY: 480,
      selectedNodeNames: ['NodeA', 'NodeB']
    })

    store.setEditorTabId('tab-b')
    expect(store.getEditorViewState('bp-a', 'graph-a', 'graph', 'tab-b')).toEqual({
      zoom: 1,
      scrollX: 2400,
      scrollY: 1800,
      translateX: 400,
      translateY: 400,
      centerX: 1280,
      centerY: 960,
      selectedNodeNames: ['NodeC']
    })
  })

  it('copies renderer view state into a duplicated tab', () => {
    const store = useBlueprintLibraryStore()

    store.setEditorTabId('source-tab')
    store.saveEditorViewState(
      'bp-source',
      'graph-source',
      'graph',
      {
        zoom: -4,
        scrollX: 1600,
        scrollY: 1100,
        translateX: 1200,
        translateY: 800,
        centerX: 640,
        centerY: 360,
        selectedNodeNames: ['NodeA']
      },
      'source-tab'
    )

    store.copyEditorStateToTabId('source-tab', 'target-tab')
    store.setEditorTabId('target-tab')

    expect(store.getEditorViewState('bp-source', 'graph-source', 'graph', 'target-tab')).toEqual({
      zoom: -4,
      scrollX: 1600,
      scrollY: 1100,
      translateX: 1200,
      translateY: 800,
      centerX: 640,
      centerY: 360,
      selectedNodeNames: ['NodeA']
    })
  })

  it('toggles a blueprint favorite on and off', () => {
    const store = useBlueprintLibraryStore()
    const actor = store.createBlueprint({
      name: 'BP_DoorController',
      blueprintType: 'BlueprintClass',
      engineVersion: '5.4'
    })

    store.toggleFavorite(actor.id)
    expect(store.blueprints.find((bp) => bp.id === actor.id)?.isFavorite).toBe(true)

    store.toggleFavorite(actor.id)
    expect(store.blueprints.find((bp) => bp.id === actor.id)?.isFavorite).toBe(false)
  })
})
