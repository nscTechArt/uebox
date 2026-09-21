/**
 * 一键接入官方 Blender Lab MCP —— 纯逻辑那一半。
 *
 * ## 为什么要有这个文件
 *
 * 和 `epicSetup.ts` 是同一个病：手工流程写在技能的 setup.md 里，一共四道关，
 * **四道全过的用户几乎没有**，过不完就等于这个能力不存在。四道是：
 *
 *   1. 装 git 和 Python 3.11+ —— 纯美术的机器上两样都没有
 *   2. 跑 `setup_mcp.ps1` / `setup_mcp.py` 装官方 server 和 Blender 插件
 *   3. 把装出来的绝对路径手敲进偏好设置 → MCP → 第三方服务器
 *   4. 再手敲三行环境变量，其中 `BLENDER_PATH` 少一个字，自动拉起 Blender
 *      的整段逻辑就认不出这是本机 Blender，静默失效（见 `blenderBridge.ts`）
 *
 * 第 2、3、4 步盒子全都能代劳：安装脚本是现成的，装完它自己会写一份
 * `mcp-entry.json`，而那份文件的形状正好就是 `mcp.json` 里的一条。
 * 所以一键要做的只是：**查清前置 → 跑脚本 → 把它写出来的那条并进配置**。
 *
 * 第 1 步不代劳。装 git 和 Python 是在用户机器上装软件，盒子没有理由替他决定
 * 装哪个版本、装到哪里；但**必须查清楚再报**——脚本自己缺 git 时只会甩一句
 * `Command failed: git`，用户看不出那是要他去装 git。
 *
 * ## 为什么拆成两个文件
 *
 * 和 `epicSetup` / `epicSetupRuntime` 一样的理由：这边全是版本号解析和配置
 * 合并，可以直接测；碰 `child_process`、探磁盘、跑安装脚本的那半在
 * `blenderSetupRuntime.ts`。
 */

import { join, posix, win32 } from 'path'

import { blenderBridgeTarget } from './blenderBridge'
import { isHttpConfig, type McpServerConfig, type McpSettings } from './types'

/**
 * 写进 `mcp.json` 的 server id。
 *
 * 固定成 `blender` 而不是让用户起名：一键这条路上用户没有命名的机会，
 * 而认出「这条已经配过了」要靠它。注意**识别本机 Blender 不看这个名字**
 * —— `blenderBridgeTarget` 认的是 `BLENDER_PATH`，用户改名后自动拉起照样有效。
 */
export const BLENDER_SERVER_ID = 'blender'

/**
 * 官方 server 的固定版本。
 *
 * **必须与两个安装脚本里的 `$revision` / `REVISION` 一字不差** ——
 * 安装目录名取它的前 8 位，对不上就会把已经装好的那份当成「别人的目录」
 * 拒绝复用，然后在旁边再装一份。
 * 脚本在 `resources/skills/blender-ue-pipeline/scripts/`。
 */
export const BLENDER_MCP_REVISION = '4309a39646e644261624bfcd2bca669b343b7621'

/** 官方插件的默认端口，和 `blenderBridge.ts` 的 `DEFAULT_PORT` 同源 */
export const BLENDER_DEFAULT_PORT = 9876

/** 官方插件要求的最低 Blender 版本 */
export const MIN_BLENDER_VERSION = { major: 5, minor: 1 }

/** 官方 server 要求的最低 Python 版本 */
export const MIN_PYTHON_VERSION = { major: 3, minor: 11 }

export interface Version {
  major: number
  minor: number
}

/** 前置依赖的三样。`python` 在 macOS 上还兼任安装脚本的解释器 */
export type BlenderPrerequisiteId = 'blender' | 'git' | 'python'

export interface BlenderPrerequisite {
  id: BlenderPrerequisiteId
  ok: boolean
  /**
   * 探到了什么。界面上要原样显示 —— 「Blender 4.5，需要 5.1+」比
   * 「版本不符」有用得多，用户据此知道该升级还是该改路径。
   */
  found?: string
  /** 探到的可执行文件路径。`blender` 这一项会被一键直接拿去用 */
  path?: string
  /** 没过的原因。`missing` 要去装，`too-old` 要去升级，是两件不同的事 */
  problem?: 'missing' | 'too-old'
}

/**
 * 一键按钮当前该长什么样。
 *
 * 分这么细的理由同 `EpicSetupStatus`：**每种状态该给用户的下一步都不一样**，
 * 合并成一个 boolean 就只能显示「不可用」，而那等于什么都没说。
 */
export type BlenderSetupState =
  /** `mcp.json` 里已经有一条带 `BLENDER_PATH` 的本机 Blender */
  | 'configured'
  /** 前置齐了，可以一键 */
  | 'ready'
  /** 缺前置。`prerequisites` 里写着缺哪个 */
  | 'blocked'
  /** 这个平台没有安装脚本（Linux） */
  | 'unsupported'

export interface BlenderSetupStatus {
  state: BlenderSetupState
  prerequisites: BlenderPrerequisite[]
  /** 一键会用的 Blender。`blocked` 时可能没有 */
  blenderPath?: string
  /** 官方 server 装到哪里。已经装过时一键会直接复用 */
  installRoot: string
  /** `configured` 时：配置里记的那个 Blender，用来让用户核对是不是他想要的那个 */
  configuredBlenderPath?: string
  /**
   * `configured` 时：那条 server 在 `mcp.json` 里的 id。
   *
   * 界面拿它去 `statuses` 里查这条**连上没有**。只看「配过」会让一键块在
   * 桥已经死掉时也收着 —— 插件装坏、Blender 换了版本，配置都还在。
   * 而这个函数兼做的「再点一次修一修」正是那种时候唯一的出路。
   */
  configuredServerId?: string
}

/**
 * 官方 server 的安装目录，和两个安装脚本的默认值保持一致。
 *
 * 显式传 `platform` / `env` / `home` 而不是就地读 `process`：这几行是
 * 「盒子以为装在哪」和「脚本实际装在哪」对齐的唯一依据，对不上就会出现
 * 「装完了却说没装」，必须能在两个平台上都测到。
 *
 * 也因此**分隔符按目标平台选，不用裸 `join`** —— 裸 `join` 跟的是跑测试的
 * 那台机器，于是在 Windows 上测 macOS 分支会拼出一条反斜杠的假路径，
 * 这个函数唯一要守的那件事反而测不到了。
 */
export function blenderInstallRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string {
  const folder = BLENDER_MCP_REVISION.slice(0, 8)
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', 'UnrealBox', 'BlenderMcp', folder)
  }
  // 脚本用的是 $env:LOCALAPPDATA，取不到时退回 home 下的同一段路径
  const localAppData = env.LOCALAPPDATA?.trim() || win32.join(home, 'AppData', 'Local')
  return win32.join(localAppData, 'UnrealBox', 'BlenderMcp', folder)
}

/** 装出来的那条配置落在哪。安装脚本写的就是这个文件 */
export function blenderEntryFile(installRoot: string): string {
  return join(installRoot, 'mcp-entry.json')
}

/**
 * 从 `blender --version` / `python --version` 的输出里抠出版本号。
 *
 * 两个都是 `名字 主.次.修订 …` 的形状，所以一个函数够用。
 * 抠不出来返回 `undefined` —— 调用方据此报「问不出版本」，
 * 而不是当成 0.0 去比大小然后说「版本太低」。
 */
export function parseVersion(text: string, name: string): Version | undefined {
  const match = new RegExp(`${name}\\s+(\\d+)\\.(\\d+)`, 'i').exec(text)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/** `found` 是不是够新 */
export function meetsVersion(found: Version, min: Version): boolean {
  return found.major > min.major || (found.major === min.major && found.minor >= min.minor)
}

/** 三项前置合起来是什么状态。已配置优先 —— 装没装过都不影响「已经能用了」 */
export function summarizeState(
  platform: NodeJS.Platform,
  prerequisites: BlenderPrerequisite[],
  configured: boolean
): BlenderSetupState {
  if (configured) return 'configured'
  if (platform !== 'win32' && platform !== 'darwin') return 'unsupported'
  return prerequisites.every((item) => item.ok) ? 'ready' : 'blocked'
}

/**
 * 配置里已经有一条本机 Blender 了吗？返回它的 id 和 `BLENDER_PATH`。
 *
 * ## 判据直接借 `blenderBridgeTarget`，不另写一套
 *
 * 第一版在这里重写了一遍「有没有 `BLENDER_PATH`」，还在注释里写着
 * 「判据和 `blenderBridgeTarget` 一致」—— 并不一致：那边还要求 host 是回环、
 * 端口是 1..65535 的整数。于是一条 `BLENDER_MCP_HOST=192.168.1.20` 的配置
 * 在这里算「已配好」（界面把整块一键收起来），在那边却返回 `undefined`
 * （自动拉起静默不挂载），用户得到的正是这一页反复防的那种**没有任何解释的空白**。
 *
 * 两个判据只能有一个，所以这里调它。
 *
 * ## 停用的不算
 *
 * `McpClientManager` 的 `connectAll` 会把 `disabled` 的条目滤掉，所以一条
 * 停用的 Blender 提供 0 个工具。把它算成「已配好」等于对着一个没有任何
 * Blender 工具的会话说「装好了」。
 *
 * ## 为什么返回 id
 *
 * 界面要拿它去 `statuses` 里查这条到底连上没有 —— 光知道「配过」不够，
 * 插件装坏、Blender 换了版本时配置都还在，而桥是死的。
 */
export function configuredBlenderServer(
  settings: McpSettings
): { id: string; path: string } | undefined {
  for (const [id, config] of Object.entries(settings.mcpServers ?? {})) {
    if (config.disabled) continue
    const target = blenderBridgeTarget(config)
    if (target) return { id, path: target.exe }
  }
  return undefined
}

/**
 * 解析安装脚本写出来的 `mcp-entry.json`。
 *
 * 它的形状就是一份 `mcp.json`（`{ mcpServers: { blender: {...} } }`），
 * 所以这里只取第一条 stdio 配置。**不复述脚本里的路径拼法** —— 装到哪、
 * 可执行文件叫什么由脚本说了算，盒子跟着读，两边各写一遍迟早会分叉。
 */
export function parseBlenderEntry(raw: unknown): McpServerConfig | undefined {
  const servers = (raw as { mcpServers?: unknown })?.mcpServers
  if (!servers || typeof servers !== 'object') return undefined

  for (const value of Object.values(servers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (!command) continue

    const args = Array.isArray(entry.args)
      ? entry.args.filter((item): item is string => typeof item === 'string')
      : []
    const env: Record<string, string> = {}
    if (entry.env && typeof entry.env === 'object') {
      for (const [key, item] of Object.entries(entry.env as Record<string, unknown>)) {
        if (typeof item === 'string') env[key] = item
        else if (typeof item === 'number') env[key] = String(item)
      }
    }
    // BLENDER_PATH 是整条自动拉起逻辑的开关，缺了这条配置写进去也只是半条
    if (!env.BLENDER_PATH?.trim()) continue

    return {
      type: 'stdio',
      command,
      ...(args.length > 0 ? { args } : {}),
      env
    }
  }

  return undefined
}

/**
 * 把一条 Blender 配置并进现有设置。
 *
 * ## 只动这一条
 *
 * 用户自己配的其他 server 原样保留。这不是客气 —— `mcp.json` 是用户可以
 * 直接手改的文件（设置页印着路径），一键把别人的配置洗掉一次，
 * 用户就再也不敢点第二次。
 *
 * ## 同名已存在时整条换掉，而不是合并 env
 *
 * 重装通常意味着换了 Blender 或换了安装目录。把旧 env 留着合并的话，
 * 会得到一条「新 command + 旧 BLENDER_PATH」的缝合配置，
 * 而它失败的样子和装坏了一模一样。
 *
 * ## 但界面管不到的字段要原样留住
 *
 * 「整条换掉」只对安装脚本**真的会写**的那三项成立：`command`、`args`、`env`。
 * 其余四项脚本从不写，全是用户自己手加的，换掉就是丢：
 *
 *   - `disabled` —— 用户特意关掉过这条，重装不该把它又打开
 *   - `allowedTools` —— 官方 Blender server 有 26 个工具，手写白名单是唯一
 *     的收敛办法。丢掉它，26 个 `destructive` 工具当场全部回来，而**没有任何提示**
 *   - `readOnlyTools` / `cwd` —— 同理
 *
 * 这正是 `renderer/src/api/mcp.ts` 的 `PreservedServerFields` 写在那儿的理由
 * （「表单读不懂的字段照原样搬回去，不是丢掉」）—— 那次事故是设置面板点一次保存
 * 就把手写配置抹了，这里是点一次「修一修」抹掉。同一个坑不该踩第二次。
 */
export function mergeBlenderServer(settings: McpSettings, config: McpServerConfig): McpSettings {
  const existing = settings.mcpServers?.[BLENDER_SERVER_ID]
  // `cwd` 只长在 stdio 那一支上。原来那条如果是 http 形态，它本来就没有 cwd
  const stdio = existing && !isHttpConfig(existing) ? existing : undefined
  return {
    version: 1,
    mcpServers: {
      ...settings.mcpServers,
      [BLENDER_SERVER_ID]: {
        ...config,
        ...(existing?.disabled ? { disabled: true } : {}),
        ...(stdio?.cwd ? { cwd: stdio.cwd } : {}),
        ...(existing?.allowedTools ? { allowedTools: existing.allowedTools } : {}),
        ...(existing?.readOnlyTools ? { readOnlyTools: existing.readOnlyTools } : {})
      }
    }
  }
}

/** 缺前置时给用户看的一句话。点名缺哪个、去哪装，不说「请检查环境」 */
export function describeMissing(prerequisites: BlenderPrerequisite[]): string {
  const failed = prerequisites.filter((item) => !item.ok)
  if (failed.length === 0) return ''

  const labels: Record<BlenderPrerequisiteId, { name: string; where: string }> = {
    blender: { name: 'Blender 5.1+', where: 'blender.org' },
    git: { name: 'Git', where: 'git-scm.com' },
    python: { name: 'Python 3.11+', where: 'python.org' }
  }

  return failed
    .map((item) => {
      const label = labels[item.id]
      if (item.problem === 'too-old') {
        return `${label.name}：这台机器上是 ${item.found ?? '更早的版本'}，需要升级（${label.where}）`
      }
      return `${label.name}：没找到，请先安装（${label.where}）`
    })
    .join('；')
}
