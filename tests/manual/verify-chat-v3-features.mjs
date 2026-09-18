/**
 * 真机验证这一轮给聊天页接上的 V3 能力。
 *
 * 单测能锁住每一块的行为，但锁不住「它们在真界面上串起来还成立」——
 * 这里跑的是用户的路径：在输入框里打字、回车、看屏幕。
 *
 * 验四件事：
 *
 *   ① 多轮记忆 —— 之前每轮 `crypto.randomUUID()` 现开一个会话 ID，而 V3 按
 *      sessionId 恢复 transcript，等于每发一条消息就换一个全新的 agent。
 *      界面又只把最新一条用户消息发过去，结果模型完全不记得上一轮。
 *      这是最重的一条，必须真机确认。
 *   ② 上下文用量 —— 内核推来的真数取代了渲染层的估算
 *   ③ 插话按钮 —— 生成中出现，且不打断执行
 *   ④ 「继续尝试」—— 报错气泡上挂得出按钮（这条只在真报错时才能验，
 *      正常跑通时记为「本轮未触发」而不是通过）
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const USERDATA = path.join(APP_DIR, '.test', 'chat-v3-userdata')
const REAL = path.join(process.env.APPDATA, 'unreal-box')

// 'Local State' 必须一起拷 —— Windows 上 safeStorage 的主密钥存在那里，
// 少了它密钥解不开，整条链路会静默退化成 401
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
  env: { ...process.env, NODE_ENV: 'production', WS_PORT: '17866' }
})

const page = await app.firstWindow({ timeout: 60_000 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(5000)

await page.evaluate(() => {
  window.location.hash = '#/dev-assistant'
})
await page.reload()
await page.waitForTimeout(6000)

// 引导可能已经起来了，把残留的遮罩摘掉
await page.evaluate(() => {
  document.querySelectorAll('.driver-overlay, .driver-popover').forEach((el) => el.remove())
  document.body.classList.remove('driver-active', 'driver-fade')
})
log(`路由: ${await page.evaluate(() => window.location.hash)}`)

// 采集事件 + 记录每轮用的会话 ID（① 靠它判定）
await page.evaluate(() => {
  window.__ev = []
  window.__sessions = new Set()
  const types = [
    'start',
    'text',
    'tool-call',
    'tool-result',
    'step',
    'done',
    'error',
    'stopped',
    'context-usage'
  ]
  for (const t of types) {
    window.api.on(`agent-v3:${t}`, (d) => {
      window.__ev.push({ type: t, ...d })
      if (d?.sessionId) window.__sessions.add(d.sessionId)
    })
  }
})

const composer = () =>
  page
    .locator('textarea, [contenteditable="true"]')
    .filter({ hasNot: page.locator('[disabled]') })
    .first()

async function send(text) {
  const input = composer()
  await input.waitFor({ state: 'visible', timeout: 30_000 })
  await input.click()
  await input.fill(text)
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
}

async function waitForTurn(afterCount) {
  await page
    .waitForFunction(
      (n) =>
        window.__ev.filter((e) => e.type === 'done' || e.type === 'error' || e.type === 'stopped')
          .length > n,
      afterCount,
      { timeout: 180_000 }
    )
    .catch(() => {})
}

const results = {}

// ── ⓪ 权限选择器：摆在输入框底部 ─────────────────────────────────────
results.approvalTriggerText = await page
  .locator('.approval-selector .mode-trigger-label')
  .first()
  .textContent()
  .then((t) => (t || '').trim())
  .catch(() => '')

await page
  .locator('.approval-selector .mode-trigger')
  .first()
  .click({ timeout: 10_000 })
  .catch(() => {})
await page.waitForTimeout(600)
results.approvalOptions = await page
  .locator('.approval-dropdown .mode-option-name')
  .allTextContents()
  .catch(() => [])

// 选一档非默认的，确认它真的记住了（而不是点完弹回原样）
await page
  .locator('.approval-dropdown .mode-option')
  .first()
  .click({ timeout: 10_000 })
  .catch(() => {})
await page.waitForTimeout(600)
results.approvalAfterPick = await page
  .locator('.approval-selector .mode-trigger-label')
  .first()
  .textContent()
  .then((t) => (t || '').trim())
  .catch(() => '')

// 「完全访问权限」要先过一道二次确认 —— 取消之后档位不该变
await page
  .locator('.approval-selector .mode-trigger')
  .first()
  .click({ timeout: 10_000 })
  .catch(() => {})
await page.waitForTimeout(500)
await page
  .locator('.approval-dropdown .mode-option')
  .nth(3)
  .click({ timeout: 10_000 })
  .catch(() => {})
results.fullAccessConfirmShown = await page
  .locator('.full-access-title')
  .first()
  .waitFor({ state: 'visible', timeout: 10_000 })
  .then(() => true)
  .catch(() => false)
results.fullAccessScopes = await page
  .locator('.full-access-item-title')
  .allTextContents()
  .catch(() => [])

await page
  .locator('.full-access-actions button')
  .first()
  .click({ timeout: 10_000 })
  .catch(() => {})
await page.waitForTimeout(600)
results.approvalAfterCancel = await page
  .locator('.approval-selector .mode-trigger-label')
  .first()
  .textContent()
  .then((t) => (t || '').trim())
  .catch(() => '')

// 换回推荐档再往下跑：「请求批准」会让后面每个写操作都卡在弹窗上
await page
  .locator('.approval-selector .mode-trigger')
  .first()
  .click({ timeout: 10_000 })
  .catch(() => {})
await page.waitForTimeout(500)
await page
  .locator('.approval-dropdown .mode-option')
  .nth(1)
  .click({ timeout: 10_000 })
  .catch(() => {})
await page.waitForTimeout(500)

// ── ① 多轮记忆 ────────────────────────────────────────────────────────
// 用一个模型不可能猜到的代号：答对只能是因为它真的看到了上一轮
const CODE = 'Kraken-7'
await send(`记住一个代号：${CODE}。只回复"好的"两个字，不要调用任何工具。`)
await waitForTurn(0)
await page.waitForTimeout(1500)

// 生成中截一眼插话按钮（② ③ 在第二轮里看，这里先记第一轮的会话 ID）
const sessionsAfterTurn1 = await page.evaluate(() => [...window.__sessions])

await send('我刚才让你记的代号是什么？原样回答，不要调用任何工具。')

// ── ③ 插话按钮：生成中应该出现 ─────────────────────────────────────────
// 这一问的回复很短，等固定时长有可能等到这一轮已经结束 —— 按出现与否来等
results.steerButtonVisible = await page
  .locator('.steer-btn')
  .waitFor({ state: 'visible', timeout: 15_000 })
  .then(() => true)
  .catch(() => false)
results.steerPlaceholder = await page
  .locator('textarea')
  .first()
  .getAttribute('placeholder')
  .catch(() => null)
// 运行状态不再额外占一行说明，插话入口保留在带文字的按钮上
results.steerBannerHidden = (await page.locator('.steer-banner').count()) === 0
results.steerButtonLabel = await page
  .locator('.steer-btn-label')
  .first()
  .textContent()
  .then((t) => (t || '').trim())
  .catch(() => '')
// 没出现时把当时的状态捞出来，否则只知道"没看见"，不知道卡在哪一步
results.steerDiagnostics = await page.evaluate(() => ({
  stopBtn: !!document.querySelector('.stop-btn'),
  sendBtn: !!document.querySelector('.send-btn'),
  steerBtn: !!document.querySelector('.steer-btn'),
  typingBubbles: document.querySelectorAll('.ai-bubble').length
}))

await waitForTurn(1)
await page.waitForTimeout(1500)

const events = await page.evaluate(() => window.__ev)
const sessions = await page.evaluate(() => [...window.__sessions])

// 第二轮的回复文本
const doneIdx = events.findIndex((e) => e.type === 'done')
const secondTurnText = events
  .slice(doneIdx + 1)
  .filter((e) => e.type === 'text')
  .map((e) => e.text)
  .join('')

results.sessionIds = sessions
results.sessionStable = sessions.length === 1
results.recalled = secondTurnText.includes(CODE)
results.secondTurnText = secondTurnText.slice(0, 200)

/**
 * ⑤ 过程日志不编造内容。
 *
 * 这两轮都是纯问答，模型一个工具都没调 —— 那就**不该有过程日志**。
 * 以前会先塞一条随机文案（「匹配合适的专家」，V3 根本没有专家这个概念）
 * 再跟一条「正在执行第 1/999 步」（999 是界面自己编的分母），
 * 于是没发生任何事的一轮也顶着一个煞有介事的进度框。
 */
results.processLogCount = await page
  .locator('.agent-process-log')
  .count()
  .catch(() => -1)
results.processLogText = await page
  .locator('.agent-process-log')
  .allTextContents()
  .then((all) => all.join(' | '))
  .catch(() => '')

// ── ② 上下文用量 ──────────────────────────────────────────────────────
const usageEvents = events.filter((e) => e.type === 'context-usage')
results.usageEventCount = usageEvents.length
results.lastUsage = usageEvents.at(-1) ?? null
results.usageIndicatorVisible = await page
  .locator('.context-ring')
  .isVisible()
  .catch(() => false)
// 圆环上**不该有文字** —— 输入框那一排已经够挤，数字放悬停卡片里
results.ringHasNoText =
  (await page
    .locator('.context-ring')
    .first()
    .textContent()
    .then((t) => (t || '').trim())
    .catch(() => 'x')) === ''
// 悬停卡片只有标题 + 数值 + 进度条，没有按钮（点圆环本身就是压缩）
await page
  .locator('.context-ring')
  .first()
  .hover()
  .catch(() => {})
await page.waitForTimeout(1000)
results.usageIndicatorText = await page
  .locator('.context-tip-head')
  .first()
  .textContent()
  .then((t) => (t || '').replace(/\s+/g, ' ').trim())
  .catch(() => null)
results.tipHasNoButton = (await page.locator('.context-usage-tip button').count()) === 0
// 百万窗口写成「1000k」既啰嗦又容易看错位数，厂商自己都写 1M
results.usesMegabyteUnit = !/\d+k \/ \d{3,}k/.test(results.usageIndicatorText || '')

/**
 * 数字得是**真的**。
 *
 * 用量一度只由 compaction 的 `onUsage` 上报，而那个钩子跑在发请求**之前** ——
 * 这一轮第一次调用时 messages 里还没有 assistant 消息，取不到厂商报的
 * input token 数，只能按字符估算用户那一句话，报出来是「4 tokens」。
 * 界面于是永远显示 0%，指示器等于没有。
 *
 * 真实值必然过万：系统提示词 + 几十个工具的定义就不止这个数。
 * 卡在 1000 这条线上，够低不会误报，也够高能挡住那个 4。
 */
results.usageLooksReal = (results.lastUsage?.tokens ?? 0) > 1_000

/**
 * ⑥ 插话要以**普通用户发言**的样子出现在对话里。
 *
 * 原来它只进过程日志（「你插话：xxx」）外加一个飘过去的 toast，用户在对话
 * 本身里看不到自己说过什么 —— 翻上去只有 AI 的独白，完全对不上。
 * 「插话」也是实现细节：对用户来说他就是说了句话，不该被标成另一类。
 *
 * 要一个够长的问题才有时间插进去，所以这里单开一轮。
 */
const STEER_TEXT = '等一下，改成用一句话概括就行'
await send('详细讲讲虚幻引擎的 Nanite 是怎么工作的，讲长一点，分很多点')
results.steerBtnAppeared = await page
  .locator('.steer-btn')
  .waitFor({ state: 'visible', timeout: 30_000 })
  .then(() => true)
  .catch(() => false)
await page.waitForTimeout(1200)

if (results.steerBtnAppeared) {
  const input = composer()
  await input.click()
  await input.fill(STEER_TEXT)
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
}

/**
 * 注意：**DOM 里是新消息在前**。
 *
 * ChatLog 渲染的是 `reversedMessages`，再靠 CSS 把每一项翻回来（那是为了
 * 让滚动条天然贴底）。所以「插话排在原提问后面」在 DOM 里表现为
 * 插话的下标**更小**。照直觉写成 `>` 会得到一个恒假的判定。
 */
results.userBubbles = await page.evaluate(() =>
  [...document.querySelectorAll('[class*="user-bubble"]')].map((el) =>
    (el.textContent || '').trim().slice(0, 40)
  )
)
results.steerShownAsUser = results.userBubbles.some((t) => t.includes('一句话概括'))
results.steerInOrder =
  results.userBubbles.findIndex((t) => t.includes('一句话概括')) <
  results.userBubbles.findIndex((t) => t.includes('Nanite'))
// 「你插话：」那条过程日志不该再出现
results.steerNotInProcessLog = !(
  await page
    .locator('.agent-process-log')
    .allTextContents()
    .catch(() => [])
)
  .join(' ')
  .includes('插话')

await page
  .locator('.stop-btn')
  .first()
  .click({ timeout: 5_000 })
  .catch(() => {})
await page.waitForTimeout(1500)

// ── ④ 继续尝试：只在真报错时才会出现 ─────────────────────────────────
results.errorEvents = events.filter((e) => e.type === 'error').map((e) => e.message)
results.resumeButtonPresent = await page
  .getByRole('button', { name: '继续尝试' })
  .count()
  .catch(() => 0)

results.blocked = consoleErrors.filter((e) => e.includes('Blocked invoke channel'))

log('\n────────── 结果 ──────────')
log(`⓪ 权限选择器`)
log(`   默认显示: 「${results.approvalTriggerText || '(没找到)'}」`)
log(`   四档选项: ${results.approvalOptions.join(' / ') || '(展不开)'}`)
log(`   选完记住: 「${results.approvalAfterPick || '(没变)'}」`)
log(`   完全访问权限弹二次确认: ${results.fullAccessConfirmShown ? '✅' : '✖'}`)
log(`   弹窗列出的范围: ${results.fullAccessScopes.join(' / ') || '(空)'}`)
log(
  `   取消后档位不变: ${
    results.approvalAfterCancel === results.approvalAfterPick
      ? '✅'
      : `✖ 变成了「${results.approvalAfterCancel}」`
  }`
)
log(`① 多轮记忆`)
log(`   会话 ID: ${results.sessionIds.join(', ')}`)
log(`   跨轮保持同一个: ${results.sessionStable ? '✅' : '✖ 每轮都在换'}`)
log(`   第二轮答出代号 ${CODE}: ${results.recalled ? '✅' : '✖'}`)
log(`   第二轮回复: ${results.secondTurnText || '(空)'}`)
log(`② 上下文用量`)
log(`   收到 context-usage 事件: ${results.usageEventCount} 条`)
log(
  `   最后一条: ${results.lastUsage ? `${results.lastUsage.tokens} / ${results.lastUsage.contextWindow}` : '(无)'}`
)
log(`   圆环可见: ${results.usageIndicatorVisible ? '✅' : '✖'}`)
log(`   圆环上没有文字: ${results.ringHasNoText ? '✅' : '✖'}`)
log(`   悬停卡片: ${results.usageIndicatorText ?? '(没出来)'}`)
log(`   卡片里没有按钮（点圆环即压缩）: ${results.tipHasNoButton ? '✅' : '✖'}`)
log(`   窗口写成 1M 而不是 1000k: ${results.usesMegabyteUnit ? '✅' : '✖'}`)
log(`   数字是真的（不是发请求前那个几十 token 的估算）: ${results.usageLooksReal ? '✅' : '✖'}`)
log(`③ 插话`)
log(`   生成中插话按钮可见: ${results.steerButtonVisible ? '✅' : '✖'}`)
log(`   按钮文字: 「${results.steerButtonLabel || '(只有图标)'}」`)
log(`   说明横幅已移除: ${results.steerBannerHidden ? '✅' : '✖'}`)
log(`   生成中输入框提示: ${results.steerPlaceholder ?? '(读不到)'}`)
log(`   当时的按钮状态: ${JSON.stringify(results.steerDiagnostics)}`)
log(`⑥ 插话按普通发言显示`)
log(`   用户气泡（DOM 里新的在前）: ${results.userBubbles.join(' ← ') || '(没有)'}`)
log(`   插话出现在用户侧: ${results.steerShownAsUser ? '✅' : '✖ 界面上看不到'}`)
log(`   排在原提问后面: ${results.steerInOrder ? '✅' : '✖ 顺序反了'}`)
log(`   不再进过程日志: ${results.steerNotInProcessLog ? '✅' : '✖ 还标着「你插话」'}`)
log(`⑤ 过程日志不编造内容`)
log(
  `   没调工具的一轮不显示过程框: ${
    results.processLogCount === 0 ? '✅' : `✖ 还有 ${results.processLogCount} 个`
  }`
)
if (results.processLogText) log(`   框里的内容: ${results.processLogText.slice(0, 160)}`)
log(`④ 继续尝试`)
log(
  results.errorEvents.length
    ? `   本轮报错 ${results.errorEvents.length} 次，按钮数: ${results.resumeButtonPresent}`
    : `   — 本轮没报错，这条没被触发（不算通过）`
)
log(
  `\n「Blocked invoke channel」: ${results.blocked.length ? '✖ ' + results.blocked[0] : '✅ 无'}`
)

fs.writeFileSync(
  path.join(APP_DIR, '.test', 'chat-v3-features-verdict.json'),
  JSON.stringify(results, null, 2),
  'utf8'
)

await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])

// ④ 不参与判定：它要真报错才能验，正常跑通时无从触发
const ok =
  results.approvalOptions.length === 4 &&
  !!results.approvalTriggerText &&
  results.approvalAfterPick !== results.approvalTriggerText &&
  results.fullAccessConfirmShown &&
  results.fullAccessScopes.length === 3 &&
  results.approvalAfterCancel === results.approvalAfterPick &&
  results.sessionStable &&
  results.recalled &&
  results.usageEventCount > 0 &&
  results.usageIndicatorVisible &&
  results.ringHasNoText &&
  results.tipHasNoButton &&
  results.usesMegabyteUnit &&
  results.usageLooksReal &&
  results.processLogCount === 0 &&
  results.steerButtonVisible &&
  results.steerBannerHidden &&
  !!results.steerButtonLabel &&
  results.steerShownAsUser &&
  results.steerInOrder &&
  results.steerNotInProcessLog &&
  results.blocked.length === 0

log(ok ? '\n✅ 全部通过' : '\n✖ 有没通过的项，见上')
void sessionsAfterTurn1
process.exit(ok ? 0 : 1)
