import { describe, expect, it } from 'vitest'

import { extractWebContentFromHtml, NOTEBOOK_MAX_CONTENT_CHARS } from './extract'

/**
 * 提取管线是笔记本和 Agent 浏览器共用的那一份。
 *
 * `webReader.test.ts` 已经覆盖了「抓取 + 提取」整条路，这里只测抽出来之后
 * 新增的那部分契约：长度上限是**参数**，以及渲染后 DOM 的处理。
 */

const RENDERED = `
<html>
  <head><title>Vue 文档</title><meta name="description" content="渐进式框架"></head>
  <body>
    <nav>首页 指南</nav>
    <div id="app">
      <article>
        <h1>组合式 API</h1>
        <p>setup 是组件的入口。</p>
        <p>ref 用来声明响应式状态。</p>
      </article>
    </div>
    <iframe src="https://ads.example.com/banner"></iframe>
    <footer>© 2026</footer>
  </body>
</html>`

describe('extractWebContentFromHtml', () => {
  it('处理前端渲染后的 DOM —— 这正是 fetch 那条路拿不到的部分', async () => {
    const result = await extractWebContentFromHtml(RENDERED, 'https://vuejs.org/guide')

    expect(result.success).toBe(true)
    expect(result.title).toBe('Vue 文档')
    expect(result.content).toContain('setup 是组件的入口')
    expect(result.content).toContain('# 组合式 API')
    expect(result.url).toBe('https://vuejs.org/guide')
  })

  it('导航、页脚和 iframe 不进正文', async () => {
    const result = await extractWebContentFromHtml(RENDERED, 'https://vuejs.org/guide')

    expect(result.content).not.toContain('指南')
    expect(result.content).not.toContain('© 2026')
    expect(result.content).not.toContain('ads.example.com')
  })

  it('密码字段的值不会出现在正文里', async () => {
    const html = `
      <html><body><article>
        <p>${'请登录后查看。'.repeat(40)}</p>
        <form><input type="password" value="hunter2"><input name="card" value="4111111111111111"></form>
      </article></body></html>`

    const result = await extractWebContentFromHtml(html, 'https://example.com/login')

    expect(result.content).not.toContain('hunter2')
    expect(result.content).not.toContain('4111111111111111')
  })

  it('maxChars 是参数：浏览器的上限不受笔记本的 20 万字影响', async () => {
    const long = `<html><body><article><p>${'内容。'.repeat(2000)}</p></article></body></html>`

    const short = await extractWebContentFromHtml(long, 'https://example.com/long', {
      maxChars: 100
    })
    const full = await extractWebContentFromHtml(long, 'https://example.com/long')

    expect(short.content).toHaveLength(100)
    // 不给上限时按笔记本的默认走，正文不该被 100 字截断
    expect(full.content!.length).toBeGreaterThan(100)
    expect(full.content!.length).toBeLessThanOrEqual(NOTEBOOK_MAX_CONTENT_CHARS)
  })

  /**
   * 划掉的文字要留着，而且要看得出是划掉的。
   *
   * 2026-09-07 真机验收就栽在这条：SQLite 官方 WAL 页面把「大于约 100MB 的事务
   * 建议改用回滚日志」整段划掉了，后面紧跟着说从 3.11.0 起两者同样高效。
   * 删除线一丢，两段都成了正文，模型把作废的旧建议当现行结论写进了报告 ——
   * **意思正好反过来**，而且从抓回来的 Markdown 上完全看不出来。
   */
  it('保留删除线 —— 划掉的建议不能变成现行结论', async () => {
    const html = `<html><head><title>WAL</title></head><body><article>
      <p>${'铺垫'.repeat(80)}</p>
      <p><del>Transactions larger than 100 megabytes should use a rollback journal.</del>
      Beginning with 3.11.0, WAL handles large transactions as efficiently as rollback mode.</p>
    </article></body></html>`

    const result = await extractWebContentFromHtml(html, 'https://sqlite.org/wal.html')

    expect(result.content).toContain('~~Transactions larger than 100 megabytes')
    // 划掉的和现行的必须分得开，否则模型只能看到两句并列的陈述
    expect(result.content).toContain('Beginning with 3.11.0')
    expect(result.content).not.toContain('~~Beginning with 3.11.0')
  })

  it.each(['s', 'strike'])('老式的 <%s> 标签同样算删除线', async (tag) => {
    const html = `<html><head><title>T</title></head><body><article>
      <p>${'铺垫'.repeat(80)}</p>
      <p><${tag}>已作废的说法</${tag}>现在的说法</p>
    </article></body></html>`

    const result = await extractWebContentFromHtml(html, 'https://example.com/t')

    expect(result.content).toContain('~~已作废的说法~~')
  })

  /** `<ins>` 常常就是那句划掉内容的替代说法，丢了等于只剩半个修订 */
  it('保留 <ins> 的正文', async () => {
    const html = `<html><head><title>T</title></head><body><article>
      <p>${'铺垫'.repeat(80)}</p>
      <p><del>旧值 100MB</del><ins>不再有这个限制</ins></p>
    </article></body></html>`

    const result = await extractWebContentFromHtml(html, 'https://example.com/t')

    expect(result.content).toContain('~~旧值 100MB~~')
    expect(result.content).toContain('不再有这个限制')
  })

  it('层层嵌套的排版也要抓全 —— 公众号把每段都包进自己的 section', async () => {
    /*
      真实的回归：一篇 Unreal Fest 征集文章只抓回了 239 字（整篇 828 字），
      报名截止时间正好在没抓到的那部分里。原因是上一版回退规则只数**直接子** <p>，
      而微信编辑器把每一段都包进 <section>，#js_content 的直接子 <p> 是 0 字，
      赢家变成中间某个只装了三段的小块。
    */
    const paragraph = (text: string): string =>
      `<section><section><p>${text}</p></section></section>`
    const html = `<html><head><title>征集</title></head><body>
      <div id="page-content"><div id="img-content">
        <div id="js_content">
          ${paragraph('开头一段' + '内'.repeat(120))}
          ${paragraph('中间一段' + '容'.repeat(120))}
          ${paragraph('报名截止时间：2026年9月30日')}
        </div>
      </div></div>
    </body></html>`

    const result = await extractWebContentFromHtml(html, 'https://mp.weixin.qq.com/s/x')

    expect(result.success).toBe(true)
    // 三段都要在，尤其是最后那段 —— 关键信息常常排在最后
    expect(result.content).toContain('开头一段')
    expect(result.content).toContain('中间一段')
    expect(result.content).toContain('报名截止时间：2026年9月30日')
  })

  /*
    这两条测的是**回退打分**那条路，所以容器名刻意不用 CONTENT_SELECTORS 里的任何一个
    （`#artibody` 这类国产 CMS 的 id 就取不到语义选择器）。上一版规则是「得分 ≥ 满分 90%
    的候选里挑最深的」，等于给自己留了 10% 的丢字额度：正文块只要有外层九成的字就赢，
    外层里那段导语／结尾直接没了。
  */
  it('回退打分不能丢掉正文块外面的导语', async () => {
    const body = '正'.repeat(560)
    const html = `<html><head><title>T</title></head><body>
      <div id="artibody">
        <p>导语：这段交代背景，字数远少于正文</p>
        <section class="post-body"><p>${body}</p></section>
      </div>
    </body></html>`

    const result = await extractWebContentFromHtml(html, 'https://example.com/p')

    expect(result.content).toContain(body)
    expect(result.content).toContain('导语')
  })

  it('回退打分不能丢掉正文块后面的结尾（关键信息常排在最后）', async () => {
    const body = '正'.repeat(560)
    const html = `<html><head><title>T</title></head><body>
      <div id="artibody">
        <section class="post-body"><p>${body}</p></section>
        <p>报名截止时间：2026年9月30日</p>
      </div>
    </body></html>`

    const result = await extractWebContentFromHtml(html, 'https://example.com/p')

    expect(result.content).toContain(body)
    expect(result.content).toContain('报名截止时间：2026年9月30日')
  })

  /*
    目录页、索引页、标题列表的正文**就是链接**。
    净分（扣掉链接文字之后）相同时如果无条件取更深的那个，整份目录就会被扔掉 ——
    所以破平必须同时要求原始字数也相等，父节点多一个字就归父节点。
  */
  it('回退打分不能扔掉目录页那一整块链接', async () => {
    const links = Array.from(
      { length: 40 },
      (_, i) => `<a href="/d${i}">文档条目标题${i}</a>`
    ).join('')
    const html = `<html><head><title>索引</title></head><body>
      <div id="artibody">
        <div class="toc">${links}</div>
        <div class="notice">${'提'.repeat(340)}</div>
      </div>
    </body></html>`

    const result = await extractWebContentFromHtml(html, 'https://example.com/index')

    expect(result.content).toContain('文档条目标题1')
    expect(result.content).toContain('提提提')
  })

  /*
    评论区和推荐位要在 NOISE_SELECTORS 里按名字剔掉，不能指望打分躲开它们：
    靠「字少一点就是噪音」判断等价于允许自己丢正文。真实类名五花八门，
    所以用前缀匹配 —— `.comment` 匹配不到 `comment-list`，那正是漏掉的原因。
  */
  it.each(['comment-list', 'comments-area', 'related-posts', 'recommend-box'])(
    '按名字剔掉噪音块：.%s 不进正文',
    async (className) => {
      const body = '正'.repeat(600)
      const html = `<html><head><title>T</title></head><body>
        <div id="artibody">
          <div class="post"><p>${body}</p></div>
          <div class="${className}"><p>${'噪'.repeat(300)}加我微信</p></div>
        </div>
      </body></html>`

      const result = await extractWebContentFromHtml(html, 'https://example.com/p')

      expect(result.content).toContain(body)
      expect(result.content).not.toContain('加我微信')
    }
  )

  /** 外层比正文多出来的那部分几乎都是链接，扣掉链接文字正文块才赢得动 */
  it('回退打分要按链接密度挑：相关阅读多的外层不算正文', async () => {
    const body = '正'.repeat(560)
    const links = Array.from(
      { length: 40 },
      (_, i) => `<a href="/x${i}">推荐阅读的一篇文章标题${i}</a>`
    ).join('')
    const html = `<html><head><title>T</title></head><body>
      <div id="artibody">
        <div class="post"><p>${body}</p></div>
        <div class="related">${links}</div>
      </div>
    </body></html>`

    const result = await extractWebContentFromHtml(html, 'https://example.com/p')

    expect(result.content).toContain(body)
    expect(result.content).not.toContain('推荐阅读的一篇文章标题1')
  })

  it('正文块和外层容器装着同样多的字时，取深的那个（不把导航页脚卷进来）', async () => {
    const body = '正'.repeat(400)
    const html = `<html><head><title>博客</title></head><body>
      <div id="wrapper">
        <nav><a href="/a">首页</a><a href="/b">归档</a></nav>
        <div id="js_content"><section><p>${body}</p></section></div>
      </div>
    </body></html>`

    const result = await extractWebContentFromHtml(html, 'https://example.com/p')

    expect(result.content).toContain(body)
    expect(result.content).not.toContain('归档')
  })

  it('取不到正文时说明原因，而不是返回空串', async () => {
    const result = await extractWebContentFromHtml(
      '<html><head><title>App</title></head><body><div id="root"></div></body></html>',
      'https://example.com/spa'
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('前端脚本渲染')
  })
})
