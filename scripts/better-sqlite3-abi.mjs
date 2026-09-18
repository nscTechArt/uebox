#!/usr/bin/env node
/**
 * better-sqlite3 的双 ABI 产物缓存。
 *
 * ## 要解决的问题
 *
 * `better-sqlite3` 是原生模块，Node 与 Electron 的 ABI 不同。
 * 原先的做法是**一个 `.node` 文件来回重编译**：跑测试前编成 Node、跑应用前编回
 * Electron。两个后果：
 *
 * 1. 每次切换要跑一次完整的原生编译，几十秒起步；
 * 2. **应用开着就切不动** —— 那个 `.node` 被 Electron 进程加载着，Windows 上
 *    连删都删不掉（EPERM: operation not permitted, unlink）。于是「开着应用就
 *    没法跑测试」，而开发时应用几乎总是开着的。
 *
 * ## 做法
 *
 * 两个 ABI 的产物**各存一份**，按 ABI 号分目录缓存；切换退化成一次文件复制，
 * 而且**已经是目标 ABI 时一个字节都不写** —— 不写就不会撞上文件锁。
 *
 * 更关键的是测试根本不再走 `node_modules`：vitest 把 `better-sqlite3` 别名到
 * `tests/support/betterSqlite3.node-abi.cjs`，那个垫片把缓存里的 Node 版产物
 * 用 better-sqlite3 自己的 `nativeBinding` 选项喂进去。于是
 * `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 可以**永远保持
 * Electron 版**，应用开着也不影响跑测试。
 *
 * 缓存键带上 better-sqlite3 版本与平台架构：升级依赖或换机器后会自然失效重建。
 *
 * 用法：
 *   node scripts/better-sqlite3-abi.mjs ensure node       确保缓存里有 Node 版
 *   node scripts/better-sqlite3-abi.mjs ensure electron   确保缓存里有 Electron 版
 *   node scripts/better-sqlite3-abi.mjs use electron      把 Electron 版放回 node_modules
 *   node scripts/better-sqlite3-abi.mjs path node         打印 Node 版产物路径
 *   node scripts/better-sqlite3-abi.mjs status            看当前状态
 */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const PKG_DIR = join(ROOT, 'node_modules', 'better-sqlite3')
const LIVE_BINDING = join(PKG_DIR, 'build', 'Release', 'better_sqlite3.node')
const CACHE_ROOT = join(ROOT, 'node_modules', '.cache', 'better-sqlite3-abi')

const isWindows = process.platform === 'win32'

function pkgVersion() {
  return JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version
}

/**
 * 让 Electron 自己报告 ABI，避免维护必然过期的版本映射表。
 * `require('electron')` 同时会取得（并在新版本首次使用时安装）Electron 可执行文件。
 */
function electronAbi() {
  const executable = require('electron')
  const result = spawnSync(executable, ['-p', 'process.versions.modules'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true
  })
  const abi = String(result.stdout || '').trim()

  if (result.status !== 0 || !/^\d+$/.test(abi)) {
    const detail = String(result.stderr || '').trim()
    throw new Error(`无法读取 Electron ABI${detail ? `：${detail}` : ''}`)
  }

  return abi
}

function abiFor(runtime) {
  return runtime === 'node' ? String(process.versions.modules) : electronAbi()
}

function cacheFile(runtime) {
  const key = `${runtime}-abi${abiFor(runtime)}-${process.platform}-${process.arch}-v${pkgVersion()}`
  return join(CACHE_ROOT, key, 'better_sqlite3.node')
}

/**
 * 认一个 `.node` 文件是哪套 ABI 编的。
 *
 * 不查表、不靠文件名，直接让 Node 去加载：加载得动就是 Node ABI，
 * 加载不动的话错误信息里会明说它要的是哪个版本。这比维护一张
 * 「Electron 版本 → ABI」的表可靠 —— 那张表一定会过期。
 *
 * **必须在子进程里做。** 在本进程 `dlopen` 会把这个 .node 一直挂在进程上，
 * Windows 下随后就删不掉它了（EPERM）—— 探测临时下载下来的产物时正好会撞上，
 * 表现是「缓存建好了但清理临时目录失败」。子进程退出时句柄自然释放。
 */
function detectAbi(file) {
  if (!existsSync(file)) return null

  const probe = `try{process.dlopen({exports:{}},${JSON.stringify(file)});process.stdout.write(process.versions.modules)}catch(e){const m=/NODE_MODULE_VERSION (\\d+)/.exec(String(e.message));process.stdout.write(m?m[1]:'')}`
  const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' })
  const abi = String(result.stdout || '').trim()
  return abi || null
}

function runtimeOfLiveBinding() {
  const abi = detectAbi(LIVE_BINDING)
  if (abi === null) return null
  if (abi === String(process.versions.modules)) return 'node'
  if (abi === electronAbi()) return 'electron'
  return `abi${abi}`
}

/** 项目内还开着的 Electron 进程会锁住 .node 文件 */
function blockingProcesses() {
  if (!isWindows) return []
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Get-CimInstance Win32_Process',
    "| Where-Object { $_.Name -in @('electron.exe','unreal-agent.exe') }",
    '| Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress'
  ].join(' ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8'
  })
  if (result.status !== 0 || !result.stdout.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const root = ROOT.toLowerCase().replace(/[\\/]+$/, '')
  return list.filter((item) =>
    `${item.ExecutablePath || ''} ${item.CommandLine || ''}`.toLowerCase().includes(root)
  )
}

/**
 * 先试预编译包。
 *
 * better-sqlite3 在 GitHub Release 上发布各 ABI 的预编译产物，`prebuild-install`
 * 就是干这个的，而且它的 `--path` 能把产物放到**指定目录**而不是 node_modules。
 *
 * 这一条很关键：走 `--path` 就完全不碰 `build/Release/better_sqlite3.node`，
 * 于是**应用开着也能把缓存补齐**，用户不必为了跑一次测试去关应用。
 * 拿不到（离线、或这个 ABI 没发预编译包）再回落到本地编译。
 *
 * 只对 Node ABI 走这条路：Electron 那份由 electron-rebuild 负责，它自己有缓存。
 */
function tryPrebuild(runtime) {
  if (runtime !== 'node') return false

  const stage = join(CACHE_ROOT, '.staging-node')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  // `--path` 的语义是「把这个目录当成包根目录」，prebuild-install 会 chdir 过去
  // 再读 package.json 拿包名与版本。所以要先把 package.json 放进去，
  // 否则它报的是一句看不出所以然的 ENOENT chdir。
  copyFileSync(join(PKG_DIR, 'package.json'), join(stage, 'package.json'))

  console.log('尝试下载 better-sqlite3 的 Node 预编译包（不碰 node_modules）...')
  const result = spawnSync(
    isWindows ? 'npx.cmd' : 'npx',
    [
      'prebuild-install',
      '--runtime',
      'node',
      '--target',
      process.versions.node,
      '--arch',
      process.arch,
      '--platform',
      process.platform,
      '--path',
      stage
    ],
    { cwd: PKG_DIR, stdio: 'inherit', shell: isWindows }
  )

  const produced = join(stage, 'build', 'Release', 'better_sqlite3.node')
  if (result.status !== 0 || !existsSync(produced)) {
    rmSync(stage, { recursive: true, force: true })
    return false
  }

  if (detectAbi(produced) !== String(process.versions.modules)) {
    console.warn('下载到的预编译包 ABI 不匹配，回落到本地编译。')
    rmSync(stage, { recursive: true, force: true })
    return false
  }

  const target = cacheFile('node')
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(produced, target)
  try {
    rmSync(stage, { recursive: true, force: true })
  } catch {
    // 清不掉不影响结果，缓存已经拿到了
  }
  console.log('已从预编译包取得 Node ABI 产物。')
  return true
}

function rebuild(runtime) {
  const blocking = blockingProcesses()
  if (blocking.length > 0) {
    console.error(
      `\n需要为 ${runtime} 重新编译 better-sqlite3，但本项目的 Electron 还开着，` +
        `\n它锁住了 ${LIVE_BINDING}。`
    )
    for (const item of blocking) {
      console.error(`  · PID ${item.ProcessId}: ${item.ExecutablePath || '(路径未知)'}`)
    }
    console.error(
      '\n关掉应用与 pnpm dev 后重跑一次即可。这一步**只需要做一次**：' +
        '\n编出来的产物会缓存起来，之后应用开着也能跑测试。\n'
    )
    process.exit(1)
  }

  console.log(`正在为 ${runtime} 编译 better-sqlite3（只需一次，之后走缓存）...`)
  const [command, args] =
    runtime === 'node'
      ? [isWindows ? 'npm.cmd' : 'npm', ['rebuild', 'better-sqlite3']]
      : [isWindows ? 'npx.cmd' : 'npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3']]

  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: isWindows })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** 把当前 build/Release 里的产物按它自己的 ABI 收进缓存 */
function snapshot() {
  const runtime = runtimeOfLiveBinding()
  if (runtime !== 'node' && runtime !== 'electron') return false

  const target = cacheFile(runtime)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(LIVE_BINDING, target)
  return runtime
}

/** 确保缓存里有某个 runtime 的产物 */
function ensure(runtime) {
  const cached = cacheFile(runtime)
  if (existsSync(cached)) return cached

  // 也许当前 node_modules 里正好就是它，那就直接收进来，不必重编
  if (runtimeOfLiveBinding() === runtime) {
    snapshot()
    return cached
  }

  // 预编译包不碰 node_modules，应用开着也能补缓存
  if (tryPrebuild(runtime)) return cached

  rebuild(runtime)
  snapshot()

  if (!existsSync(cached)) {
    console.error(`编译完成但没能缓存到 ${cached}，请检查 better-sqlite3 的产物路径。`)
    process.exit(1)
  }
  return cached
}

/**
 * 把某个 runtime 的产物放回 node_modules。
 *
 * 已经是目标 ABI 就**直接返回，不写文件** —— 这是能在应用开着时也不报错的关键：
 * 文件锁只挡写入，不挡读取。
 */
function use(runtime) {
  if (runtimeOfLiveBinding() === runtime) {
    console.log(`better-sqlite3 已是 ${runtime} ABI，无需改动。`)
    return
  }

  const cached = ensure(runtime)
  mkdirSync(dirname(LIVE_BINDING), { recursive: true })

  // 先写临时文件再改名：改名在同一分区上是原子的，中途失败不会留下半个文件
  const staging = `${LIVE_BINDING}.staging`
  try {
    copyFileSync(cached, staging)
    rmSync(LIVE_BINDING, { force: true })
    renameSync(staging, LIVE_BINDING)
  } catch (error) {
    rmSync(staging, { force: true })
    if (error.code === 'EPERM' || error.code === 'EBUSY') {
      console.error(
        `\n没能把 better-sqlite3 换成 ${runtime} ABI：文件被占用。` +
          '\n本项目的 Electron 还开着的话，关掉再试。' +
          '\n（跑测试不需要这一步 —— 测试走的是缓存里的副本，见 vitest.config.ts）\n'
      )
      process.exit(1)
    }
    throw error
  }
  console.log(`better-sqlite3 已切换为 ${runtime} ABI（从缓存复制，未重新编译）。`)
}

function status() {
  const live = runtimeOfLiveBinding()
  console.log(`node_modules 里当前是：${live ?? '(缺失或无法识别)'}`)
  for (const runtime of ['node', 'electron']) {
    const file = cacheFile(runtime)
    const ok = existsSync(file)
    const size = ok ? `${(statSync(file).size / 1024 / 1024).toFixed(1)}MB` : '-'
    console.log(
      `  缓存 ${runtime.padEnd(8)} abi${abiFor(runtime).padEnd(4)} ${ok ? '✓' : '✗'} ${size}`
    )
  }
}

const [command, runtimeArg] = process.argv.slice(2)

if (command === 'status') {
  status()
} else if (command === 'path') {
  const runtime = runtimeArg || 'node'
  process.stdout.write(ensure(runtime))
} else if (command === 'ensure') {
  const runtime = runtimeArg || 'node'
  if (!['node', 'electron'].includes(runtime)) {
    console.error('用法：ensure <node|electron>')
    process.exit(1)
  }
  ensure(runtime)
  console.log(`${runtime} ABI 产物已就绪：${cacheFile(runtime)}`)
} else if (command === 'use') {
  if (!['node', 'electron'].includes(runtimeArg)) {
    console.error('用法：use <node|electron>')
    process.exit(1)
  }
  use(runtimeArg)
} else {
  console.error(
    '用法：\n' +
      '  node scripts/better-sqlite3-abi.mjs status\n' +
      '  node scripts/better-sqlite3-abi.mjs ensure <node|electron>\n' +
      '  node scripts/better-sqlite3-abi.mjs use <node|electron>\n' +
      '  node scripts/better-sqlite3-abi.mjs path <node|electron>'
  )
  process.exit(1)
}
