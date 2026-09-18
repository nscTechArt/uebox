import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it'

import { buildPathLinkHtml, createPathLinkRule, isFilesystemPath } from './markdownPathLinks'

function createRenderer(): MarkdownItInstance {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: true })
  md.core.ruler.push('fs_path_link', createPathLinkRule(buildPathLinkHtml))
  return md
}

function pathsIn(html: string): string[] {
  return Array.from(html.matchAll(/data-fs-path="([^"]*)"/g)).map((m) => m[1])
}

describe('isFilesystemPath', () => {
  it('接受盘符路径与 UNC 网络路径', () => {
    expect(isFilesystemPath('I:/UE Project/SampleProject/说明.html')).toBe(true)
    expect(isFilesystemPath('C:\\Users\\me\\a.txt')).toBe(true)
    expect(isFilesystemPath('\\\\nas\\share\\Content\\a.uasset')).toBe(true)
  })

  it('拒绝相对路径、URL 和过短的片段', () => {
    expect(isFilesystemPath('assets/a.png')).toBe(false)
    expect(isFilesystemPath('https://example.com/a')).toBe(false)
    expect(isFilesystemPath('C:')).toBe(false)
    expect(isFilesystemPath('')).toBe(false)
  })
})

describe('createPathLinkRule', () => {
  it('把反引号里的路径变成链接（带空格也认）', () => {
    const html = createRenderer().render('我已经写到了：`I:/UE Project/SampleProject/说明.html`')
    expect(pathsIn(html)).toEqual(['I:/UE Project/SampleProject/说明.html'])
  })

  it('把裸写在正文里的路径变成链接，并剥掉尾部标点', () => {
    const html = createRenderer().render('文件在 C:\\Users\\me\\a.txt。')
    expect(pathsIn(html)).toEqual(['C:\\Users\\me\\a.txt'])
    expect(html).toContain('。')
  })

  it('认反引号里的 UNC 网络路径', () => {
    const html = createRenderer().render('放在 `\\\\nas\\share\\Content` 里')
    expect(pathsIn(html)).toEqual(['\\\\nas\\share\\Content'])
  })

  it('不动普通文本、代码块和相对路径', () => {
    const html = createRenderer().render('见 assets/a.png 和 README.md\n\n```\nC:\\a\\b.txt\n```')
    expect(pathsIn(html)).toEqual([])
  })

  it('转义路径里的 HTML 特殊字符', () => {
    const html = createRenderer().render('`C:/a<b>/c.txt`')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;')
  })
})
