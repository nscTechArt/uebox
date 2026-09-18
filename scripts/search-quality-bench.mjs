/**
 * 检索质量基准。
 *
 * ## 这个脚本存在的理由
 *
 * 检索能力的问题**测不出来在解析层**。上一版的 `webSearch.test.ts` 全绿，而工具
 * 本身在给模型喂银行官网和桌宠项目 —— 因为解析是对的，错的是解析出来的东西。
 * 单测打桩 fetch，永远发现不了这件事。
 *
 * 所以换后端、改 provider、调判据之后，**必须跑一次真实网络的基准**，看命中率
 * 有没有掉。这是人工验收门，不是自动门。
 *
 * ## 为什么不进 pnpm verify
 *
 * 它依赖外网，而且依赖的正是那些会限频、会下人机验证的第三方站点。放进门禁
 * 等于让 CI 的成败取决于别人的心情 —— 那种门禁只会被人学会忽略。
 *
 * ## 跑法
 *
 *   node scripts/search-quality-bench.mjs --jina <key>
 *   node scripts/search-quality-bench.mjs --searxng http://localhost:8080
 *   JINA_API_KEY=xxx node scripts/search-quality-bench.mjs --searxng http://localhost:8080
 *
 * **故意不 import 产品里的 `searchWeb`**：那条路要经过 `ai/jinaKey`，而取密钥
 * 依赖 Electron 的 safeStorage，在裸 Node 里跑不起来。这个脚本量的是**后端本身
 * 的质量**，直接打后端反而更准 —— 中间少一层，出了问题不用猜是谁的错。
 *
 * ## 怎么看结果
 *
 * 关注两个数，别只看命中率：
 *
 *   1. **命中率** —— 有答案的用例里，前 5 条是否出现了期望的来源；
 *   2. **乱码用例必须返回 0 条**。这一条比命中率更重要：返回垃圾的后端会让
 *      模型拿着噪声当事实，比搜不到坏得多。
 */
import { judgeResults } from '../src/main/services/searchRelevance.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

/**
 * 固定用例。**别随便改** —— 改了就没法和历史结果比。
 *
 * 每一条都对应一类真实失效场景，`expect` 是「合格答案应该来自哪些站点」。
 * `null` 表示这条**不该有答案**，返回任何结果都算失败。
 */
const CASES = [
  {
    tag: 'zh-tech',
    query: '虚幻引擎 蓝图 事件分发器 教程',
    expect: /unreal\s?engine|epicgames|zhihu|csdn|bilibili|openhutb|虚幻/i
  },
  {
    tag: 'en-api',
    query: '"FObjectFinder" "ConstructorHelpers" Unreal C++',
    expect: /unreal\s?engine|epicgames|stackoverflow|github/i
  },
  {
    tag: 'en-topic',
    query: 'Unreal Engine 5.5 Lumen global illumination release notes',
    expect: /unreal\s?engine|epicgames|lumen/i
  },
  { tag: 'site-op', query: 'site:dev.epicgames.com nanite', expect: /dev\.epicgames\.com/i },
  {
    tag: 'fact',
    query: 'What is the tallest mountain in the world',
    expect: /everest|wikipedia|britannica|珠穆朗玛|highest mountain/i
  },
  {
    tag: 'zh-life',
    query: '如何正确泡一杯龙井茶',
    expect: /茶|龙井|zhihu|baike|bilibili|xiaohongshu/i
  },
  { tag: 'gibberish', query: 'qzxwvba83yrh9k4nmg zzz nothing here', expect: null }
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 产品当前默认走的后端 */
function viaJina(apiKey) {
  return async (query) => {
    const response = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'X-Respond-With': 'no-content'
      }
    })
    if (response.status !== 200) return { error: `HTTP ${response.status}`, items: [] }
    const body = await response.json()
    const items = (body.data ?? []).slice(0, 5).map((row) => ({
      title: String(row.title ?? ''),
      url: String(row.url ?? ''),
      snippet: String(row.description ?? '')
    }))
    return { items }
  }
}

/** 本地 SearXNG，用于横向对比。需要实例打开 `formats: [html, json]` */
function viaSearxng(base) {
  return async (query) => {
    const response = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
      headers: { Accept: 'application/json', 'User-Agent': UA }
    })
    if (response.status !== 200) return { error: `HTTP ${response.status}`, items: [] }
    const body = await response.json()
    const items = (body.results ?? []).slice(0, 5).map((row) => ({
      title: row.title ?? '',
      url: row.url ?? '',
      snippet: row.content ?? ''
    }))
    // SearXNG 会逐个报告哪个上游引擎挂了 —— 排查「今天为什么变差了」全靠它
    const down = (body.unresponsive_engines ?? []).map((e) => (Array.isArray(e) ? e.join(':') : e))
    return { items, down }
  }
}

async function runBackend(name, search) {
  console.log(`\n======== ${name} ========`)
  let hit = 0
  let answerable = 0
  let gibberishLeaked = 0

  for (const { tag, query, expect } of CASES) {
    const started = Date.now()
    let outcome
    try {
      outcome = await search(query)
    } catch (error) {
      console.log(`  [${tag}] 异常 ${error.message}`)
      continue
    }
    const ms = Date.now() - started
    const items = outcome.items ?? []

    if (expect === null) {
      // 乱码查询返回任何东西都是失败：那说明后端在「没答案时编内容」
      if (items.length > 0) gibberishLeaked = items.length
      console.log(
        `  [${tag}] ${items.length === 0 ? '✅ 正确返回 0 条' : `❌ 返回了 ${items.length} 条垃圾`}` +
          ` — ${ms}ms${outcome.error ? `（${outcome.error.slice(0, 40)}）` : ''}`
      )
      items.slice(0, 2).forEach((i) => console.log(`        · ${i.title.slice(0, 50)} | ${i.url}`))
      continue
    }

    answerable++
    const ok = items.some((i) => expect.test(`${i.title} ${i.url}`))
    if (ok) hit++
    const unclear = judgeResults(query, items).items.filter((i) => i.relevance === 'unclear').length
    console.log(
      `  [${tag}] ${ok ? 'HIT ' : 'MISS'} — ${items.length} 条，${unclear} 条存疑，${ms}ms` +
        (outcome.error ? `（${outcome.error.slice(0, 50)}）` : '')
    )
    items.slice(0, 3).forEach((i) => console.log(`        · ${i.title.slice(0, 50)} | ${i.url}`))
    if (outcome.down?.length) console.log(`        挂掉的上游引擎：${outcome.down.join(' / ')}`)

    await sleep(1500)
  }

  console.log(
    `  => ${name}：${answerable} 个有答案的用例命中 ${hit} 个；` +
      `乱码用例${gibberishLeaked ? `漏出 ${gibberishLeaked} 条 ❌` : '干净 ✅'}`
  )
  return { hit, answerable, gibberishLeaked }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : ''
}

const jinaKey = argValue('--jina') || process.env.JINA_API_KEY || ''
const searxngBase = argValue('--searxng')

if (!jinaKey && !searxngBase) {
  console.error(
    [
      '没有指定任何后端。用法：',
      '  node scripts/search-quality-bench.mjs --jina <key>',
      '  node scripts/search-quality-bench.mjs --searxng http://localhost:8080'
    ].join('\n')
  )
  process.exit(1)
}

if (jinaKey) await runBackend('Jina（产品当前默认）', viaJina(jinaKey))
if (searxngBase) await runBackend(`SearXNG ${searxngBase}`, viaSearxng(searxngBase))

console.log(
  '\n提示：命中率会随搜索引擎当天的状态浮动，别把单次结果当结论。' +
    '真正的红线是乱码用例 —— 它一旦漏出内容，说明后端在没答案时编东西。'
)
