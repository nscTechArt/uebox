/**
 * 资产锁的界面侧状态。
 *
 * 主进程那份锁表（`main/agent-v3/core/assetLock.ts`）是真相源，这里只负责
 * 把它显示出来，并提供那个**必须存在**的逃生口。
 *
 * ## 为什么冲突提示不走 `agentV3.subscribe`
 *
 * 那个订阅按 sessionId 过滤 —— 而锁冲突恰恰是**跨会话**的事：被挡住的是
 * 会话 A，而用户此刻很可能正看着会话 B。按会话过滤等于把提示发给了
 * 唯一不需要看到它的那个窗口。所以这里直接挂全局事件。
 *
 * ## 为什么要轮询
 *
 * 锁的获取和释放都发生在主进程里（工具执行时、run 结束时），没有对应的
 * 推送事件。为一个指示器加一整套推送通道不划算，而 2 秒一次的轮询在
 * 没有锁的时候也只是一次空查询。
 */

import { onUnmounted, readonly, ref, type Ref } from 'vue'

export interface AssetLock {
  path: string
  connectionId?: string
  /** 持有它的会话 id */
  owner: string
  acquiredAt: number
}

export interface AssetLockConflict {
  path: string
  /** 现在占着它的会话 */
  owner: string
  /** 被挡住的那条会话 */
  requester: string
}

const POLL_INTERVAL_MS = 2000

/** 冲突提示最多留几条 —— 它是提醒，不是日志 */
const MAX_CONFLICTS = 5

export interface UseAssetLocks {
  locks: Readonly<Ref<readonly AssetLock[]>>
  conflicts: Readonly<Ref<readonly AssetLockConflict[]>>
  refresh: () => Promise<void>
  releaseAll: () => Promise<void>
  dismissConflict: (index: number) => void
}

export function useAssetLocks(): UseAssetLocks {
  const locks = ref<AssetLock[]>([])
  const conflicts = ref<AssetLockConflict[]>([])

  const refresh = async (): Promise<void> => {
    try {
      const result = await window.api.agentV3.locks()
      locks.value = result?.locks ?? []
    } catch {
      // 查不到锁不是错误，只是这一次没查到。清空会让指示器闪，
      // 保留上一次的值更接近事实
    }
  }

  const releaseAll = async (): Promise<void> => {
    await window.api.agentV3.releaseAllLocks()
    conflicts.value = []
    await refresh()
  }

  const dismissConflict = (index: number): void => {
    conflicts.value = conflicts.value.filter((_, i) => i !== index)
  }

  const onConflict = (...args: unknown[]): void => {
    const payload = args[0] as AssetLockConflict | undefined
    if (!payload?.path) return
    // 主进程已经按 (会话, 资产) 去过重了，这里只防列表无限长
    conflicts.value = [payload, ...conflicts.value].slice(0, MAX_CONFLICTS)
    void refresh()
  }

  window.api.on('agent-v3:lock-conflict', onConflict)
  const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
  void refresh()

  onUnmounted(() => {
    window.api.off('agent-v3:lock-conflict', onConflict)
    window.clearInterval(timer)
  })

  return {
    locks: readonly(locks) as Readonly<Ref<readonly AssetLock[]>>,
    conflicts: readonly(conflicts) as Readonly<Ref<readonly AssetLockConflict[]>>,
    refresh,
    releaseAll,
    dismissConflict
  }
}
