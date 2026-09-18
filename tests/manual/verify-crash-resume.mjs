/**
 * 验收标准 5：杀掉 Electron 进程后重启，对话能续跑。
 *
 * transcriptStore 有 12 个单测，但**从没在真机上演练过** ——
 * 单测证明的是「写进去的能读出来」，证明不了：
 *   - 进程被强杀（不是优雅退出）时最后一轮到底落没落盘
 *   - 新进程能不能按 sessionId 找回那份 transcript
 *   - continue() 恢复出来的上下文里，早先的结论还在不在
 *
 * 落盘时机是每个 turn_end 一次（不是每个事件，那会拖慢主进程），
 * 所以「最多丢当前这一轮」是设计承诺 —— 这里要验的正是这句话。
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const USERDATA = path.join(APP_DIR, '.test', 'crash-userdata')
const REAL = path.join(process.env.APPDATA, 'unreal-box')
const SESSION = 'verify-crash-resume'
const FACT = 'QX-4471-MJD'

// 'Local State' 必须一起拷 —— Windows 上 safeStorage 的主密钥存在那里，
// 少了它密钥解不开，credentials 会按空库处理，表现成 401。
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.mkdirSync(USERDATA, { recursive: true })
for (const f of ['models.json', 'ai-provider-secrets.bin', 'Local State']) {
  const src = path.join(REAL, f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(USERDATA, f))
}

const launch = () =>
  electron.launch({
    args: ['.', `--user-data-dir=${USERDATA}`],
    cwd: APP_DIR,
    env: { ...process.env, NODE_ENV: 'production', WS_PORT: '17863' }
  })

const log = (m) => {
  process.stdout.write(m + '\n')
}
const hr = (t) => log(`\n${'─'.repeat(66)}\n${t}\n${'─'.repeat(66)}`)

/** 收集一次执行产生的事件 */
async function collect(page, fn, timeoutMs = 240_000) {
  await page.evaluate(() => {
    window.__ev = []
    for (const t of ['text', 'tool-call', 'done', 'error', 'stopped']) {
      window.api.on(`agent-v3:${t}`, (d) => window.__ev.push({ type: t, ...d }))
    }
  })
  const out = await fn()
  await page
    .waitForFunction(() => window.__ev.some((e) => e.type === 'done' || e.type === 'error'), null, {
      timeout: timeoutMs
    })
    .catch(() => {})
  return { out, events: await page.evaluate(() => window.__ev) }
}

const texts = (events) =>
  events
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('')

// ── 第一次启动：塞一个事实 ────────────────────────────────────────────────
hr('① 第一次启动：建立会话并塞一个只有这轮知道的事实')

let app = await launch()
let page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(3000)

const first = await collect(page, () =>
  page.evaluate(
    ({ sessionId, fact }) =>
      window.api.agentV3.execute({
        sessionId,
        prompt: `记住这个批次号：${fact}。之后我会问你。先回一句"记住了"。`,
        approvalMode: 'yolo'
      }),
    { sessionId: SESSION, fact: FACT }
  )
)

if (first.out?.success === false) {
  log(`✖ 第一轮就没跑起来：${first.out.error}`)
  await app.close()
  process.exit(1)
}
log(`模型回复：${texts(first.events).slice(0, 60)}`)

// ── 强杀进程 ──────────────────────────────────────────────────────────────
hr('② 强杀进程（不是优雅退出）')

const pid = app.process().pid
log(`强杀进程树 PID ${pid}`)

// **必须杀整棵树。**
// Windows 上 process.kill(pid) 只杀主进程，渲染/GPU 子进程还活着 ——
// 而 Electron 的单实例互斥锁是按 userData 路径注册的，子进程还占着它，
// 于是第二个实例 requestSingleInstanceLock() 拿不到锁，直接 app.quit()。
// 表现是 firstWindow() 超时，看上去像 transcript 恢复失败，其实压根没启动。
execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 5000))

// 强杀留下的锁文件也清掉 —— 真实崩溃后用户重启同样会遇到
for (const stale of ['lockfile', 'SingletonLock', 'SingletonCookie']) {
  fs.rmSync(path.join(USERDATA, stale), { recursive: true, force: true })
}

// transcript 应该已经落盘了
const transcriptDir = path.join(USERDATA, 'agent-v3-sessions')
let onDisk = 'not-found'
if (fs.existsSync(transcriptDir)) {
  const files = fs.readdirSync(transcriptDir).filter((f) => f.includes(SESSION))
  onDisk = files.length
    ? `${files[0]}（${fs.statSync(path.join(transcriptDir, files[0])).size} 字节）`
    : 'dir-empty'
}
log(`磁盘上的 transcript：${onDisk}`)

// ── 重启并续跑 ────────────────────────────────────────────────────────────
hr('③ 重启新进程，续跑同一个会话')

app = await launch()
page = await app.firstWindow({ timeout: 60_000 }).catch((error) => {
  log('✖ 第二个实例没起来：' + String(error).slice(0, 200))
  process.exit(1)
})
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(3000)

const resumed = await collect(page, () =>
  page.evaluate(
    (sessionId) =>
      window.api.agentV3.execute({
        sessionId,
        prompt: '我刚才给你的批次号是什么？只回答批次号本身。',
        approvalMode: 'yolo'
      }),
    SESSION
  )
)

const answer = texts(resumed.events)
const restored = resumed.out?.restoredMessages ?? 0
const recalled = answer.includes(FACT)

log(`恢复的历史消息：${restored} 条`)
log(`回答：${answer.slice(0, 120)}`)
log(`\n${recalled ? '✅' : '✖'} 杀进程后重启，早先的结论${recalled ? '还在' : '丢了'}`)

fs.writeFileSync(
  path.join(APP_DIR, '.test', 'crash-resume-verdict.json'),
  JSON.stringify(
    {
      transcriptOnDisk: onDisk,
      restoredMessages: restored,
      recalled,
      answer: answer.slice(0, 200)
    },
    null,
    2
  ),
  'utf8'
)

// app.close() 在这个应用上会挂住（后台服务不肯退），别等它
await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
process.exit(recalled && restored > 0 ? 0 : 1)
