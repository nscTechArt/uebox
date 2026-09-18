import { computed, onBeforeUnmount, ref, watch, type Ref, type ComputedRef } from 'vue'

interface BrowserPaneResize {
  width: ComputedRef<number | undefined>
  minWidth: ComputedRef<number>
  maxWidth: ComputedRef<number>
  dragging: Ref<boolean>
  start: (event: PointerEvent) => void
  finish: () => void
  reset: () => void
  keydown: (event: KeyboardEvent) => void
}

/** 右侧面板向左拖会变宽；窄窗口下两侧各保留一半，避免挤出横向滚动。 */
export function useBrowserPaneResize(
  pane: Ref<HTMLElement | null>,
  enabled: ComputedRef<boolean>
): BrowserPaneResize {
  const available = ref(0)
  const requested = ref<number | null>(null)
  const dragging = ref(false)
  const minWidth = computed(() => Math.min(360, available.value / 2))
  const maxWidth = computed(() => available.value - minWidth.value)
  const clamp = (value: number): number =>
    Math.round(Math.max(minWidth.value, Math.min(maxWidth.value, value)))
  const width = computed(() =>
    available.value > 0
      ? clamp(requested.value ?? Math.min(available.value * 0.52, 900))
      : undefined
  )
  let observer: ResizeObserver | null = null
  let pointerId: number | null = null
  let startX = 0
  let startWidth = 0
  let originalWidth: number | null = null
  let originalCursor = ''
  let originalSelection = ''

  function move(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return
    requested.value = clamp(startWidth + startX - event.clientX)
  }

  function finish(): void {
    if (!dragging.value) return
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', end)
    document.removeEventListener('pointercancel', end)
    document.removeEventListener('keydown', cancel)
    window.removeEventListener('blur', finish)
    document.body.style.cursor = originalCursor
    document.body.style.userSelect = originalSelection
    pointerId = null
    dragging.value = false
  }

  function end(event: PointerEvent): void {
    if (event.pointerId === pointerId) finish()
  }

  function cancel(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    requested.value = originalWidth
    finish()
  }

  function start(event: PointerEvent): void {
    if (!enabled.value || event.button !== 0 || dragging.value || width.value === undefined) return
    event.preventDefault()
    startX = event.clientX
    startWidth = width.value
    originalWidth = requested.value
    pointerId = event.pointerId
    originalCursor = document.body.style.cursor
    originalSelection = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    dragging.value = true
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', end)
    document.addEventListener('pointercancel', end)
    document.addEventListener('keydown', cancel)
    window.addEventListener('blur', finish)
  }

  function reset(): void {
    finish()
    requested.value = null
  }

  function keydown(event: KeyboardEvent): void {
    if (!enabled.value || dragging.value || width.value === undefined) return
    const values: Partial<Record<string, number>> = {
      ArrowLeft: width.value + 24,
      ArrowRight: width.value - 24,
      Home: minWidth.value,
      End: maxWidth.value
    }
    const next = values[event.key]
    if (next === undefined) return
    event.preventDefault()
    requested.value = clamp(next)
  }

  watch(
    pane,
    (element) => {
      observer?.disconnect()
      const parent = element?.parentElement
      if (!parent) return
      const measure = (): void => {
        available.value = parent.getBoundingClientRect().width
      }
      observer = new ResizeObserver(measure)
      observer.observe(parent)
      measure()
    },
    { flush: 'post' }
  )

  watch(
    enabled,
    (value) => {
      if (!value) finish()
    },
    { flush: 'sync' }
  )
  onBeforeUnmount(() => {
    finish()
    observer?.disconnect()
  })

  return { width, minWidth, maxWidth, dragging, start, finish, reset, keydown }
}
