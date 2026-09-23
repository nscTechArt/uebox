/**
 * 对外 MCP server 的持久化配置。
 *
 * ## 为什么必须持久化
 *
 * 第一版是「随机端口 + 每次启动新 token」。安全上没问题，能用上就出问题了：
 * 用户在设置里开启服务，拿到 `http://127.0.0.1:53812/` 和一串 token，
 * 粘进 Claude Code 的 `.mcp.json`；**下次开盒子端口和 token 全变了**，
 * 那份配置直接失效，得回来重新复制一遍。
 *
 * 外部客户端的配置是写在磁盘上的长期配置，不是一次性的。地址和凭据必须稳定，
 * 否则「对外暴露」这件事根本没法投入使用。
 *
 * 所以：
 *   - **端口固定**，默认 17861（盒子自身的 HTTP 服务是 17860，挨着放好记），
 *     用户可改。端口被占用时报错让用户换一个 —— 不能悄悄退回随机端口，
 *     那等于又把配置搞失效了。
 *   - **token 只生成一次**并存盘，之后一直复用。
 *   - **enabled 记住开关状态**，下次启动盒子自动把服务拉起来，
 *     不用每次进设置点一遍。
 *
 * token 存在 userData 下的明文 JSON 里。它是本机回环服务的凭据，
 * 能读到这个文件的进程本来就能直接读盒子的数据库，加密没有意义。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { app } from 'electron'

const FILE = 'mcp-server.json'

/** 盒子自身的 HTTP 服务占 17860，这个挨着放 */
export const DEFAULT_HOST_PORT = 17861

export interface McpHostSettings {
  /** 开机是否自动启动 */
  enabled: boolean
  port: number
  /** 长期凭据，只在第一次生成 */
  token: string
  /** 是否连写操作工具一起暴露 */
  includeMutating: boolean
  /**
   * 「默认开」这条新规则有没有对这份配置生效过。
   *
   * 存在的唯一目的是区分「用户明确关过」和「他从来没做过选择」——
   * 见 `resolveEnabled()`。老配置里没有这个字段。
   */
  defaultOnApplied?: boolean
}

export function mcpHostSettingsPath(): string {
  return join(app.getPath('userData'), FILE)
}

function newToken(): string {
  return randomBytes(24).toString('hex')
}

/**
 * 读配置，缺什么补什么。
 *
 * 和 `mcp.json` 一样是用户可见、可手改的文件，所以解析要宽容：
 * 任何一个字段坏掉都不该让服务起不来；非法权限值按只读处理。
 *
 * 首次读取会生成 token 并落盘 —— 界面在服务还没启动时就要能显示
 * 完整的客户端配置片段，token 不能等到 start 才有。
 */
export async function readHostSettings(): Promise<McpHostSettings> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(mcpHostSettingsPath(), 'utf8'))
  } catch {
    parsed = {}
  }

  const raw = (parsed ?? {}) as Record<string, unknown>
  const port = Number(raw.port)
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''

  const settings: McpHostSettings = {
    enabled: resolveEnabled(raw),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_HOST_PORT,
    token: token || newToken(),
    // 新配置默认可写；老配置里明确的 false 仍是用户的只读选择。
    // 非法值按只读处理，避免手改配置时意外放开权限。
    includeMutating: raw.includeMutating === undefined || raw.includeMutating === true,
    defaultOnApplied: true
  }

  // 补出来的 token 立刻存盘，否则每次读都会换一个新的 ——
  // 那就退回到「配置隔天失效」的老问题了。
  // `defaultOnApplied` 也要落盘，否则下面那次一次性迁移每次启动都会重来。
  if (!token || raw.defaultOnApplied !== true) await writeHostSettings(settings)

  return settings
}

/**
 * 服务开不开。
 *
 * ## 为什么从「默认关」改成了「默认开」
 *
 * 这个服务原来默认关闭，用户要去设置里显式开一次。那条默认挡住的主要是误装误用，
 * 但代价是**我们自己随包发的命令行开箱不可用** —— 装完盒子敲 `uebox doctor`
 * 直接拿到 `SERVICE_UNAVAILABLE`，而用户完全想不到要去「MCP 设置」里开一个
 * 名叫「对外暴露虚幻引擎能力」的开关。CLI 和第三方 MCP 客户端是两件事，
 * 却共用同一个开关，这个耦合本身就是错的。
 *
 * 服务仍只监听 127.0.0.1，并强制 token。写工具是否开放由
 * `includeMutating` 决定，老配置里明确的只读选择会保留。
 * 而引擎的本地通道本来就一直开着（插件桥接的 17860 是常驻的）。
 *
 * ## 老用户怎么迁移
 *
 * 麻烦在于：首次读取时会把 `enabled: false` 落盘（那是为了持久化 token 顺手写的），
 * 所以磁盘上的 `false` **分不出「用户明确关过」还是「他从来没做过选择」**。
 * 用 `defaultOnApplied` 这个一次性标记区分：没有它 = 老文件 = 那个 false 不是
 * 用户的选择，按新默认开；有它之后，用户关掉就是真关掉，永远尊重。
 */
function resolveEnabled(raw: Record<string, unknown>): boolean {
  if (raw.defaultOnApplied === true) return raw.enabled === true
  return true
}

export async function writeHostSettings(settings: McpHostSettings): Promise<void> {
  const path = mcpHostSettingsPath()
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * 服务的回环地址。停止状态下也算得出来，界面据此提前渲染配置片段。
 *
 * 结尾的 `/` 要和 `McpServerHost.status()` 报的地址一致 —— 服务端其实不看
 * 路径，但两处给用户看的地址不一样只会让人怀疑自己抄错了。
 */
export function hostUrl(settings: McpHostSettings): string {
  return `http://127.0.0.1:${settings.port}/`
}

/**
 * 生成可以直接粘进外部客户端的配置片段。
 *
 * 在主进程里生成而不是让界面拼字符串：格式只有一处定义，能被测试盯住，
 * 而且以后加字段（比如 allowedTools）不用两边同时改。
 *
 * 这份形状 Claude Code（`.mcp.json`）、Cursor（`~/.cursor/mcp.json`）、
 * Cline 都认 —— 都是 Claude Desktop 那套 `mcpServers`。
 */
export function clientConfigSnippet(settings: McpHostSettings): string {
  return JSON.stringify(
    {
      mcpServers: {
        'unreal-box': {
          type: 'http',
          url: hostUrl(settings),
          headers: { Authorization: `Bearer ${settings.token}` }
        }
      }
    },
    null,
    2
  )
}

/** 换一把新 token（界面上的「重置令牌」）。旧配置随即失效，这是它的用途 */
export async function rotateHostToken(): Promise<McpHostSettings> {
  const settings = { ...(await readHostSettings()), token: newToken() }
  await writeHostSettings(settings)
  return settings
}
