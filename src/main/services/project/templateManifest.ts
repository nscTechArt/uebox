/**
 * 社区模板清单的解析与校验。
 *
 * 清单是**别人写的 JSON**，不是我们自己的数据结构：字段缺、类型错、多写了
 * 不认识的键都得当成常态。所以这里走 `src/main/ai/store.ts` 同一个路数 ——
 * 尽量修，修不了的条目丢掉，绝不让一条脏数据把整个源废掉。
 *
 * 但有两件事不宽容，因为它们直接关系到"下载下来的东西会不会被 UE 执行"：
 *   · 没有合法 sha256 的条目直接丢弃 —— 没有校验值就没法确认下载到的是清单作者
 *     写的那个包，中间人换掉包体我们看不出来。
 *   · packageUrl 的协议必须和清单本身一致（都 https 或都 http）。清单走 https
 *     却把包指向 http，等于把 https 的保护绕过去了。
 */
import type { CommunityTemplate, TemplateManifest } from '../../../shared/projectTemplate'

/** 64 位小写十六进制 */
const SHA256_PATTERN = /^[a-f0-9]{64}$/

/** 清单里允许出现的分类，与界面上的子分类 Tab 一一对应 */
const KNOWN_CATEGORIES = new Set([
  'game',
  'render',
  'film',
  'architecture',
  'automotive',
  'other',
  'all'
])

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return 0
}

/**
 * 把清单里的 packageUrl / previewUrl 解析成绝对地址。
 *
 * 允许相对路径是为了让清单能和模板包放在同一个仓库里（`packages/foo.zip`），
 * 换个托管地址不用重写整份清单。
 *
 * 返回 null 表示这个地址不可用，调用方应当丢弃该条目。
 */
export function resolveAssetUrl(raw: string, manifestUrl: string): string | null {
  if (!raw) return null
  let resolved: URL
  try {
    resolved = new URL(raw, manifestUrl)
  } catch {
    return null
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null

  // 清单走 https 就不许把包降级到 http，否则 https 白走了
  try {
    const manifestProtocol = new URL(manifestUrl).protocol
    if (manifestProtocol === 'https:' && resolved.protocol === 'http:') return null
  } catch {
    return null
  }

  return resolved.toString()
}

function normalizeTemplate(raw: unknown, manifestUrl: string): CommunityTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>

  const id = str(source.id)
  const name = str(source.name)
  if (!id || !name) return null

  const sha256 = str(source.sha256).toLowerCase()
  if (!SHA256_PATTERN.test(sha256)) return null

  const packageUrl = resolveAssetUrl(str(source.packageUrl), manifestUrl)
  if (!packageUrl) return null

  const category = str(source.category).toLowerCase()

  return {
    id,
    name,
    description: str(source.description),
    category: KNOWN_CATEGORIES.has(category) ? category : 'other',
    engineVersion: str(source.engineVersion) || '5.3',
    packageUrl,
    size: num(source.size),
    sha256,
    version: str(source.version) || '1.0.0',
    author: str(source.author),
    license: str(source.license),
    previewUrl: resolveAssetUrl(str(source.previewUrl), manifestUrl) || undefined,
    homepage: resolveAssetUrl(str(source.homepage), manifestUrl) || undefined
  }
}

/**
 * 解析一份清单。
 *
 * `skipped` 是被丢掉的条目数 —— 界面上会提示，否则源作者写错了 sha256 只会看到
 * "少了一个模板"，无从排查。
 */
export function parseManifest(
  raw: unknown,
  manifestUrl: string
): { manifest: TemplateManifest; skipped: number } {
  if (!raw || typeof raw !== 'object') {
    throw new Error('清单不是一个 JSON 对象')
  }

  const source = raw as Record<string, unknown>
  const formatVersion = num(source.formatVersion)
  if (formatVersion !== 1) {
    throw new Error(`不支持的清单格式版本：${formatVersion || '(缺失)'}，当前只支持 1`)
  }

  const rawTemplates = Array.isArray(source.templates) ? source.templates : []
  const templates: CommunityTemplate[] = []
  const seen = new Set<string>()
  let skipped = 0

  for (const entry of rawTemplates) {
    const normalized = normalizeTemplate(entry, manifestUrl)
    if (!normalized) {
      skipped += 1
      continue
    }
    // 同一份清单里 id 重复，只认第一条：后面的当脏数据丢掉，
    // 否则界面上会出现两张一模一样的卡片，点哪张都说不清下载的是谁。
    if (seen.has(normalized.id)) {
      skipped += 1
      continue
    }
    seen.add(normalized.id)
    templates.push(normalized)
  }

  return { manifest: { formatVersion: 1, templates }, skipped }
}
