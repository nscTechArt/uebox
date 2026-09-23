/**
 * 创作者 Token Plan IPC 的渲染层封装。
 *
 * 和 updater.ts 同一个理由不用 unwrapResult：这些都是用户点一下的动作（连接、应用、
 * 断开），调用方要按错误码各自提示，抛出去反而逼每个调用点再包一层 try。
 * 这一层统一的是桥的存在性和返回值形状。
 */

import type { ModelRole } from '@core/shared/aiProvider'
import type {
  CreatorPlanDevicePrompt,
  CreatorPlanDisconnectResult,
  CreatorPlanPreview,
  CreatorPlanResult,
  CreatorPlanState
} from '@core/shared/creatorPlan'

function bridge(): Window['api']['creatorPlan'] | null {
  return window.api?.creatorPlan ?? null
}

const missing = { ok: false, code: 'unknown', error: 'creatorPlan bridge unavailable' } as const

async function call<T>(
  run: (api: Window['api']['creatorPlan']) => Promise<CreatorPlanResult<T>>
): Promise<CreatorPlanResult<T>> {
  const api = bridge()
  if (!api) return missing
  try {
    return await run(api)
  } catch (error) {
    return {
      ok: false,
      code: 'unknown',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export const creatorPlanAPI = {
  state: () => call<CreatorPlanState>((api) => api.state()),
  connect: () => call<CreatorPlanPreview>((api) => api.connect()),
  preview: () => call<CreatorPlanPreview>((api) => api.preview()),
  apply: (roles: ModelRole[]) => call<CreatorPlanState>((api) => api.apply([...roles])),
  disconnect: () => call<CreatorPlanDisconnectResult>((api) => api.disconnect()),
  /** 对话里套餐错误提示上的「管理订阅」：主进程用缓存的清单地址打开，不发请求 */
  openManage: async (): Promise<void> => {
    await bridge()?.openManage()
  },
  cancel: async (): Promise<void> => {
    await bridge()?.cancel()
  },
  onDeviceCode: (listener: (prompt: CreatorPlanDevicePrompt) => void): (() => void) =>
    bridge()?.onDeviceCode(listener) ?? (() => {})
}
