import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

function get(pack: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  }, pack)
}

describe('设置文案的实际显示', () => {
  it('侧边栏和页标题的间接翻译键在两种语言中都存在', () => {
    // t(header.titleKey) 和 $t(item.labelKey) 不在字面量 t() 扫描范围内。
    const keys = new Set<string>()
    for (const file of [
      'src/renderer/src/views/System/Preferences/index.vue',
      'src/renderer/src/views/System/Preferences/components/PreferencesSidebar.vue'
    ]) {
      const source = readFileSync(resolve(file), 'utf8')
      for (const match of source.matchAll(/(?:titleKey|descKey|labelKey):\s*'([^']+)'/g)) {
        keys.add(match[1])
      }
    }
    expect(keys.size).toBeGreaterThan(30)
    for (const pack of [zhCN, enUS]) {
      for (const key of keys) {
        expect(get(pack, key), key).toBeTypeOf('string')
        expect(get(pack, key), key).not.toBe('')
      }
    }
  })

  it.each(['zh-CN', 'en-US'] as const)('配色提示无需比值参数即可完整显示：%s', (locale) => {
    const i18n = createI18n({
      legacy: false,
      locale,
      messages: { 'zh-CN': zhCN, 'en-US': enUS }
    })
    for (const suffix of [
      'customThemeReady',
      'customThemeTextContrast',
      'customThemeAccentContrast',
      'customThemeAccentTextContrast',
      'customThemeInvalidBackground',
      'customThemeInvalidForeground',
      'customThemeInvalidAccent'
    ]) {
      const key = `profile.appearance.${suffix}`
      const raw = get(locale === 'zh-CN' ? zhCN : enUS, key)
      expect(raw).not.toMatch(/\{ratio\}|:1/)
      expect(i18n.global.t(key)).toBe(raw)
    }
  })

  it('普通模型说明不携带纯文本页面无法解析的 Markdown', () => {
    for (const pack of [zhCN, enUS]) {
      for (const [key, value] of Object.entries(pack.aiProvider.roles)) {
        if (/Desc$|More$/.test(key)) expect(value, key).not.toContain('**')
      }
    }
  })

  it('已移除入口的死文案已清理，实际使用的命名规则仍保留', () => {
    for (const pack of [zhCN, enUS]) {
      for (const key of [
        'profile.ai.miniChatPersist',
        'profile.ai.miniChatPersistDesc',
        'profile.ai.miniChatOpacity',
        'profile.ai.miniChatOpacityDesc',
        'profile.namingRules.preview',
        'profile.namingRules.importExport',
        'profile.notebook.recallDistanceThreshold',
        'profileAssetSettings.importConcurrency'
      ]) {
        expect(get(pack, key), key).toBeUndefined()
      }
      expect(pack.profile.namingRules.customRules.title).toBeTruthy()
    }
  })
})
