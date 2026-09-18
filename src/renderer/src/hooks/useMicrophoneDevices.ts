import { onMounted, onBeforeUnmount, ref, type Ref } from 'vue'

/** Enumerate quietly on mount; request labels only when the user opens the picker. */
export function useMicrophoneDevices(): {
  devices: Ref<MediaDeviceInfo[]>
  failed: Ref<boolean>
  refresh: (open?: boolean) => Promise<void>
} {
  const devices = ref<MediaDeviceInfo[]>([])
  const failed = ref(false)
  let disposed = false
  let pending = false
  const media = navigator.mediaDevices

  async function refresh(open = false): Promise<void> {
    if (pending || disposed || !media?.enumerateDevices) return
    pending = true
    let stream: MediaStream | undefined
    try {
      let list = await media.enumerateDevices()
      if (open && !list.some((device) => device.kind === 'audioinput' && device.label)) {
        stream = await media.getUserMedia({ audio: true })
        if (disposed) return
        list = await media.enumerateDevices()
      }
      if (!disposed) {
        devices.value = list.filter(
          (device) =>
            device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default'
        )
        failed.value = false
      }
    } catch {
      if (!disposed) failed.value = true
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      pending = false
    }
  }

  const onDeviceChange = (): void => {
    void refresh()
  }
  onMounted(() => {
    void refresh()
    media?.addEventListener?.('devicechange', onDeviceChange)
  })
  onBeforeUnmount(() => {
    disposed = true
    media?.removeEventListener?.('devicechange', onDeviceChange)
  })
  return { devices, failed, refresh }
}
