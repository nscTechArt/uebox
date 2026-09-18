/**
 * 界面改造的真机烟测。
 *
 * 单测能证明分发器的映射对，但证明不了**订阅本身能不能建立** ——
 * 通道白名单填错时 `assertChannelAllowed` 会抛异常，整条订阅链路一起挂掉，
 * 而界面只表现为「收不到任何事件」，控制台里也未必看得出跟 agent 有关。
 * 这个坑之前真踩过一次（放进了 RAW_EVENT_CHANNELS 而不是 GENERIC）。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHANNELS = [
  'agent-v3:text',
  'agent-v3:thinking',
  'agent-v3:tool-call',
  'agent-v3:tool-progress',
  'agent-v3:tool-result',
  'agent-v3:step',
  'agent-v3:compacting',
  'agent-v3:done',
  'agent-v3:stopped',
  'agent-v3:error'
]

// 用独立的 userData：
//   1) 不碰用户真实配置
//   2) 用户自己开着盒子时也能跑 —— 否则 Electron 的单实例锁按 userData 路径
//      注册，第二个实例拿不到锁会直接 app.quit()，表现成 firstWindow() 超时
const USERDATA = path.join(APP_DIR, '.test', 'smoke-userdata')
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.mkdirSync(USERDATA, { recursive: true })

const app = await electron.launch({
  args: ['.', `--user-data-dir=${USERDATA}`],
  cwd: APP_DIR,
  env: { ...process.env, NODE_ENV: 'production', WS_PORT: '17862' }
})

const page = await app.firstWindow({ timeout: 60_000 })
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(4000)

// ① 分发器订阅的每个通道都必须能建立
const subs = await page.evaluate((channels) => {
  const out = {}
  for (const c of channels) {
    try {
      const h = window.api.on(c, () => {})
      window.api.off(c, h)
      out[c] = 'ok'
    } catch (e) {
      out[c] = String(e?.message || e)
    }
  }
  return out
}, CHANNELS)

// ② V2 的通道应该已经不在白名单里了
const v2 = await page.evaluate(() => {
  try {
    window.electron.ipcRenderer.on('agent:text', () => {})
    return 'still-allowed'
  } catch {
    return 'removed'
  }
})

// ③ 分发器初始化过，且没在启动时炸
const dispatcher = await page.evaluate(() => {
  const el = document.querySelector('#app')
  return { mounted: !!el && el.children.length > 0 }
})

const bad = Object.entries(subs).filter(([, v]) => v !== 'ok')
console.log('── agent-v3 通道订阅 ──')
for (const [c, v] of Object.entries(subs))
  console.log(`  ${v === 'ok' ? '✅' : '✖'} ${c}${v === 'ok' ? '' : ' → ' + v}`)
console.log(`\nV2 agent:text 通道: ${v2 === 'removed' ? '✅ 已摘除' : '✖ 还在白名单里'}`)
console.log(`界面已挂载: ${dispatcher.mounted ? '✅' : '✖'}`)
console.log(`\n启动期控制台错误 ${errors.length} 条:`)
for (const e of errors.slice(0, 8)) console.log('  ·', e.slice(0, 160))

await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
const ok = bad.length === 0 && v2 === 'removed' && dispatcher.mounted
console.log(`\n${ok ? '✅ 烟测通过' : '✖ 烟测失败'}`)
process.exit(ok ? 0 : 1)
