import { defineStore } from 'pinia'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import { StorageUtils } from '../../common/utils/storage'

interface NoteTabState {
  selectedNoteId: number | null
}

export const useNoteViewStore = defineStore('noteView', {
  state: () => ({
    // 存储所有标签页的状态
    // Key: tabId, Value: NoteTabState
    tabStates: {} as Record<string, NoteTabState>,
    // 用于通知笔记被外部更新（如 AI 生成标题后）
    noteUpdatedId: null as number | null,
    noteUpdateTimestamp: 0
  }),
  actions: {
    setTabState(tabId: string, state: NoteTabState) {
      this.tabStates[tabId] = state
    },
    getTabState(tabId: string): NoteTabState | null {
      return this.tabStates[tabId] || null
    },
    clearTabState(tabId: string) {
      delete this.tabStates[tabId]
    },
    /**
     * 通知笔记已被外部更新，需要刷新
     * @param noteId 更新的笔记ID
     */
    notifyNoteUpdated(noteId: number) {
      this.noteUpdatedId = noteId
      this.noteUpdateTimestamp = Date.now()
    }
  },
  persist: usePersistOptions<{
    tabStates: Record<string, NoteTabState>
  }>({
    key: 'note-view-store',
    paths: ['tabStates'],
    storage: 'localStorage',
    serializer: StorageUtils.createCustomSerializer()
  })
})
