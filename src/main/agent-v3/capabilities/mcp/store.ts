/**
 * `mcp.json` 读写。
 *
 * 与 `models.json` 同样是**用户可见、可直接编辑**的文件（设置界面会显示路径），
 * 所以解析必须宽容：字段缺失、类型写错、多了不认识的键，都不该让整份配置读不出来。
 * 修不了的条目丢掉并留一行日志。
 *
 * 格式对齐 Claude Desktop 的 `mcpServers`，用户可以直接粘贴已有配置。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

import { EMPTY_MCP_SETTINGS, type McpServerConfig, type McpSettings } from './types'

const FILE = 'mcp.json'

export function mcpSettingsPath(): string {
  return join(app.getPath('userData'), FILE)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length > 0 ? out : undefined
}

function strRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 归一化一条 server 配置。认不出形状就返回 null，由调用方丢弃 */
export function normalizeServer(id: string, raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>

  const disabled = source.disabled === true
  const allowedTools = strArray(source.allowedTools)
  const readOnlyTools = strArray(source.readOnlyTools)
  const common = {
    ...(disabled ? { disabled } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(readOnlyTools ? { readOnlyTools } : {})
  }

  // 有 url 就是远程，即使没写 type —— Claude Desktop 的配置里 type 常常省略
  const url = str(source.url)
  if (url || source.type === 'http') {
    if (!url) {
      console.warn(`[AgentV3][MCP] 跳过 "${id}"：声明为 http 但没有 url`)
      return null
    }
    const headers = strRecord(source.headers)
    return { type: 'http', url, ...(headers ? { headers } : {}), ...common }
  }

  const command = str(source.command)
  if (!command) {
    console.warn(`[AgentV3][MCP] 跳过 "${id}"：既没有 command 也没有 url`)
    return null
  }

  const args = strArray(source.args)
  const env = strRecord(source.env)
  const cwd = str(source.cwd)
  return {
    type: 'stdio',
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    ...common
  }
}

/** serverId 会成为工具名的一部分，必须是安全字符 */
const VALID_SERVER_ID = /^[a-zA-Z0-9_-]{1,32}$/

export async function readMcpSettings(): Promise<McpSettings> {
  let text: string
  try {
    text = await fs.readFile(mcpSettingsPath(), 'utf8')
  } catch {
    // 没配过就是空配置，不是错误
    return EMPTY_MCP_SETTINGS
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    console.warn('[AgentV3][MCP] mcp.json 不是合法 JSON，按空配置处理:', (error as Error).message)
    return EMPTY_MCP_SETTINGS
  }

  const raw = (parsed as { mcpServers?: unknown })?.mcpServers
  if (!raw || typeof raw !== 'object') return EMPTY_MCP_SETTINGS

  const mcpServers: Record<string, McpServerConfig> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALID_SERVER_ID.test(id)) {
      console.warn(`[AgentV3][MCP] 跳过 server id "${id}"：只允许字母数字下划线连字符，最长 32`)
      continue
    }
    const config = normalizeServer(id, value)
    if (config) mcpServers[id] = config
  }

  return { version: 1, mcpServers }
}

export async function writeMcpSettings(settings: McpSettings): Promise<void> {
  const path = mcpSettingsPath()
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * 只改一条 server，盘上其余内容原样不动。
 *
 * ## 为什么不能用「读出来 → 改 → 整份写回去」
 *
 * `readMcpSettings` 是**有损**的，而且是故意的：它按 `VALID_SERVER_ID`
 * 筛 id、按固定字段表重建每一条，读不懂的只留一行 warn 就跳过。作为
 * 「喂给客户端的那份配置」这没问题 —— 认不出来的本来也连不上。
 *
 * 但一旦把这个结果再写回盘，丢弃就变成了**删除**。用户从 Claude Desktop
 * 抄来一条 `"github.com/foo": {...}`（那边的合法 id，而这份文件的说明
 * 正是「可以直接粘贴已有配置」），盒子替他做一件不相干的事时就把它抹了。
 *
 * 所以程序化地动配置走这条路：解析原文、只改目标那个键、写回去。
 * 认不出的条目、认不出的字段，一律原样留着。
 *
 * 整份覆盖（`writeMcpSettings`）留给设置界面 —— 那是用户看着整张表按的保存。
 */
export async function upsertMcpServer(id: string, config: McpServerConfig): Promise<void> {
  await editServersRaw((servers) => ({ ...servers, [id]: config }))
}

/**
 * 删掉一条 server，盘上其余内容原样不动。返回它本来在不在。
 *
 * 和 `upsertMcpServer` 同一个理由走原文：整份重写会顺手删掉
 * `readMcpSettings` 认不出的那些条目，而用户只是想删一条。
 */
export async function removeMcpServer(id: string): Promise<boolean> {
  let existed = false
  await editServersRaw((servers) => {
    existed = Object.hasOwn(servers, id)
    const next = { ...servers }
    delete next[id]
    return next
  })
  return existed
}

/**
 * 读原文 → 改 `mcpServers` → 写回去。
 *
 * 认不出的条目、认不出的字段一律原样留着 —— 这是这两个函数存在的全部理由，
 * 所以改动只能经过这里，不要另开一条自己读写的路。
 */
async function editServersRaw(
  edit: (servers: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  const path = mcpSettingsPath()

  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>
    }
  } catch {
    // 没有文件、或者文件坏了：按空配置起一份新的。坏文件的情况下
    // `readMcpSettings` 本来也已经把它当空的了，这里不比那更糟
  }

  const servers =
    raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)
      ? (raw.mcpServers as Record<string, unknown>)
      : {}

  const next = { ...raw, version: 1, mcpServers: edit(servers) }
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}
