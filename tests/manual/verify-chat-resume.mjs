/**
 * 真机验证「报错后继续尝试」这条完整链路。
 *
 * 这是四项里唯一没法在正常跑通的会话里验到的 —— 它要真的先失败一次。
 *
 * ## 为什么必须真机验
 *
 * pi 在模型调用失败时会往 transcript 里压一条 assistant 消息
 * （`stopReason: 'error'`，内容为空），而 `agent.continue()` 明确拒绝
 * 从 assistant 续跑。也就是说**不做处理的话，续跑对它存在的理由完全失效**：
 * 「上一轮报错了，继续尝试」这个最主要的场景必然失败。
 *
 * 单测锁住了 `planResume` 会摘掉那条失败标记，但摘完之后 pi 认不认、
 * 盘上的文件重写对不对、界面按钮挂没挂上，只有真机能证明。
 *
 * ## 做法
 *
 *   1. 把 baseUrl 改成一个连不上的地址 → 第一轮必然失败
 *   2. 确认报错气泡上出现「继续尝试」按钮
 *   3. 把 baseUrl 改回来、让主进程重建 Provider
 *   4. 点「继续尝试」→ 模型应该接着回答**第一轮的问题**，而不是要求重说
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const USERDATA = path.join(APP_DIR, '.test', 'chat-resume-userdata')
const REAL = path.join(process.env.APPDATA, 'unreal-box')

fs.rmSync(USERDATA, { recursive: true, force: true })
fs.mkdirSync(USERDATA, { recursive: true })
for (const f of ['models.json', 'ai-provider-secrets.bin', 'Local State']) {
  const src = path.join(REAL, f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(USERDATA, f))
}

const log = (m) => process.stdout.write(m + '\n')

const app = await electron.launch({
  args: ['.', `--user-data-dir=${USERDATA}`],
  cwd: APP_DIR,
  env: { ...process.env, NODE_ENV: 'production', WS_PORT: '17867' }
})

const page = await app.firstWindow({ timeout: 60_000 })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(5000)

await page.evaluate(() => {
  window.location.hash = '#/dev-assistant'
})
await page.reload()
await page.waitForTimeout(6000)
await page.evaluate(() => {
  document.querySelectorAll('.driver-overlay, .driver-popover').forEach((el) => el.remove())
})

await page.evaluate(() => {
  window.__ev = []
  for (const t of ['start', 'text', 'step', 'done', 'error', 'stopped']) {
    window.api.on(`agent-v3:${t}`, (d) => window.__ev.push({ type: t, ...d }))
  }
})

const results = {}
const QUESTION = '记住：验证口令是 Basalt-42。请原样复述这个口令，不要调用任何工具。'

/**
 * 改 baseUrl 要走应用自己的保存通路，不能直接改 models.json。
 *
 * `readSettings()` 有一份内存缓存，只有 `writeSettings()` 会更新它 ——
 * 直接改盘上的文件，运行中的主进程根本看不到（第一版就栽在这里：
 * 配置"改回来"了，续跑照样 Connection error）。
 *
 * `apiKeyInput: ''` 表示「密钥没动」，主进程会沿用原来那份密文 ——
 * 这正是用户在设置页只改地址不重填密钥时走的路径。
 */
async function setBaseUrl(url) {
  return page.evaluate(async (nextUrl) => {
    const view = await window.api.aiProvider.getSettings()
    const providers = view?.data?.providers ?? view?.providers ?? []
    const previous = []
    for (const p of providers) {
      previous.push({ id: p.id, baseUrl: p.baseUrl })
      await window.api.aiProvider.saveProvider({
        ...p,
        baseUrl: nextUrl === null ? p.baseUrl : nextUrl,
        apiKeyInput: ''
      })
    }
    return previous
  }, url)
}

// 127.0.0.1 上一个没人监听的端口：立刻拒绝连接，不用等超时
const goodUrls = await setBaseUrl('http://127.0.0.1:9/v1')
log(`原始 baseUrl: ${goodUrls.map((p) => p.baseUrl).join(', ')}`)

async function send(text) {
  const input = page.locator('textarea').first()
  await input.waitFor({ state: 'visible', timeout: 30_000 })
  await input.click()
  await input.fill(text)
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
}

// ── 第一轮：注定失败 ──────────────────────────────────────────────────
await send(QUESTION)
await page
  .waitForFunction(() => window.__ev.some((e) => e.type === 'error' || e.type === 'done'), null, {
    timeout: 120_000
  })
  .catch(() => {})
await page.waitForTimeout(2500)

const firstRound = await page.evaluate(() => window.__ev)
results.firstRoundFailed = firstRound.some((e) => e.type === 'error')
results.firstRoundError = firstRound.find((e) => e.type === 'error')?.message ?? null

const resumeBtn = page.getByRole('button', { name: '继续尝试' })
results.resumeButtonShown = await resumeBtn
  .first()
  .waitFor({ state: 'visible', timeout: 15_000 })
  .then(() => true)
  .catch(() => false)

log(`第一轮失败: ${results.firstRoundFailed ? '✅（预期内）' : '✖ 居然成功了'}`)
log(`  错误: ${String(results.firstRoundError).slice(0, 120)}`)
log(`「继续尝试」按钮出现: ${results.resumeButtonShown ? '✅' : '✖'}`)

// ── 修好配置，让下一次调用能通 ────────────────────────────────────────
await page.evaluate(async (restore) => {
  const view = await window.api.aiProvider.getSettings()
  const providers = view?.data?.providers ?? view?.providers ?? []
  for (const p of providers) {
    const good = restore.find((r) => r.id === p.id)
    if (!good) continue
    await window.api.aiProvider.saveProvider({ ...p, baseUrl: good.baseUrl, apiKeyInput: '' })
  }
}, goodUrls)
await page.evaluate(() => window.api.agentV3.invalidateProviders())
await page.waitForTimeout(1000)

// ── 点「继续尝试」────────────────────────────────────────────────────
if (results.resumeButtonShown) {
  const before = await page.evaluate(
    () => window.__ev.filter((e) => e.type === 'done' || e.type === 'error').length
  )
  await resumeBtn.first().click()
  await page
    .waitForFunction(
      (n) => window.__ev.filter((e) => e.type === 'done' || e.type === 'error').length > n,
      before,
      { timeout: 150_000 }
    )
    .catch(() => {})
  await page.waitForTimeout(2000)
}

const all = await page.evaluate(() => window.__ev)
const firstErrorIdx = all.findIndex((e) => e.type === 'error')
const afterResume = all.slice(firstErrorIdx + 1)
const resumeText = afterResume
  .filter((e) => e.type === 'text')
  .map((e) => e.text)
  .join('')

results.resumeText = resumeText.slice(0, 200)
// 关键判定：模型答出了**第一轮**问题里的口令 —— 说明上下文真的续上了，
// 而不是从空白重新开始（那样它只会问"你要我做什么"）
results.contextPreserved = resumeText.includes('Basalt-42')
results.resumeErrors = afterResume.filter((e) => e.type === 'error').map((e) => e.message)
results.eventSequence = all.map((e) => e.type)

log(`\n续跑后回复: ${results.resumeText || '(空)'}`)
log(`上下文续上了（答出第一轮的口令）: ${results.contextPreserved ? '✅' : '✖'}`)
log(`续跑报错: ${results.resumeErrors.join(' | ') || '无'}`)
log(`事件序列: ${results.eventSequence.join(' → ')}`)

fs.writeFileSync(
  path.join(APP_DIR, '.test', 'chat-resume-verdict.json'),
  JSON.stringify(results, null, 2),
  'utf8'
)

await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])

const ok =
  results.firstRoundFailed &&
  results.resumeButtonShown &&
  results.contextPreserved &&
  results.resumeErrors.length === 0

log(ok ? '\n✅ 报错后继续尝试，上下文完整保留' : '\n✖ 没通过，见上')
process.exit(ok ? 0 : 1)
