import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

/**
 * 语言包一致性守卫。
 *
 * 缺 key 时 vue-i18n 会回落到另一侧：中文用户看到英文、英文用户看到中文，
 * 而且不报错。全量抽 key 不在本期范围内（仍有大量 .vue 硬编码中文），
 * 所以这里守两条能自动判定、不需要人工维护清单的规则：
 *
 *   1. 两侧的顶层块必须一一对应 —— 少一块就是整片文案没翻译
 *   2. 英文包里不得残留中文字符 —— 典型是复制粘贴后忘了翻
 *
 * 原先这里维护的是一份写死的「海外必经路径」key 清单（登录、订阅、付款、授权），
 * 那些键随商业账户面一起移出了公开仓库，清单也就跟着走了。
 */

/** 取嵌套 key，取不到返回 undefined */
function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part]
    }
    return undefined
  }, obj)
}

const CHINESE_CHAR = /[一-鿿]/

/**
 * 允许在英文包里出现中文的键。
 *
 * 语言选择器里各语言用**自称**显示（中文条目就该写「中文（简体）」），
 * 这是有意为之，不是漏翻。
 */
const CHINESE_ALLOWED_IN_EN = new Set(['profile.appearance.languageZhCN'])

/** 收集所有叶子路径 */
function collectLeafPaths(obj: unknown, prefix = '', out: string[] = []): string[] {
  if (typeof obj !== 'object' || obj === null) return out
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      collectLeafPaths(value, path, out)
    } else {
      out.push(path)
    }
  }
  return out
}

describe('语言包一致性', () => {
  it('新对话按钮使用约定文案', () => {
    expect(zhCN.menu.newChat).toBe('新对话')
  })

  it('@ 提及来源按字面量渲染，不触发 linked message 编译错误', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'zh-CN',
      messages: { 'zh-CN': zhCN, 'en-US': enUS }
    })

    expect(i18n.global.t('assistantInputComposer.atMentionTooltip')).toBe('@ 提及来源')
    i18n.global.locale.value = 'en-US'
    expect(i18n.global.t('assistantInputComposer.atMentionTooltip')).toBe('@ Mention a source')
  })

  it('主题只有跟随系统 / 浅色 / 深色三个选项', () => {
    // 以前这里是八个配色预设（暮影、深蓝、墨绿、黑灰、极光、黑洞……），
    // 它们走的是 data-color-theme，跟 data-theme 那套深浅色是两套并行的机制，
    // 同时改颜色、谁赢取决于 CSS 里谁写在后面。现在只留一套。
    //
    // 键从 profile.general 挪到了 profile.appearance —— 外观与语言从常规设置里
    // 提成了独立一页，文案跟着走
    expect(zhCN.profile.appearance.themeSystem).toBe('跟随系统')
    expect(zhCN.profile.appearance.themeLight).toBe('浅色')
    expect(zhCN.profile.appearance.themeDark).toBe('深色')
    expect(enUS.profile.appearance.themeSystem).toBe('Match system')

    for (const key of Object.keys(zhCN.profile.appearance)) {
      expect(key).not.toMatch(
        /^theme(Default|Night|Ink|DeepBlue|MossGreen|Charcoal|Aurora|BlackHole)$/
      )
    }
  })

  it('两侧顶层块一一对应', () => {
    const zhTop = Object.keys(zhCN).sort()
    const enTop = Object.keys(enUS).sort()

    expect(enTop).toEqual(zhTop)
  })

  it('英文包不得残留中文字符', () => {
    const leaked = collectLeafPaths(enUS).filter((path) => {
      if (CHINESE_ALLOWED_IN_EN.has(path)) return false
      const value = get(enUS, path)
      return typeof value === 'string' && CHINESE_CHAR.test(value)
    })

    expect(leaked).toEqual([])
  })

  it('带插值的文案两侧占位符一致', () => {
    // 占位符对不上会让某一侧渲染出字面量 {days}，是典型的翻译事故
    const zhPaths = collectLeafPaths(zhCN)
    const mismatched: string[] = []

    for (const path of zhPaths) {
      const zhValue = get(zhCN, path)
      const enValue = get(enUS, path)
      if (typeof zhValue !== 'string' || typeof enValue !== 'string') continue

      // 比的是「用到了哪些占位符」，不是出现次数 ——
      // 同一个 {limit} 中文里出现两次、英文一次，属于行文差异不是事故
      const zhSlots = new Set(zhValue.match(/\{(\w+)\}/g) || [])
      const enSlots = new Set(enValue.match(/\{(\w+)\}/g) || [])
      const missing = [...zhSlots].filter((slot) => !enSlots.has(slot))
      const extra = [...enSlots].filter((slot) => !zhSlots.has(slot))
      if (missing.length > 0 || extra.length > 0) mismatched.push(path)
    }

    expect(mismatched).toEqual([])
  })
})
