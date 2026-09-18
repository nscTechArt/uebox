import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 真浏览器检索。
 *
 * 这里盯的不是「能不能搜到东西」——那要真网络，由
 * `scripts/search-quality-bench.mjs` 人工验收。这里锁住的是几条**改坏了没人
 * 会发现、出事代价很大**的性质：
 *
 *   - 窗口不显示、不给 Node、用独立分区（不能带上用户在 Agent 浏览器里的登录态）；
 *   - 等结果靠轮询而不是固定 sleep（固定 sleep 会在慢的时候抓到空壳）；
 *   - 第一家没结果要换第二家，全挂时**每家的原因都要带出来**；
 *   - 撞上人机验证如实说，不去解那道题；
 *   - 两次搜索同时进来时排队，不能各读到对方的页面。
 */

interface FakeWin {
  options: Record<string, unknown>
  loaded: string[]
  userAgent: string
  destroyed: boolean
}

/**
 * 假页面按**当前打开的是哪家**应答，不用排队。
 *
 * 排队的写法要精确数出轮询次数（超时 / 间隔），改一次常量就全崩，
 * 而且用例读起来完全看不出在测什么。
 */
interface EnginePlan {
  /** 结果节点。空数组表示这家什么都没有 */
  results: unknown[]
  /** 取不到结果时页面正文长什么样 —— 用来区分「被挡住」和「真没有」 */
  bodyText: string
}
let plan: Record<string, EnginePlan> = {}
/**
 * 按**搜索词**应答，优先于 `plan`。
 *
 * 并发那组用例要的就是这个：页面内容随「当前打开的是哪次搜索」变化，
 * 谁读到了别人的页面，一眼就看得出来。
 */
let planByQuery: Record<string, EnginePlan> = {}
let created: FakeWin[] = []

class FakeBrowserWindow {
  webContents: Record<string, unknown>
  private state: FakeWin

  constructor(options: Record<string, unknown>) {
    this.state = { options, loaded: [], userAgent: '', destroyed: false }
    created.push(this.state)

    this.webContents = {
      setUserAgent: (ua: string) => {
        this.state.userAgent = ua
      },
      setWindowOpenHandler: (handler: () => { action: string }) => {
        this.state.options.windowOpenAction = handler().action
      },
      loadURL: async (url: string) => {
        this.state.loaded.push(url)
      },
      executeJavaScript: async (script: string) => {
        // **读的是「此刻窗口里是哪一页」**，和真实情况一致 —— 别人把页面导航走了，
        // 这里就会读到别人的东西
        const current = this.state.loaded.at(-1) ?? ''
        const engine = current.includes('bing.com') ? 'bing' : 'duckduckgo'
        const query = new URL(current).searchParams.get('q') ?? ''
        const here = planByQuery[query] ?? plan[engine] ?? { results: [], bodyText: '' }
        return script.includes('document.body.innerText') ? here.bodyText : here.results
      }
    }
  }

  isDestroyed = (): boolean => this.state.destroyed
  destroy = (): void => {
    this.state.destroyed = true
  }
}

vi.mock('electron', () => ({
  app: {
    userAgentFallback:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 UnrealBox/1.0 Electron/44.0.0 Safari/537.36',
    getName: () => 'UnrealBox'
  },
  BrowserWindow: FakeBrowserWindow,
  session: { fromPartition: (name: string) => ({ partition: name }) }
}))

const { searchViaBrowser, closeSearchBrowser } = await import('./browserSearch')

const RESULTS = [
  {
    title: '虚幻引擎事件分发器 | 虚幻引擎 5.8 文档',
    url: 'https://dev.epicgames.com/documentation/zh-cn/unreal-engine/event-dispatchers',
    snippet: '蓝图之间通信'
  },
  {
    title: 'UE4蓝图通信-事件分发器',
    url: 'https://blog.csdn.net/Motarookie/article/details/121635692',
    snippet: ''
  }
]

/** 测试里把等待压到几十毫秒，不然每个「没结果」的用例都要空等 8 秒 */
const FAST = { resultTimeoutMs: 60 }

beforeEach(() => {
  plan = {}
  planByQuery = {}
  created = []
  closeSearchBrowser()
  vi.useRealTimers()
})

afterEach(() => {
  closeSearchBrowser()
})

describe('窗口性质', () => {
  it('不显示、不给 Node、开沙箱 —— 远程页面拿到的应该和普通浏览器一样多', async () => {
    plan = { duckduckgo: { results: RESULTS, bodyText: '' } }
    await searchViaBrowser('事件分发器', 5, FAST)

    const options = created[0].options
    expect(options.show).toBe(false)
    const prefs = options.webPreferences as Record<string, unknown>
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.sandbox).toBe(true)
    expect(prefs.webSecurity).toBe(true)
  })

  /**
   * 这是最要紧的一条。
   *
   * 复用 Agent 浏览器那个 `persist:` 分区，等于把用户登过的账号带进每一次搜索，
   * 搜索引擎能认出这是谁。分区必须是独立的，而且**不能是 persist:** ——
   * 搜索不需要任何登录态，留着 cookie 只会把多次搜索串成一个人。
   */
  it('用独立的非持久分区，不碰 Agent 浏览器的登录态', async () => {
    plan = { duckduckgo: { results: RESULTS, bodyText: '' } }
    await searchViaBrowser('事件分发器', 5, FAST)

    const prefs = created[0].options.webPreferences as Record<string, unknown>
    const partition = (prefs.session as { partition: string }).partition
    expect(partition).not.toContain('agent-browser')
    expect(partition.startsWith('persist:')).toBe(false)
  })

  it('UA 里去掉 Electron 和应用名 —— 留着等于自报家门是自动化客户端', async () => {
    plan = { duckduckgo: { results: RESULTS, bodyText: '' } }
    await searchViaBrowser('事件分发器', 5, FAST)

    expect(created[0].userAgent).not.toContain('Electron/')
    expect(created[0].userAgent).not.toContain('UnrealBox/')
    expect(created[0].userAgent).toContain('Chrome/152.0')
  })

  it('搜索页想开新窗口一律拒绝', async () => {
    plan = { duckduckgo: { results: RESULTS, bodyText: '' } }
    await searchViaBrowser('事件分发器', 5, FAST)

    expect(created[0].options.windowOpenAction).toBe('deny')
  })

  /** 冷启动 5～11 秒全是起 Chromium 的钱，一次搜索通常跟着好几次 */
  it('窗口复用，第二次搜索不再新建', async () => {
    plan = { duckduckgo: { results: RESULTS, bodyText: '' } }
    await searchViaBrowser('第一次', 5, FAST)
    await searchViaBrowser('第二次', 5, FAST)

    expect(created).toHaveLength(1)
  })
})

describe('searchViaBrowser', () => {
  it('第一家就有结果时直接返回，并说明是哪家给的', async () => {
    plan = { duckduckgo: { results: RESULTS, bodyText: '' } }

    const result = await searchViaBrowser('虚幻引擎 事件分发器', 5, FAST)

    expect(result.success).toBe(true)
    expect(result.engine).toBe('duckduckgo')
    expect(result.items).toHaveLength(2)
    expect(created[0].loaded[0]).toContain('duckduckgo.com')
  })

  it('按 limit 截断', async () => {
    plan = { duckduckgo: { results: RESULTS, bodyText: '' } }

    const result = await searchViaBrowser('事件分发器', 1, FAST)

    expect(result.items).toHaveLength(1)
  })

  /** DuckDuckGo 在前是因为它给干净地址；Bing 的链接包在跳转壳里 */
  it('第一家没结果就换第二家', async () => {
    plan = {
      duckduckgo: { results: [], bodyText: '普通页面，就是没搜到' },
      bing: { results: RESULTS, bodyText: '' }
    }

    const result = await searchViaBrowser('事件分发器', 5, FAST)

    expect(result.success).toBe(true)
    expect(result.engine).toBe('bing')
    expect(created[0].loaded[0]).toContain('duckduckgo.com')
    expect(created[0].loaded[1]).toContain('bing.com')
  })

  /**
   * 全挂时**每家的原因都要带出来**。糊成一句「搜索失败」的话，
   * 「被人机验证挡住」和「真的没有结果」下次就分不出来了。
   */
  it('全挂时列出每一家各自的原因，并区分验证码和没结果', async () => {
    plan = {
      duckduckgo: { results: [], bodyText: 'Verify you are human 请输入验证码' },
      bing: { results: [], bodyText: '普通页面，就是没搜到东西' }
    }

    const result = await searchViaBrowser('事件分发器', 5, FAST)

    expect(result.success).toBe(false)
    expect(result.error).toContain('duckduckgo')
    expect(result.error).toContain('人机验证')
    expect(result.error).toContain('bing')
    expect(result.error).toContain('没有结果')
  })
})

/**
 * 隐藏窗口只有一个，而搜索是「导航 → 轮询几秒 → 读结果」。
 * 不排队的话后来那次会把前一次正在等的页面顶掉。
 */
describe('并发', () => {
  /**
   * 这是这组里最要紧的一条。
   *
   * 出事的样子不是报错，是**两次搜索各自都「成功」了，其中一次拿的是别人的结果**。
   * 调用方没有任何办法发现，模型会拿着它一路错下去。
   */
  it('两次搜索同时进来，各自拿到自己那次的结果', async () => {
    planByQuery = {
      蓝图通信: {
        results: [{ title: '蓝图通信的结果', url: 'https://a.example/', snippet: '' }],
        bodyText: ''
      },
      材质编辑器: {
        results: [{ title: '材质编辑器的结果', url: 'https://b.example/', snippet: '' }],
        bodyText: ''
      }
    }

    const [first, second] = await Promise.all([
      searchViaBrowser('蓝图通信', 5, FAST),
      searchViaBrowser('材质编辑器', 5, FAST)
    ])

    expect(first.items?.[0].title).toBe('蓝图通信的结果')
    expect(second.items?.[0].title).toBe('材质编辑器的结果')
    // 排队不该把窗口复用也一起弄丢
    expect(created).toHaveLength(1)
  })

  /** 队尾吞掉失败，否则一次挂掉之后**后面每一次**搜索都跟着挂 */
  it('前一次全挂不影响后一次', async () => {
    plan = { duckduckgo: { results: [], bodyText: '什么都没有' } }
    const failed = await searchViaBrowser('搜不到的东西', 5, FAST)
    expect(failed.success).toBe(false)

    plan = { duckduckgo: { results: RESULTS, bodyText: '' } }
    const after = await searchViaBrowser('事件分发器', 5, FAST)
    expect(after.success).toBe(true)
  })
})
