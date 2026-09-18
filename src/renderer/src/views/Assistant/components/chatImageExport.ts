import html2canvas from 'html2canvas'

type CaptureOptions = NonNullable<Parameters<typeof html2canvas>[1]>
type Capture = (element: HTMLElement, options: CaptureOptions) => Promise<HTMLCanvasElement>

const MAX_CANVAS_EDGE = 32_000
const MAX_CANVAS_PIXELS = 120_000_000
let exportSequence = 0

interface ExportLayout {
  height: number
  paddingTop: string
  paddingBottom: string
}

function findBackgroundColor(element: HTMLElement): string | null {
  let current: HTMLElement | null = element
  while (current) {
    const color = getComputedStyle(current).backgroundColor
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
    current = current.parentElement
  }

  return (
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg-page').trim() || null
  )
}

export function resolveCaptureScale(width: number, height: number, deviceScale: number): number {
  return Math.min(
    Math.max(deviceScale, 1),
    2,
    MAX_CANVAS_EDGE / width,
    MAX_CANVAS_EDGE / height,
    Math.sqrt(MAX_CANVAS_PIXELS / (width * height))
  )
}

export function prepareChatExportLayout(root: HTMLElement, layout: ExportLayout): void {
  root.style.height = `${layout.height}px`
  root.style.maxHeight = 'none'
  root.style.overflow = 'visible'
  root.style.transform = 'none'
  root.style.backgroundColor = 'inherit'

  const area = root.closest<HTMLElement>('.chat-log-area')
  if (area) {
    area.style.height = `${layout.height}px`
    area.style.maxHeight = 'none'
    area.style.overflow = 'visible'
  }

  const messages = root.querySelector<HTMLElement>('.messages-container')
  if (messages) {
    messages.style.flexDirection = 'column-reverse'
    messages.style.paddingTop = layout.paddingBottom
    messages.style.paddingBottom = layout.paddingTop
  }

  root.querySelectorAll<HTMLElement>('.message-item-flipper').forEach((item) => {
    item.style.transform = 'none'
  })
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Failed to encode conversation image'))
    }, 'image/png')
  })
}

export async function captureChatAsPng(
  element: HTMLElement,
  capture: Capture = html2canvas
): Promise<Blob> {
  const width = element.clientWidth
  const height = element.scrollHeight
  if (width <= 0 || height <= 0) throw new Error('Conversation has no visible content')

  const messages = element.querySelector<HTMLElement>('.messages-container')
  const messagesStyle = messages ? getComputedStyle(messages) : null
  const layout: ExportLayout = {
    height,
    paddingTop: messagesStyle?.paddingTop || '0px',
    paddingBottom: messagesStyle?.paddingBottom || '0px'
  }
  const marker = `chat-image-${++exportSequence}`
  element.dataset.chatImageExport = marker

  try {
    const canvas = await capture(element, {
      backgroundColor: findBackgroundColor(element),
      height,
      logging: false,
      onclone(clonedDocument) {
        const clonedRoot = clonedDocument.querySelector<HTMLElement>(
          `[data-chat-image-export="${marker}"]`
        )
        if (clonedRoot) prepareChatExportLayout(clonedRoot, layout)
      },
      scale: resolveCaptureScale(width, height, window.devicePixelRatio || 1),
      useCORS: true,
      width,
      windowHeight: Math.max(document.documentElement.clientHeight, height),
      windowWidth: Math.max(document.documentElement.clientWidth, width)
    })

    return await canvasToPng(canvas)
  } finally {
    delete element.dataset.chatImageExport
  }
}
