/**
 * 真机验证 `/dev-assistant` 聊天页跑得通一整轮 V3 对话。
 *
 * 这条是用户实际用的路径，和调试台不是同一条：
 *   调试台  → window.api.agentV3.execute（preload 封装）
 *   聊天页  → Welcome.vue → useAgentMode → aiAPI.executeAgent → 全局分发器
 *
 * 之前聊天页走的是 `ipcRenderer.invoke('agent-v3:execute')`，
 * 而那个通道不在 preload 的 RAW_REQUEST_CHANNELS 白名单里，
 * **一发消息就报「Blocked invoke channel」**，V3 在聊天页从来没通过。
 * 单测能锁住"调的是封装"，但只有真机能证明整条链路真的跑得起来。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const USERDATA = path.join(APP_DIR, '.test', 'chat-userdata')
const REAL = path.join(process.env.APPDATA, 'unreal-box')

// 'Local State' 必须一起拷 —— Windows 上 safeStorage 的主密钥存在那里
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
  env: { ...process.env, NODE_ENV: 'production', WS_PORT: '17864' }
})

const page = await app.firstWindow({ timeout: 60_000 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(5000)

// 进聊天页
await page.evaluate(() => {
  window.location.hash = '#/dev-assistant'
})
await page.waitForTimeout(4000)
log(`当前路由: ${await page.evaluate(() => window.location.hash)}`)

// 挂上事件采集
await page.evaluate(() => {
  window.__ev = []
  for (const t of [
    'start',
    'text',
    'thinking',
    'tool-call',
    'tool-result',
    'step',
    'done',
    'error',
    'stopped'
  ]) {
    window.api.on(`agent-v3:${t}`, (d) => window.__ev.push({ type: t, ...d }))
  }
})

// 真的在输入框里打字、点发送 —— 这才是用户的路径。
// 直接调 window.api.agentV3 只能证明通道通，证明不了界面接对了。
const PROMPT = '你是什么模型？一句话回答，不要调用任何工具。'

const input = page
  .locator('textarea, [contenteditable="true"]')
  .filter({ hasNot: page.locator('[disabled]') })
  .first()

await input.waitFor({ state: 'visible', timeout: 30_000 })
await input.click()
await input.fill?.(PROMPT).catch(async () => {
  await page.keyboard.type(PROMPT)
})
await page.waitForTimeout(500)
await page.keyboard.press('Enter')
const started = { via: '界面输入框 + 回车' }

log(`发起方式: ${started.via}`)

await page
  .waitForFunction(
    () =>
      window.__ev.some(
        (e) => e.type === 'done' || e.type === 'error' || e.type === 'startup-error'
      ),
    null,
    { timeout: 180_000 }
  )
  .catch(() => {})

const events = await page.evaluate(() => window.__ev)
const text = events
  .filter((e) => e.type === 'text')
  .map((e) => e.text)
  .join('')
const errors = events.filter((e) => e.type === 'error' || e.type === 'startup-error')
const blocked = consoleErrors.filter((e) => e.includes('Blocked invoke channel'))

log(`\n事件序列: ${events.map((e) => e.type).join(' → ') || '(无)'}`)
log(`模型回复: ${text.slice(0, 160) || '(空)'}`)
log(`错误事件: ${errors.map((e) => e.message).join(' | ') || '无'}`)
log(
  `\n「Blocked invoke channel」: ${blocked.length ? '✖ 仍有 ' + blocked.length + ' 条 → ' + blocked[0] : '✅ 没有了'}`
)

fs.writeFileSync(
  path.join(APP_DIR, '.test', 'chat-ui-verdict.json'),
  JSON.stringify(
    {
      via: started.via,
      events: events.map((e) => e.type),
      text: text.slice(0, 300),
      errors,
      blocked
    },
    null,
    2
  ),
  'utf8'
)

await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
const ok = blocked.length === 0 && errors.length === 0 && text.trim().length > 0
log(ok ? '\n✅ 聊天页跑通一整轮' : '\n✖ 没跑通')
process.exit(ok ? 0 : 1)
