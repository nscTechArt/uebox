import type { ImportErrorDetails, ImportErrorKey } from '@core/shared/importErrorKey'

/**
 * 主进程回的导入失败码 → 界面文案。形状照 agentControlHandlers.ts 的 describeStartupError。
 *
 * `error` 还是随结果一起回来 —— 模型经 box_manage / 导入任务 errorMessage 读的是它 ——
 * 但界面不该再把那句中文原文塞进外框：认得的码查语言包，英文界面也就有了英文。
 *
 * 这张表是写全的完整 i18n key，不拼字符串 —— 搜得到也测得到。
 * `usedKeyCoverage` 只扫 `t('字面量')`，扫不到这张表，完整性由
 * importErrorText.test.ts 逐个 key 到两份语言包里取值来守。
 */
export const IMPORT_ERROR_COPY: Record<ImportErrorKey, string> = {
  reportMissingImportId: 'assetManagement.import.errors.reportMissingImportId',
  notResumable: 'assetManagement.import.errors.notResumable',
  cancelNotConfirmed: 'assetManagement.import.errors.cancelNotConfirmed',
  serverImportFailed: 'assetManagement.import.errors.serverImportFailed'
}

/**
 * 这次导入失败该跟用户说什么。
 *
 * 认识的码且语言包里真有这句（`t(key) !== key` —— vue-i18n 缺 key 时把 key 原样还回来）
 * 时返回译文，`{status}` 这类参数原样带入；否则退回主进程给的 `error` 原文 —— 难看但
 * 不丢信息；连原文都没有才轮到调用方的 `fallback`。
 */
export function describeImportError(
  error: ImportErrorDetails | null | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
  fallback: string
): string {
  const key = error?.errorKey ? IMPORT_ERROR_COPY[error.errorKey] : undefined
  if (key) {
    const copy = t(key, error?.errorParams)
    if (copy !== key) return copy
  }
  return error?.error || fallback
}
