/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { helpText, type Lang } from './help.js'

const LANGS: Lang[] = ['zh-CN', 'en-US']


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
  it.each(LANGS)('%s 里没有 Markdown 标记', (lang) => {
    const offenders = helpText(lang)
      .split('\n')
      .filter((line) => line.includes('**') || /(^|\s)`[^`]+`/.test(line))

    expect(offenders).toEqual([])
  })

  /**
   * 80 列。超了会在标准宽度的终端上回绕，把对齐好的两栏拧成一团 ——
   * 那比一开始就不对齐还难读。
   */
  it.each(LANGS)('%s 每行都不超过 80 列', (lang) => {
    const tooWide = helpText(lang)
      .split('\n')
      .map((line, index) => ({ line: index + 1, width: displayWidth(line), text: line }))
      .filter((entry) => entry.width > 80)

    expect(tooWide).toEqual([])
  })

  /**
   * 一层帮助要能在三屏之内读完（30 行的终端）。
   *
   * 包装命令删掉之后选项只剩十来个，才合回一层；这条上限一旦松了，
   * 就该回头看是不是又长出了不该有的命令或选项。
   */
  it.each(LANGS)('%s 控制在 90 行以内', (lang) => {
    expect(helpText(lang).split('\n').length).toBeLessThanOrEqual(90)
  })
})

describe('帮助文本和实现保持同步', () => {
  /**
   * 命令表会漂：加了命令忘了写进帮助，用户就只能靠读源码发现它。
   * 这里把 `cli.ts` 分发到的每条命令都对一遍。
   */
  const COMMANDS = [
    'ask',
    'doctor',
    'projects list',
    'tools list',
    'tools show',
    'tools call',
    'viewport screenshot'
  ]

  it.each(LANGS)('%s 列出了每一条命令', (lang) => {
    const text = helpText(lang)
    expect(COMMANDS.filter((command) => !text.includes(command))).toEqual([])
  })

  /** 选项同理 —— 实现里认的每个 flag 都要能在帮助里查到 */
  const OPTIONS = [
    '--json',
    '--config',
    '--lang',
    '--timeout',
    '--search',
    '--args',
    '--args-file',
    '--project',
    '--name',
    '--output',
    '--world',
    '--overwrite',
    '--allow-write'
  ]

  it.each(LANGS)('%s 列出了每一个选项', (lang) => {
    const text = helpText(lang)
    expect(OPTIONS.filter((option) => !text.includes(option))).toEqual([])
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
