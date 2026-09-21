import { unwrapResult } from '@renderer/common/utils'
import type { SpotlightAction, SpotlightSearchResult } from '@core/shared/spotlight'

export const spotlightAPI = {
  async search(query: string): Promise<SpotlightSearchResult[]> {
    return unwrapResult(await window.api.spotlight.search(query), '搜索失败')
  },
  execute(action: SpotlightAction, data: Record<string, unknown>): void {
    window.api.spotlight.execute(action, data)
  },
  close(): void {
    window.api.spotlight.close()
  },
  /** `dictate` 为真表示这一次是语音热键唤起的，窗口该直接进听写态 */
  onShow(callback: (payload: { dictate: boolean }) => void): () => void {
    return window.api.spotlight.onShow(callback)
  },
  onHide(callback: () => void): () => void {
    return window.api.spotlight.onHide(callback)
  }
}
