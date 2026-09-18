/**
 * 社区模板源的配置读写（`userData/template-sources.json`）。
 *
 * 这里有一条不能松的规矩：**内置源默认 enabled = false**。
 *
 * 本仓库是社区核心版，AGENTS.md 明写「不许给社区版代码路径加远程调用」。
 * 社区模板天然要联网，两者的调和办法就是"装好之后一个请求都不发，用户在界面上
 * 点了「启用」才第一次去拉清单"。所以任何时候都不要给内置源写死 enabled: true，
 * 也不要在启动流程里自动抓取 —— 那会让「完全离线运行」这句话变成假的。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { TemplateSource } from '../../../shared/projectTemplate'

const SOURCES_FILE = 'template-sources.json'

/**
 * 内置的官方社区模板源。
 *
 * 放的是公开 Git 托管上的静态 JSON，不是官方服务端 —— 社区核心版不认识官方服务端，
 * 也不该认识（`scripts/check-official-endpoints.mjs` 在守这条线）。
 *
 * **两个源装的是同一份内容**，Gitee 那份是 GitHub 的镜像。给两个是因为
 * raw.githubusercontent.com 在国内经常连不上，只给一个等于让一半用户点了没反应。
 * 两个都启用也没关系：清单条目按「源 id + 模板 id」去重，同一个模板不会显示两遍
 * （见 templateRows.ts）—— 不过两边的模板 id 相同的话，用户会看到两条同名的，
 * 所以镜像仓库请保持和主仓库同名同 id。
 *
 * 地址不通不会崩：用户点「启用」时会看到一条抓取失败的提示，别的源照常工作，
 * 并且随时可以自己加源。
 */
export const OFFICIAL_SOURCE_ID = 'official'
export const MIRROR_CN_SOURCE_ID = 'mirror-cn'

const BUILTIN_SOURCES: readonly TemplateSource[] = [
  {
    id: OFFICIAL_SOURCE_ID,
    name: '官方社区库（GitHub）',
    url: 'https://raw.githubusercontent.com/ueboxai/community-templates/main/manifest.json',
    enabled: false,
    builtin: true
  },
  {
    id: MIRROR_CN_SOURCE_ID,
    name: '官方社区库（国内镜像）',
    url: 'https://gitee.com/ueboxai/community-templates/raw/main/manifest.json',
    enabled: false,
    builtin: true
  }
]

export function sourcesPath(): string {
  return join(app.getPath('userData'), SOURCES_FILE)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 源地址必须是 http/https。其它协议（file:、data:）一律拒绝 */
export function isValidSourceUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeSource(raw: unknown): TemplateSource | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = str(source.id)
  const url = str(source.url)
  if (!id || !isValidSourceUrl(url)) return null
  return {
    id,
    name: str(source.name) || id,
    url,
    enabled: source.enabled === true,
    builtin: source.builtin === true
  }
}

/**
 * 读取源列表。
 *
 * 内置源始终存在：配置文件里没有就补上（默认关闭），有就沿用用户的开关状态，
 * 但**地址和名字以代码里的为准** —— 官方源换地址时不该被一份旧配置钉死。
 * 老版本的配置里只有一条 official，新增的镜像源会在这里自动补进去。
 */
export async function listSources(): Promise<TemplateSource[]> {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(await fs.readFile(sourcesPath(), 'utf-8'))
  } catch {
    parsed = null
  }

  const rawList = Array.isArray(parsed) ? parsed : []
  const sources: TemplateSource[] = []
  const seen = new Set<string>()

  for (const entry of rawList) {
    const normalized = normalizeSource(entry)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    sources.push(normalized)
  }

  // 内置源永远排在最前，且按代码里声明的顺序，不受旧配置里的次序影响
  const builtinIds = new Set(BUILTIN_SOURCES.map((s) => s.id))
  const resolved = BUILTIN_SOURCES.map((builtin) => {
    const saved = sources.find((s) => s.id === builtin.id)
    // 只沿用用户的开关状态，地址和名字以代码为准
    return { ...builtin, enabled: saved?.enabled === true }
  })

  return [...resolved, ...sources.filter((s) => !builtinIds.has(s.id))]
}

async function saveSources(sources: TemplateSource[]): Promise<void> {
  await fs.writeFile(sourcesPath(), `${JSON.stringify(sources, null, 2)}\n`, 'utf-8')
}

/** 开关一个源。开启是用户的显式动作，是社区版允许联网的唯一入口 */
export async function setSourceEnabled(id: string, enabled: boolean): Promise<TemplateSource[]> {
  const sources = await listSources()
  const target = sources.find((s) => s.id === id)
  if (!target) throw new Error(`模板源不存在：${id}`)
  target.enabled = enabled
  await saveSources(sources)
  return sources
}

/** 生成一个不与现有源冲突的 id */
function createSourceId(existing: TemplateSource[]): string {
  let index = existing.length + 1
  const taken = new Set(existing.map((s) => s.id))
  let id = `custom-${index}`
  while (taken.has(id)) {
    index += 1
    id = `custom-${index}`
  }
  return id
}

/** 添加自定义源。新加的源直接是启用状态 —— 用户手填地址本身就是明确的联网意愿 */
export async function addSource(name: string, url: string): Promise<TemplateSource[]> {
  const trimmedUrl = url.trim()
  if (!isValidSourceUrl(trimmedUrl)) {
    throw new Error('源地址必须是 http:// 或 https:// 开头的清单地址')
  }

  const sources = await listSources()
  if (sources.some((s) => s.url === trimmedUrl)) {
    throw new Error('这个源已经添加过了')
  }

  sources.push({
    id: createSourceId(sources),
    name: name.trim() || trimmedUrl,
    url: trimmedUrl,
    enabled: true,
    builtin: false
  })
  await saveSources(sources)
  return sources
}

/** 删除自定义源。内置源只能禁用不能删 */
export async function removeSource(id: string): Promise<TemplateSource[]> {
  const sources = await listSources()
  const target = sources.find((s) => s.id === id)
  if (!target) throw new Error(`模板源不存在：${id}`)
  if (target.builtin) throw new Error('内置源不能删除，只能禁用')
  await saveSources(sources.filter((s) => s.id !== id))
  return sources.filter((s) => s.id !== id)
}
