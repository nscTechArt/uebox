/**
 * 小窗里「自动朗读」开关此刻的值。
 *
 * 小窗是独立的渲染进程，它那份 `aiConfig` store 只在窗口创建时从 localStorage 抄过一次；
 * 用户之后在主窗口设置页拨开关，小窗的 store 一无所知。这里不去改小窗的 store ——
 * store 一动，持久化插件就会把小窗手里那份**陈旧的**整包配置写回 localStorage，
 * 把主窗口刚存的盖掉。只读，读的是主窗口写进去的那一份，靠原生 storage 事件跟着刷新
 * （`useTheme` 用的同一招）。
 */

import { onScopeDispose, ref, type Ref } from 'vue'

import { StorageUtils } from '@renderer/common/utils/storage'

/** 与 `aiConfig` store 的 persist key 一致 */
const STORAGE_KEY = 'ai-config-store'

/** 从 localStorage 直接读一次开关；读不到、解不开一律当关 */
export function readVoiceAutoPlayFlag(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return false
  const parsed = StorageUtils.decrypt<{ config?: { voiceAutoPlayEnabled?: boolean } }>(raw)
  return parsed?.config?.voiceAutoPlayEnabled === true
}

/**
 * 响应式的开关值。首次取当前值；之后别的窗口一改就跟着变。
 * 挂在调用它的组件作用域上，组件卸载时监听器一起撤。
 */
export function useMiniVoiceAutoPlay(): Ref<boolean> {
  const enabled = ref(readVoiceAutoPlayFlag())
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === STORAGE_KEY) enabled.value = readVoiceAutoPlayFlag()
  }
  window.addEventListener('storage', onStorage)
  onScopeDispose(() => window.removeEventListener('storage', onStorage))
  return enabled
}
