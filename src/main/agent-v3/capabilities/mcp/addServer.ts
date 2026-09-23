/**
 * 「我装了个 MCP，端口 9876，你连一下」—— 把这句话变成一条能用的 mcp.json 配置。
 *
 * ## 为什么要有这个文件
 *
 * 在这之前，加一台第三方 server 只有一条路：用户自己进偏好设置 → MCP，
 * 在手动配置那张表里填标识、选连接方式、把启动命令和环境变量一行行敲对。
 * 模型帮不上忙 —— 它既没有写配置的工具，`write_local_file` 也够不着
 * userData（见 `tools/builtin/pathBoundary.ts`，那道墙是故意的）。
 *
 * 于是真机上的对话是这样的：用户说「我装好了，你连一下」，模型答
 * 「我没有连接 MCP 的能力，请你去设置里填」。**能填对的人本来就不需要问。**
 *
 * Blender 和 UE 5.8 官方 server 各自有一条一键接入（`blenderSetup.ts` /
 * `epicSetup.ts`），但那是设置页上厂商写死的按钮。这里要的是通用的那一半。
 *
 * ## 先连通再落盘
 *
 * 顺序不能反。写进去再说连不上，用户得到的是一条永远报错的配置，而且是
 * **盒子替他写的**那条 —— 他不知道该改哪里，也不知道该不该删。所以这里
 * 握手成功才落盘，失败就只报原因，盘上什么都不留。
 *
 * ## 这里只有纯逻辑
 *
 * 和 `blenderSetup` / `epicSetup` 拆两半是同一个理由：参数归一化、候选地址、
 * 报告措辞可以直接测；真的去握手、真的写盘在 `McpClientManager.addServer`
 * 和 `tools/builtin/mcpConnect.ts`。
 */

import type { McpServerConfig } from './types'

/** 和 `store.ts` 读配置时那把尺子一模一样：serverId 会成为工具名的一部分 */
export const SERVER_ID_RULE = /^[a-zA-Z0-9_-]{1,32}$/

/** 纯数字 = 用户只给了端口。真机上最常见的一种说法 */
const BARE_PORT = /^\d{1,5}$/

/**
 * `localhost:9876` / `192.168.1.7:3000` / `localhost:9876/mcp` —— 有主机有端口，就是少个协议头。
 * 端口后面可以跟路径或查询串；只认到端口为止的话，`localhost:9876/mcp` 会被当成
 * 一个叫 localhost 的协议，然后回一句「看不懂地址」
 */
const HOST_PORT = /^[\w.-]+:\d{1,5}(?:[/?#]|$)/

/** `http:` / `https:` / `file:` 这种开头。用来认「他到底写没写协议」 */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** Streamable HTTP 的事实标准路径。用户只给端口时第一个试它 */
const CONVENTIONAL_PATH = '/mcp'

export interface ConnectRequest {
  id: string
  /** 远程形态。可以是完整 URL，也可以只是 `9876` 或 `localhost:9876` */
  url?: string
  /** 本地形态：启动命令 */
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  headers?: Record<string, string>
  allowedTools?: string[]
}

export function validateServerId(id: string): string | undefined {
  if (SERVER_ID_RULE.test(id)) return undefined
  return (
    `标识 "${id}" 不合法。它会成为工具名的一部分（\`mcp_<标识>_<工具名>\`），` +
    '只允许字母、数字、下划线、连字符，最长 32 个字符。换一个短名字重试。'
  )
}

/**
 * 一个地址说法 → 要挨个试的候选 URL。
 *
 * ## 为什么要猜
 *
 * 用户说的是「端口 9876」，而连接要的是一个完整 URL。让模型回一句
 * 「请提供完整 URL」等于把问题原样推回去 —— 他多半也不知道路径是什么，
 * 那藏在 server 的 README 里。
 *
 * ## 为什么只猜两条
 *
 * `/mcp` 是 Streamable HTTP 的事实标准（SDK 示例、绝大多数 server 都用它），
 * 根路径是第二常见。再往下就是瞎试：每多一条都是一次十几秒的握手超时，
 * 而猜中的概率并不随之增长。两条都不中，正确的下一步是问用户要 README 里
 * 那一行，不是继续猜。
 *
 * 用户自己写了路径（`http://host:9876/api/mcp`）就**只试那一条** —— 他知道
 * 自己的 server 挂在哪，替他改路径只会让报错指向一个他没说过的地址。
 *
 * 认不出来的写法返回空数组，由调用方报错。
 */
export function httpUrlCandidates(raw: string): string[] {
  const text = raw.trim()
  if (!text) return []

  const withScheme = BARE_PORT.test(text)
    ? `http://127.0.0.1:${text}`
    : // 顺序要紧：`localhost:9876` 也能匹配「有协议头」那条正则
      //（`localhost` 长得就像一个 scheme），先认主机端口才不会把它当协议
      HOST_PORT.test(text) || !HAS_SCHEME.test(text)
      ? `http://${text}`
      : text

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return []
  }

  // 盒子只会说 HTTP(S)。`ws://` / `file://` 在这儿挡掉，比让 SDK 抛一句
  // 看不懂的传输层错误强
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return []

  if (parsed.pathname !== '/' || parsed.search) return [parsed.toString()]
  return [`${parsed.origin}${CONVENTIONAL_PATH}`, `${parsed.origin}/`]
}

/** 一条候选：要连的东西，以及报给用户时怎么称呼它 */
export interface Candidate {
  config: McpServerConfig
  /** 给人看的那行字：URL 或者完整命令行 */
  target: string
}

/**
 * 请求 → 挨个去试的候选配置。
 *
 * 两种形态只能给一种。同时给了 url 和 command 时不替用户挑 —— 挑错的那次
 * 会连上一个他没打算连的东西，而他从报告里看不出发生过一次选择。
 */
export function buildCandidates(
  req: ConnectRequest
): { candidates: Candidate[] } | { error: string } {
  const idError = validateServerId(req.id)
  if (idError) return { error: idError }

  const url = req.url?.trim()
  const command = req.command?.trim()

  if (url && command) {
    return {
      error:
        '同时给了 url 和 command，这是两种不同的接法（远程 HTTP / 本地进程），只能选一种。' +
        '按 server 的说明文档决定：给了一行启动命令的用 command，给了一个地址的用 url。'
    }
  }

  const common = {
    ...(req.allowedTools?.length ? { allowedTools: req.allowedTools } : {})
  }

  if (command) {
    return {
      candidates: [
        {
          config: {
            type: 'stdio',
            command,
            ...(req.args?.length ? { args: req.args } : {}),
            ...(req.env && Object.keys(req.env).length ? { env: req.env } : {}),
            ...(req.cwd?.trim() ? { cwd: req.cwd.trim() } : {}),
            ...common
          },
          target: [command, ...(req.args ?? [])].join(' ')
        }
      ]
    }
  }

  if (!url) {
    return {
      error:
        '既没有 url 也没有 command，没法知道要连什么。' +
        '远程 server 给 url（完整地址，或者只给端口号也行），本地 server 给 command（那一行启动命令）。'
    }
  }

  const urls = httpUrlCandidates(url)
  if (urls.length === 0) {
    return {
      error:
        `看不懂地址 "${url}"。可以写完整 URL（http://127.0.0.1:9876/mcp）、` +
        '主机加端口（localhost:9876），或者只写端口号（9876）。盒子只支持 http / https。'
    }
  }

  return {
    candidates: urls.map((one) => ({
      config: {
        type: 'http',
        url: one,
        ...(req.headers && Object.keys(req.headers).length ? { headers: req.headers } : {}),
        ...common
      },
      target: one
    }))
  }
}

export interface AddOutcome {
  id: string
  /** 真正连上的那条候选 */
  target: string
  toolCount: number
  toolNames: string[]
  serverName?: string
  serverVersion?: string
  settingsPath: string
  /** 写盘失败时带上原因。连是连上了，但这次不会留到下次开机 */
  persistError?: string
}

/** 工具名最多列几个。再多模型也用不上，还把结果撑成一面墙 */
const MAX_LISTED_TOOLS = 12

/**
 * 连上了怎么说。
 *
 * 最后那段不能省：工具清单是**每条消息开头装配一次**的（见 `ipc/agentV3.ts`
 * 的 `executeAgent`），这一轮的清单在这次工具调用之前就定死了。不明说的话，
 * 模型接下来就会去调 `mcp_xxx_yyy`，拿到「工具不存在」，然后大概率下结论
 * 说接入失败了 —— 而它其实已经成了。
 */
export function formatSuccess(outcome: AddOutcome): string {
  const named = outcome.serverName
    ? `（server 自报 ${outcome.serverName}${outcome.serverVersion ? ` ${outcome.serverVersion}` : ''}）`
    : ''
  const listed = outcome.toolNames.slice(0, MAX_LISTED_TOOLS)
  const more =
    outcome.toolNames.length > listed.length
      ? `，还有 ${outcome.toolNames.length - listed.length} 个`
      : ''

  const lines = [
    `已连上 MCP server「${outcome.id}」${named}，接的是 ${outcome.target}。`,
    `它带来 ${outcome.toolCount} 个工具，名字一律以 \`mcp_${outcome.id}_\` 开头：` +
      `${listed.join('、')}${more}。`
  ]

  if (outcome.persistError) {
    lines.push(
      `**配置没写进 ${outcome.settingsPath}**：${outcome.persistError}。` +
        '也就是说这次连上了，但盒子重启后就没有了 —— 告诉用户这件事，让他到' +
        '偏好设置 → MCP 里手动补一条，或者排查那个写盘错误。'
    )
  } else {
    lines.push(
      `配置已写进 ${outcome.settingsPath}，下次启动会自动连上；` +
        '用户可以在 偏好设置 → MCP 里看到它，也可以在那里改参数或停用。'
    )
  }

  lines.push(
    '**这些工具本轮还不在你手里。** 工具清单在每条消息开头装配一次，' +
      '这一轮的清单在你调用之前就定下来了。所以：把接好了这件事告诉用户，' +
      '请他发下一条消息，从那一条起你就能直接调这些工具。' +
      '不要在这一轮硬调它们，只会拿到「工具不存在」。'
  )

  return lines.join('\n')
}

export interface Attempt {
  target: string
  error: string
}

/**
 * 没连上怎么说。
 *
 * 把试过哪些地址、各自的原因原样列出来 —— 那是用户唯一能拿去排查的东西。
 * 后面几条建议不是客套：真机上「连不上」的分布高度集中在这几种，
 * 不写的话模型的下一步通常是换个端口再试一遍，而那次也一样不会通。
 */
export function formatFailure(id: string, attempts: Attempt[]): string {
  return [
    `没能连上「${id}」，**配置没有写入** —— 连不上的配置留在盘上，` +
      '只会变成一条每次启动都报错的记录。',
    '试过这些：',
    ...attempts.map((a) => `- ${a.target} —— ${a.error}`),
    '',
    '接下来可以查的（按真机上的常见程度排）：',
    '- **端口通不代表那是个 MCP 端点。** 很多工具的端口说的是它自己的插件通道' +
      '（比如 Blender 插件的 9876），MCP server 是另一个进程。让用户看 server 的' +
      '说明文档，那里写的是要跑哪行命令，而不是连哪个端口。',
    '- **大多数 MCP server 是本地进程（stdio），不是网络服务。** 说明文档里那行' +
      '`npx ...` / `uvx ...` / `python ...` 就是它，用 command 和 args 再试一次。',
    '- 远程形态盒子只支持 Streamable HTTP。只有旧式 SSE 端点的 server 接不进来。',
    '- stdio 起不来最常见的两个原因：命令不在 PATH 上（报 ENOENT），' +
      '或者 npx 第一次要下载包、超过了握手超时 —— 让用户先在终端里手动跑一次那行命令。'
  ].join('\n')
}
