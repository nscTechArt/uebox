/**
 * 真机验证：设置页的三个面板点得开，而且点完之后界面还活着。
 *
 * 起因是 `aiProvider.onOAuthDeviceCode` 只写在 preload 的 .d.ts 里、
 * 没有真的实现。它在 `AIProviderSettings.vue` 的 onMounted 里被调用，
 * 抛出去中断了 Vue 的 post-flush 队列 —— 后果不是"这个面板打不开"，
 * 而是**整个应用界面不再更新**，从「模型」页蔓延到旁边几个无关的设置页。
 *
 * 所以这里不只看面板渲染出来没有，更要看**界面还响不响应** ——
 * 卡死时 DOM 还在，只是不再重绘，光看截图分辨不出来。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const USERDATA = path.join(APP_DIR, '.test', 'prefs-userdata')

fs.rmSync(USERDATA, { recursive: true, force: true })
fs.mkdirSync(USERDATA, { recursive: true })

const log = (m) => process.stdout.write(m + '\n')

const app = await electron.launch({
  args: ['.', `--user-data-dir=${USERDATA}`],
  cwd: APP_DIR,
  env: { ...process.env, NODE_ENV: 'production', WS_PORT: '17868' }
})

const page = await app.firstWindow({ timeout: 60_000 })
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(5000)

await page.evaluate(() => {
  window.location.hash = '#/preferences'
})
await page.reload()
await page.waitForTimeout(6000)
await page.evaluate(() => {
  document.querySelectorAll('.driver-overlay, .driver-popover').forEach((el) => el.remove())
})

/**
 * `menu` 是侧栏上的文字，`title` 是面板头部的标题 —— 两者**不一定相同**
 * （MCP 那项侧栏写「MCP 设置」，面板标题是「接入外部 MCP 服务」）。
 * 判定要看面板标题，所以两个都得写死。
 */
const PANELS = [
  { menu: '模型', title: '模型' },
  { menu: 'MCP 设置', title: '接入外部 MCP 服务' },
  { menu: 'Agent V3 调试台', title: 'Agent V3 调试台' }
]
const results = []

/**
 * 判据是**面板标题真的换成了点的那一项**。
 *
 * 不用截图、也不用 rAF：卡死时 DOM 还在、rAF 照样触发，光看那些分辨不出来。
 * `.header-title` 是 Vue 根据当前选中项渲染的 —— 它跟着变，就证明 Vue 的
 * 渲染队列还在推进；被 post-flush 异常打断的话它会**停在上一个面板的标题上**。
 */
async function panelTitle() {
  return page
    .locator('.header-title')
    .first()
    .textContent()
    .then((t) => (t || '').trim())
    .catch(() => '')
}

for (const panel of PANELS) {
  await page
    .getByText(panel.menu, { exact: true })
    .first()
    .click({ timeout: 15_000 })
    .catch(() => {})
  await page.waitForTimeout(1500)

  const title = await panelTitle()
  const switched = title === panel.title
  results.push({ menu: panel.menu, title, switched })
  log(
    `${panel.menu}: 面板标题「${title || '(读不到)'}」 ${
      switched ? '✅' : '✖ 没切过去，界面已经不刷新了'
    }`
  )
}

// 三个面板都点过之后，界面还得能正常切回去 —— 卡死的表现就是从这里开始点不动
await page
  .getByText('常规设置', { exact: true })
  .first()
  .click({ timeout: 10_000 })
  .catch(() => {})
await page.waitForTimeout(1500)
const backHeading = await panelTitle()

const notAFunction = errors.filter((e) => e.includes('is not a function'))

log(
  `\n点完三个面板后切回「常规设置」: 标题「${backHeading || '(读不到)'}」 ${
    backHeading === '常规设置' ? '✅' : '✖'
  }`
)
log(`「is not a function」报错: ${notAFunction.length ? '✖ ' + notAFunction[0] : '✅ 无'}`)

fs.writeFileSync(
  path.join(APP_DIR, '.test', 'prefs-panels-verdict.json'),
  JSON.stringify({ results, backHeading, errors: errors.slice(0, 20) }, null, 2),
  'utf8'
)

await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])

const ok =
  notAFunction.length === 0 &&
  results.length === PANELS.length &&
  results.every((r) => r.switched) &&
  backHeading === '常规设置'

log(ok ? '\n✅ 三个面板都点得开，界面没卡死' : '\n✖ 有问题，见上')
process.exit(ok ? 0 : 1)
