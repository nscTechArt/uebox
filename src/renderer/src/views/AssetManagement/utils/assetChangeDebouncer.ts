/**
 * 实时变更推送的防抖：一段时间内的多条变更合并成一次刷新。
 *
 * 「有没有文件夹变更」要跨整个防抖窗口累计 —— 只看最后一条的话，先来文件夹、后来资产，
 * 目录树就漏刷了。网络库那边一批变更还会合成一条汇总通知（tableName 取「这批里有没有
 * 文件夹」），这里照样按「窗口内任何一条碰过文件夹」算。
 */
export interface AssetChangeDebouncer {
  push(tableName?: string): void
  cancel(): void
}

export function createAssetChangeDebouncer(
  onFlush: (summary: { touchedFolders: boolean }) => void | Promise<void>,
  delayMs = 500
): AssetChangeDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null
  let touchedFolders = false

  return {
    push(tableName) {
      if (tableName === 'assetFolder') touchedFolders = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const summary = { touchedFolders }
        touchedFolders = false
        timer = null
        void onFlush(summary)
      }, delayMs)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      touchedFolders = false
    }
  }
}
