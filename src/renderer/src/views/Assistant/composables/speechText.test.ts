import { describe, expect, it } from 'vitest'
import { speechText } from './speechText'

describe('speech Markdown cleanup', () => {
  it('reads headings, emphasis, list content and link labels without markup or URLs', () => {
    expect(
      speechText(
        '# 标题\n\n> **重点**与*说明*\n\n- [资料](https://example.com)\n- ~~旧内容~~\n- [x] 完成'
      )
    ).toBe('标题\n重点与说明\n资料\n旧内容\n完成')
  })
  it('retains code content and table cells but removes fences and table separators', () => {
    expect(
      speechText('```cpp\nC++ x = 2 < 3;\n```\n\n| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 2 |')
    ).toBe('C++ x = 2 < 3;\n名称，数量\n苹果，2')
    expect(speechText('`some_name` 和 ![示意图](image.png)')).toBe('some_name 和 示意图')
  })
  it('removes HTML and scripts, decodes entities and handles references', () => {
    expect(
      speechText(
        '<script>alert(1)</script>\n\n正文 <b>加粗</b> &amp; &#20320;&#x597d;\n\n[参考][doc]\n\n[doc]: https://example.com'
      )
    ).toBe('正文 加粗 & 你好\n参考')
    expect(speechText('---\n\n<!-- comment -->')).toBe('')
  })
})
