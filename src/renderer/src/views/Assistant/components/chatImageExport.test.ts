import { describe, expect, it, vi } from 'vitest'
import { captureChatAsPng, prepareChatExportLayout, resolveCaptureScale } from './chatImageExport'

function createChatElement(): HTMLElement {
  const element = document.createElement('div')
  element.className = 'chat-log'
  element.innerHTML = `
    <div class="messages-container">
      <div class="message-item-flipper">newest</div>
      <div class="message-item-flipper">oldest</div>
    </div>
  `
  Object.defineProperties(element, {
    clientWidth: { value: 900 },
    scrollHeight: { value: 5000 }
  })
  document.body.appendChild(element)
  return element
}

describe('chat image export', () => {
  it('按完整滚动高度截图，并在结束后清理临时标记', async () => {
    const element = createChatElement()
    const blob = new Blob(['png'], { type: 'image/png' })
    const canvas = document.createElement('canvas')
    canvas.toBlob = vi.fn((callback) => callback(blob))
    const capture = vi.fn(async () => canvas)

    await expect(captureChatAsPng(element, capture)).resolves.toBe(blob)

    expect(capture).toHaveBeenCalledWith(
      element,
      expect.objectContaining({ width: 900, height: 5000, useCORS: true })
    )
    expect(element.dataset.chatImageExport).toBeUndefined()
    element.remove()
  })

  it('导出布局恢复正常顺序，并移除滚动区的翻转和裁切', () => {
    const area = document.createElement('section')
    area.className = 'chat-log-area'
    const element = createChatElement()
    area.appendChild(element)

    prepareChatExportLayout(element, {
      height: 5000,
      paddingTop: '36px',
      paddingBottom: '20px'
    })

    expect(element.style.height).toBe('5000px')
    expect(element.style.transform).toBe('none')
    expect(area.style.overflow).toBe('visible')
    expect(element.querySelector<HTMLElement>('.messages-container')?.style.flexDirection).toBe(
      'column-reverse'
    )
    expect(element.querySelector<HTMLElement>('.messages-container')?.style.paddingTop).toBe('20px')
    expect(element.querySelector<HTMLElement>('.message-item-flipper')?.style.transform).toBe(
      'none'
    )
    area.remove()
  })

  it('超长对话自动降低像素倍率，仍保留从头到尾的完整内容', () => {
    expect(resolveCaptureScale(1000, 5000, 2)).toBe(2)
    expect(resolveCaptureScale(1000, 64_000, 2)).toBe(0.5)
  })

  it('PNG 编码失败时抛错，并照样清理临时标记', async () => {
    const element = createChatElement()
    const canvas = document.createElement('canvas')
    canvas.toBlob = vi.fn((callback) => callback(null))

    await expect(captureChatAsPng(element, async () => canvas)).rejects.toThrow(
      'Failed to encode conversation image'
    )
    expect(element.dataset.chatImageExport).toBeUndefined()
    element.remove()
  })
})
