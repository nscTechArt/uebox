/**
 * 「一篇最多读几张图」的取值规则。
 *
 * 单独放在 shared 是因为两边都要它：设置页要用同一个范围画输入框，主进程读设置时
 * 要用同一套收敛规则。各写一份的话，界面允许填 50、后台按 20 截，用户看不出为什么。
 *
 * **这个数不写死。** 读几张只有用户自己知道 —— 他订阅的是哪家模型、一张多少钱、
 * 他这批资料图多不多，我们都不知道。下面的上下限不是产品判断，只是挡手滑：
 * 填 0 等于开了个不干活的开关，填四位数是一次导入几千次付费调用。
 */

/** 出厂默认。一篇公众号大半是装饰图，六张通常够覆盖真正带信息的那几张 */
export const DEFAULT_IMAGE_READ_MAX = 6

export const MIN_IMAGES_PER_SOURCE = 1
export const MAX_IMAGES_PER_SOURCE = 50

/**
 * 把用户填的张数收进合法范围。没设过或者填了非数字，按出厂默认走。
 *
 * 「没设过」要单独判：`Number(null)` 和 `Number('')` 都是 0，跟着走 clamp 会变成 1 ——
 * 于是一个从没动过这项设置的用户，每篇只会被读一张图，而界面上显示的是 6。
 */
export function normalizeMaxImages(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_IMAGE_READ_MAX

  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return DEFAULT_IMAGE_READ_MAX
  return Math.min(MAX_IMAGES_PER_SOURCE, Math.max(MIN_IMAGES_PER_SOURCE, parsed))
}
