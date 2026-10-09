import { describe, expect, it } from 'vitest'
import { MAIN_STRINGS } from '@core/main/i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

/**
 * 术语守卫。
 *
 * 三份文案来源 —— 渲染层两份语言包与主进程 `MAIN_STRINGS` 的中英两侧 ——
 * 任何一个叶子字符串里出现禁用词，测试就红，并逐条告诉贡献者：哪份文案、
 * 哪个 key、命中了什么、该换成什么。零容忍，不设基线文件。
 *
 * 写这个测试的目的是让贡献者写新文案时不必先读完
 * `CONTEXT.md` 的词汇表 —— 词汇表仍然是对的来源，这里只拦写错的。
 */

/** 一条禁用词：`word` 是要在文案里拦下的写法，`suggestion` 告诉贡献者该换成什么 */
interface BannedTerm {
  word: string
  suggestion: string
}

/**
 * 禁用词表。来源：`CONTEXT.md` 的 _Avoid_，是有意挑选的子集；改这张表时同步 `CONTEXT.md`。
 *
 * Thread、Fork 不入表，只靠词汇表约束 —— UE 与内核语境里有正常用法
 * （Game Thread、内核复制 session 的 fork），入表会把它们一并拦掉。
 *
 * 含汉字的词按子串匹配，有已知的跨词误报：「社会话题」含「会话」、「撤回合并」含「回合」。
 * 碰上时改写那句文案，不用白名单 —— 白名单只放调试台三个 key（08 填入）。
 */
const BANNED_TERMS: BannedTerm[] = [
  // 对话主体
  { word: '聊天', suggestion: '对话' },
  { word: '回合', suggestion: '一轮' },
  { word: '一问一答', suggestion: '一轮' },
  { word: 'exchange', suggestion: 'turn' },
  // 分支
  { word: '会话分支', suggestion: '分支' },
  { word: '对话分支', suggestion: '分支' },
  // 侧边问一句
  { word: '侧边对话', suggestion: '侧边问一句' },
  { word: 'side chat', suggestion: 'side question' }
]

/**
 * 白名单：完整 key → 放行的禁用词条目。按 key 精确匹配，只放行该 key 下列出的条目；
 * 同一个 key 下出现别的禁用词照样命中。放行的词写禁用词表里已有的条目本身，
 * 按条目比较、不按命中原文 —— 放行 "session" 条目，"Session ID" 里的 "Session" 也放行。
 */
const WHITELIST = new Map<string, string[]>()

/** 含汉字的禁用词按子串匹配，其余（拉丁字母的词）按单词边界、不区分大小写 */
const CJK_CHAR = /[一-鿿]/

/** 插值占位符是运行时才填的值，不算文案 —— 先剥掉再匹配（`{session}` 不算命中 session） */
const INTERPOLATION = /\{\w+\}/g

/** 一片叶子字符串：`path` 是文案里的完整 key（数组元素带下标），`text` 是文案本身 */
interface Leaf {
  path: string
  text: string
}

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

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 返回在这段文案里命中的禁用词条目。匹配方式按禁用词本身的写法决定，对所有来源一视同仁 */
function matchTerms(text: string, terms: BannedTerm[]): BannedTerm[] {
  const plain = text.replace(INTERPOLATION, '')
  return terms.filter((term) => {
    if (CJK_CHAR.test(term.word)) return plain.includes(term.word)
    return new RegExp(`\\b${escapeRegExp(term.word)}\\b`, 'i').test(plain)
  })
}

/**
 * 扫一批叶子，返回逐条失败信息（key 路径、命中词、替换建议；来源由调用方拼在前面）。
 * 白名单按完整 key 放行指定条目，放行之外照样报。
 */
function scan(leaves: Leaf[], terms: BannedTerm[], whitelist: Map<string, string[]>): string[] {
  const failures: string[] = []
  for (const leaf of leaves) {
    const allowed = whitelist.get(leaf.path) ?? []
    for (const term of matchTerms(leaf.text, terms)) {
      if (allowed.includes(term.word)) continue
      failures.push(`${leaf.path}：命中「${term.word}」，建议改为「${term.suggestion}」`)
    }
  }
  return failures
}

const SOURCES: Array<{ label: string; pack: unknown }> = [
  { label: 'zh-CN', pack: zhCN },
  { label: 'en-US', pack: enUS },
  { label: 'MAIN_STRINGS["zh-CN"]', pack: MAIN_STRINGS['zh-CN'] },
  { label: 'MAIN_STRINGS["en-US"]', pack: MAIN_STRINGS['en-US'] }
]

describe('术语守卫', () => {
  it('三份文案来源零禁用词', () => {
    const failures: string[] = []
    for (const { label, pack } of SOURCES) {
      for (const line of scan(collectLeaves(pack), BANNED_TERMS, WHITELIST)) {
        failures.push(`${label} ${line}`)
      }
    }
    expect(failures).toEqual([])
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
