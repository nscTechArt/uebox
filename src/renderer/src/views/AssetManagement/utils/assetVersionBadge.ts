import { onMounted, onUnmounted, ref, type Ref } from 'vue'

/** 资产卡片上显示引擎版本角标。默认关：大多数库只用一个引擎版本，角标只是噪音 */
export const SHOW_ASSET_VERSION_KEY = 'assetManagement.showAssetVersion'

export function readShowAssetVersion(storage: Pick<Storage, 'getItem'>): boolean {
  return storage.getItem(SHOW_ASSET_VERSION_KEY) === 'true'
}

export function writeShowAssetVersion(value: boolean): void {
  if (value) localStorage.setItem(SHOW_ASSET_VERSION_KEY, 'true')
  else localStorage.removeItem(SHOW_ASSET_VERSION_KEY)
  // 同窗口 setItem 不触发 storage 事件，靠这个自定义事件让资产页即时跟上
  window.dispatchEvent(
    new CustomEvent('local-storage-change', {
      detail: { key: SHOW_ASSET_VERSION_KEY, value: value ? 'true' : null }
    })
  )
}

/** 开关的响应式读数：设置页在同窗口或别的窗口改了，资产页都跟着变 */
export function useShowAssetVersion(): Ref<boolean> {
  const show = ref(readShowAssetVersion(localStorage))
  const sync = (e: Event): void => {
    const key = e instanceof StorageEvent ? e.key : (e as CustomEvent<{ key?: string }>).detail?.key
    if (key === SHOW_ASSET_VERSION_KEY) show.value = readShowAssetVersion(localStorage)
  }
  onMounted(() => {
    window.addEventListener('storage', sync)
    window.addEventListener('local-storage-change', sync)
  })
  onUnmounted(() => {
    window.removeEventListener('storage', sync)
    window.removeEventListener('local-storage-change', sync)
  })
  return show
}
