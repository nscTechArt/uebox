import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBlueprintLibraryStore } from './blueprintLibraryStore'

describe('blueprintLibrary store editor view state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('isolates renderer view state per editor tab', () => {
    const store = useBlueprintLibraryStore()

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
