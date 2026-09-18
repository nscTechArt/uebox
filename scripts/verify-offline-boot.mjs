#!/usr/bin/env node
/**
 * 离线启动门禁。
 *
 * 社区版承诺：冷启动完全离线可用 —— 不需要账号、不依赖官方服务器。
 * 这条承诺光靠 typecheck 和单测守不住：遗留的请求会以 catch 后打 warning
 * 的形式静默失败，界面照常渲染，人工看不出来，但用户装上就是一堆网络错误。
 *
 * 本脚本启动打包产物，用 CDP 监听真实网络请求，断言：
 *   1. 首屏正常渲染（不是白屏）
 *   2. 落在首页而不是登录页
 *   3. 逐个功能页走一遍，全程没有指向官方服务端的请求
 *
 * **覆盖边界**：CDP 的 Network 域只看得见**渲染层**。主进程的 fetch / axios /
 * net.request 既不走 session.webRequest 也不进 CDP —— 自动更新就是这么一条
 * 主进程请求，这里看不到它。那一半靠 scripts/check-official-endpoints.mjs
 * 的静态扫描兜，两者缺一不可，不要因为这条绿了就以为社区版全线离线。
 *
 * 用法：node scripts/verify-offline-boot.mjs [--exe <path>] [--port 9222]
 * 由 `pnpm verify --ci` / `--with-build` 自动调用（见 scripts/verify.mjs 的 STEPS）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { packagedAppPaths } from './packaged-app-paths.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag)
    return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback
  }
  return {
    exe: resolve(read('--exe', packagedAppPaths(ROOT).exe)),
    port: read('--port', '9222'),
    // 启动后观察窗口：够长以覆盖各 store 的启动请求
    settleMs: Number(read('--settle', '12000'))
  }
}

/**
 * 启动后要逐个走一遍的功能页。
 *
 * 路径取自 src/renderer/src/router/modules/mainRoutes.ts。
 * 新增社区功能页时同步补进来 —— 漏一个就等于那一页的服务端请求没人看着。
 */
const ROUTES_TO_VISIT = Object.freeze([
  '/', // 首页
  '/asset-management', // 资产库
  '/blueprint-library', // 蓝图库
  '/material-library', // 材质库
  '/notebooks', // 知识库
  '/aigc-studio', // AI 创作
  '/dev-assistant', // AI 对话（虚幻助手）
  '/preferences?tab=asset', // 资产库偏好设置
  '/preferences' // 偏好设置
])

/** 每个路由停留多久，等它的 onMounted 请求发出来 */
const ROUTE_SETTLE_MS = 3500

const failures = []
const fail = (message) => failures.push(message)

/** 视为"官方服务端"的请求特征 */
function isServerRequest(url) {
  if (!url) return false
  // 打包后 baseURL 为空时，相对请求会退化成 file:///<盘符>/api/...
  if (/^file:\/\/\/[A-Za-z]:\/api\//.test(url)) return true
  if (/^https?:\/\//.test(url)) {
    // devtools 自身与本地回环不算
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) return false
    return true
  }
  return false
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

async function waitForTarget(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await fetchTargets(port)
      const page = targets.find((t) => t.type === 'page' && !t.url.includes('spotlight'))
      if (page) return page
    } catch {
      // devtools 还没起来
    }
    await sleep(1000)
  }
  return null
}

function attach(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const requests = []

  const call = (method, params = {}) =>
    new Promise((resolveCall) => {
      const myId = ++id
      pending.set(myId, resolveCall)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Network.requestWillBeSent') {
      requests.push(msg.params.request.url)
    }
  })

  return { ws, call, requests, ready: new Promise((r) => ws.on('open', r)) }
}

async function main() {
  const { exe, port, settleMs } = parseArgs(process.argv.slice(2))
  if (!existsSync(exe)) {
    // 只 fail 不 report：收尾统一由文件末尾那次 report() 输出，
    // 在这里再调一次会把同一条错误打印两遍。
    fail(`找不到打包产物：${exe}（先执行 pnpm build:unpack）`)
    return
  }

  // 每次冷启动使用独立目录，避免读取用户令牌、修改用户数据或命中已有进程。
  const userDataDir = mkdtempSync(join(tmpdir(), 'uebox-offline-boot-'))
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
    detached: true,
    windowsHide: true,
    env: { ...process.env, UA_DISABLE_SINGLE_INSTANCE_LOCK: '1', UA_REMOTE_DEBUGGING_PORT: port },
    stdio: 'ignore'
  })
  child.unref()
  let session
  console.log(`离线启动临时数据目录：${userDataDir}`)

  try {
    const page = await waitForTarget(port)
    if (!page) {
      fail('应用启动后没有出现可调试页面（可能是主进程崩溃或窗口未创建）')
      return
    }

    session = attach(page)
    await session.ready
    await session.call('Network.enable')
    await session.call('Runtime.enable')

    await sleep(settleMs)

    const probe = await session.call('Runtime.evaluate', {
      expression: `JSON.stringify({
        route: location.hash,
        appLength: document.querySelector('#app') ? document.querySelector('#app').innerHTML.length : -1,
        hasApi: typeof window.api
      })`,
      returnByValue: true
    })

    let state = {}
    try {
      state = JSON.parse(probe?.result?.value || '{}')
    } catch {
      state = {}
    }

    if (state.hasApi !== 'object') {
      fail(`preload 未正确暴露 window.api（实际为 ${state.hasApi}），渲染层会退回 mock`)
    }

    if (!state.appLength || state.appLength < 5000) {
      fail(`首屏疑似白屏：#app 内容仅 ${state.appLength} 字符`)
    }

    if (String(state.route || '').includes('/auth/')) {
      fail(`社区版不应停在账号页，实际路由：${state.route}`)
    }

    // 逐个路由导航一遍。
    //
    // 只查启动是不够的：遗留请求大多挂在具体功能页的 onMounted 上，
    // 用户点进去才会打向官方服务端。这里把每个主要功能页都走一遍，
    // 任何一页触发服务端请求都算社区版不纯净。
    for (const route of ROUTES_TO_VISIT) {
      await session.call('Runtime.evaluate', {
        expression: `(() => {
          const app = document.querySelector('#app')
          const router = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$router
          if (!router) return 'no router'
          return router.push(${JSON.stringify(route)}).then(() => 'ok', (e) => 'nav failed: ' + e)
        })()`,
        awaitPromise: true,
        returnByValue: true
      })
      await sleep(ROUTE_SETTLE_MS)
    }

    const serverRequests = [...new Set(session.requests.filter(isServerRequest))]
    if (serverRequests.length > 0) {
      fail(`社区版启动时不应访问服务端，实际发出 ${serverRequests.length} 个请求：`)
      for (const url of serverRequests) fail(`  - ${url}`)
    }

    if (failures.length === 0) {
      console.log(
        `离线启动检查通过（路由 ${state.route || '/'}，#app ${state.appLength} 字符，服务端请求 0 个）。`
      )
    }
  } finally {
    session?.ws.terminate()
    try {
      process.kill(child.pid)
    } catch {
      // 进程可能已退出
    }
  }
}

function report() {
  if (failures.length > 0) {
    for (const line of failures) console.error(`ERROR ${line}`)
    process.exitCode = 1
  }
}

await main()
report()
