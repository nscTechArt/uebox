import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { useCollectionDragMerge } from './useCollectionDragMerge'
import type { CollectionDragMerge } from './useCollectionDragMerge'

interface FakeEntry {
  id: string
  name: string
}

type DragMergeHarness = CollectionDragMerge<FakeEntry> & {
  createCollection: Mock
  addToCollection: Mock
}

function createHarness(entries: FakeEntry[]): DragMergeHarness {
  const createCollection = vi.fn()
  const addToCollection = vi.fn()
  const api = useCollectionDragMerge<FakeEntry>({
    dragMime: 'text/test-id',
    getEntry: (id) => entries.find((entry) => entry.id === id),
    createCollection,
    addToCollection
  })
  return { ...api, createCollection, addToCollection }
}

/** 构造带几何信息的伪事件与元素 */
interface DragEventHarness {
  event: DragEvent
  stopPropagation: Mock
}

function createDragEvent(options: {
  clientX: number
  left?: number
  width?: number
  dataTransfer?: Partial<DataTransfer>
  relatedTarget?: HTMLElement | null
}): DragEventHarness {
  const element = {
    getBoundingClientRect: () => ({
      left: options.left ?? 0,
      width: options.width ?? 100,
      right: (options.left ?? 0) + (options.width ?? 100),
      top: 0,
      bottom: 0,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }),
    contains: () => false
  } as unknown as HTMLElement
  const stopPropagation = vi.fn()
  return {
    event: {
      clientX: options.clientX,
      currentTarget: element,
      relatedTarget: options.relatedTarget ?? null,
      stopPropagation,
      dataTransfer: {
        getData: vi.fn((mime: string) =>
          mime === 'text/test-id' ? 'source' : mime === 'text/plain' ? 'source' : ''
        ),
        setData: vi.fn(),
        ...(options.dataTransfer ?? {})
      }
    } as unknown as DragEvent,
    stopPropagation
  }
}

describe('useCollectionDragMerge', () => {
  const entries: FakeEntry[] = [
    { id: 'source', name: 'Source' },
    { id: 'target', name: 'Target' },
    { id: 'other', name: 'Other' }
  ]

  it('拖到条目中间区域放下时创建集合并清理状态', () => {
    const api = createHarness(entries)
    api.onDragStart(createDragEvent({ clientX: 0 }).event, entries[0])
    expect(api.draggingId.value).toBe('source')

    const { event, stopPropagation } = createDragEvent({ clientX: 50 })
    api.onDropOnEntry(event, entries[1])

    expect(api.createCollection).toHaveBeenCalledWith('Target', ['target', 'source'])
    expect(stopPropagation).toHaveBeenCalled()
    expect(api.draggingId.value).toBeNull()
    expect(api.mergingId.value).toBeNull()
  })

  it('拖到条目边缘区域（非合并区）放下时不创建集合', () => {
    const api = createHarness(entries)
    api.onDragStart(createDragEvent({ clientX: 0 }).event, entries[0])
    const { event, stopPropagation } = createDragEvent({ clientX: 10 })
    api.onDropOnEntry(event, entries[1])

    expect(api.createCollection).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(api.draggingId.value).toBeNull()
  })

  it('dragover 中间区域时标记合并高亮，边缘清除', () => {
    const api = createHarness(entries)
    api.onDragStart(createDragEvent({ clientX: 0 }).event, entries[0])

    api.onDragOverEntry(createDragEvent({ clientX: 60 }).event, entries[1])
    expect(api.dragOverId.value).toBe('target')
    expect(api.mergingId.value).toBe('target')

    api.onDragOverEntry(createDragEvent({ clientX: 90 }).event, entries[1])
    expect(api.dragOverId.value).toBeNull()
    expect(api.mergingId.value).toBeNull()
  })

  it('拖到集合上放下时加入集合并清理状态', () => {
    const api = createHarness(entries)
    api.onDragStart(createDragEvent({ clientX: 0 }).event, entries[0])

    api.onDragOverCollection('col-1')
    expect(api.dragOverCollectionId.value).toBe('col-1')

    const { event } = createDragEvent({ clientX: 50 })
    api.onDropOnCollection(event, 'col-1')

    expect(api.addToCollection).toHaveBeenCalledWith('source', 'col-1')
    expect(api.dragOverCollectionId.value).toBeNull()
  })

  it('来源条目不存在（跨库脏数据）时忽略放置', () => {
    const api = createHarness(entries)
    api.onDragStart(createDragEvent({ clientX: 0 }).event, entries[0])
    const { event } = createDragEvent({
      clientX: 50,
      dataTransfer: {
        getData: vi.fn(() => 'ghost-id')
      }
    })
    // draggingId 优先于 dataTransfer，先结束本次拖拽再模拟纯 dataTransfer 输入
    api.onDragEnd()
    api.onDropOnCollection(event, 'col-1')

    expect(api.addToCollection).not.toHaveBeenCalled()
  })

  it('dragstart 写入主 MIME 与 text/plain 兜底并允许领域钩子附加 ghost', () => {
    const entries2: FakeEntry[] = [{ id: 'source', name: 'Source' }]
    const onDragStart = vi.fn()
    const api = useCollectionDragMerge<FakeEntry>({
      dragMime: 'text/test-id',
      getEntry: (id) => entries2.find((entry) => entry.id === id),
      createCollection: vi.fn(),
      addToCollection: vi.fn(),
      onDragStart
    })
    const { event } = createDragEvent({ clientX: 0 })
    api.onDragStart(event, entries2[0])

    expect(
      (event.dataTransfer as unknown as { setData: ReturnType<typeof vi.fn> }).setData
    ).toHaveBeenCalledWith('text/test-id', 'source')
    expect(onDragStart).toHaveBeenCalledWith(event, entries2[0])
  })
})
