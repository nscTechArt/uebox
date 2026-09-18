/**
 * 社区模板的抓取与下载。
 *
 * 两件事：
 *   1. 抓清单 —— 只抓 **enabled 的源**。这是社区版唯一允许发出网络请求的地方，
 *      而 enabled 只能由用户在界面上点出来（见 templateSource.ts）。
 *   2. 下包 —— 边下边算 sha256，对不上就删掉报错。模板包解压出来是一个 UE 工程，
 *      里面可以有 C++、插件 DLL、Python 脚本，打开工程就会跑；"下到的字节确实是
 *      清单作者写的那份"是这里唯一能提供的保证，所以它不是可选项。
 */
import { promises as fs } from 'fs'
import { createWriteStream } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type {
  CommunityFetchResult,
  CommunityTemplate,
  TemplateDownloadProgress,
  TemplateSource
} from '../../../shared/projectTemplate'
import { parseManifest } from './templateManifest'

/** 清单请求超时。清单是个小 JSON，超过这个时间基本就是地址不通 */
const MANIFEST_TIMEOUT_MS = 15_000

/** 清单体积上限，防止一个源用超大响应把内存吃光 */
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024

/**
 * 抓取单个源的清单。
 *
 * 失败不抛 —— 一个源挂了不该让其它源的模板也显示不出来，错误原因原样带回界面。
 */
export async function fetchSource(source: TemplateSource): Promise<CommunityFetchResult> {
  const base: CommunityFetchResult = {
    sourceId: source.id,
    sourceName: source.name,
    templates: [],
    skipped: 0
  }

  try {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      redirect: 'follow'
    })
    if (!response.ok) {
      return { ...base, error: `HTTP ${response.status}` }
    }

    const text = await response.text()
    if (text.length > MANIFEST_MAX_BYTES) {
      return { ...base, error: '清单文件过大' }
    }

    const { manifest, skipped } = parseManifest(JSON.parse(text), source.url)
    return { ...base, templates: manifest.templates, skipped }
  } catch (error) {
    return { ...base, error: String(error instanceof Error ? error.message : error) }
  }
}

/** 抓取所有启用的源。逐源并行，互不影响 */
export async function fetchEnabledSources(
  sources: TemplateSource[]
): Promise<CommunityFetchResult[]> {
  return Promise.all(sources.filter((s) => s.enabled).map((s) => fetchSource(s)))
}

/** Windows 文件名里不允许出现的字符 */
const RESERVED_FILENAME_CHARS = '<>:"/\\|?*'

/**
 * 把模板名变成安全的文件名。
 *
 * 名字来自清单，也就是**别人写的字符串**：除了 Windows 保留字符，控制字符同样要过滤
 * —— 它们在文件名里没有正当用途，却能让路径在日志和界面上显示成另一个样子。
 * 逐字符判断而不是写正则，是因为控制字符的正则范围会踩 no-control-regex。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = Array.from(name)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0
      if (code < 0x20 || code === 0x7f) return '_'
      return RESERVED_FILENAME_CHARS.includes(ch) ? '_' : ch
    })
    .join('')
    .trim()
  // 开头的点会生成 `.zip` 这种没有主名的隐藏文件，去掉；全被过滤光时兜个底
  return cleaned.replace(/^\.+/, '') || 'template'
}

/** 进行中的下载，用来支持取消。键是 `${sourceId}/${templateId}` */
const activeDownloads = new Map<string, AbortController>()

function downloadKey(sourceId: string, templateId: string): string {
  return `${sourceId}/${templateId}`
}

/** 取消一个进行中的下载。没有对应任务时返回 false */
export function cancelDownload(sourceId: string, templateId: string): boolean {
  const controller = activeDownloads.get(downloadKey(sourceId, templateId))
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * 为一条社区模板挑一个不冲突的落地文件名。
 *
 * 同名冲突走 `名字-模板id`，而不是 `名字(1)`：后者下次再下同一个模板会又开一个新文件，
 * 目录里堆一串看不出谁是谁的副本。
 */
async function pickTargetName(dir: string, template: CommunityTemplate): Promise<string> {
  const base = sanitizeFileName(template.name)
  const candidate = path.join(dir, `${base}.zip`)
  try {
    await fs.access(candidate)
  } catch {
    return base
  }
  return `${base}-${sanitizeFileName(template.id)}`
}

export interface DownloadResult {
  templatePath: string
  metaPath: string
}

/**
 * 下载一条社区模板到本地模板目录。
 *
 * 落地后就是一个普通的本地模板（zip + 同名 json 边车），建工程那条路径不需要改。
 */
export async function downloadTemplate(params: {
  source: TemplateSource
  template: CommunityTemplate
  targetDir: string
  onProgress?: (progress: TemplateDownloadProgress) => void
}): Promise<DownloadResult> {
  const { source, template, targetDir, onProgress } = params
  const key = downloadKey(source.id, template.id)

  if (activeDownloads.has(key)) {
    throw new Error('这个模板正在下载中')
  }

  const controller = new AbortController()
  activeDownloads.set(key, controller)

  const tempDir = path.join(targetDir, '.download')
  const tempFile = path.join(tempDir, `${sanitizeFileName(template.id)}.part`)

  try {
    await fs.mkdir(tempDir, { recursive: true })

    const response = await fetch(template.packageUrl, {
      signal: controller.signal,
      redirect: 'follow'
    })
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`)
    }
    if (!response.body) {
      throw new Error('下载失败：响应没有内容')
    }

    const declared = Number(response.headers.get('content-length') || 0)
    const total = declared > 0 ? declared : template.size

    const hash = createHash('sha256')
    let received = 0
    let lastPercent = -1

    // 边写盘边算哈希：包动辄几百 MB 到几个 G，先整个读进内存再校验会直接把内存打满
    const source$ = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source$.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      received += chunk.length
      if (!onProgress) return
      const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0
      // 只在整数百分比变化时上报，否则大文件会往渲染层灌几万条消息
      if (percent === lastPercent) return
      lastPercent = percent
      onProgress({ sourceId: source.id, templateId: template.id, received, total, percent })
    })

    await pipeline(source$, createWriteStream(tempFile))

    const digest = hash.digest('hex')
    if (digest !== template.sha256) {
      throw new Error(
        `校验失败：下载内容与清单声明的 sha256 不一致（得到 ${digest.slice(0, 12)}…）`
      )
    }

    const targetName = await pickTargetName(targetDir, template)
    const templatePath = path.join(targetDir, `${targetName}.zip`)
    const metaPath = path.join(targetDir, `${targetName}.json`)

    await fs.rename(tempFile, templatePath)
    await fs.writeFile(
      metaPath,
      `${JSON.stringify(
        {
          origin: 'community',
          // 文件名被 sanitize 过（"Third Person" → "Third_Person"），
          // 界面上要显示清单里的原名，所以单独存一份
          name: template.name,
          sourceId: source.id,
          templateId: template.id,
          category: template.category,
          description: template.description,
          version: template.version,
          engineVersion: template.engineVersion,
          author: template.author,
          license: template.license,
          homepage: template.homepage
        },
        null,
        2
      )}\n`,
      'utf-8'
    )

    return { templatePath, metaPath }
  } catch (error) {
    // 失败一律不留半截文件：下次进来看到的应该是"没下过"，而不是一个坏包
    await fs.rm(tempFile, { force: true }).catch(() => {})
    if (controller.signal.aborted) {
      throw new Error('下载已取消')
    }
    throw error
  } finally {
    activeDownloads.delete(key)
  }
}
