/**
 * 页面根节点上的「拖文件进来导入」这一层，不能把应用内部的拖拽也劫走。
 *
 * 红灯用例：把工程卡片拖到分组按钮上。内部拖拽声明 effectAllowed='move'，
 * 而这一层原来在 dragover 里无条件 preventDefault + dropEffect='copy'，
 * copy 跟 move 对不上，浏览器把结果解析成 none —— 光标变禁用图标，
 * drop 事件根本不发，放置目标那边怎么写都没用。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/utils/messageManager', () => ({
  message: { warning: vi.fn(), error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/utils/messageManager', () => ({
  message: { warning: vi.fn(), error: vi.fn(), success: vi.fn() }
}))

vi.mock('@renderer/i18n', () => ({
  default: { global: { t: (key: string) => key } }
}))

vi.mock('ant-design-vue', () => ({ default: {} }))

vi.mock('@renderer/components/ProjectSelectModal.vue', () => ({ default: {} }))

const { useDragImport } = await import('./useDragImport')

type FakeDragEvent = {
  dataTransfer: { types: string[]; dropEffect: string }
  preventDefault: () => void
  stopPropagation: () => void
}

const makeEvent = (types: string[]): FakeDragEvent => ({
  dataTransfer: { types, dropEffect: 'move' },
  preventDefault: vi.fn(),
  stopPropagation: vi.fn()
})

describe('drag-to-import layer keeps its hands off internal drags', () => {
  it('leaves an internal card drag alone', () => {
    const { handleDragOver, handleDragEnter, isDragOver } = useDragImport()
    const event = makeEvent(['text/project-key'])

    handleDragEnter(event as unknown as DragEvent)
    handleDragOver(event as unknown as DragEvent)

    expect(event.preventDefault).not.toHaveBeenCalled()
    // 没被改成 copy，放置目标自己设的 move 才留得住
    expect(event.dataTransfer.dropEffect).toBe('move')
    expect(isDragOver.value).toBe(false)
  })

  it('still claims a real file drag from the system', () => {
    const { handleDragOver, handleDragEnter, isDragOver } = useDragImport()
    const event = makeEvent(['Files'])

    handleDragEnter(event as unknown as DragEvent)
    expect(isDragOver.value).toBe(true)

    handleDragOver(event as unknown as DragEvent)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.dataTransfer.dropEffect).toBe('copy')
  })
})
