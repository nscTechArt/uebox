// @vitest-environment jsdom
//
// 这个文件必须跑在 jsdom 上，不能用仓库默认的 happy-dom。
//
// happy-dom 的 DOM 实现喂不饱 DOMPurify：把一段 `<h2>t</h2>` 交给它消毒，
// 回来的是光秃秃的 `t` —— 标签被整个吃掉，`<img>` 同理。也就是说在 happy-dom
// 上写这组断言，测的不是消毒逻辑，是 happy-dom 的缺陷。
// 真实环境（Electron 的 Chromium 渲染层）与 jsdom 的行为才是一致的。

import { describe, expect, it } from 'vitest'
import { sanitizeRenderedHtml } from './sanitizeHtml'

/**
 * 两个 markdown 渲染器都开着 `html: true`，而喂进去的内容来自网页抓取、
 * 模型输出、导入的笔记 —— 都不可信。CSP 已经挡住脚本执行，这一层是纵深：
 * 摘掉危险构造，同时**不能**误伤渲染器自己生成的结构。
 */
describe('sanitizeRenderedHtml', () => {
  it('摘掉 script', () => {
    expect(sanitizeRenderedHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>')
  })

  it('摘掉内联事件处理器', () => {
    const out = sanitizeRenderedHtml('<img src="x" onerror="alert(1)">')
    expect(out).not.toContain('onerror')
  })

  it('摘掉 javascript: 链接', () => {
    const out = sanitizeRenderedHtml('<a href="javascript:alert(1)">go</a>')
    expect(out).not.toContain('javascript:')
  })

  it('摘掉 iframe 与 object', () => {
    const out = sanitizeRenderedHtml(
      '<iframe src="https://evil.example"></iframe><object></object>'
    )
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<object')
  })

  /**
   * 这几条守的是「别把功能洗没了」：
   * 代码块的复制按钮靠 data-target 找目标，图片预览靠 class 命中。
   */
  it('保留代码块复制按钮的 data-target 与 class', () => {
    const html = '<div class="code-block"><button class="copy" data-target="c1">复制</button></div>'
    const out = sanitizeRenderedHtml(html)
    expect(out).toContain('data-target="c1"')
    expect(out).toContain('class="copy"')
  })

  it('保留路径链接的 data-fs-path 与 class', () => {
    const html = '<span class="fs-path" data-fs-path="C:\\a\\b.txt">C:\\a\\b.txt</span>'
    const out = sanitizeRenderedHtml(html)
    expect(out).toContain('data-fs-path="C:\\a\\b.txt"')
    expect(out).toContain('class="fs-path"')
  })

  it('保留正常的图片与外链', () => {
    const out = sanitizeRenderedHtml(
      '<img src="https://a.example/x.png"><a href="https://a.example">x</a>'
    )
    expect(out).toContain('https://a.example/x.png')
    expect(out).toContain('href="https://a.example"')
  })

  /**
   * 这一条守的是「本地图片显示得出来」。
   *
   * DOMPurify 碰上不认识的协议是静默摘掉 src，页面上留一个没有 src 的 <img>，
   * 看起来像图没生成 —— AI 出的概念图和视口截图全都走这两个协议。
   */
  it('保留 local-resource / uebox-asset 的本地图片', () => {
    const out = sanitizeRenderedHtml(
      '<img src="local-resource://C:/vault/a.png"><img src="uebox-asset://pkg/b.png">'
    )
    expect(out).toContain('src="local-resource://C:/vault/a.png"')
    expect(out).toContain('src="uebox-asset://pkg/b.png"')
  })

  /**
   * 正文里的视频播放器整块都得留下来。少一个 controls 就是一个点不动的黑框，
   * 少一个 src 就是一个空框 —— 两种都会被当成「视频没生成」。
   */
  it('保留本地视频播放器与它的控件', () => {
    const out = sanitizeRenderedHtml(
      '<video src="local-resource://C:/vault/a.mp4" controls preload="metadata" playsinline></video>'
    )
    expect(out).toContain('src="local-resource://C:/vault/a.mp4"')
    expect(out).toContain('controls')
    expect(out).toContain('preload="metadata"')
  })

  it('保留图片上的 referrerpolicy —— 它是条隐私措施，不是装饰', () => {
    const out = sanitizeRenderedHtml(
      '<img src="https://a.example/x.png" referrerpolicy="no-referrer">'
    )
    expect(out).toContain('referrerpolicy="no-referrer"')
  })

  // 放行两个自定义协议不能顺手把别的协议一起放开
  it('仍然摘掉 javascript: 图片和不认识的协议', () => {
    const out = sanitizeRenderedHtml('<img src="javascript:alert(1)"><img src="evil-scheme://x">')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('evil-scheme:')
  })

  it('保留普通排版标签', () => {
    const html = '<h2>标题</h2><ul><li><strong>粗</strong></li></ul><pre><code>x</code></pre>'
    expect(sanitizeRenderedHtml(html)).toBe(html)
  })
})
