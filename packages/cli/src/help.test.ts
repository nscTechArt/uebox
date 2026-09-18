/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { helpText, type Lang } from './help.js'

const LANGS: Lang[] = ['zh-CN', 'en-US']

/** 两层帮助的四种组合，硬约束对每一种都成立 */
const VARIANTS: Array<[string, Lang, { all?: boolean }]> = [
  ['zh-CN', 'zh-CN', {}],
  ['zh-CN --all', 'zh-CN', { all: true }],
  ['en-US', 'en-US', {}],
  ['en-US --all', 'en-US', { all: true }]
]

/**
 * 东亚宽字符：中文、假名、谚文、全角标点，一个占 2 列。
 *
 * 范围写成转义序列而不是字面量 —— 里面有全角空格（U+3000），直接写进正则
 * 既会被 eslint 的 no-irregular-whitespace 挡下，肉眼也分辨不出来。
 */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/

/**
 * 「歧义宽度」字符按 2 列算，其中最要紧的是破折号 —— 这份帮助里到处都是。
 *
 * 这类字符在西文终端占 1 列、在中文终端占 2 列。按 1 算，一条中文行就会在
 * 中文终端上悄悄超宽 —— 而那正是这份帮助的读者最可能用的终端。往宽了算才安全。
 */
const AMBIGUOUS = /[‐-‧‰-⁞¡§«°-·Ⅰ-Ⅻ]/

function displayWidth(text: string): number {
  return [...text].reduce((sum, char) => sum + (WIDE.test(char) || AMBIGUOUS.test(char) ? 2 : 1), 0)
}

describe('帮助文本的硬约束', () => {
  /**
   * 终端不渲染 Markdown —— 写了 `**` 用户就真的看见两个星号。
   *
   * 这条曾经破过：三段说明是从设计文档里整段搬过来的，连着强调标记一起搬了。
   */
  it.each(VARIANTS)('%s 里没有 Markdown 标记', (_label, lang, options) => {
    const offenders = helpText(lang, options)
      .split('\n')
      .filter((line) => line.includes('**') || /(^|\s)`[^`]+`/.test(line))

    expect(offenders).toEqual([])
  })

  /**
   * 80 列。超了会在标准宽度的终端上回绕，把对齐好的两栏拧成一团 ——
   * 那比一开始就不对齐还难读。
   */
  it.each(VARIANTS)('%s 每行都不超过 80 列', (_label, lang, options) => {
    const tooWide = helpText(lang, options)
      .split('\n')
      .map((line, index) => ({ line: index + 1, width: displayWidth(line), text: line }))
      .filter((entry) => entry.width > 80)

    expect(tooWide).toEqual([])
  })

  /**
   * 默认那份要能在两屏之内读完。
   *
   * 加上写操作之后完整帮助有一百一十多行，在 30 行的终端上是四屏，而最要紧的
   * 东西恰好在最底下。分层就是为了这个 —— 所以这条限制只管默认那份，
   * 它一旦松了，分层也就白做了。
   */
  it.each(LANGS)('%s 默认帮助控制在 72 行以内', (lang) => {
    // 72 而不是 70：英文讲同样的内容就是要多一两行，那是语言密度差。
    // 卡到中文那个数只能靠在英文里少说点，那是拿排版去换内容
    expect(helpText(lang).split('\n').length).toBeLessThanOrEqual(72)
  })

  /** --all 那份不设上限，但也不该无限长 */
  it.each(LANGS)('%s --all 控制在 130 行以内', (lang) => {
    expect(helpText(lang, { all: true }).split('\n').length).toBeLessThanOrEqual(130)
  })

  /** 分层不是删内容：短的那份必须告诉用户还有更多，以及怎么看 */
  it.each(LANGS)('%s 默认帮助指出了 --help --all', (lang) => {
    expect(helpText(lang)).toContain('uebox --help --all')
  })
})

describe('帮助文本和实现保持同步', () => {
  /**
   * 命令表会漂：加了命令忘了写进帮助，用户就只能靠读源码发现它。
   * 这里把 `cli.ts` 分发到的每条命令都对一遍。
   */
  const COMMANDS = [
    'setup',
    'doctor',
    'projects list',
    'tools list',
    'tools show',
    'tools call',
    'selection get',
    'actors list',
    'actors spawn',
    'actors move',
    'actors delete',
    'actors undo',
    'viewport screenshot'
  ]

  /** 命令表在默认那份里就要全 —— 一条命令查不到，等于它不存在 */
  it.each(LANGS)('%s 默认帮助就列出了每一条命令', (lang) => {
    const text = helpText(lang)
    expect(COMMANDS.filter((command) => !text.includes(command))).toEqual([])
  })

  /** 选项同理 —— 实现里认的每个 flag 都要能在帮助里查到 */
  const OPTIONS = [
    '--json',
    '--config',
    '--lang',
    '--timeout',
    '--host-config',
    '--search',
    '--args',
    '--args-file',
    '--project',
    '--name',
    '--limit',
    '--include-system',
    '--output',
    '--world',
    '--overwrite',
    '--allow-write',
    '--asset',
    '--location',
    '--rotation',
    '--scale'
  ]

  /** 专属选项在 --all 那份里，但一个都不能少 */
  it.each(LANGS)('%s --all 列出了每一个选项', (lang) => {
    const text = helpText(lang, { all: true })
    expect(OPTIONS.filter((option) => !text.includes(option))).toEqual([])
  })

  /** 写操作是安全边界，光在 --all 里说不够，默认那份也得提到 */
  it.each(LANGS)('%s 默认帮助就写明了 --allow-write', (lang) => {
    expect(helpText(lang)).toContain('--allow-write')
  })

  /**
   * 退出码是给脚本用的接口。漏掉一个，调用方就会撞上一个帮助里查不到的码，
   * 只能去猜它是什么意思。
   */
  it.each(LANGS)('%s 把每个退出码都解释了', (lang) => {
    const text = helpText(lang)
    const missing = [0, 2, 3, 4, 5, 6, 7, 8, 130].filter(
      (code) => !new RegExp(`^ {2}${code} `, 'm').test(text)
    )

    expect(missing).toEqual([])
  })

  /**
   * 1 永远不会出现（`toUeboxError` 兜住了所有异常）。明说这件事，
   * 脚本作者才知道真收到 1 意味着别的事故，而不是某个没写进文档的失败。
   */
  it.each(LANGS)('%s 说明了 1 不会出现', (lang) => {
    expect(helpText(lang)).toMatch(/不会返回 1|1 is never returned/)
  })
})

describe('例子必须是能照抄的', () => {
  /**
   * 实测过（PowerShell 5.1 / cmd.exe）：两个 shell 都会把裸 JSON 里的双引号
   * 吃掉 —— `--args '{"k":"v"}'` 传到进程里变成 `{k:v}`，然后报一个
   * 「不是合法 JSON」的错，而用户看着自己写的明明是合法 JSON。
   *
   * 所以两个 shell 各自验证过的转义形式都得给全。
   */
  it.each(LANGS)('%s 给了两个 shell 各自验证过的 --args 转义', (lang) => {
    const text = helpText(lang)

    expect(text).toContain(String.raw`--args '{\"name\":\"Floor\"}'`)
    expect(text).toContain('--args "{""name"":""Floor""}"')
  })

  /** 转义太绕的时候有出路，而且这条出路本身要出现在例子里 */
  it.each(LANGS)('%s 指出了 --args-file 这条不用转义的路', (lang) => {
    expect(helpText(lang)).toContain('--args-file args.json')
  })
})
