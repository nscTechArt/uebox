/**
 * 插件的发现、安装、启停。
 *
 * 设计上**不新造扩展机制** —— 插件带来的能力最终汇入已有的两条路：
 *
 *   - `skills/` → 加进 skill 发现路径（`capabilities/skills.ts`）
 *   - `mcp.json` → 加进 MCP 连接列表（`capabilities/mcp`）
 *
 * 所以这个文件只负责「目录管理 + 清单校验 + 启停状态」，
 * 不碰工具注册、不碰 agent 装配。
 */

import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import { app } from 'electron'

import type { McpServerConfig } from '../mcp/types'
import { normalizeServer } from '../mcp/store'
import { parseManifest, VALID_PLUGIN_ID, type InstalledPlugin } from './types'

const PLUGINS_DIR = 'plugins'
const DISABLED_FILE = 'disabled-plugins.json'

export function pluginsRoot(): string {
  return join(app.getPath('userData'), PLUGINS_DIR)
}

function disabledListPath(): string {
  return join(app.getPath('userData'), DISABLED_FILE)
}

async function readDisabled(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(disabledListPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [])
  } catch {
    // 没这个文件就是一个都没停用
    return new Set()
  }
}

async function writeDisabled(ids: Set<string>): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(disabledListPath(), JSON.stringify([...ids], null, 2), 'utf8')
}

/**
 * 扫描已安装的插件。
 *
 * 单个插件坏掉只把 error 记在它自己身上，不影响其余 ——
 * 用户装了个写坏的插件，不该导致所有插件都用不了。
 */
export async function listPlugins(): Promise<InstalledPlugin[]> {
  const root = pluginsRoot()
  const disabled = await readDisabled()

  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }

  const plugins: InstalledPlugin[] = []
  for (const entry of entries) {
    if (!VALID_PLUGIN_ID.test(entry)) continue
    const dir = join(root, entry)

    try {
      if (!(await fs.stat(dir)).isDirectory()) continue
    } catch {
      continue
    }

    const base: InstalledPlugin = {
      manifest: { id: entry, name: entry, version: '0.0.0' },
      path: dir,
      disabled: disabled.has(entry),
      hasSkills: false,
      mcpServerCount: 0
    }

    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(join(dir, 'plugin.json'), 'utf8'))
    } catch (error) {
      plugins.push({ ...base, error: `读不出 plugin.json：${(error as Error).message}` })
      continue
    }

    const parsed = parseManifest(raw)
    if ('error' in parsed) {
      plugins.push({ ...base, error: parsed.error })
      continue
    }

    // 目录名必须与清单 id 一致 —— 否则停用列表、MCP 前缀会对不上
    if (parsed.manifest.id !== entry) {
      plugins.push({
        ...base,
        error: `目录名 "${entry}" 与 plugin.json 里的 id "${parsed.manifest.id}" 不一致`
      })
      continue
    }

    plugins.push({
      ...base,
      manifest: parsed.manifest,
      hasSkills: await exists(join(dir, 'skills')),
      mcpServerCount: Object.keys(await readPluginMcpServers(dir, entry)).length
    })
  }

  return plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 读一个插件自带的 MCP server 配置。
 *
 * serverId 强制加插件 id 前缀 —— 两个插件都叫 `server` 时不会互相覆盖，
 * 而且用户在 MCP 设置页能一眼看出这个 server 是谁带来的。
 */
export async function readPluginMcpServers(
  dir: string,
  pluginId: string
): Promise<Record<string, McpServerConfig>> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(join(dir, 'mcp.json'), 'utf8'))
  } catch {
    return {}
  }

  const servers = (raw as { mcpServers?: unknown })?.mcpServers
  if (!servers || typeof servers !== 'object') return {}

  const out: Record<string, McpServerConfig> = {}
  for (const [id, value] of Object.entries(servers as Record<string, unknown>)) {
    const config = normalizeServer(`${pluginId}/${id}`, value)
    if (!config) continue

    // stdio 的 cwd 默认指向插件目录 —— 插件自带的脚本通常用相对路径
    const withCwd = 'command' in config && !config.cwd ? { ...config, cwd: dir } : config

    out[`${pluginId}_${id}`] = withCwd
  }
  return out
}

/** 已启用插件贡献的 skill 目录，供 skill 发现使用 */
export async function enabledPluginSkillDirs(): Promise<string[]> {
  const plugins = await listPlugins()
  return plugins
    .filter((p) => !p.disabled && !p.error && p.hasSkills)
    .map((p) => join(p.path, 'skills'))
}

/** 已启用插件贡献的 MCP server，合并进主配置 */
export async function enabledPluginMcpServers(): Promise<Record<string, McpServerConfig>> {
  const plugins = await listPlugins()
  const out: Record<string, McpServerConfig> = {}
  for (const plugin of plugins) {
    if (plugin.disabled || plugin.error) continue
    Object.assign(out, await readPluginMcpServers(plugin.path, plugin.manifest.id))
  }
  return out
}

export async function setPluginDisabled(id: string, disabled: boolean): Promise<void> {
  const set = await readDisabled()
  if (disabled) set.add(id)
  else set.delete(id)
  await writeDisabled(set)
}

/**
 * 从一个目录安装插件。
 *
 * 只做校验和拷贝，**不执行插件里的任何代码** —— 插件不能有安装脚本，
 * 那是供应链攻击最常见的入口。
 */
export async function installFromDirectory(
  sourceDir: string
): Promise<{ success: true; plugin: InstalledPlugin } | { success: false; error: string }> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(join(sourceDir, 'plugin.json'), 'utf8'))
  } catch {
    return { success: false, error: '这个目录里没有可读的 plugin.json' }
  }

  const parsed = parseManifest(raw)
  if ('error' in parsed) return { success: false, error: parsed.error }

  const { id } = parsed.manifest
  const target = join(pluginsRoot(), id)

  // 拷贝前再确认一次目标路径没跑出插件根目录。id 已经过正则校验，
  // 这里是纵深防御 —— 单点校验被绕过时还有一层。
  if (!resolve(target).startsWith(resolve(pluginsRoot()) + sep)) {
    return { success: false, error: `插件 id "${id}" 解析出的路径越界` }
  }

  try {
    await fs.mkdir(pluginsRoot(), { recursive: true })
    await fs.rm(target, { recursive: true, force: true })
    await fs.cp(sourceDir, target, { recursive: true })
  } catch (error) {
    return { success: false, error: `拷贝失败：${(error as Error).message}` }
  }

  const installed = (await listPlugins()).find((p) => p.manifest.id === id)
  if (!installed) return { success: false, error: '安装后没能读回插件，请检查目录内容' }
  return { success: true, plugin: installed }
}

export async function uninstallPlugin(id: string): Promise<{ success: boolean; error?: string }> {
  if (!VALID_PLUGIN_ID.test(id)) return { success: false, error: `非法插件 id "${id}"` }

  const target = join(pluginsRoot(), id)
  if (!resolve(target).startsWith(resolve(pluginsRoot()) + sep)) {
    return { success: false, error: '路径越界' }
  }

  try {
    await fs.rm(target, { recursive: true, force: true })
    await setPluginDisabled(id, false)
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}
