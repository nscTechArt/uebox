import { describe, expect, it, vi, afterEach } from 'vitest'
import { readWebPageLocally } from './webReader'

/**
 * 本地网页提取。
 *
 * 重点不在「能不能转 Markdown」，而在几条容易出事的边界：
 * 协议白名单、正文选择、以及取不到正文时是否**说清楚原因**（而不是返回空串
 * 让用户以为网页是空的）。
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  vi.useRealTimers()
  calls.length = 0
})

/** 重试之间有 1.2 秒等待，用假时钟推过去 */
async function withFakeTimers<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  const settled = work().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
  await vi.advanceTimersByTimeAsync(10_000)
  const result = await settled
  if (result.ok) return result.value
  throw result.error
}

function stubHtml(html: string, init: { status?: number; contentType?: string } = {}): void {
  globalThis.fetch = (async () => {
    calls.push('x')
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      headers: { get: () => init.contentType ?? 'text/html; charset=utf-8' },
      text: async () => html
    }
  }) as unknown as typeof fetch
}

/** 记一下发了几次请求，用来验证重试次数 */
const calls: string[] = []

/** 按顺序给出若干次响应，用来模拟「先被挡、后放行」 */
function stubSequence(responses: Array<{ status: number; body: string }>): void {
  let index = 0
  globalThis.fetch = (async () => {
    const current = responses[Math.min(index++, responses.length - 1)]
    calls.push(String(current.status))
    return {
      ok: current.status < 400,
      status: current.status,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => current.body
    }
  }) as unknown as typeof fetch
}

const PAGE = `
<html>
  <head>
    <title>材质入门</title>
    <meta name="description" content="虚幻引擎材质基础">
  </head>
  <body>
    <nav>首页 文档 论坛</nav>
    <header>站点横幅</header>
    <article>
      <h1>材质入门</h1>
      <p>材质决定物体表面的外观。</p>
      <p>基础色控制漫反射。</p>
    </article>
    <footer>版权所有</footer>
    <script>console.log('tracker')</script>
  </body>
</html>`

describe('readWebPageLocally', () => {
  it('提取正文并转成 Markdown，同时剥掉导航与脚本', async () => {
    stubHtml(PAGE)

    const result = await readWebPageLocally('https://example.com/doc')

    expect(result.success).toBe(true)
    expect(result.title).toBe('材质入门')
    expect(result.description).toBe('虚幻引擎材质基础')
    expect(result.content).toContain('材质决定物体表面的外观')
    expect(result.content).toContain('# 材质入门')
    // 导航、页脚、脚本都不该混进正文
    expect(result.content).not.toContain('论坛')
    expect(result.content).not.toContain('版权所有')
    expect(result.content).not.toContain('tracker')
  })

  it('拒绝 file:// —— URL 来自渲染层，不挡就能读本机任意文件', async () => {
    const result = await readWebPageLocally('file:///C:/Windows/win.ini')

    expect(result.success).toBe(false)
    expect(result.error).toContain('http/https')
  })

  it('无效网址直接报错', async () => {
    expect((await readWebPageLocally('不是网址')).success).toBe(false)
  })

  it('非 HTML 内容类型给出明确说明', async () => {
    stubHtml('%PDF-1.7', { contentType: 'application/pdf' })

    const result = await readWebPageLocally('https://example.com/a.pdf')

    expect(result.success).toBe(false)
    expect(result.error).toContain('application/pdf')
  })

  it('HTTP 错误码原样带出来', async () => {
    stubHtml('', { status: 404 })

    expect((await readWebPageLocally('https://example.com/x')).error).toContain('404')
  })

  it('前端渲染的空壳页面要说清楚原因，而不是返回空正文', async () => {
    // 这是最容易让用户困惑的一种：页面「打得开」但取不到东西
    stubHtml('<html><head><title>App</title></head><body><div id="root"></div></body></html>')

    const result = await readWebPageLocally('https://example.com/spa')

    expect(result.success).toBe(false)
    expect(result.error).toContain('前端脚本渲染')
  })

  it('没有语义标签时退化为「段落最多的块」', async () => {
    stubHtml(`
      <html><head><title>无语义</title></head><body>
        <div class="menu"><p>登录</p></div>
        <div class="real">
          <p>${'正文内容。'.repeat(80)}</p>
        </div>
      </body></html>`)

    const result = await readWebPageLocally('https://example.com/plain')

    expect(result.success).toBe(true)
    expect(result.content).toContain('正文内容')
    expect(result.content).not.toContain('登录')
  })
})

/**
 * 被反爬挡住这件事，实测是**按 IP 信誉随机**的：同一组请求头连发 8 次，
 * 拿到 `200 403 403 403 403 200 200 200`。用代理的用户命中率更高。
 *
 * 所以这里测两件事：重试（对抗随机性，不是绕过挑战），
 * 以及失败文案**给不给下一步** —— 只回一个 403 的话，模型只会换个渠道瞎猜。
 */
describe('被站点挡住时', () => {
  const PAGE_OK = `<html><head><title>UE</title></head><body><article><p>${'正文内容。'.repeat(60)}</p></article></body></html>`

  it('403 会重试，第二次通过就当没事发生', async () => {
    stubSequence([
      { status: 403, body: '<html>blocked</html>' },
      { status: 200, body: PAGE_OK }
    ])

    const result = await withFakeTimers(() => readWebPageLocally('https://www.unrealengine.com/'))

    expect(result.success).toBe(true)
    expect(calls).toEqual(['403', '200'])
  })

  it('200 的挑战页也算被挡 —— 有些站点不改状态码', async () => {
    stubSequence([
      {
        status: 200,
        body: '<html><body>Just a moment...<div class="cf_challenge_text_small">x</div></body></html>'
      },
      { status: 200, body: PAGE_OK }
    ])

    const result = await withFakeTimers(() => readWebPageLocally('https://www.unrealengine.com/'))

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2)
  })

  /**
   * 两句话，两个受众。
   *
   * 同一个 `readWebPageLocally` 既服务 AI 工具（`builtin/web.ts`），也服务知识库
   * 「添加来源」那条 IPC（`ipc/webRead.ts`）。后者的 `error` 直接显示在来源条下
   * （`NoteSourcePanel.vue`）—— 原来那句合在一起写，用户读到的是「改用 browser_open
   * 打开它」，一句让他去调用一个他根本看不见的工具的话。
   */
  it('重试到头仍被挡时，给出能走通的下一步而不是一个光秃秃的 403', async () => {
    stubSequence([{ status: 403, body: '<html>blocked</html>' }])

    const result = await withFakeTimers(() => readWebPageLocally('https://www.unrealengine.com/'))

    expect(result.success).toBe(false)
    // 给模型的那句：有具体工具名
    expect(result.agentHint).toContain('browser_open')
    // 给用户的那句：不能出现工具名，而且**也要**给出他能做的下一步
    expect(result.error).not.toContain('browser_open')
    expect(result.error).toContain('手动添加')
    // 重试有上限，不能没完没了地敲人家的门
    expect(calls).toHaveLength(3)
  })

  it('404 这类不是「被挡」，不浪费重试', async () => {
    stubSequence([{ status: 404, body: '<html>not found</html>' }])

    const result = await withFakeTimers(() => readWebPageLocally('https://example.com/missing'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('404')
    expect(calls).toHaveLength(1)
  })
})
