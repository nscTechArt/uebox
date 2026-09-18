import { ref } from 'vue'
import type { Ref } from 'vue'

/**
 * Gallery"拖拽整理"共享逻辑（蓝图库 / 材质库逐行同构的部分收归一处）。
 *
 * 交互语义：
 * - 拖动条目卡片到另一个条目卡片的"中间 50% 区域"（25%~75%）→ 放下时用两个条目创建新集合
 * - 拖动条目卡片到集合卡片上 → 放下时把条目加入该集合
 * - 状态（draggingId/dragOverId/mergingId/dragOverCollectionId）供模板绑定高亮
 *
 * 领域差异通过配置注入：
 * - dragMime：dataTransfer 主 MIME（如 'text/bp-id' / 'text/material-entry-id'）
 * - getEntry：按 id 取条目（drop 前校验来源仍存在）
 * - createCollection(name, [targetId, sourceId])：拖到条目上放下时创建集合
 * - addToCollection(entryId, collectionId)：拖到集合上放下时加入集合（参数序统一为
 *   entry 在前；蓝图库的 store API 参数序相反，由适配层交换）
 * - onDragStart：dragstart 附加钩子（蓝图库的自定义拖拽 ghost 图在这里实现）
 * - onMerged / onAssigned：成功后的副作用（材质库弹 toast，蓝图库无）
 */
export interface CollectionDragMerge<T> {
  draggingId: Ref<string | null>
  dragOverId: Ref<string | null>
  mergingId: Ref<string | null>
  dragOverCollectionId: Ref<string | null>
  onDragStart: (event: DragEvent, entry: T) => void
  onDragOverEntry: (event: DragEvent, targetEntry: T) => void
  onDragLeaveEntry: (event: DragEvent) => void
  onDropOnEntry: (event: DragEvent, targetEntry: T) => void
  onDragOverCollection: (collectionId: string) => void
  onDropOnCollection: (event: DragEvent, collectionId: string) => void
  onDragEnd: () => void
}

export function useCollectionDragMerge<T extends { id: string; name: string }>(options: {
  dragMime: string
  getEntry: (id: string) => T | undefined
  createCollection: (name: string, memberIds: [string, string]) => void
  addToCollection: (entryId: string, collectionId: string) => void
  onDragStart?: (event: DragEvent, entry: T) => void
  onMerged?: (target: T, source: T) => void
  onAssigned?: (entry: T, collectionId: string) => void
}): CollectionDragMerge<T> {
  const {
    dragMime,
    getEntry,
    createCollection,
    addToCollection,
    onDragStart: onDragStartHook,
    onMerged,
    onAssigned
  } = options

  const draggingId = ref<string | null>(null)
  const dragOverId = ref<string | null>(null)
  const mergingId = ref<string | null>(null)
  const dragOverCollectionId = ref<string | null>(null)

  function clearDragState(): void {
    draggingId.value = null
    dragOverId.value = null
    mergingId.value = null
    dragOverCollectionId.value = null
  }

  function onDragStart(event: DragEvent, entry: T): void {
    draggingId.value = entry.id
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      try {
        event.dataTransfer.setData(dragMime, entry.id)
        event.dataTransfer.setData('text/plain', entry.id)
      } catch {
        /* 某些环境 setData 可能失败，忽略 */
      }
    }
    onDragStartHook?.(event, entry)
  }

  /** 目标卡片水平 25%~75% 视为"合并区" */
  function isMergeZone(event: DragEvent): boolean {
    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    if (!rect.width) return false
    const percent = (event.clientX - rect.left) / rect.width
    return percent > 0.25 && percent < 0.75
  }

  function onDragOverEntry(event: DragEvent, targetEntry: T): void {
    if (!draggingId.value) return
    if (draggingId.value === targetEntry.id) return
    if (isMergeZone(event)) {
      event.stopPropagation()
      dragOverId.value = targetEntry.id
      mergingId.value = targetEntry.id
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    } else {
      dragOverId.value = null
      mergingId.value = null
    }
  }

  function onDragLeaveEntry(event: DragEvent): void {
    const relatedTarget = event.relatedTarget as HTMLElement | null
    const currentTarget = event.currentTarget as HTMLElement | null
    if (relatedTarget && currentTarget?.contains(relatedTarget)) return
    dragOverId.value = null
    mergingId.value = null
  }

  function getDraggedId(event: DragEvent): string {
    return (
      draggingId.value ||
      event.dataTransfer?.getData(dragMime) ||
      event.dataTransfer?.getData('text/plain') ||
      ''
    )
  }

  function onDropOnEntry(event: DragEvent, targetEntry: T): void {
    const sourceId = getDraggedId(event)
    dragOverId.value = null
    mergingId.value = null
    const sourceEntry = sourceId ? getEntry(sourceId) : undefined
    if (!sourceEntry || sourceId === targetEntry.id) {
      clearDragState()
      return
    }
    if (!isMergeZone(event)) {
      clearDragState()
      return
    }
    event.stopPropagation()
    createCollection(targetEntry.name, [targetEntry.id, sourceId])
    onMerged?.(targetEntry, sourceEntry)
    clearDragState()
  }

  function onDragOverCollection(collectionId: string): void {
    if (!draggingId.value) return
    dragOverCollectionId.value = collectionId
  }

  function onDropOnCollection(event: DragEvent, collectionId: string): void {
    const sourceId = getDraggedId(event)
    const sourceEntry = sourceId ? getEntry(sourceId) : undefined
    if (!sourceEntry) {
      clearDragState()
      return
    }
    event.stopPropagation()
    addToCollection(sourceId, collectionId)
    onAssigned?.(sourceEntry, collectionId)
    clearDragState()
  }

  function onDragEnd(): void {
    clearDragState()
  }

  return {
    draggingId,
    dragOverId,
    mergingId,
    dragOverCollectionId,
    onDragStart,
    onDragOverEntry,
    onDragLeaveEntry,
    onDropOnEntry,
    onDragOverCollection,
    onDropOnCollection,
    onDragEnd
  }
}
