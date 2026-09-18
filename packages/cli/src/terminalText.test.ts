/** @vitest-environment node */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * 终端不渲染 Markdown。
 *
 * 这条规矩已经破过八次了 —— 帮助文本四处、`actors list` 的警告两处、
 * 截图的警告两处，全都是从设计文档里搬运的时候连着强调标记一起搬了。
 * 用户看见的就是两个字面的星号。
 *
 * `help.test.ts` 只盯帮助文本，可这些字符串散在各个命令的 `warnings` 和
 * `hint` 里，一样会原样打进终端。所以这里扫的是整个 CLI 的源码：
 * 剥掉注释之后还剩下的 `**`，只可能在一个会打给用户看的字符串里。
 */

const SRC = fileURLToPath(new URL('.', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    // 测试自己不打给用户看；testServer 也不进发布产物
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') && entry !== 'testServer.ts'
      ? [path]
      : []
  })
}

/**
 * 剥掉注释。
 *
 * 注释里写 Markdown 是好事（这个仓库到处都是），要抓的只是**会打出去的
 * 字符串**。剥完之后剩下的 `**` 基本只有两种：字符串里的强调标记，
 * 或者带空格的乘方运算符 —— 后者放过。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('打给用户看的文本里不许有 Markdown', () => {
  const files = sources(SRC)

  it('扫到了源码（防止上面那个遍历悄悄扫了个空）', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(files.map((path) => [path.slice(SRC.length).replace(/\\/g, '/'), path]))(
    '%s 里没有 Markdown 强调',
    (_label, path) => {
      const offenders = stripComments(readFileSync(path, 'utf8'))
        .split('\n')
        .map((line, index) => ({ line: index + 1, text: line.trim() }))
        // ` ** ` 是乘方，不是强调
        .filter((entry) => /\*\*/.test(entry.text) && !/\s\*\*\s/.test(entry.text))

      expect(offenders).toEqual([])
    }
  )
})
