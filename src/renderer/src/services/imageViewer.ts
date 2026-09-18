import PhotoSwipeLightbox from 'photoswipe/lightbox'
import type { SlideData, PhotoSwipeOptions } from 'photoswipe'
import { createApp, type App } from 'vue'
import { PhCopy, PhDownloadSimple } from '@phosphor-icons/vue'
import ContextMenu from '@renderer/components/ContextMenu/ContextMenu.vue'
import i18n from '@renderer/i18n'
import { message } from '@renderer/utils/messageManager'

import 'photoswipe/style.css'

import { runWithConcurrency } from '@renderer/common/utils'
import { copyImageToClipboard, downloadImage } from '@renderer/utils/imageBlob'
import { toLocalResourceUrl } from '@renderer/utils/localResource'

export type ImageViewerItemInput = {
  /** 支持 http(s) / file:/// / data: / 也支持本地绝对路径（会自动转 local-resource://） */
  src: string
  /** 缩略图（可选） */
  msrc?: string
  /** alt 文本（可选） */
  alt?: string
  /** 宽高（可选，不传会尝试通过 Image 预加载获取） */
  width?: number
  height?: number
}

export type OpenImageViewerInput = {
  items: ImageViewerItemInput[]
  index?: number
  options?: PhotoSwipeOptions
}

type ImageViewerPageNavigator = {
  getNumItems: () => number
  prev: () => void
  next: () => void
}

/**
 * 在大图查看器内用上下方向键翻页。
 *
 * PhotoSwipe 原本将上下方向键留给缩放图片后的画布平移。生图历史更常见的
 * 操作是逐张比对，因此仅在存在多张图片时接管这两个按键；左右方向键和滚轮缩放保持原样。
 */
export function handleVerticalImageViewerPageKey(
  event: KeyboardEvent,
  navigator: ImageViewerPageNavigator
): boolean {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    navigator.getNumItems() < 2
  ) {
    return false
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    navigator.prev()
    return true
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    navigator.next()
    return true
  }

  return false
}

let lightbox: PhotoSwipeLightbox | null = null

/**
 * 确保 PhotoSwipe Lightbox 已初始化，并注册自定义按钮
 * @param options 额外的 PhotoSwipe 配置选项
 */
function ensureLightbox(options?: PhotoSwipeOptions): PhotoSwipeLightbox {
  if (lightbox) return lightbox

  lightbox = new PhotoSwipeLightbox({
    // v5 推荐用动态 import，避免首次 bundle 体积
    pswpModule: () => import('photoswipe'),
    // 这里不传 dataSource，打开时通过 loadAndOpen 传入动态 dataSource
    escKey: true,
    arrowKeys: true,
    closeOnVerticalDrag: true,
    wheelToZoom: true,
    bgOpacity: 0.9,
    errorMsg: '图片加载失败',
    ...(options || {})
  })

  lightbox.on('afterInit', () => {
    const viewer = lightbox?.pswp
    if (!viewer) return

    const host = document.createElement('div')
    let menu: InstanceType<typeof ContextMenu> | null = null
    let menuApp: App | null = null
    const hideMenu = (): void => {
      menuApp?.unmount()
      menuApp = null
      menu = null
    }
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      hideMenu()
      const src = viewer.currSlide?.data.src
      if (!src) return

      menuApp = createApp(ContextMenu, {
        menuItems: [
          { key: 'copy', label: i18n.global.t('common.copy'), icon: PhCopy },
          { key: 'save', label: i18n.global.t('common.save'), icon: PhDownloadSimple }
        ],
        onClick: (key: string) => {
          const action = key === 'copy' ? copyImageToClipboard : downloadImage
          void action(src).catch(() => {
            message.error(i18n.global.t(key === 'copy' ? 'common.copyFailed' : 'common.saveFailed'))
          })
        }
      })
      menu = menuApp.mount(host) as InstanceType<typeof ContextMenu>
      menu.show(event.clientX, event.clientY)
    }
    viewer.element?.addEventListener('contextmenu', onContextMenu)
    viewer.on('change', hideMenu)
    viewer.on('close', hideMenu)
    viewer.on('destroy', () => {
      viewer.element?.removeEventListener('contextmenu', onContextMenu)
      hideMenu()
    })
    viewer.on('keydown', (event) => {
      const { originalEvent } = event
      if (menu?.visible) {
        event.preventDefault()
        if (originalEvent.key === 'Escape') {
          originalEvent.preventDefault()
          hideMenu()
        }
        return
      }
      handleVerticalImageViewerPageKey(originalEvent, viewer)
    })
  })

  // 注册复制图片按钮
  lightbox.on('uiRegister', function () {
    lightbox!.pswp!.ui!.registerElement({
      name: 'copy-button',
      ariaLabel: '复制图片',
      order: 8,
      isButton: true,
      html: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style="margin-top: 2px; -webkit-app-region: no-drag;">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
      </svg>`,
      onClick: (_event, _el, pswp) => {
        const currentSlide = pswp.currSlide
        if (currentSlide?.data?.src) {
          copyImageToClipboard(currentSlide.data.src)
            .then(() => {
              console.log('[ImageViewer] 图片已复制到剪贴板')
            })
            .catch((err) => {
              console.error('[ImageViewer] 复制图片失败:', err)
            })
        }
      }
    })

    // 注册下载图片按钮
    lightbox!.pswp!.ui!.registerElement({
      name: 'download-button',
      ariaLabel: '下载图片',
      order: 9,
      isButton: true,
      html: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style="margin-top: 2px; -webkit-app-region: no-drag;">
        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
      </svg>`,
      onClick: (_event, _el, pswp) => {
        const currentSlide = pswp.currSlide
        if (currentSlide?.data?.src) {
          downloadImage(currentSlide.data.src)
            .then(() => {
              console.log('[ImageViewer] 图片已下载')
            })
            .catch((err) => {
              console.error('[ImageViewer] 下载图片失败:', err)
            })
        }
      }
    })
  })

  lightbox.init()
  return lightbox
}

/**
 * 判断是否为 Windows 绝对路径
 */
function isProbablyWindowsPath(input: string): boolean {
  return /^[a-zA-Z]:\\/.test(input) || input.startsWith('\\\\')
}

/**
 * 规范化图片 src：本地路径 / file:// URL 一律转成 local-resource://，
 * 否则 dev 模式下 Chromium 会拒绝加载。
 *
 * 相对路径（打包进来的静态资源等）保持原样，不能当本地绝对路径去转。
 */
function normalizeSrc(src: string): string {
  const s = String(src || '').trim()
  if (!s) return s

  if (
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    s.startsWith('data:') ||
    s.startsWith('blob:') ||
    s.startsWith('local-resource:') ||
    s.startsWith('uebox-asset:')
  ) {
    return s
  }

  if (s.startsWith('file:') || isProbablyWindowsPath(s)) {
    return toLocalResourceUrl(s) ?? s
  }

  return s
}

async function resolveImageSize(
  src: string,
  timeoutMs = 5000
): Promise<{ width: number; height: number }> {
  return await new Promise((resolve) => {
    const img = new Image()
    let done = false

    const finish = (w?: number, h?: number): void => {
      if (done) return
      done = true
      resolve({
        width: Number.isFinite(w) && (w as number) > 0 ? (w as number) : 1920,
        height: Number.isFinite(h) && (h as number) > 0 ? (h as number) : 1080
      })
    }

    // 轮询 naturalWidth，通常在 onload 之前就能拿到尺寸
    const pollInterval = window.setInterval(() => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        window.clearTimeout(timer)
        window.clearInterval(pollInterval)
        finish(img.naturalWidth, img.naturalHeight)
      }
    }, 10)

    const timer = window.setTimeout(() => {
      window.clearInterval(pollInterval)
      finish()
    }, timeoutMs)

    img.onload = () => {
      window.clearTimeout(timer)
      window.clearInterval(pollInterval)
      finish(img.naturalWidth, img.naturalHeight)
    }
    img.onerror = () => {
      window.clearTimeout(timer)
      window.clearInterval(pollInterval)
      finish()
    }

    img.src = src
  })
}

async function toSlideData(item: ImageViewerItemInput): Promise<SlideData> {
  const src = normalizeSrc(item.src)
  console.log('[ImageViewer] toSlideData - original:', item.src, '-> normalized:', src)
  const msrc = item.msrc ? normalizeSrc(item.msrc) : undefined

  const w = item.width
  const h = item.height
  if (Number.isFinite(w) && Number.isFinite(h) && (w as number) > 0 && (h as number) > 0) {
    return {
      src,
      msrc,
      alt: item.alt,
      width: w,
      height: h
    }
  }

  const size = await resolveImageSize(src)
  console.log('[ImageViewer] resolveImageSize result:', size)
  return {
    src,
    msrc,
    alt: item.alt,
    width: size.width,
    height: size.height
  }
}

export async function openImageViewer(input: OpenImageViewerInput): Promise<void> {
  const items = Array.isArray(input.items) ? input.items : []
  if (items.length === 0) return

  const index = Math.max(0, Math.min(items.length - 1, Number(input.index ?? 0) || 0))

  // 并发预取尺寸，避免打开时布局抖动
  const producers = items.map((it) => () => toSlideData(it))
  const slideData = await runWithConcurrency(producers, 4)

  const lb = ensureLightbox(input.options)
  const ok = lb.loadAndOpen(index, slideData)
  if (!ok) {
    try {
      lb.destroy()
    } catch {
      // ignore
    }
    lightbox = null
    ensureLightbox(input.options).loadAndOpen(index, slideData)
  }
}

export async function openSingleImage(src: string, alt?: string): Promise<void> {
  await openImageViewer({ items: [{ src, alt }], index: 0 })
}
