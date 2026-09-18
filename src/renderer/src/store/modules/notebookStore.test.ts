import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNotebookStore } from './notebookStore'

describe('notebookStore tab isolation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('keeps notebook ui state isolated per tab', () => {
    const store = useNotebookStore()

    store.setTabId('tab-a')
    store.setActiveNotebookId('notebook-a')
    store.setDetailViewType('note-editor')
    store.setCurrentNoteId(101)

    store.setTabId('tab-b')
    expect(store.activeNotebookId).toBeNull()
    expect(store.detailViewType).toBe('assistant')
    expect(store.currentNoteId).toBeNull()

    store.setActiveNotebookId('notebook-b')
    store.setDetailViewType('source-preview')
    store.setCurrentNoteId(202)

    store.setTabId('tab-a')
    expect(store.activeNotebookId).toBe('notebook-a')
    expect(store.detailViewType).toBe('note-editor')
    expect(store.currentNoteId).toBe(101)

    store.setTabId('tab-b')
    expect(store.activeNotebookId).toBe('notebook-b')
    expect(store.detailViewType).toBe('source-preview')
    expect(store.currentNoteId).toBe(202)
  })

  it('copies notebook tab state when a tab is duplicated', () => {
    const store = useNotebookStore()

    store.setTabId('source-tab')
    store.setActiveNotebookId('notebook-source')
    store.setDetailViewType('note-editor')
    store.setCurrentNoteId(88)

    store.copyStateToTabId('source-tab', 'target-tab')
    store.setTabId('target-tab')

    expect(store.activeNotebookId).toBe('notebook-source')
    expect(store.detailViewType).toBe('note-editor')
    expect(store.currentNoteId).toBe(88)
  })
})
