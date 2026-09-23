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
  },
  /** 语音热键还按着。每次键盘自动重复来一下，约 31ms 一次 */
  onHold(callback: () => void): () => void {
    return window.api.spotlight.onHold(callback)
  },
  /** 真收到了 keyup：这一次按住结束，下一次按下是新的一轮 */
  holdReleased(): void {
    window.api.spotlight.holdReleased()
  }
}
