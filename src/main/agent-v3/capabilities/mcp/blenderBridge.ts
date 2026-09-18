/**
 * Blender 自动拉起 —— 桥断了就把 Blender 开起来，而不是把活退回给用户。
 *
 * 官方 Blender Lab MCP 有两条通道，能力完全不同：
 *
 *   - **后台通道**：`execute_blender_code_for_cli` 和一族 `get_blendfile_summary_*`，
 *     server 自己按 `BLENDER_PATH` 起一个 `blender --background` 跑完就退。
 *     **不需要 Blender 开着**，纯批处理走这条最省事，代价是没有视口、没有截图、
 *     进程之间不留状态。
 *   - **桥通道**：`execute_blender_code`、截图、`jump_to_*` 等，走 127.0.0.1:9876
 *     的 socket，要求 Blender 开着且插件的 bridge server 已启动。
 *
 * 所以「自动选」其实不需要选：后台通道本来就一直可用，会失败的只有桥通道。
 * 这个模块只补上缺的那一半 —— 桥连不上时，按 `BLENDER_PATH` 把 Blender 拉起来，
 * 等端口通了让调用重来一次。插件的 Auto Start 默认开着，起来一秒后自己监听端口；
 * `--online-mode` 是插件自己要求的（没有在线访问它会拒绝开 socket，
 * 报 "Online access must be enabled in the system preferences"）。
 *
 * ## 什么情况下不拉
 *
 * - **Blender 已经开着但端口不通**：说明用户关掉了 bridge server，或者插件没装。
 *   这时再开一个 Blender 只会让用户桌面上多一个窗口，问题原样还在 —— 只报原因。
 * - **失败后的冷却期内**：模型会连着重试，没有冷却就会一次拉起好几个 Blender。
 */

import { execFile, spawn } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { createConnection } from 'net'
import { basename, resolve } from 'path'
import { promisify } from 'util'

import { isHttpConfig, type McpServerConfig } from './types'

const execFileAsync = promisify(execFile)

/** 插件默认端口，和官方 `blmcp` 的 `_DEFAULT_PORT` 一致 */
const DEFAULT_PORT = 9876

/** 单次探测端口的超时。本机回环，通不通几毫秒就知道 */
const PROBE_TIMEOUT_MS = 1_000

/**
 * 连上之后等对方应答握手的上限。
 *
 * 插件对不认识的消息类型是**在 socket 线程上直接回错**的（不排进主线程队列），
 * 所以正在渲染、卡在模态操作里的 Blender 也答得出来，给 3 秒足够宽松。
 */
const HANDSHAKE_TIMEOUT_MS = 3_000

/** 启动后每隔多久探一次端口 */
const POLL_INTERVAL_MS = 500

/**
 * 等 Blender 起来的上限。
 *
 * 冷启动 + 插件 1 秒的 autostart 延迟，实测个位数秒；给到 60 秒是留给
 * 首次启动要编译着色器缓存的机器。再长就该报错了 —— 工具调用本身
 * 只有 120 秒预算，不能全耗在等启动上。
 */
const LAUNCH_TIMEOUT_MS = 60_000

/** 拉起失败后的冷却期，避免模型连续重试时开出一排 Blender */
const FAILURE_COOLDOWN_MS = 30_000

/** 诊断用的后台 Blender 的上限。只读三个状态，正常个位数秒 */
const DIAGNOSE_TIMEOUT_MS = 30_000

/** 查进程列表的上限。PowerShell 冷启动本身就要一两秒 */
const PROCESS_QUERY_TIMEOUT_MS = 15_000

/** 只认回环地址：非本机的 Blender 我们拉不起来，也不该去拉 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * 拉不起来时给模型的兜底提示。
 *
 * 直接告诉它还有一条不需要窗口的路，比只报一句「连不上」有用得多 ——
 * 纯批处理任务本来就不需要桥。
 */
const HEADLESS_HINT =
  '不需要窗口的批处理可以改用 execute_blender_code_for_cli(blend_file, code)，' +
  '它在后台起 blender --background 执行，不依赖这个桥。'

/** 一个可以被盒子拉起来的本机 Blender */
export interface BlenderBridgeTarget {
  host: string
  port: number
  /** Blender 可执行文件的绝对路径，来自配置里的 `BLENDER_PATH` */
  exe: string
}

export type BlenderLaunchOutcome = { ok: true; launched: boolean } | { ok: false; reason: string }

/**
 * 桥起不来时，Blender 自己回答的三件事。
 *
 * 真机踩过的坑：链路有四层（桥进程 → 端口 → 插件装没装 → 启动模式对不对），
 * 每层断掉的症状**完全一样**，都只有一句 `Cannot connect to Blender`。
 * 用户只能拿命令行一层层查。所以失败时不猜，直接起一个后台 Blender 问它。
 */
export interface BlenderDiagnosis {
  /** 扩展目录里有没有官方插件 */
  installed: boolean
  /** 装了但没勾启用也是白装 */
  enabled: boolean
  /**
   * Blender 的「允许在线访问」这个**持久偏好**开着没有。
   *
   * 插件把开桥当联机行为，这一项关着就直接拒绝监听端口。默认是关的，
   * 所以用户自己双击打开的 Blender 基本都连不上 —— 这是整条链路里最隐蔽的一环。
   * 盒子自己拉起来时带 `--online-mode` 绕过它，所以这一项只用来解释
   * 「你手动开的那个 Blender 为什么没有桥」。
   */
  online: boolean
}

/**
 * 端口上是谁。
 *
 * 光看「TCP 连得上」不够：9876 被别的程序占着时，插件根本绑不上这个端口，
 * 而我们会把那个程序当成桥，报「已连上」，接着调用照样失败 —— 用户看到的
 * 是一串互相矛盾的信息。所以连上之后还要握一次手。
 */
export type BridgeCheck = 'bridge' | 'closed' | 'foreign'

/** 便于测试注入；默认实现都在本文件底部 */
export interface BlenderLaunchDeps {
  probe: (host: string, port: number) => Promise<BridgeCheck>
  /** 「配置里这一个 Blender」是不是在跑，不是「有没有 Blender 在跑」 */
  isRunning: (exe: string) => Promise<boolean>
  launch: (exe: string) => void
  exists: (file: string) => boolean
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** 尽力而为：问不出来就返回 undefined，绝不能让诊断本身变成新的失败点 */
  diagnose: (exe: string) => Promise<BlenderDiagnosis | undefined>
}

/**
 * 从 MCP server 配置里认出「本机的官方 Blender Lab server」。
 *
 * 判据是配置里有没有 `BLENDER_PATH`，不是 server 叫不叫 blender ——
 * 名字是用户随手起的，认名字等于让重命名后功能静默失效。
 */
export function blenderBridgeTarget(config: McpServerConfig): BlenderBridgeTarget | undefined {
  if (isHttpConfig(config)) return undefined

  const env = config.env ?? {}
  const exe = env.BLENDER_PATH?.trim()
  if (!exe) return undefined

  const host = (env.BLENDER_MCP_HOST?.trim() || '127.0.0.1').toLowerCase()
  if (!LOOPBACK_HOSTS.has(host)) return undefined

  const port = env.BLENDER_MCP_PORT ? Number(env.BLENDER_MCP_PORT) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined

  return { host, port, exe }
}

/**
 * 这条错误信息是不是「桥没通」。
 *
 * 只认官方 `send_code` 里连接被拒和空响应两种 —— 这两种都发生在代码送出去**之前**，
 * Blender 侧一定什么都没执行，重试才是安全的。
 *
 * **超时不在此列**：超时表示结果未知，重试可能把一次几何修改做两遍。
 * 这条和 `docs/Blender-DCC互联能力设计.md` 的异常处理约定是同一条。
 */
export function isBridgeDownMessage(text: string): boolean {
  return /Cannot connect to Blender at/i.test(text) || /Empty response from Blender/i.test(text)
}

/**
 * 造一个「确保桥通」的函数：端口通就直接返回，不通就拉起 Blender 等它通。
 *
 * 返回 `undefined` 表示这个 server 不是本机 Blender，调用方不必接这套逻辑。
 * 闭包里带单飞和冷却：并行工具调用同时踩到桥断时只会拉起一个 Blender。
 */
export function createBlenderLauncher(
  config: McpServerConfig,
  overrides: Partial<BlenderLaunchDeps> = {}
): (() => Promise<BlenderLaunchOutcome>) | undefined {
  const target = blenderBridgeTarget(config)
  if (!target) return undefined

  const deps: BlenderLaunchDeps = { ...defaultDeps, ...overrides }
  let inFlight: Promise<BlenderLaunchOutcome> | undefined
  let lastFailure: { at: number; reason: string } | undefined

  const attempt = async (): Promise<BlenderLaunchOutcome> => {
    const fail = (reason: string): BlenderLaunchOutcome => {
      lastFailure = { at: deps.now(), reason }
      return { ok: false, reason }
    }

    const first = await deps.probe(target.host, target.port)
    if (first === 'bridge') return { ok: true, launched: false }
    // 拉起 Blender 解决不了端口被占：插件绑不上，开出来的窗口白开
    if (first === 'foreign') return fail(portTakenBy(target))

    if (lastFailure && deps.now() - lastFailure.at < FAILURE_COOLDOWN_MS) {
      return { ok: false, reason: lastFailure.reason }
    }

    if (!deps.exists(target.exe)) {
      return fail(
        `Blender 不在配置记录的位置（${target.exe}）。` +
          '请到偏好设置 → MCP 里把这个 server 的 BLENDER_PATH 改成实际路径。'
      )
    }

    if (await deps.isRunning(target.exe)) {
      return fail(
        `Blender 已经在运行，但 ${target.host}:${target.port} 上没有 MCP 桥 —— ` +
          '没有再开一个窗口。' +
          (await explain(deps, target.exe, true)) +
          HEADLESS_HINT
      )
    }

    deps.launch(target.exe)

    const deadline = deps.now() + LAUNCH_TIMEOUT_MS
    while (deps.now() < deadline) {
      await deps.sleep(POLL_INTERVAL_MS)
      const check = await deps.probe(target.host, target.port)
      if (check === 'bridge') return { ok: true, launched: true }
      if (check === 'foreign') return fail(portTakenBy(target))
    }

    return fail(
      `已启动 Blender，但 ${Math.round(LAUNCH_TIMEOUT_MS / 1000)} 秒内 ` +
        `${target.host}:${target.port} 上的 MCP 桥没有起来。` +
        (await explain(deps, target.exe, false)) +
        HEADLESS_HINT
    )
  }

  return async (): Promise<BlenderLaunchOutcome> => {
    if (!inFlight) {
      inFlight = attempt().finally(() => {
        inFlight = undefined
      })
    }
    return inFlight
  }
}

/** 端口被别人占了 —— 换端口是唯一的出路，拉起 Blender 没用 */
function portTakenBy(target: BlenderBridgeTarget): string {
  return (
    `${target.host}:${target.port} 上有别的程序在监听，它不是 Blender 的 MCP 桥 —— ` +
    '插件因此绑不上这个端口。换一个端口：改 MCP 配置里的 BLENDER_MCP_PORT，' +
    '并在 Blender 的插件偏好里把端口改成同一个。' +
    HEADLESS_HINT
  )
}

/**
 * 把诊断结果翻成一句「该修哪一层」。
 *
 * `userOpened` 区分的是这个 Blender 谁开的：用户自己双击开的，最可能卡在
 * 「允许在线访问」那一项（默认关，插件因此拒绝开桥）；盒子自己开的带了
 * `--online-mode`，那一项不可能是原因，往前查插件装没装。
 */
async function explain(deps: BlenderLaunchDeps, exe: string, userOpened: boolean): Promise<string> {
  const found = await deps.diagnose(exe)

  if (!found) {
    return '问不出 Blender 侧的状态，请依次检查：官方插件装没装、启用没启用、在线访问开没开。'
  }
  if (!found.installed) {
    return (
      '官方 Blender Lab 插件没装进 Blender —— 扩展目录里没有它。' +
      '装一次即可持久生效：按 blender-ue-pipeline 技能的设置指引，Windows 跑 setup_mcp.ps1，macOS 跑 setup_mcp.py。'
    )
  }
  if (!found.enabled) {
    return '插件装了但没启用。在 Blender 的偏好设置 → 扩展里勾上它，勾一次就持久。'
  }
  if (userOpened && !found.online) {
    return (
      '插件装了也启用了，但 Blender 的「允许在线访问」是关的 —— 插件把开桥当联机行为，' +
      '这一项关着它就拒绝监听端口，你双击打开的 Blender 因此没有桥。' +
      '关掉它让盒子来开（盒子会带 --online-mode），或者在偏好设置 → 系统 → 网络里勾上这一项。'
    )
  }
  if (userOpened) {
    return '插件装了、启用了、在线访问也开着，但桥没在监听。在偏好设置 → 扩展 → Blender MCP 里点 Start Server（勾上 Auto Start 以后就不用每次点）。'
  }
  return '插件装了也启用了，桥却没起来 —— 请看 Blender 控制台窗口里的报错。'
}

/**
 * 握手帧。
 *
 * 故意用一个插件不认识的 type：它会**原样回一个 `status: error` 的 JSON**
 * 而不执行任何代码（`mcp_to_blender_server.py` 在派发前就挡掉了未知类型）。
 * 于是这次探测既能证明对面确实是 Blender 的桥，又不会往用户的建模会话里
 * 塞任何东西 —— 比发一段 `bpy` 代码去试探安全得多。
 */
const HANDSHAKE_FRAME = JSON.stringify({ type: 'unreal-box-bridge-probe' }) + '\0'

/** 回应是不是插件的协议帧：能解析成带 `status` 的 JSON 就算 */
function isBridgeReply(buffer: string): boolean {
  try {
    const parsed: unknown = JSON.parse(buffer.slice(0, buffer.indexOf('\0')))
    return typeof (parsed as { status?: unknown })?.status === 'string'
  } catch {
    return false
  }
}

/** 探端口上是谁：连得上、而且答得出插件的协议，才算桥 */
function probeBridge(host: string, port: number): Promise<BridgeCheck> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let buffer = ''
    let settled = false
    const done = (result: BridgeCheck): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => {
      socket.setTimeout(HANDSHAKE_TIMEOUT_MS)
      socket.write(HANDSHAKE_FRAME)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('\0')) done(isBridgeReply(buffer) ? 'bridge' : 'foreign')
    })
    socket.once('timeout', () => {
      if (socket.connecting) return done('closed')
      // 说了话但不是我们的协议（SSH 那种上来就发 banner 的）→ 不是桥。
      // 一声不吭的：可能是沉默的 HTTP 服务，也可能是 Blender 卡住了 ——
      // 判成桥。把一个忙着的 Blender 说成「端口被别人占了」是更糟的错。
      done(buffer.length > 0 ? 'foreign' : 'bridge')
    })
    socket.once('error', () => done('closed'))
  })
}

/** 路径比较用：大小写和分隔符都归一，Windows 上两者都不该影响判断 */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false
  const norm = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * **配置里这一个** Blender 是不是已经开着。
 *
 * 按完整路径比，不是按文件名。同机装了多个版本时按名字比会误判：用户开着
 * 4.5（没装插件），盒子要用的是 5.2，按名字比会认定「目标已经在运行」，
 * 于是拒绝启动 5.2，还给出一段基于 5.2 的诊断 —— 全错。
 *
 * 走 EncodedCommand 而不是拼命令行：参数里带用户配置的路径，拼进 shell
 * 既是注入面，也会被引号和转义坑到（Win32_Process 的过滤器本身是 WQL）。
 */
export async function isBlenderRunning(
  exe: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const name = basename(exe)
  try {
    if (platform === 'win32') {
      // 进 WQL 字符串的只有文件名。形状不对就不查了，宁可当没开着 ——
      // 最坏结果是多开一个窗口，而不是拼出一条奇怪的查询
      if (!/^[\w.\- ]+$/.test(name)) return false
      const script = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { $_.ExecutablePath }`
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { timeout: PROCESS_QUERY_TIMEOUT_MS }
      )
      return stdout.split(/\r?\n/).some((line) => samePath(line.trim(), exe))
    }
    if (platform === 'darwin') {
      const target = realpathSync(exe)
      const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-axo', 'comm='], {
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
      })
      return stdout.split('\n').some((line) => {
        const candidate = line.trim()
        // 先按文件名筛掉：realpath 是同步系统调用，机器上几百个进程逐个解
        // 会把主进程按住不放（其中还可能有网络盘上的可执行文件）。
        if (!candidate.startsWith('/') || basename(candidate) !== name) return false
        try {
          // realpath handles symlinks and the volume's actual case semantics.
          return realpathSync(candidate) === target
        } catch {
          // Another process may have exited or its executable may be inaccessible.
          return false
        }
      })
    }
    // Linux retains its existing name-based fallback.
    const { stdout } = await execFileAsync('pgrep', ['-x', name])
    return stdout.trim().length > 0
  } catch {
    // pgrep 没匹配到会以 1 退出；查不出来就当没开着，最坏结果是多开一个窗口
    return false
  }
}

/**
 * 拉起 Blender。
 *
 * `detached` + `unref`：用户可能接着在这个 Blender 里继续干活，
 * 盒子退出不该把它一起带走。
 */
function launchBlender(exe: string): void {
  const child = spawn(exe, ['--online-mode'], { detached: true, stdio: 'ignore' })
  // 不挂 error 监听的话，可执行文件起不来会以未捕获事件的形式掀掉主进程
  child.on('error', (error) => {
    console.warn('[AgentV3][MCP] 启动 Blender 失败:', error.message)
  })
  child.unref()
}

/** 官方插件装进用户扩展库之后的模块名 */
const ADDON_MODULE = 'bl_ext.user_default.mcp'

/** 诊断脚本。只读不写，`--disable-autoexec` 保证不会执行文件里的脚本 */
const DIAGNOSE_SCRIPT = `
import bpy, os
_ext = bpy.utils.user_resource('EXTENSIONS')
print('BLMCP_INSTALLED=' + str(os.path.isdir(os.path.join(_ext, 'user_default', 'mcp'))))
print('BLMCP_ENABLED=' + str('${ADDON_MODULE}' in bpy.context.preferences.addons))
print('BLMCP_ONLINE=' + str(bpy.app.online_access))
`

/** 起一个后台 Blender 问它自己的状态 —— 比在磁盘上猜扩展目录在哪可靠 */
async function diagnoseAddon(exe: string): Promise<BlenderDiagnosis | undefined> {
  try {
    const { stdout } = await execFileAsync(
      exe,
      ['--background', '--disable-autoexec', '--python-expr', DIAGNOSE_SCRIPT],
      { timeout: DIAGNOSE_TIMEOUT_MS }
    )
    const read = (key: string): boolean | undefined => {
      const match = new RegExp(`BLMCP_${key}=(True|False)`).exec(stdout)
      return match ? match[1] === 'True' : undefined
    }
    const installed = read('INSTALLED')
    const enabled = read('ENABLED')
    const online = read('ONLINE')
    if (installed === undefined || enabled === undefined || online === undefined) return undefined
    return { installed, enabled, online }
  } catch {
    // 诊断是锦上添花：问不出来就让上层说「问不出」，不能把它变成新的失败点
    return undefined
  }
}

const defaultDeps: BlenderLaunchDeps = {
  probe: probeBridge,
  isRunning: isBlenderRunning,
  diagnose: diagnoseAddon,
  launch: launchBlender,
  exists: existsSync,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}
