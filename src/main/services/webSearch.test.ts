import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 检索走哪条路，由用户绑在 `search` 角色上的 Provider 决定 ——
 * 和生图、视频、实时语音是同一套心智。免密钥的 Bing RSS 已删，
 * 理由见 `webSearch.ts` 顶部。
 *
 * 两组用例最要紧：
 *
 *   1. **没绑定要落到内置浏览器**。社区版的零配置承诺就是这一条；
 *   2. **回读校验**。后端失手时不会自己承认，返回的是 HTTP 200 + 结构完整 +
 *      内容无关，测试用的正是当时真实抓到的垃圾样本。
 *
 * 真浏览器和 SearXNG 都显式打桩 —— 前者要 import electron，在裸 Node 里加载
 * 会失败，不打桩的话用例会**碰巧**通过，测的却不是我们想测的东西。
 *
 * 测试一律打桩 fetch —— 单测不发真实网络请求（真实可用性由 `scripts/search-quality-bench.mjs` 人工验收）。
 */

const jinaKey = { value: '' }
const browserSearch = vi.fn()
const searxngSearch = vi.fn()
const boundProvider: { value: unknown } = { value: null }

vi.mock('../ai/jinaKey', () => ({
  resolveJinaApiKey: async () => jinaKey.value,
  JINA_KEY_MISSING_HINT: '到 https://jina.ai 申请一个'
}))

vi.mock('./searchProvider', () => ({
  BUILTIN_BROWSER_PROVIDER_ID: 'builtin-browser',
  SEARXNG_PROVIDER_ID: 'searxng',
  JINA_SEARCH_PROVIDER_ID: 'jina-search',
  resolveSearchProvider: async () => boundProvider.value
}))

vi.mock('./browserSearch', () => ({
  searchViaBrowser: (...args: unknown[]) => browserSearch(...args)
}))

vi.mock('./searxngSearch', () => ({
  searchViaSearxng: (...args: unknown[]) => searxngSearch(...args)
}))

// 界面语言。检索要把它翻成 Jina 的 hl 参数，不给的话结果跟着出口 IP 走
const uiLanguage = { value: 'zh-CN' as 'zh-CN' | 'en-US' }

vi.mock('../appSettingsManager', () => ({
  appSettingsManager: { getLanguage: () => uiLanguage.value }
}))

const { searchWeb } = await import('./webSearch')

function jinaBody(items: { title: string; url: string; description: string }[]): string {
  return JSON.stringify({ data: items })
}

const RELEVANT = jinaBody([
  {
    title: '虚幻引擎事件分发器 | 虚幻引擎 5.8 文档',
    url: 'https://dev.epicgames.com/documentation/zh-cn/unreal-engine/event-dispatchers',
    description: '事件分发器让蓝图之间通信'
  },
  {
    title: 'UE4蓝图通信-事件分发器',
    url: 'https://blog.csdn.net/Motarookie/article/details/121635692',
    description: '事件分发器用法'
  }
])

/** 真实抓到过的垃圾：查 UE 的 C++ API，回来一批银行和桌宠 */
const GARBAGE = jinaBody([
  {
    title: 'Login Page for BambooHR Users',
    url: 'https://www.bamboohr.com/login',
    description: 'Sign in to your account'
  },
  {
    title: 'Releases · ayangweb/BongoCat - GitHub',
    url: 'https://github.com/ayangweb/BongoCat/releases',
    description: '跨平台桌面宠物'
  }
])

const originalFetch = globalThis.fetch
const calls: string[] = []

function stub(body: string, status = 200): void {
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }) as unknown as typeof fetch
}

/** 第一次按 `first` 应答，之后一律按 `rest`。用来测「换个参数再试一次」 */
function stubOnceThen(first: { status: number; body: string }, rest: string): void {
  let n = 0
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    n += 1
    const status = n === 1 ? first.status : 200
    const body = n === 1 ? first.body : rest
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }) as unknown as typeof fetch
}

const BROWSER_ITEMS = [
  {
    title: '虚幻引擎事件分发器 | 官方文档',
    url: 'https://dev.epicgames.com/documentation/event-dispatchers',
    snippet: '蓝图通信'
  }
]

beforeEach(() => {
  calls.length = 0
  jinaKey.value = 'jina_test'
  uiLanguage.value = 'zh-CN'
  // 默认：什么都没绑 —— 这正是绝大多数用户的状态
  boundProvider.value = null
  browserSearch.mockReset()
  browserSearch.mockResolvedValue({ success: true, engine: 'duckduckgo', items: BROWSER_ITEMS })
  searxngSearch.mockReset()
  searxngSearch.mockResolvedValue({ success: true, items: BROWSER_ITEMS })
})

/** 绑一个「网页检索」Provider。modelId 是「去哪儿搜」，不是模型 */
function bind(providerId: string, modelId = '', baseUrl = '', apiKey?: string): void {
  boundProvider.value = { providerId, modelId, baseUrl, ...(apiKey ? { apiKey } : {}) }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('searchWeb', () => {
  it('绑了 Jina 就走 Jina，解析出标题、链接和摘要', async () => {
    bind('jina-search', 's.jina.ai')
    stub(RELEVANT)

    const result = await searchWeb('虚幻引擎 蓝图 事件分发器')

    expect(result.success).toBe(true)
    expect(result.provider).toBe('jina-search')
    expect(calls[0]).toContain('s.jina.ai')
    expect(result.items?.[0].url).toBe(
      'https://dev.epicgames.com/documentation/zh-cn/unreal-engine/event-dispatchers'
    )
  })

  it('条数收敛在 1..10，模型要不来更多', async () => {
    bind('jina-search', 's.jina.ai')
    stub(RELEVANT)

    expect((await searchWeb('事件分发器', { limit: 1 })).items).toHaveLength(1)
    expect((await searchWeb('事件分发器', { limit: 99 })).items?.length).toBeLessThanOrEqual(10)
  })

  it('空搜索词直接拒绝，不白跑一趟网络', async () => {
    stub(RELEVANT)

    expect((await searchWeb('   ')).success).toBe(false)
    expect(calls).toEqual([])
    expect(browserSearch).not.toHaveBeenCalled()
  })

  /**
   * 不带语言这一位时，结果的语言跟着**出口 IP** 走 —— 挂代理的用户查中文
   * 会拿到一串外语站点。这个现象在删掉的 Bing 那条路上就记过一次。
   */
  describe('跟随界面语言', () => {
    it('中文界面发 hl=zh-cn', async () => {
      bind('jina-search', 's.jina.ai')
      uiLanguage.value = 'zh-CN'
      stub(RELEVANT)

      await searchWeb('虚幻引擎 事件分发器')

      expect(calls[0]).toContain('hl=zh-cn')
    })

    it('英文界面发 hl=en', async () => {
      bind('jina-search', 's.jina.ai')
      uiLanguage.value = 'en-US'
      stub(RELEVANT)

      await searchWeb('unreal engine event dispatcher')

      expect(calls[0]).toContain('hl=en')
    })

    /**
     * `hl` 是拿**对方的**语言码表做精确匹配校验的，那张表我们看不见也管不住。
     * 它哪天改了名，带着这一位的请求会整个失败 —— 那等于中文用户完全搜不到。
     * 语言只是「更准」，不是「能不能用」。
     */
    it('对方不认这个语言码时，去掉它重试一次而不是整个失败', async () => {
      bind('jina-search', 's.jina.ai')
      stubOnceThen({ status: 400, body: '' }, RELEVANT)

      const result = await searchWeb('虚幻引擎 事件分发器')

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('hl=')
      expect(calls[1]).not.toContain('hl=')
    })

    /** 5xx 是对方的故障，不是参数问题 —— 重试没有意义，别白发一次 */
    it('服务端故障不触发去掉语言的重试', async () => {
      bind('jina-search', 's.jina.ai')
      stubOnceThen({ status: 503, body: '' }, RELEVANT)

      const result = await searchWeb('虚幻引擎')

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(1)
    })
  })

  describe('按绑定的角色分发', () => {
    /**
     * 社区版的零配置承诺就是这一条：什么都没配也要能搜。
     * 否则检索会变成一个「先去第三方申请点什么」才能用的功能。
     */
    it('没绑定时落到内置浏览器，而不是报不可用', async () => {
      jinaKey.value = ''

      const result = await searchWeb('虚幻引擎 事件分发器')

      expect(result.success).toBe(true)
      expect(result.provider).toBe('browser:duckduckgo')
      // 没绑定就没有「挑哪个搜索站」这回事
      expect(browserSearch).toHaveBeenCalledWith('虚幻引擎 事件分发器', 5, {})
      // 就算 Key 在，没绑定也不该去打 Jina
      expect(calls).toEqual([])
    })

    /** 有 Key 也不擅自替用户改路 —— 走哪条是他在设置里定的 */
    it('有 Jina Key 但没绑定时，仍然走内置浏览器', async () => {
      jinaKey.value = 'jina_test'

      const result = await searchWeb('虚幻引擎 事件分发器')

      expect(result.provider).toBe('browser:duckduckgo')
      expect(calls).toEqual([])
    })

    it('绑定的「模型」是挑哪个搜索站，会传给浏览器', async () => {
      bind('builtin-browser', 'bing')
      browserSearch.mockResolvedValue({ success: true, engine: 'bing', items: BROWSER_ITEMS })

      const result = await searchWeb('虚幻引擎 事件分发器')

      expect(browserSearch).toHaveBeenCalledWith('虚幻引擎 事件分发器', 5, {
        preferEngine: 'bing'
      })
      expect(result.provider).toBe('browser:bing')
    })

    it('绑了 SearXNG 就把实例地址交给它', async () => {
      bind('searxng', 'web-search', 'http://localhost:8080')

      const result = await searchWeb('虚幻引擎 事件分发器')

      expect(result.provider).toBe('searxng')
      expect(searxngSearch).toHaveBeenCalledWith('http://localhost:8080', '虚幻引擎 事件分发器', 5)
      expect(browserSearch).not.toHaveBeenCalled()
    })

    it('SearXNG 挂了如实报错，不偷偷改走别的路', async () => {
      bind('searxng', 'web-search', 'http://localhost:8080')
      searxngSearch.mockResolvedValue({ success: false, error: '实例没有打开 JSON 输出。' })

      const result = await searchWeb('虚幻引擎')

      expect(result.success).toBe(false)
      expect(result.error).toContain('JSON 输出')
      // 用户明确选了 SearXNG，悄悄换成浏览器等于让他以为 SearXNG 是好的
      expect(browserSearch).not.toHaveBeenCalled()
    })

    /** 目录里 Jina 有两条记录（向量化、网页检索），共用同一把 Key */
    it('绑了 Jina 但密钥配在向量化那条上时，仍然能取到', async () => {
      bind('jina-search', 's.jina.ai')
      jinaKey.value = 'jina_from_embedding_entry'
      stub(RELEVANT)

      const result = await searchWeb('虚幻引擎 事件分发器')

      expect(result.success).toBe(true)
      expect(result.provider).toBe('jina-search')
    })

    it('绑了 Jina 却没有任何 Key 时，说清楚去哪儿拿', async () => {
      bind('jina-search', 's.jina.ai')
      jinaKey.value = ''

      const result = await searchWeb('虚幻引擎')

      expect(result.success).toBe(false)
      expect(result.error).toContain('jina.ai')
      expect(calls).toEqual([])
    })

    /**
     * 绑了个不认识的 Provider —— **退回内置浏览器，但要说出来**。
     *
     * 这条以前是硬失败。区别在故障性质：Key 过期是临时故障，静默降级会埋掉它；
     * 而绑错 Provider 是**结构性配置错误**，不会自己好 —— 硬失败等于让一次误操作
     * 永久废掉网页检索，用户看到的却只是「AI 说搜索失败」。
     *
     * 真实路径：新建 Provider 时「用途」选了「网页检索」，地址和模型却填的是某个
     * 对话厂商（百炼 + qwen）。它能通过角色下拉的过滤，直接落到这里。
     */
    it('绑了不支持的 Provider：退回内置浏览器，并把配置问题带出来', async () => {
      bind('qwen-as-search', 'qwen3-max', 'https://dashscope.aliyuncs.com')

      const result = await searchWeb('虚幻引擎')

      expect(result.success).toBe(true)
      expect(browserSearch).toHaveBeenCalled()
      // 提醒要指名道姓，并说清楚这一档到底支持什么
      expect(result.notice).toContain('qwen-as-search')
      expect(result.notice).toContain('builtin-browser')
      expect(result.notice).toContain('searxng')
    })

    /** 不去拿一个对话模型的地址当搜索接口试 —— 猜错只会得到看不懂的错误 */
    it('不拿那个 Provider 的地址去试探', async () => {
      bind('qwen-as-search', 'qwen3-max', 'https://dashscope.aliyuncs.com')

      await searchWeb('虚幻引擎')

      expect(calls).toEqual([])
      expect(searxngSearch).not.toHaveBeenCalled()
    })

    /** 兜底也失败时，两件事都要说：配置错了，而且这次也没搜到 */
    it('内置浏览器也失败时，配置问题和检索失败一起说', async () => {
      bind('qwen-as-search', 'qwen3-max')
      browserSearch.mockResolvedValue({ success: false, error: '两个搜索站都被人机验证挡住' })

      const result = await searchWeb('虚幻引擎')

      expect(result.success).toBe(false)
      expect(result.error).toContain('qwen-as-search')
      expect(result.error).toContain('人机验证')
    })
  })

  /**
   * 搜索站点常用 **202** 返回人机验证页。`response.ok` 覆盖 200-299，
   * 照那个判就会把挑战页当正常响应解析。
   *
   * 这里把浏览器那条也打成失败，才看得到 202 是被当成失败记下来的 ——
   * 否则它会被兜底成功掩盖掉。
   */
  it('HTTP 202 当失败处理，不把人机验证页当结果', async () => {
    bind('jina-search', 's.jina.ai')
    stub('<html>anomaly detected</html>', 202)

    const result = await searchWeb('虚幻引擎')

    expect(result.success).toBe(false)
    expect(result.error).toContain('202')
  })

  describe('回读校验', () => {
    // 这一组测的是「拿到结果之后怎么判」，不是「从哪条路拿」。
    // 固定绑到 Jina，结果就只可能来自打桩的 fetch，用例才说得清在测什么
    beforeEach(() => {
      bind('jina-search', 's.jina.ai')
    })

    it('整批都和查询对不上时报失败，绝不当 success 递出去', async () => {
      stub(GARBAGE)

      const result = await searchWeb('"FObjectFinder" "ConstructorHelpers" Unreal C++')

      expect(result.success).toBe(false)
      expect(result.items).toBeUndefined()
      // 要说清楚是「后端没正常工作」，不是「这个问题没有答案」
      expect(result.error).toContain('检索后端')
    })

    it('对得上的结果照常通过，并标成 ok', async () => {
      stub(RELEVANT)

      const result = await searchWeb('虚幻引擎 事件分发器')

      expect(result.success).toBe(true)
      expect(result.items?.every((item) => item.relevance === 'ok')).toBe(true)
    })

    /**
     * 单条对不上只标注、不丢弃 —— 语义相关但字面不重合的好结果确实存在，
     * 判据只在「整批都对不上」这一个方向上是硬的。
     */
    it('部分对不上时保留结果，只把那几条标成存疑', async () => {
      stub(
        jinaBody([
          {
            title: '虚幻引擎事件分发器 | 官方文档',
            url: 'https://dev.epicgames.com/documentation/event-dispatchers',
            description: '官方说明'
          },
          {
            title: 'Login Page for BambooHR Users',
            url: 'https://www.bamboohr.com/login',
            description: 'Sign in'
          }
        ])
      )

      const result = await searchWeb('虚幻引擎 事件分发器')

      expect(result.success).toBe(true)
      expect(result.items).toHaveLength(2)
      expect(result.items?.[0].relevance).toBe('ok')
      expect(result.items?.[1].relevance).toBe('unclear')
    })

    it('乱码查询拿到的整批噪声也会被拦下', async () => {
      stub(
        jinaBody([
          { title: 'Google', url: 'https://www.google.com/', description: '' },
          {
            title: 'Zenless Zone Zero Official Website',
            url: 'https://zenless.hoyoverse.com/',
            description: 'HoYoverse'
          }
        ])
      )

      const result = await searchWeb('qzxwvba83yrh9k4nmg zzz')

      expect(result.success).toBe(false)
    })

    it('Jina 一条都没返回时如实说没有，不编一条出来', async () => {
      stub(jinaBody([]))

      const result = await searchWeb('一个没人写过的词')

      expect(result.success).toBe(false)
      expect(result.items).toBeUndefined()
    })
  })
})
/**
 * 目录里能选的每一条，代码都得真的会走。
 *
 * 这条用例是补一个真实的坑：目录里曾经挂着 `deepsearch.jina.ai`
 * 「深度搜索（更慢更贵）」，用户在设置里选得中，但 `searchViaJina` **根本不看
 * modelId** —— 选它和选普通网页搜索跑出来一模一样，界面上却写着「更慢更贵」。
 *
 * 界面上能选的东西必须有实现，这和斜杠命令那张表是同一条规矩
 * （见 `views/Assistant/components/slashCommands.ts`：加命令前先把实现接上）。
 * 往目录里加检索后端时，**先把 `runProviders` 那条分支接上，再改这份名单**。
 */
describe('目录与实现对得上', () => {
  it('search 档里每一条「模型」都有代码在走', async () => {
    const { GENERATED_CATALOG } = await import('../ai/catalog.generated')

    const searchModels = GENERATED_CATALOG.filter((provider) => provider.kind === 'search').flatMap(
      (provider) => provider.models.map((model) => `${provider.id}/${model.id}`)
    )

    expect(new Set(searchModels)).toEqual(
      new Set([
        // browserSearch.ts 的 ENGINES
        'builtin-browser/duckduckgo',
        'builtin-browser/bing',
        // searxngSearch.ts：具体开哪些上游引擎是实例自己的配置
        'searxng/web-search',
        // webSearch.ts 的 searchViaJina
        'jina-search/s.jina.ai'
      ])
    )
  })
})

/** Box Plan：`POST /search`（协议 08），来源 id 以 creator-plan 开头 */
describe('Box Plan 检索', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    boundProvider.value = null
  })

  it('绑了套餐来源：POST /search，带界面语言，结果过回读校验', async () => {
    boundProvider.value = {
      providerId: 'creator-plan-search',
      modelId: 'uebox-search',
      baseUrl: 'https://plan.example/v1',
      apiKey: 'ubx-sk-t'
    }
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(
        JSON.stringify({
          model: 'uebox-search',
          results: [
            {
              title: '虚幻引擎事件分发器',
              url: 'https://dev.epicgames.com/x',
              snippet: '事件分发器的用法'
            }
          ],
          usage: { searches: 1 }
        })
      )
    })
    const result = await searchWeb('虚幻引擎 事件分发器', { limit: 3 })
    expect(result).toMatchObject({ success: true, provider: 'creator-plan' })
    expect(result.items?.[0]).toMatchObject({ url: 'https://dev.epicgames.com/x' })
    expect(requests[0].url).toBe('https://plan.example/v1/search')
    expect(requests[0].body).toMatchObject({
      model: 'uebox-search',
      query: '虚幻引擎 事件分发器',
      limit: 3,
      language: 'zh-CN'
    })
    expect(browserSearch).not.toHaveBeenCalled()
  })

  it('额度用完：说清下一步，不偷偷退回内置浏览器', async () => {
    boundProvider.value = {
      providerId: 'creator-plan-search',
      modelId: 'uebox-search',
      baseUrl: 'https://plan.example/v1',
      apiKey: 'ubx-sk-t'
    }
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { code: 'quota_exhausted', message: 'x' } }), {
          status: 402
        })
    )
    const result = await searchWeb('虚幻引擎')
    expect(result.success).toBe(false)
    expect(result.error).toContain('额度用完了')
    expect(browserSearch).not.toHaveBeenCalled()
  })
})
