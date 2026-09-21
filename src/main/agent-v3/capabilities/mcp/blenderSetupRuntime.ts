/**
 * `blenderSetup.ts` 的运行时外壳：探依赖、跑安装脚本、把结果写进 `mcp.json`。
 *
 * 拆成两个文件的理由见那边的文件头 —— 这边碰 `child_process`、碰磁盘、
 * 碰随包资源路径，纯逻辑留在那边好测。
 *
 * ## 安装脚本在主进程里跑，不走 agent 的 shell
 *
 * 这是整件事的关键。原来唯一的路是让模型调 `run_shell_command` 去跑
 * `setup_mcp.ps1`，而那个工具**只在机器上找得到 bash 时才注册**
 * （`tools/builtin/localShell.ts` 的 `isShellAvailable`，Windows 上≈装了
 * Git for Windows）。没装的机器上模型连工具都看不见，只能回一句
 * 「我没有连 Blender 的能力」—— 而那是假话。
 *
 * 主进程直接 `execFile` 到 `powershell` / `python3`，与用户机器上有没有 bash
 * 无关，也不经过审批门（用户点的那个按钮就是审批）。
 */

import { execFile } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'

import {
  BLENDER_SERVER_ID,
  blenderEntryFile,
  blenderInstallRoot,
  configuredBlenderServer,
  describeMissing,
  mergeBlenderServer,
  meetsVersion,
  MIN_BLENDER_VERSION,
  MIN_PYTHON_VERSION,
  parseBlenderEntry,
  parseVersion,
  summarizeState,
  type BlenderPrerequisite,
  type BlenderSetupStatus,
  type Version
} from './blenderSetup'
import { readMcpSettings, upsertMcpServer } from './store'

const execFileAsync = promisify(execFile)

/** 问一个可执行文件的版本号要多久。冷启动的 Blender 会读一遍扩展目录 */
const VERSION_PROBE_TIMEOUT_MS = 20_000

/**
 * 整个安装的上限。
 *
 * 要 `git fetch` 官方仓库、建 venv、pip 装依赖、再起两次后台 Blender
 * 打包和装插件。实测一两分钟，网络慢的机器更久；给到 15 分钟是因为
 * **超时杀掉一个装到一半的安装是最糟的结局** —— 留下的目录里没有
 * `installed-revision.txt`，脚本下次会拒绝复用它（故意的，那可能是别人的文件）。
 */
const INSTALL_TIMEOUT_MS = 15 * 60_000

/** 安装脚本的输出。pip 的进度条能刷出很长一串 */
const INSTALL_MAX_BUFFER = 16 * 1024 * 1024

/** 技能里那两个安装脚本所在的目录。随包资源，不是用户目录 */
function setupScriptDir(): string {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
  return join(root, 'blender-ue-pipeline', 'scripts')
}

/**
 * Windows 上 Blender 可能在哪。
 *
 * 官方安装器进 `Program Files\Blender Foundation\Blender X.Y\`，Steam 版在
 * steamapps 下。**这只是给界面预填一个默认值**，探不到不是失败 ——
 * 用户可以自己选，便携版和网络盘上的 Blender 本来就猜不到。
 */
async function windowsBlenderCandidates(env: NodeJS.ProcessEnv): Promise<string[]> {
  const roots = [
    join(env.ProgramFiles?.trim() || 'C:\\Program Files', 'Blender Foundation'),
    join(env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)', 'Blender Foundation')
  ]

  const found: string[] = []
  for (const root of roots) {
    let entries: string[]
    try {
      entries = await fs.readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const exe = join(root, entry, 'blender.exe')
      if (existsSync(exe)) found.push(exe)
    }
  }

  const steam = join(
    env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)',
    'Steam',
    'steamapps',
    'common',
    'Blender',
    'blender.exe'
  )
  if (existsSync(steam)) found.push(steam)

  // 排一下只为结果稳定。**「用哪个版本」不由这个顺序决定** ——
  // 名字排序解不了两位数小版本（`Blender 5.10` 排在 `5.2` 前面），也解不了
  // Steam 那条（`Program Files (x86)` 里的 `(` 排在 `\` 前面，于是 Steam 的
  // 5.1 永远压过官方的 5.4）。挑版本的活在 `checkVersioned` 里按真实版本号做。
  return found.sort()
}

/** macOS 上 Blender 可能在哪 */
function macBlenderCandidates(home: string): string[] {
  return [
    '/Applications/Blender.app/Contents/MacOS/Blender',
    join(home, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender')
  ].filter((path) => existsSync(path))
}

/** 问一个可执行文件的版本。问不出来（不存在、不是可执行文件）返回 undefined */
async function probeVersionOutput(exe: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(exe, args, {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true
    })
    // Python 3.3 之前把版本打在 stderr 上；两条都看，反正只是找一行版本号
    return `${stdout}\n${stderr}`
  } catch {
    return undefined
  }
}

/** `a` 比 `b` 新吗？`b` 缺席时任何版本都算更新 */
function newerThan(a: Version, b: Version | undefined): boolean {
  return !b || a.major > b.major || (a.major === b.major && a.minor > b.minor)
}

/**
 * 检查一个有版本要求的前置，**同机装了多个就挑版本号最大的那个**。
 *
 * 不能挑「第一个够用的」：候选是按路径字符串排的，而路径顺序和版本顺序
 * 没有关系（`Blender 5.10` 的路径排在 `5.2` 前面；Steam 的路径排在
 * 官方安装目录前面）。于是「第一个够用的」实际含义是「随便哪个」，
 * 装了 5.1 和 5.4 的机器会把插件装进 5.1 —— 扩展是按 Blender 版本分开存的，
 * 用户打开 5.4 时桥根本不在。
 *
 * 代价是每个候选都要问一次版本，不再中途返回。几个 `--version` 而已。
 */
async function checkVersioned(
  id: 'blender' | 'python',
  candidates: string[],
  versionArgs: string[],
  name: string,
  min: { major: number; minor: number }
): Promise<BlenderPrerequisite> {
  let best: { version: Version; item: BlenderPrerequisite } | undefined
  // 版本不够的也记下来：一台只装了 Blender 4.5 的机器，该看到
  // 「找到 4.5，需要 5.1+」，而不是「没找到 Blender」
  let tooOld: { version: Version; item: BlenderPrerequisite } | undefined

  for (const candidate of candidates) {
    const output = await probeVersionOutput(candidate, versionArgs)
    if (!output) continue

    const version = parseVersion(output, name)
    if (!version) continue

    const label = `${name} ${version.major}.${version.minor}`
    if (meetsVersion(version, min)) {
      if (newerThan(version, best?.version)) {
        best = { version, item: { id, ok: true, found: label, path: candidate } }
      }
    } else if (newerThan(version, tooOld?.version)) {
      tooOld = {
        version,
        item: { id, ok: false, found: label, path: candidate, problem: 'too-old' }
      }
    }
  }

  return best?.item ?? tooOld?.item ?? { id, ok: false, problem: 'missing' }
}

/** git 没有版本下限，装了就行 */
async function checkGit(): Promise<BlenderPrerequisite> {
  const output = await probeVersionOutput('git', ['--version'])
  if (!output) return { id: 'git', ok: false, problem: 'missing' }
  return { id: 'git', ok: true, found: output.trim().split(/\r?\n/)[0], path: 'git' }
}

/**
 * 这台机器上 Python 可能叫什么。
 *
 * **`py` 必须在里面**：python.org 的 Windows 安装器默认不勾
 * 「Add python.exe to PATH」，所以装好之后进 PATH 的只有这个启动器；
 * 这时 `python` / `python3` 撞上的是 WindowsApps 里那两个假入口
 * （打开应用商店、不打印版本号）。第一版漏了它，注释却写着「`py` 启动器
 * 单独一支」—— 于是一台装着好好的 Python 3.13 的机器被判「没找到 Python」，
 * 而 Python 这一项又没有「选择…」那样的手动出路，等于永久锁死。
 */
function pythonCandidates(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']
}

/**
 * 把解释器问成绝对路径。
 *
 * `execFile` 会查 PATH，所以拿 `python` 这个**名字**探版本是成功的；
 * 但 `setup_mcp.ps1` 收到它之后做的是
 * `(Resolve-Path -LiteralPath $PythonPath).ProviderPath`，而 `Resolve-Path`
 * **不查 PATH**，在 `$ErrorActionPreference='Stop'` 下第 20 行就抛。
 * 结果是界面刚说完「Python 3.12 ✓」，点下去却报「找不到路径 python」——
 * 整个 Windows 一键安装从来没有成功过。
 *
 * 所以问解释器自己要 `sys.executable`：`py` 这种启动器也会如实报出它
 * 真正拉起来的那个 exe，比在 PATH 上猜可靠。
 */
async function resolveInterpreterPath(exe: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(exe, ['-c', 'import sys; print(sys.executable)'], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true
    })
    const resolved = stdout.trim().split(/\r?\n/).pop()?.trim()
    return resolved && existsSync(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

/**
 * Python 这一项：先按版本挑，再落成绝对路径。
 *
 * 问不出绝对路径就当没找到 —— 把一个名字递给安装脚本只会换来一句
 * 用户读不懂的 PowerShell 报错，不如在这儿就说「没找到」。
 */
async function checkPython(platform: NodeJS.Platform): Promise<BlenderPrerequisite> {
  const found = await checkVersioned(
    'python',
    pythonCandidates(platform),
    ['--version'],
    'Python',
    MIN_PYTHON_VERSION
  )
  if (!found.ok || !found.path) return found

  const absolute = await resolveInterpreterPath(found.path)
  if (!absolute) return { id: 'python', ok: false, found: found.found, problem: 'missing' }
  return { ...found, path: absolute }
}

export interface BlenderSetupEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
}

function currentEnvironment(): BlenderSetupEnvironment {
  return { platform: process.platform, env: process.env, home: app.getPath('home') }
}

/**
 * 探这台机器上的三项前置。要起三个子进程问版本，别在一次交互里调两遍。
 */
export async function checkPrerequisites(
  environment: BlenderSetupEnvironment
): Promise<BlenderPrerequisite[]> {
  const { platform, env, home } = environment
  const candidates =
    platform === 'win32' ? await windowsBlenderCandidates(env) : macBlenderCandidates(home)

  return Promise.all([
    checkVersioned('blender', candidates, ['--version'], 'Blender', MIN_BLENDER_VERSION),
    checkGit(),
    checkPython(platform)
  ])
}

/**
 * 界面进来时调一次：现在能不能一键，不能的话缺什么。
 *
 * 已经配过的直接返回 `configured`，**不再去探依赖** —— 配好之后 git 和
 * Python 就不再需要了（server 跑在自己的 venv 里），这时候还报「缺 git」
 * 会让用户以为配置坏了。
 *
 * 所以 `configured` 那一支的 `prerequisites` 是空的，**而空不等于「都过了」**。
 * `runBlenderSetup` 因此不能拿这个返回值当前置检查用，它自己再探一次。
 */
export async function inspectBlenderSetup(
  environment: BlenderSetupEnvironment = currentEnvironment()
): Promise<BlenderSetupStatus> {
  const { platform, env, home } = environment
  const installRoot = blenderInstallRoot(platform, env, home)

  const configured = configuredBlenderServer(await readMcpSettings())
  if (configured) {
    return {
      state: 'configured',
      prerequisites: [],
      installRoot,
      configuredBlenderPath: configured.path,
      configuredServerId: configured.id
    }
  }

  if (platform !== 'win32' && platform !== 'darwin') {
    return { state: 'unsupported', prerequisites: [], installRoot }
  }

  const prerequisites = await checkPrerequisites(environment)
  const blender = prerequisites.find((item) => item.id === 'blender')
  return {
    state: summarizeState(platform, prerequisites, false),
    prerequisites,
    ...(blender?.path ? { blenderPath: blender.path } : {}),
    installRoot
  }
}

export interface BlenderSetupResult {
  success: boolean
  /** 给界面直接显示的一句话 */
  message: string
  /** 失败原因原文。用户唯一能拿去排查的东西，不概括 */
  error?: string
  /** 成功时：写进配置的那个 Blender */
  blenderPath?: string
}

/**
 * 跑一次安装，装完把配置写进 `mcp.json`。
 *
 * 顺序是「先装、再读脚本写的 `mcp-entry.json`、最后并进配置」。
 * **不自己拼那条配置**——装到哪、可执行文件叫什么由脚本说了算，
 * 两边各写一遍迟早分叉（见 `parseBlenderEntry`）。
 *
 * 重复点不会装两遍：脚本认 `installed-revision.txt`，同一版本直接跳到
 * 装插件那步。所以这个函数也兼做「修一修」——插件那步以前失败过的，
 * 再点一次就补上了。
 */
export async function runBlenderSetup(
  args: { blenderPath?: string } = {},
  environment: BlenderSetupEnvironment = currentEnvironment(),
  deps: BlenderSetupDeps = {}
): Promise<BlenderSetupResult> {
  const { platform, env, home } = environment
  const install = deps.runInstaller ?? runInstaller

  if (platform !== 'win32' && platform !== 'darwin') {
    return {
      success: false,
      message: '这个平台还没有 Blender 安装脚本，只有 Windows 和 macOS 有。',
      error: `unsupported platform: ${platform}`
    }
  }

  // 自己探，不复用 `inspectBlenderSetup` 的返回值 —— 已经配过的机器上那边
  // 会短路成空列表，拿它当前置检查会让每一次「重装修一修」都卡在
  // 「没找到 Python」，而插件装坏的用户正是靠这条路修回来的
  const prerequisites = await checkPrerequisites(environment)

  const blenderPath =
    args.blenderPath?.trim() || prerequisites.find((item) => item.id === 'blender')?.path
  if (!blenderPath) {
    return {
      success: false,
      message: '没找到 Blender。请在上面选一个 blender 可执行文件再试。',
      error: 'no blender executable'
    }
  }
  if (!existsSync(blenderPath)) {
    return {
      success: false,
      message: `这个位置没有文件：${blenderPath}`,
      error: `blender not found: ${blenderPath}`
    }
  }

  // 用户自己选了 Blender 的情况下，探到的那条 blender 前置可能是别的版本，
  // 不该拿它挡路；git 和 python 两条与选哪个 Blender 无关，照挡。
  //
  // **`userPicked` 这个条件不能省。** 第一版无条件滤掉 blender 那条，于是
  // 一台只装了 Blender 4.5 的机器上，`blenderPath` 从 `too-old` 记录里回退到
  // 那个 4.5，自己的守卫又刚被滤掉，安装照跑 —— 三十秒后死在脚本里的一句
  // 英文 `The official Blender Lab add-on requires Blender 5.1 or newer.`。
  // 界面那边的同一条规则本来就是带条件的，两层必须一致。
  const userPicked = Boolean(args.blenderPath?.trim())
  const blocking = prerequisites.filter(
    (item) => !item.ok && !(item.id === 'blender' && userPicked)
  )
  if (blocking.length > 0) {
    const missing = describeMissing(blocking)
    return { success: false, message: `还差这些才能装：${missing}`, error: missing }
  }

  const python = prerequisites.find((item) => item.id === 'python')?.path
  if (!python) {
    return {
      success: false,
      message: '没找到 Python 3.11+，官方 server 装不了。',
      error: 'no python interpreter'
    }
  }

  const installRoot = blenderInstallRoot(platform, env, home)

  // 装到一半留下的目录会把这个按钮永久卡死，先把它清掉
  const stuck = await clearPartialInstall(installRoot)
  if (stuck) return { success: false, message: stuck, error: `stale install root: ${installRoot}` }

  let installerOutput = ''
  try {
    installerOutput = await install(platform, setupScriptDir(), blenderPath, python)
  } catch (error) {
    const reason = installerMessage(error)
    return {
      success: false,
      // 带上安装目录：脚本自己的那句报错只说「换一个目录」，不说是哪个
      message: `安装没跑完：${reason}（安装目录：${installRoot}）`,
      error: reason
    }
  }

  const entryFile = blenderEntryFile(installRoot)
  let entry: ReturnType<typeof parseBlenderEntry>
  try {
    entry = parseBlenderEntry(JSON.parse(await fs.readFile(entryFile, 'utf8')))
  } catch (error) {
    return {
      success: false,
      message: '装完了，但读不到安装脚本写出来的配置，没能自动填进 MCP 设置。',
      error: `${entryFile}: ${(error as Error).message}`
    }
  }
  if (!entry) {
    return {
      success: false,
      message: '装完了，但安装脚本写出来的配置不完整，没能自动填进 MCP 设置。',
      error: `${entryFile} has no usable server entry`
    }
  }

  // 只写这一条，不回写整份配置。
  //
  // `readMcpSettings` 会**丢掉**它看不懂的条目 —— id 不符合
  // `^[a-zA-Z0-9_-]{1,32}$` 的（比如从 Claude Desktop 抄来的
  // `"github.com/foo"`）只留一行 warn 就跳过。把它读回来再整份写出去，
  // 等于替用户把那些条目从盘上删了，而 `mergeBlenderServer` 的说明里
  // 明明写着「用户自己配的其他 server 原样保留」。
  const merged = mergeBlenderServer(await readMcpSettings(), entry)
  await upsertMcpServer(BLENDER_SERVER_ID, merged.mcpServers[BLENDER_SERVER_ID])

  return {
    success: true,
    message:
      '已接入 Blender。需要视口的操作盒子会自己把 Blender 拉起来，不用手动开。' +
      onlineAccessNote(installerOutput),
    blenderPath
  }
}

/**
 * 装完那一刻就把「允许联机访问」是关的这件事说出来。
 *
 * ## 为什么非说不可
 *
 * 官方插件把开桥当联机行为，这一项关着它就拒绝监听端口 —— 而它默认是关的。
 * 盒子自己拉 Blender 一律带 `--online-mode`，所以走盒子这条路不受影响；
 * 可用户装完的下一件事常常是**自己双击打开 Blender** 开始建模，那个 Blender
 * 永远没有桥。
 *
 * 这条链路本来是有兜底的（`blenderBridge.ts` 会起一个后台 Blender 读
 * `bpy.app.online_access`，把该改哪一项写进报错），但那要等到**第一次工具
 * 调用失败**才发生。而安装脚本在装完的那一秒就已经知道答案了 —— 它读回过
 * 这三项状态。原先 `runInstaller` 把整段 stdout 扔了，于是这个已知的事实
 * 被丢掉，用户要绕一圈失败才拿得到。
 *
 * ## 认标记，不认那几句英文
 *
 * 脚本里那三行提示是给人看的，改个措辞是随时的事；`BLMCP_ONLINE=` 是
 * 专门为这里加的机器可读行。另外脚本最后那句
 * `Add the generated server entry in Box MCP settings` **不能原样透传** ——
 * 盒子已经替用户做完了，照抄会让他再去手填一遍。所以这里不转发 stdout，
 * 只取这一个事实，用自己的话说。
 */
function onlineAccessNote(installerOutput: string): string {
  if (!/BLMCP_ONLINE=False/i.test(installerOutput)) return ''
  return (
    '（另外：Blender 的「允许在线访问」是关的。盒子拉起来的那个不受影响，' +
    '但你自己双击打开的 Blender 不会开桥 —— 要么让盒子来开，' +
    '要么在 Blender 的偏好设置 → 系统 → 网络里勾上这一项。）'
  )
}

/**
 * 安装脚本装到一半会留下的东西。**只认这几样才敢删。**
 *
 * 脚本自己拒绝复用一个没有 `installed-revision.txt` 的目录，理由是
 * 「那可能是别人的文件」—— 这个判断是对的，所以这里不是无脑 `rm -rf`：
 * 出现任何一个不在这张表里的名字就不动它，改成告诉用户路径。
 */
const INSTALL_ROOT_ENTRIES = new Set([
  'source',
  'venv',
  'installed-revision.txt',
  'blender-lab-mcp.zip',
  'mcp-entry.json',
  'mcp-entry.json.tmp'
])

/**
 * 清掉一个装到一半的安装目录，清不了就返回一句给用户看的话。
 *
 * ## 为什么必须做这件事
 *
 * `setup_mcp.ps1` 先建 `<root>\source`，最后才写 `installed-revision.txt`。
 * 中间任何一步断掉（网络抖一下、pip 失败、15 分钟超时）都会留下一个
 * 没有那张记录的目录，而脚本下一次直接抛
 * `InstallDirectory is already in use or contains an incomplete install.
 *  Choose a new directory; nothing was removed.`
 *
 * 问题是**盒子没有「换一个目录」这个入口**：`runInstaller` 不传
 * `-InstallDirectory`，界面也没有目录选择器。于是这一句建议对用户毫无意义，
 * 按钮从此每次都以同样的方式失败，直到他自己去删那个目录 —— 而报错里
 * 连路径都没有。所以断过一次的目录由盒子清掉，按钮保持可用。
 */
async function clearPartialInstall(installRoot: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await fs.readdir(installRoot)
  } catch {
    return undefined // 不存在就是干净的
  }

  // 有记录的是装完的，脚本会自己复用，跳到装插件那步
  if (entries.includes('installed-revision.txt')) return undefined

  const unexpected = entries.filter((entry) => !INSTALL_ROOT_ENTRIES.has(entry))
  if (unexpected.length > 0) {
    return (
      `${installRoot} 里有一份没装完的安装，而且夹着不认识的文件` +
      `（${unexpected.slice(0, 3).join('、')}），盒子没有动它。` +
      '请确认这个目录没有你要留的东西，删掉它再点一次。'
    )
  }

  await fs.rm(installRoot, { recursive: true, force: true })
  return undefined
}

/**
 * 跑安装脚本。抽成可替换的一项，测试才不会真去 `git fetch` 官方仓库。
 *
 * 返回 stdout：脚本在装完那一秒就已经读回了 Blender 侧的三项状态，
 * 扔掉它等于把一个已知的事实丢了（见 `onlineAccessNote`）。
 */
export interface BlenderSetupDeps {
  runInstaller?: (
    platform: NodeJS.Platform,
    scriptDir: string,
    blenderPath: string,
    python: string
  ) => Promise<string>
}

/** 按平台挑安装脚本。两个脚本的参数形状不一样，这里是唯一分叉点 */
async function runInstaller(
  platform: NodeJS.Platform,
  scriptDir: string,
  blenderPath: string,
  python: string
): Promise<string> {
  if (platform === 'darwin') {
    const { stdout } = await execFileAsync(
      python,
      [join(scriptDir, 'setup_mcp.py'), '--blender-path', blenderPath],
      { timeout: INSTALL_TIMEOUT_MS, maxBuffer: INSTALL_MAX_BUFFER }
    )
    return stdout
  }

  // `-ExecutionPolicy Bypass` 是必须的：Windows 客户端的默认策略挡住
  // 直接跑 .ps1，而那报错看起来像脚本坏了
  const { stdout } = await execFileAsync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(scriptDir, 'setup_mcp.ps1'),
      '-BlenderPath',
      blenderPath,
      '-PythonPath',
      python
    ],
    { timeout: INSTALL_TIMEOUT_MS, maxBuffer: INSTALL_MAX_BUFFER, windowsHide: true }
  )
  return stdout
}

/**
 * 从安装失败里抠出一句人看得懂的话。
 *
 * 脚本是 `throw` 出错的，真正的原因在 stderr 的最后几行；`execFile` 的
 * `message` 只有一句 `Command failed`，原样抛给用户等于没报错。
 *
 * **「我们自己杀的」要排在 stderr 前面判。** `execFile` 超时杀进程时
 * 会**照样**把已经收到的 stderr 挂在 error 上，所以先看 stderr 的话，
 * 一次 15 分钟的超时会被报成最后那三行无关的 pip 警告，而真正的
 * 「已中止」那一句永远轮不到 —— 它只在 stderr 一个字都没有时才出现。
 */
function installerMessage(error: unknown): string {
  const failure = error as {
    killed?: boolean
    signal?: string | null
    code?: unknown
    stderr?: string
  }

  if (failure.killed || failure.signal) {
    return (
      `安装超过 ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} 分钟仍未结束，已中止。` +
      // Windows 上杀 powershell.exe 不会连带杀掉它拉起的 git / pip / blender
      '（脚本拉起的 git、pip 可能还在后台跑，过一会儿再点一次。）'
    )
  }
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return '安装脚本的输出超出上限，已中止。'
  }

  const stderr = failure.stderr?.trim()
  if (stderr) {
    const lines = stderr.split(/\r?\n/).filter((line) => line.trim())
    return lines.slice(-3).join(' ').slice(0, 500)
  }
  return (error as Error).message
}
