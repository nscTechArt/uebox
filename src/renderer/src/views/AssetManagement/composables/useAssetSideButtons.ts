import { onActivated, onDeactivated, onMounted, onUnmounted, ref, type Ref } from 'vue'

/** KeepAlive pages must release global mouse listeners while hidden. */
export function useAssetSideButtons(
  navigate: (event: MouseEvent) => void,
  onActivate: () => void,
  onDeactivate: () => void
): Ref<boolean> {
  const active = ref(false)
  const handle = (event: MouseEvent): void => {
    if (!active.value || (event.button !== 3 && event.button !== 4)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'mouseup') navigate(event)
  }
  const activate = (): void => {
    if (active.value) return
    active.value = true
    onActivate()
    window.addEventListener('mousedown', handle, true)
    window.addEventListener('mouseup', handle, true)
    window.addEventListener('auxclick', handle, true)
  }
  const deactivate = (): void => {
    if (!active.value) return
    active.value = false
    window.removeEventListener('mousedown', handle, true)
    window.removeEventListener('mouseup', handle, true)
    window.removeEventListener('auxclick', handle, true)
    onDeactivate()
  }
  onMounted(activate)
  onActivated(activate)
  onDeactivated(deactivate)
  onUnmounted(deactivate)
  return active
}
