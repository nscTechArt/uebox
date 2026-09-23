/**
 * MCP Client —— 把第三方 MCP server 的工具接进 V3。
 *
 * 这是 V3 相对 V2 最大的扩展性提升：用户在设置里加一个 server，不用等我们写代码
 * 就能给 agent 增加能力。
 *
 * ## 安全立场：第三方工具默认不可信
 *
 * MCP 工具一律标 `destructive`，无论 server 怎么自我声明。理由：
 *
 *   - 我们看不到它的实现，无法判断它会不会删文件、发网络请求、改系统设置
 *   - MCP 的 `annotations.readOnlyHint` 是 **server 自报**的，攻击者随便填
 *
 * `destructive` 意味着即使在 auto-edit 模式下也要用户确认。用户信任某个 server 时，
 * 审批弹窗里点「本次会话始终允许」即可，成本只有一次。
 *
 * ## 隔离
 *
 * 每个 server 独立连接、独立超时、独立错误捕获。一个 server 起不来或者卡住，
 * 其余照常工作 —— 不能因为用户配错一个 server 就让整个 agent 用不了。
 */

import { createHash } from 'crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { TSchema } from 'typebox'

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { runAbortable } from '../../tools/abortable'
import { compressForContext } from '../../tools/contextImage'
import type { UnrealAgentTool } from '../../tools/defineTool'
import { createBlenderLauncher, isBridgeDownMessage } from './blenderBridge'
import { toVendorSafeSchema } from './vendorSchema'
import { isHttpConfig, type McpServerConfig, type McpServerStatus } from './types'

/** 连接单个 server 的超时。卡住的 server 不能拖住整个 agent 启动 */
const CONNECT_TIMEOUT_MS = 20_000

/** 单次工具调用的超时 */
const CALL_TIMEOUT_MS = 120_000

/**
 * 单个 server 允许贡献的工具数上限。
 *
 * 超过就整个拒绝接入，而不是截断 —— 截断会让模型看到一份残缺的能力表，
 * 「有些工具时灵时不灵」比「这个 server 没接上」难排查得多。
 *
 * 120 这个数是照着已知最大的一家定的：UE 5.8 官方 server 在
 * `bEnableToolSearch=false` 时会一次性铺开约 900 个工具（见 epicToolsets.ts），
 * 那既会撑爆上下文，也会撞上工具名 64 字符上限。默认的 `bEnableToolSearch=true`
 * 只暴露 3 个，正常接入完全够用。
 *
 * 想接一个确实很大的 server，用 `allowedTools` 点名要哪些。
 */
export const MAX_TOOLS_PER_SERVER = 120

/** 工具名前缀。避免第三方工具和我们自己的 77 个撞名 */
export function namespaceFor(serverId: string): string {
  return `mcp.${serverId}`
}

/** 厂商工具名上限 */
const MAX_TOOL_NAME = 64

/** 截断时留给哈希后缀的长度：`_` + 8 位十六进制 */
const HASH_SUFFIX_LEN = 9

/**
 * MCP 工具名 → V3 工具名。
 *
 * 厂商要求 `^[a-zA-Z0-9_-]{1,64}$`，而 MCP server 可以起任意名字
 * （常见带点号或斜杠）。不清洗的话整个请求会被厂商拒掉 ——
 * 而且报错信息通常只说「invalid tool name」，不指出是哪个。
 *
 * ## 超长时为什么不能直接截断
 *
 * 深命名空间的 server 会把整棵路径写进工具名。UE 5.8 官方
 * ModelContextProtocol 插件就是这样：
 *
 *   toolset_registry.toolsets.core.actor.ActorTools.get_label
 *   toolset_registry.toolsets.core.material_instance.MaterialInstanceTools.set_scalar_parameter
 *
 * 加上前缀清洗后，一大批工具的前 64 个字符完全一样。直接 `slice(0, 64)`
 * 会让两个不同的工具注册成同一个名字 —— 模型调到的是另一个工具，
 * 或者厂商直接以「重名」拒掉整份工具列表。
 *
 * 所以截断时留 9 位放**完整原名**的哈希：前缀仍然可读（模型靠它认工具），
 * 后缀保证不同原名一定得到不同结果。哈希只影响对外注册的名字，
 * 真正调用用的还是 `toAgentTool` 闭包里的原始 `tool.name`。
 */
export function toSafeToolName(serverId: string, toolName: string): string {
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  const full = `mcp_${clean(serverId)}_${clean(toolName)}`
  if (full.length <= MAX_TOOL_NAME) return full

  // 哈希取未清洗的原始输入：清洗是多对一的，`a.b` 和 `a_b` 洗完一样，
  // 拿洗过的串做哈希等于把碰撞又放回来了
  // 带长度前缀拼接：分隔符本身可能出现在名字里，`a:b`+`c` 和 `a`+`b:c` 拼完一样
  const digest = createHash('sha256')
    .update(`${serverId.length}:${serverId}:${toolName}`, 'utf-8')
    .digest('hex')
    .slice(0, HASH_SUFFIX_LEN - 1)

  return `${full.slice(0, MAX_TOOL_NAME - HASH_SUFFIX_LEN)}_${digest}`
}

interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: { uri: string; text?: string; mimeType?: string }
}

/**
 * MCP 的内容块 → pi 的内容块。
 *
 * MCP 有 text / image / audio / resource 四种，pi 只认 text 和 image。
 * audio 和 resource 降级成文本描述而不是丢掉 —— 丢掉的话模型看到一个
 * 空结果，会以为调用失败并重试。
 *
 * ## 图片一律重压
 *
 * 第三方 server 返回多大的图完全不由我们决定 —— Blender 那类渲染 server
 * 随手就是几 MB 的 PNG。原样转发进上下文的代价是一次 413：厂商网关的请求体
 * 上限在 1MB 附近，而 pi 每次请求都重发整条 transcript，一张超大的图会把
 * **后续每一轮**都打死（原委见 `builtin/localFiles.ts` 的 `readImageProcessor`）。
 */
export async function toPiContent(
  blocks: McpContentBlock[]
): Promise<AgentToolResult<unknown>['content']> {
  const content: AgentToolResult<unknown>['content'] = []

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && block.data) {
      const compressed = await compressForContext(Buffer.from(block.data, 'base64'))
      content.push(
        compressed
          ? { type: 'image', data: compressed.data, mimeType: compressed.mimeType }
          : {
              type: 'text',
              text:
                `[这个 server 返回了一张图（${block.mimeType ?? '未知格式'}），` +
                '但压不进上下文，你看不到它。需要的话把结果里的文件路径告诉用户，让他自己看。]'
            }
      )
    } else if (block.type === 'resource' && block.resource) {
      const { uri, text } = block.resource
      content.push({ type: 'text', text: text ? `[${uri}]\n${text}` : `[资源 ${uri}]` })
    } else if (block.type === 'audio') {
      content.push({
        type: 'text',
        text: `[音频内容，${block.mimeType ?? '未知格式'}，无法直接读取]`
      })
    }
  }

  // pi 要求 content 非空
  if (content.length === 0) content.push({ type: 'text', text: '(无输出)' })
  return content
}

/** 把结果里的文本块拼起来 —— 报错和「桥没通」的判断都只看得到文本 */
function textOf(blocks: McpContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/** MCP 工具调用结果里我们真正用到的部分 */
export interface McpCallResult {
  content?: McpContentBlock[]
  isError?: boolean
}

/** 桥断了怎么办：拉起来（`ok`）或者给出用户能照做的原因（`reason`） */
export type BridgeRecovery = () => Promise<
  { ok: true; launched: boolean } | { ok: false; reason: string }
>

/**
 * 跑一次 MCP 工具，必要时先把 Blender 的桥修好再重来一次。
 *
 * 单独拎出来是为了能直接测：这里唯一危险的判断是「什么时候可以重试」——
 * 判错就等于把一次几何修改做两遍。判据在 `isBridgeDownMessage`，
 * 只认「连接被拒」，那种情况下代码根本没送到 Blender。
 */
export async function runMcpTool(
  toolName: string,
  callOnce: () => Promise<McpCallResult>,
  ensureBridge?: BridgeRecovery
): Promise<AgentToolResult<unknown>> {
  let result = await callOnce()
  let blocks = result.content ?? []
  /** 自动启动过就说一声，别让「刚才连不上、现在又通了」变成一个谜 */
  let notice: string | undefined

  // 官方 server 可能把这个错误报成 MCP 错误，也可能塞进一个成功响应里，
  // 所以两层一起看（见 docs/Blender-DCC互联能力设计.md）
  const bridgeDown = isBridgeDownMessage(textOf(blocks))

  // 桥断了、却连自动拉起都没挂上 —— 只可能是配置里没有 `BLENDER_PATH`
  // （`isBridgeDownMessage` 只认 Blender 插件自己的那两句话，别的 server 到不了这里）。
  //
  // 这一条是真机踩出来的：用户在设置面板里配好 blender、状态显示「已连接」，
  // 技能文档也写着「盒子会自动启动 Blender」，然后**什么都没发生**，
  // 报出来的只有一句 `Cannot connect to Blender`。整条链路里最难查的一环，
  // 恰恰是「那段代码根本没被挂上」，从外面完全看不出来。所以宁可在这里明说。
  if (!ensureBridge && bridgeDown) {
    throw new Error(
      `MCP 工具 ${toolName} 失败：${textOf(blocks)}\n` +
        '这个 server 的配置里没有 BLENDER_PATH，盒子因此没法自动启动 Blender —— ' +
        '需要窗口的桥调用会一直失败，后台的 *_for_cli 一族也只能去 PATH 上找 blender。' +
        '请到偏好设置 → MCP，在这个 server 的「环境变量」里补上 ' +
        'BLENDER_PATH=<Blender 可执行文件的绝对路径>，然后重新连接。'
    )
  }

  if (ensureBridge && bridgeDown) {
    const outcome = await ensureBridge()
    if (!outcome.ok) {
      throw new Error(`MCP 工具 ${toolName} 失败：${textOf(blocks)}\n${outcome.reason}`)
    }
    if (outcome.launched) {
      notice = 'Blender 原本没在运行，盒子已自动启动并连上，然后重跑了这次调用。'
    }
    result = await callOnce()
    blocks = result.content ?? []
  }

  if (result.isError) {
    // pi 只认异常。返回一个"看起来成功"的结果会让模型基于错误前提继续。
    throw new Error(`MCP 工具 ${toolName} 失败：${textOf(blocks) || '未提供原因'}`)
  }

  const content = await toPiContent(blocks)
  if (notice) content.unshift({ type: 'text', text: `[盒子] ${notice}` })
  // `details` 原样带上。它只进界面，不进请求体 —— 出口闸量的也只是 `content`
  // （见 `core/requestBudget.ts` 的 `measureContextBytes`），所以这里不需要
  // 再把图片字节择出去。之前择过一版，只挑了 image 一种块，audio 和 resource
  // 的大 payload 照样留着，等于问题没解决还多了一层。
  return { content, details: result }
}

interface Connection {
  client: Client
  close: () => Promise<void>
}

export class McpClientManager {
  private readonly connections = new Map<string, Connection>()
  private readonly statuses = new Map<string, McpServerStatus>()
  private readonly tools = new Map<string, UnrealAgentTool<unknown>[]>()

  /**
   * 连接全部启用的 server。
   *
   * 并发连接，单个失败只记进状态不往外抛 —— 用户配错一个 server 不该让
   * 整个 agent 起不来。
   */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(servers).filter(([, config]) => !config.disabled)

    // 停用的也记一条状态。
    //
    // 原来直接过滤掉，结果「停用了」和「压根没配过」在下游长得一模一样。
    // 用户停用后忘了，问起来 agent 只会说「我没有这个能力」，
    // 而正确的回答是「你把它停用了，去设置里打开就行」。
    for (const [id, config] of Object.entries(servers)) {
      if (config.disabled) {
        this.statuses.set(id, { id, connected: false, toolCount: 0, disabled: true })
      }
    }

    await Promise.all(
      entries.map(async ([id, config]) => {
        try {
          await this.connect(id, config)
        } catch (error) {
          const message = (error as Error).message
          console.warn(`[AgentV3][MCP] server "${id}" 连接失败:`, message)
          this.statuses.set(id, { id, connected: false, toolCount: 0, error: message })
        }
      })
    )
  }

  /**
   * 会话进行中现接一台 server。给 `connect_mcp_server` 工具用。
   *
   * 和 `connectAll` 的两点不同：
   *
   *   - **失败往外抛。** 那边是开机路径，一台连不上不能拖垮其余的；这边是
   *     用户刚刚说「你连一下」，连不上就是这次调用的结果，必须回到他面前。
   *   - **新来的失败了不留状态。** 那边留一条 FAILED 是对的（配置在盘上，
   *     用户该看见它坏了）；这边配置还没落盘，留下来的话系统提示词会报一台
   *     根本不存在的 server 连不上（见 `promptSection.ts`），用户去设置里
   *     还找不到它。
   *
   * 覆盖一台已有的 server 时反过来：`connect` 第一步就会把旧连接断掉，失败后
   * 那台**仍然配置在盘上**，所以留一条 FAILED —— 抹掉的话，用户会看到一台
   * 明明配着、却从提示词里凭空消失的 server。
   */
  async addServer(id: string, config: McpServerConfig): Promise<McpServerStatus> {
    const previous = this.statuses.get(id)
    try {
      await this.connect(id, config)
    } catch (error) {
      const message = (error as Error).message
      await this.disconnect(id)
      if (previous) this.statuses.set(id, { id, connected: false, toolCount: 0, error: message })
      else this.statuses.delete(id)
      throw error
    }
    return this.statuses.get(id)!
  }

  /** 某台 server 贡献的工具。名字要报给用户，所以按命名空间挑出来 */
  toolsOf(id: string): UnrealAgentTool<unknown>[] {
    return this.tools.get(id) ?? []
  }

  private async connect(id: string, config: McpServerConfig): Promise<void> {
    await this.disconnect(id)

    const client = new Client({ name: 'unreal-box', version: '1.0.0' }, { capabilities: {} })

    const transport = isHttpConfig(config)
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          ...(config.headers ? { requestInit: { headers: config.headers } } : {})
        })
      : new StdioClientTransport({
          command: config.command,
          ...(config.args ? { args: config.args } : {}),
          ...(config.env ? { env: config.env } : {}),
          ...(config.cwd ? { cwd: config.cwd } : {}),
          // 子进程的 stderr 直接吞掉会让排错无从下手；转到主进程日志
          stderr: 'pipe'
        })

    try {
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `连接 MCP server "${id}" 超时（${CONNECT_TIMEOUT_MS}ms）`
      )
    } catch (error) {
      /*
       * 超时只是我们不等了，SDK 那边的握手还在跑（它自己的请求超时是 60 秒）。
       * 这时还没登记进 `connections`，上层的 `disconnect(id)` 摸不到它 —— 不在这里关，
       * 首次 `npx -y` 要下载半分钟的那种 server 会在 20~60 秒之间握手成功，
       * 然后作为一个没人引用的子进程一直活到盒子退出；重试一次就再多一个
       */
      await client.close().catch(() => undefined)
      throw error
    }

    this.connections.set(id, { client, close: () => client.close() })

    const listed = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      `列出 "${id}" 的工具超时`
    )

    const allowed = config.allowedTools ? new Set(config.allowedTools) : undefined
    const usable = listed.tools.filter((tool) => !allowed || allowed.has(tool.name))

    // 超量的 server 整个不接。放进去的话上下文会被工具定义吃光，
    // 而症状是「模型突然变笨」——比一条明确的连接失败难查得多。
    if (usable.length > MAX_TOOLS_PER_SERVER) {
      await this.disconnect(id)
      throw new Error(
        `server "${id}" 暴露了 ${usable.length} 个工具，超过上限 ${MAX_TOOLS_PER_SERVER}。` +
          '请在 server 侧收窄暴露范围（UE 5.8 官方 server 把 bEnableToolSearch 打开即可），' +
          '或在 mcp.json 里用 allowedTools 点名需要的工具。'
      )
    }

    const readOnly = config.readOnlyTools ? new Set(config.readOnlyTools) : undefined

    // 本机 Blender 才有；其余 server 拿到 undefined，走原来的路径
    const ensureBridge = createBlenderLauncher(config)

    this.tools.set(
      id,
      usable.map((tool) =>
        this.toAgentTool(id, client, tool, readOnly?.has(tool.name) === true, ensureBridge)
      )
    )

    const version = client.getServerVersion()
    this.statuses.set(id, {
      id,
      connected: true,
      toolCount: usable.length,
      ...(version?.name ? { serverName: version.name } : {}),
      ...(version?.version ? { serverVersion: version.version } : {})
    })

    console.log(`[AgentV3][MCP] "${id}" 已连接，可用工具 ${usable.length} 个`)
  }

  private toAgentTool(
    serverId: string,
    client: Client,
    tool: { name: string; description?: string; inputSchema: unknown },
    /** 由配置里的 `readOnlyTools` 点名降级。见 types.ts 的说明 */
    isReadOnly = false,
    /** 本机 Blender 专用：桥断了先把它拉起来再重试一次。见 blenderBridge.ts */
    ensureBridge?: BridgeRecovery
  ): UnrealAgentTool<unknown> {
    const namespace = namespaceFor(serverId)

    return {
      name: toSafeToolName(serverId, tool.name),
      // 描述里标明来源：模型知道这不是盒子内建能力，出错时也便于用户定位
      description: `[来自 MCP server "${serverId}"] ${tool.description ?? tool.name}`,
      // MCP 的 inputSchema 是 JSON Schema，但**不能原样转交厂商**：
      // $ref / $defs / oneOf 都是合法 JSON Schema、厂商却普遍不收，
      // 而厂商拒的是整个请求 —— 一个第三方 server 用了 $ref，
      // 这次对话里所有工具（含盒子自己的 77 个）会一起失效。
      parameters: toVendorSafeSchema(tool.inputSchema) as TSchema,
      executionMode: 'parallel',
      // 套一层 `runAbortable`：MCP server 是第三方进程，它慢不慢、会不会挂起
      // 都不由我们决定，唯一的兜底是 `CALL_TIMEOUT_MS`。不赛跑的话，用户按下
      // 停止之后要一直等到那个超时才停得下来。
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal
      ): Promise<AgentToolResult<unknown>> =>
        runAbortable(toSafeToolName(serverId, tool.name), signal, () =>
          runMcpTool(
            tool.name,
            () =>
              withTimeout(
                client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }),
                CALL_TIMEOUT_MS,
                `MCP 工具 ${tool.name} 执行超时（${CALL_TIMEOUT_MS}ms）`
              ) as Promise<McpCallResult>,
            ensureBridge
          )
        ),
      // 第三方来源默认按最危险处理（见文件头）。唯一的例外是配置里点名的
      // 纯发现类工具 —— 那是为了不让审批门被无意义的确认框点烦，见 types.ts
      unrealBox: { namespace, risk: isReadOnly ? 'safe' : 'destructive' }
    } as unknown as UnrealAgentTool<unknown>
  }

  /** 全部已连接 server 的工具，扁平化后直接注册给 agent */
  getTools(): UnrealAgentTool<unknown>[] {
    return [...this.tools.values()].flat()
  }

  getStatuses(): McpServerStatus[] {
    return [...this.statuses.values()]
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    try {
      await connection.close()
    } catch (error) {
      // 关不掉不该阻塞后续流程；子进程最终会被 Electron 回收
      console.warn(`[AgentV3][MCP] 关闭 "${id}" 失败:`, (error as Error).message)
    }
    this.connections.delete(id)
    this.tools.delete(id)
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
    this.statuses.clear()
  }
}

/**
 * 给 Promise 套超时。
 *
 * MCP server 是外部进程/服务，卡住是常态（等 stdin、等网络）。没有超时的话
 * 一个坏 server 能让 agent 永远起不来，而用户只看到界面转圈。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
