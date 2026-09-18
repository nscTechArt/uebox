/**
 * 「测试连接」「导入模型」失败时跟用户说什么。
 *
 * ## 为什么文案在这一侧
 *
 * 主进程原来直接返回成品中文（`main/ai/probe.ts` 的 `describeProbeError`）。
 * 于是英文用户在设置页点「测试连接」，拿到的是一整句中文 —— 而这恰恰是他最
 * 需要读懂的一句话：密钥对不对、地址通不通、协议选没选错，全看它。
 *
 * 现在主进程只回一个码（外加少数分支必须让用户看见的厂商原文），
 * 文案在这里查语言包。这是 AGENTS 里「主进程只回错误码 + 参数，渲染层查 i18n」
 * 那条的第一处落地。
 *
 * ## 为什么有些分支要带原文
 *
 * 5xx 的服务端错误码、400 的拒绝理由、以及归不上类的，翻译过去仍然说不清 ——
 * 那几句里真正有用的信息在厂商的原话里。把它截断附在后面，比替用户猜一个
 * 原因要诚实。
 */
import type { ProbeFailure } from '@core/shared/aiProvider'
import i18n from '@renderer/i18n'

/** 带原文的那几种：光有文案说不清，必须让用户看见厂商原话 */
const WITH_RAW = new Set(['providerServerError', 'badRequest', 'listHttpError'])

export function describeProbeFailure(failure: ProbeFailure | string | null | undefined): string {
  const { t } = i18n.global

  if (!failure) return t('aiProvider.probe.unknown')
  // 老形状兜底：万一哪条路还在回字符串，原样显示总比显示 `[object Object]` 强
  if (typeof failure === 'string') return failure

  /*
   * `unknown` 带着原文时，**只显示原文**。
   *
   * 这一档的整个内容就是原文：`probe.ts` 归不上类时回 `raw.slice(0,300)`，
   * `ipc.ts` 的 `failProbe()` 把任何抛出来的异常都塞进 raw（没有安全存储时的
   * `EncryptionUnavailableError` 就走这条）。而它配的文案是「厂商没有给出原因」——
   * 拼在一起会变成一句自相矛盾的话：先说没给原因，后面紧跟着原因。
   *
   * 改动之前 `describeProbeError` 就是直接 `return raw.slice(0, 300)`，
   * 这里恢复的是同一个行为。
   */
  if (failure.code === 'unknown' && failure.raw) return failure.raw

  const key = `aiProvider.probe.${failure.code}`
  const copy = t(key)
  // 查不到就退回原文 —— 新增了码却忘了配文案时，用户读到的是英文原始错误，
  // 而不是一个 `aiProvider.probe.somethingNew` 这样的 key
  if (copy === key) return failure.raw || t('aiProvider.probe.unknown')

  if (failure.raw && WITH_RAW.has(failure.code)) {
    return `${copy}${t('aiProvider.probe.rawSuffix', { raw: failure.raw })}`
  }
  return copy
}
