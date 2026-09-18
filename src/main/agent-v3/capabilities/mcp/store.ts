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
