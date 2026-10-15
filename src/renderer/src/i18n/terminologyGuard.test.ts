import { describe, expect, it } from 'vitest'
import { MAIN_STRINGS } from '@core/main/i18n'
import { BANNED_TERMS, scan, type BannedTerm, type Leaf } from '@core/shared/terminologyGuard'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

/**
 * 术语守卫。
 *
 * 三份文案来源文件 —— 渲染层两份语言包与主进程 `MAIN_STRINGS` —— 的中英两侧：
 * 任何一个叶子字符串里出现禁用词，测试就红，并逐条告诉贡献者：哪份文案、
 * 哪个 key、命中了什么、该换成什么。零容忍，不设基线文件。
 *
 * 写这个测试的目的是让贡献者写新文案时不必先读完
 * `CONTEXT.md` 的词汇表 —— 词汇表仍然是对的来源，这里只拦写错的。
 *
 * 失败信息只给替换写法。确有改写不了的正当用法时，加进白名单放行 ——
 * 每条必须在条目旁写清理由，由评审把关。
 */

/**
 * 白名单：完整 key → 放行的禁用词条目。按 key 精确匹配，只放行该 key 下列出的条目；
 * 同一个 key 下出现别的禁用词照样命中。放行的词写禁用词表里已有的条目本身，
 * 按条目比较、不按命中原文 —— 放行 "session" 条目，"Session ID" 里的 "Session" 也放行。
 *
 * 可以加条目：改写不掉的正当用法（引擎界面名、外部协议名）就加，每条把
 * 理由写在条目旁的注释里 —— 没有理由的条目评审不放行。现有三条都是调试台。
 * key 路径不含来源，所以两份语言包（以及将来的主进程同名 key）都适用。
 */
const WHITELIST = new Map<string, string[]>([
  // 调试台说的是内核那一层，session 按术语表不翻译
  ['agentV3Debug.sessionId', ['session']],
  ['agentV3Debug.approveAlways', ['session']],
  ['agentV3Debug.newSession', ['session']]
])

/**
 * 收集全部叶子字符串。数组元素也是叶子，路径带下标（如 `assistant.contextChips.default[0]`）——
 * 不能照抄 `criticalPathCoverage.test.ts` 的 `collectLeafPaths`：它把整个数组当一片叶子、
 * 再按非字符串跳过，照抄会漏掉数组。
 */
function collectLeaves(value: unknown, prefix = '', out: Leaf[] = []): Leaf[] {
  if (typeof value === 'string') {
    out.push({ path: prefix, text: value })
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectLeaves(item, `${prefix}[${index}]`, out))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectLeaves(item, prefix ? `${prefix}.${key}` : key, out)
    }
  }
  return out
}

const SOURCES: Array<{ label: string; pack: unknown }> = [
  { label: 'zh-CN', pack: zhCN },
  { label: 'en-US', pack: enUS },
  { label: 'MAIN_STRINGS["zh-CN"]', pack: MAIN_STRINGS['zh-CN'] },
  { label: 'MAIN_STRINGS["en-US"]', pack: MAIN_STRINGS['en-US'] }
]

describe('术语守卫', () => {
  it('每个来源都扫到了文案，来源改名或变空时立刻发现', () => {
    for (const { label, pack } of SOURCES) {
      expect(collectLeaves(pack).length, label).toBeGreaterThan(0)
    }
  })

  it('三份文案来源零禁用词', () => {
    const failures: string[] = []
    for (const { label, pack } of SOURCES) {
      for (const line of scan(collectLeaves(pack), BANNED_TERMS, WHITELIST)) {
        failures.push(`${label} ${line}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('session、sessions 的替换建议按意思列全：chat、sign-in、import', () => {
    for (const word of ['session', 'sessions']) {
      const suggestion = BANNED_TERMS.find((term) => term.word === word)?.suggestion ?? ''
      for (const expected of ['chat', 'sign-in', 'import']) {
        expect(suggestion).toContain(expected)
      }
    }
  })
})

describe('术语守卫 · 匹配规则自证', () => {
  // 临时词表，只为自证匹配规则，与真实的 BANNED_TERMS 无关
  const TERMS: BannedTerm[] = [
    { word: 'session', suggestion: 'chat' },
    { word: 'sessions', suggestion: 'chat' },
    { word: '会话', suggestion: '对话' }
  ]
  const NO_WHITELIST = new Map<string, string[]>()
  // 白名单只放行该 key 下写明的条目；三条用例共用同一个白名单
  const DEBUG_SESSION_WHITELIST = new Map([['agentV3Debug.sessionId', ['session']]])

  it('拉丁词按单词边界、不区分大小写："New session" 命中', () => {
    expect(scan([{ path: 'a', text: 'New session' }], TERMS, NO_WHITELIST)).toEqual([
      'a：命中「session」，建议改为「chat」'
    ])
  })

  it('含汉字的词按子串匹配：「新会话」命中', () => {
    expect(scan([{ path: 'a', text: '新会话' }], TERMS, NO_WHITELIST)).toEqual([
      'a：命中「会话」，建议改为「对话」'
    ])
  })

  it('单词边界跨连字符："mid-session" 命中', () => {
    expect(scan([{ path: 'a', text: 'mid-session' }], TERMS, NO_WHITELIST)).toEqual([
      'a：命中「session」，建议改为「chat」'
    ])
  })

  it('数组元素也扫到，报出的路径带下标', () => {
    const leaves = collectLeaves({ list: ['继续这个话题', 'New session'] })
    expect(leaves.map((leaf) => leaf.path)).toEqual(['list[0]', 'list[1]'])
    expect(scan(leaves, TERMS, NO_WHITELIST)).toEqual([
      'list[1]：命中「session」，建议改为「chat」'
    ])
  })

  it('插值占位符先剥掉：{session} 不命中', () => {
    expect(scan([{ path: 'a', text: '{session}' }], TERMS, NO_WHITELIST)).toEqual([])
  })

  it('白名单按条目放行：放行 "session"，原文 "Session" 也不命中', () => {
    expect(
      scan([{ path: 'agentV3Debug.sessionId', text: 'Session ID' }], TERMS, DEBUG_SESSION_WHITELIST)
    ).toEqual([])
  })

  it('白名单放行只对列出的条目生效：同一个 key 下别的禁用词照样命中', () => {
    expect(
      scan([{ path: 'agentV3Debug.sessionId', text: '新会话' }], TERMS, DEBUG_SESSION_WHITELIST)
    ).toEqual(['agentV3Debug.sessionId：命中「会话」，建议改为「对话」'])
  })

  it('白名单按完整 key 匹配：同一个词换到别的 key 命中', () => {
    expect(
      scan([{ path: 'menu.newChat', text: 'New session' }], TERMS, DEBUG_SESSION_WHITELIST)
    ).toEqual(['menu.newChat：命中「session」，建议改为「chat」'])
  })
})
