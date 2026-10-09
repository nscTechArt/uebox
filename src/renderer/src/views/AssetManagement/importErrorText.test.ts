import { describe, expect, it } from 'vitest'
import type { ImportErrorKey } from '@core/shared/importErrorKey'
import zhCN from '../../i18n/locales/zh-CN'
import enUS from '../../i18n/locales/en-US'
import { describeImportError, IMPORT_ERROR_COPY } from './importErrorText'

/**
 * 到语言包里按点分路径取值；取不到就照 vue-i18n 缺 key 的行为把 key 原样还回去，
 * 这样「语言包缺 key → 退回原文」这条路在测试里走得通。
 */
const translate =
  (pack: unknown) =>
  (key: string, params?: Record<string, unknown>): string => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (acc, part) =>
          acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined,
        pack
      )
    if (typeof value !== 'string') return key
    return value.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? `{${name}}`))
  }

const zh = translate(zhCN)
const en = translate(enUS)

describe('describeImportError', () => {
  it('key 表里每个值在 zh-CN、en-US 都取得到字符串', () => {
    // usedKeyCoverage 只扫 t('字面量')，扫不到这张表 —— 完整性在这里守
    for (const i18nKey of Object.values(IMPORT_ERROR_COPY)) {
      expect(zh(i18nKey)).not.toBe(i18nKey)
      expect(en(i18nKey)).not.toBe(i18nKey)
    }
  })

  it('认识的 key 出译文，并把服务器状态原样带进去', () => {
    const payload = {
      error: '这次导入在服务器上的状态是 failed_recoverable，不能继续',
      errorKey: 'notResumable' as ImportErrorKey,
      errorParams: { status: 'failed_recoverable' }
    }
    expect(describeImportError(payload, zh, '兜底')).toBe(
      '这次导入在服务器上已经不能继续（服务器状态：failed_recoverable）'
    )
    expect(describeImportError(payload, en, 'fallback')).toBe(
      'This import can no longer be resumed on the server (server status: failed_recoverable).'
    )
  })

  it('不认识的 key 退回 error 原文', () => {
    expect(
      describeImportError(
        { error: '服务器回的原文', errorKey: 'not-yet-known' as ImportErrorKey },
        zh,
        '兜底'
      )
    ).toBe('服务器回的原文')
  })

  it('语言包缺这句（t 把 key 原样还回来）也退回 error 原文', () => {
    const missing = (key: string): string => key
    expect(
      describeImportError({ error: '服务器回的原文', errorKey: 'notResumable' }, missing, '兜底')
    ).toBe('服务器回的原文')
  })

  it('key 和 error 都没有时退回 fallback', () => {
    expect(describeImportError({ errorKey: 'notResumable' }, (key: string) => key, '兜底')).toBe(
      '兜底'
    )
    expect(describeImportError({}, zh, '兜底')).toBe('兜底')
    expect(describeImportError(undefined, zh, '兜底')).toBe('兜底')
  })
})
