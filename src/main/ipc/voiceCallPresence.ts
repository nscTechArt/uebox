/**
 * 「哪个窗口在通话」。
 *
 * 通话是全局一路（`realtimeVoice.ts` 的 `active`），但可以开在主窗口、也可以开在
 * 独立对话窗口里。每个窗口要知道的是**别的窗口**在不在通话 —— 别人在通话时自己不能
 * 自动朗读（会念进对方开着的麦克风），而自己在不在通话它自己最清楚。
 *
 * 原来只广播一个布尔值，谁报的都一样。两个窗口一交接就错：小窗开口把主窗口那路抢过来，
 * 主窗口随后报一句「我挂了」，广播出去的「没人在通话」会把小窗也一起标成没在通话。
 * 按窗口记，各自只撤自己的。
 */
export class VoiceCallPresence {
  private readonly inCall = new Set<number>()

  /** 这个窗口报上来它的通话状态。返回是否有变化 */
  set(webContentsId: number, active: boolean): boolean {
    if (active === this.inCall.has(webContentsId)) return false
    if (active) this.inCall.add(webContentsId)
    else this.inCall.delete(webContentsId)
    return true
  }

  /** 窗口没了：它那份通话状态一起撤掉 */
  remove(webContentsId: number): boolean {
    return this.inCall.delete(webContentsId)
  }

  /** 对这个窗口来说，别的窗口有没有在通话 */
  activeElsewhere(webContentsId: number): boolean {
    for (const id of this.inCall) if (id !== webContentsId) return true
    return false
  }
}
