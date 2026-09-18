import { defaultSpeechVoice } from '../../shared/speech'
import { promises as fs } from 'fs'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import {
  EMPTY_SETTINGS,
  MODEL_ROLES,
  type AiProviderSettings,
  type ModelConfig,
  type ModelRole,
  type ProviderConfig,
  type ProviderProtocol
} from './types'
import {
  isDoubaoRealtimeBaseUrl,
  isOpenAiRealtimeModelId,
  model3dApiFromBaseUrl,
  OPENAI_DEFAULT_REALTIME_VOICE,
  PROVIDER_KINDS,
  type EmbeddingApi,
  type ImageApi,
  type Model3dApi,
  type ProviderKind,
  type StructuredOutputApi,
  type VideoApi
} from '../../shared/aiProvider'
import { findCatalogEntry } from './catalog'

/**
 * `models.json` 读写。
 *
 * 这个文件是**用户可见、可直接编辑**的（界面上会显示它的完整路径）。
 * 因此解析必须宽容：字段缺失、类型写错、多写了不认识的键，都不该让整个
 * AI 配置读不出来 —— 尽量修，修不了的条目丢掉并留一行日志。
 *
 * 明文密钥不在这里，见 credentials.ts。
 */

const SETTINGS_FILE = 'models.json'

const VALID_PROTOCOLS: readonly ProviderProtocol[] = [
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'google-generative-ai'
]

export function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 配置结构版本。
 *
 * 1 → 2：`supportsReasoning` 是后加的字段，而 v1 的 normalize 会把「没写」
 * 无脑落成 `false` 并存回磁盘 —— 于是所有存量配置里每个模型都明确写着
 * 「不会推理」，与用户的选择长得一模一样，目录里的真实值再也顶不上来。
 * 表现是输入框里的思考档位只剩 auto / off，哪怕用的是推理模型。
 * 从 v1 升上来时，这一位一律按目录重查一次。
 */
const SETTINGS_VERSION = 3

/**
 * 推理能力那条迁移**只针对 v1**，不能跟着 SETTINGS_VERSION 走。
 *
 * 它修的是 v1 的 normalize 把「没写」落成 false 这一个具体错误。写成
 * `version < SETTINGS_VERSION` 的话，每次版本号往上抬，所有旧配置都会被
 * 再迁一遍 —— v2 用户明确取消掉的推理勾会被目录值顶回来，而且他永远取消不掉。
 * 2 → 3（模态上移到 Provider）就差点这么干了一次。
 */
const REASONING_MIGRATED_VERSION = 2

/** 目录里这个模型标了推理能力吗。目录里没有这条模型则为 undefined */
function catalogReasoning(providerId: string, modelId: string): boolean | undefined {
  return findCatalogEntry(providerId)?.models.find((item) => item.id === modelId)?.supportsReasoning
}

/**
 * 推理能力这一位取谁的。
 *
 * - 从 v1 升上来：磁盘上那个 false 不是用户的选择，是旧 normalize 写进去的，
 *   一律按目录重查（目录不认识的模型才保留原值）
 * - v2 起：用户明确写了就听用户的，没写才查目录
 */
function resolveReasoning(
  source: Record<string, unknown>,
  providerId: string,
  modelId: string,
  legacy: boolean
): boolean {
  const explicit = typeof source.supportsReasoning === 'boolean' ? source.supportsReasoning : null
  if (legacy) return catalogReasoning(providerId, modelId) ?? explicit ?? false
  return explicit ?? catalogReasoning(providerId, modelId) ?? false
}

/** 内核认识的档位。用户手写的 models.json 里出现别的键一律丢掉 */
const THINKING_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 档位阶梯。
 *
 * `null` 必须原样留住 —— 它表示「这一档不存在」，与「没写这个键」是**两回事**：
 * 前者会让内核把这一档从清单里去掉，后者是走缺省。把 null 当成空值滤掉，
 * 表现就是界面列出模型根本没有的档位。
 *
 * 空对象归一成 undefined：留一个 `{}` 在 models.json 里既没有意义，
 * 又会让「用户配过」和「没配过」分不开。
 */
function normalizeThinkingLevelMap(raw: unknown): Record<string, string | null> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string | null> = {}
  for (const [level, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!THINKING_LEVELS.includes(level)) continue
    if (value === null) {
      out[level] = null
    } else if (typeof value === 'string' && value.trim()) {
      out[level] = value.trim()
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeModel(
  raw: unknown,
  providerId: string,
  kind: ProviderKind,
  legacy: boolean
): ModelConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = str(source.id)
  if (!id) return null
  return {
    id,
    displayName: str(source.displayName) || undefined,
    supportsVision: source.supportsVision === true,
    supportsVideo: source.supportsVideo === true,
    // 绝大多数在用的模型都支持工具调用，显式写 false 才关掉，
    // 否则用户导入一批模型后会发现 Agent 一个都不能用。
    // 只有对话类 Provider 下的模型谈得上工具调用 —— 生图/3D/视频模型勾着
    // 「工具」只会让界面撒谎，而它们根本不进 Agent 的候选。
    supportsTools: kind === 'chat' && source.supportsTools !== false,
    // 只在对得上用途时才留着形状那一位，免得换了用途之后还挂着上一档的残留
    imageApi:
      kind === 'image' ? migrateImageApi(normalizeImageApi(source.imageApi), id) : undefined,
    embeddingApi: kind === 'embedding' ? normalizeEmbeddingApi(source.embeddingApi) : undefined,
    structuredOutputApi:
      kind === 'chat' ? normalizeStructuredOutputApi(source.structuredOutputApi) : undefined,
    embeddingDimensions: kind === 'embedding' ? positiveInt(source.embeddingDimensions) : undefined,
    supportsReasoning: resolveReasoning(source, providerId, id, legacy),
    thinkingLevelMap: normalizeThinkingLevelMap(source.thinkingLevelMap),
    // 只认显式的 true。没写就是「没说」，让 piModel 去 pi 目录和我们的目录里
    // 逐级找 —— 写成 false 会把回落链掐断，老用户存过的 Anthropic 就永远
    // 停在预算那条路上（xhigh / max 与 high 同义）。
    adaptiveThinking: source.adaptiveThinking === true ? true : undefined,
    contextWindow: positiveInt(source.contextWindow),
    maxOutputTokens: positiveInt(source.maxOutputTokens),
    ttsVoice: kind === 'tts' ? str(source.ttsVoice) || defaultSpeechVoice(id) : undefined,
    realtimeVoice:
      kind === 'realtime'
        ? str(source.realtimeVoice) ||
          (isOpenAiRealtimeModelId(id) ? OPENAI_DEFAULT_REALTIME_VOICE : undefined)
        : undefined
  }
}

/**
 * 生图接口形状这一位。
 *
 * models.json 用户可以直接编辑，认不出来的值一律当没填 —— 让 imageGeneration
 * 按协议猜一个通用的，好过带着一个谁也不认识的字符串去查规格表然后 undefined。
 */
const IMAGE_APIS: readonly ImageApi[] = [
  'openai-images',
  'gpt-images',
  'grok-images',
  'siliconflow-images',
  'ark-images',
  'gemini-images'
]

function normalizeImageApi(value: unknown): ImageApi | undefined {
  return IMAGE_APIS.find((api) => api === value)
}

/**
 * 3D 接口形状这一位。与生图同理：认不出来的值一律当没填。
 *
 * 但**回落方式相反** —— 生图认不出来会按协议猜一个通用值，3D 没有通用值可猜
 * （三家的提交/轮询/取文件全不一样），只能按 Base URL 认厂商，认不出就留空
 * 让调用时明确报「没选接口形状」。
 */
const MODEL3D_APIS: readonly Model3dApi[] = ['rodin', 'tripo', 'meshy']

function normalizeModel3dApi(value: unknown): Model3dApi | undefined {
  return MODEL3D_APIS.find((api) => api === value)
}

/**
 * 向量化接口形状这一位。
 *
 * 这一位**以前压根没被写回磁盘** —— 与 3D 那两位是同一类白名单漏字段的 bug：
 * 用户在 models.json 里给 Jina 写了 `jina-embeddings`，存一次盘就没了，
 * 于是非对称检索的 task 参数不发，**不报错，只是搜不准**。
 *
 * 不填按 `openai-embeddings` 处理，那是事实标准，所以留空是安全的缺省。
 */
const EMBEDDING_APIS: readonly EmbeddingApi[] = [
  'openai-embeddings',
  'jina-embeddings',
  'voyage-embeddings'
]

function normalizeEmbeddingApi(value: unknown): EmbeddingApi | undefined {
  return EMBEDDING_APIS.find((api) => api === value)
}

/**
 * 结构化输出的能力档位。同样是白名单：认不出来的值当没填，
 * 由 structuredOutput.ts 按厂商硬规则猜、猜错再降档。
 *
 * 这一位必须留在白名单里 —— 漏了它就是上面向量化那个 bug 的翻版：用户在
 * models.json 里给自建网关标了 `json-object`，存一次盘就没了，于是每次调用
 * 都要先白挨一个 400 才降到对的那一档。
 */
const STRUCTURED_OUTPUT_APIS: readonly StructuredOutputApi[] = [
  'json-schema',
  'json-object',
  'none'
]

function normalizeStructuredOutputApi(value: unknown): StructuredOutputApi | undefined {
  return STRUCTURED_OUTPUT_APIS.find((api) => api === value)
}

/**
 * 就地修掉存量配置里的错生图形状。
 *
 * 与 migrateProtocol 同一类问题：models.json 里的 `imageApi` 是**添加 Provider 那一刻
 * 从内置目录拷进去的一份快照**，目录后来改对了，磁盘上那份不会跟着变。
 *
 * 方舟的 Seedream 曾被写成 `openai-images`，而方舟只有 `/images/generations`
 * 一个端点 —— 按 OpenAI 那套带参考图去打 `/images/edits`，回来的是一个空 body 的
 * 404，用户看到的只有一句没头没尾的 `Not Found`，而界面上没有任何线索说
 * 「去 models.json 手改这一位」。
 *
 * 只修**我们自己写错的那一种**：值是通用形状、模型名却是方舟的。用户手工改成
 * 别的值（比如某个网关确实提供 `/images/edits`）保持不动。
 */
function migrateImageApi(imageApi: ImageApi | undefined, modelId: string): ImageApi | undefined {
  if (imageApi === 'openai-images' && /seedream|seededit/i.test(modelId)) return 'ark-images'
  return imageApi
}

/**
 * 只收正整数，其余（0、负数、字符串、NaN）一律当没填。
 *
 * models.json 是用户可直接编辑的，这里收到 0 就会让上下文用量条除零、
 * 让压缩判定退化成「每轮都压」。宁可回落到缺省值。
 */
function positiveInt(value: unknown): number | undefined {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num) || num < 1) return undefined
  return Math.floor(num)
}

function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim()
    if (name && typeof value === 'string') out[name] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 就地修掉存量配置里的错协议。
 *
 * ChatGPT 订阅最初被当成普通 Responses 接过来，实际打过去只会得到一句
 * 400 Bad Request。已经登录过的用户磁盘上还留着那份配置，不在这里改的话
 * 他们得把 Provider 删掉重加 —— 而界面上没有任何线索告诉他们该这么做。
 *
 * 按 Base URL 判而不是按 provider id：手工建的、指向同一个后端的 Provider
 * 同样是错的，同样该修。
 */
function migrateProtocol(protocol: ProviderProtocol, baseUrl: string): ProviderProtocol {
  const isCodexBackend = /^https:\/\/chatgpt\.com\/backend-api(\/codex)?$/i.test(baseUrl)
  if (isCodexBackend && protocol === 'openai-responses') return 'openai-codex-responses'
  return protocol
}

const VIDEO_APIS: readonly VideoApi[] = ['ark-video', 'minimax-video']

function normalizeVideoApi(value: unknown): VideoApi | undefined {
  return VIDEO_APIS.find((api) => api === value)
}

/** 按域名认视频厂商。与 model3dApiFromBaseUrl 同一个套路 */
function videoApiFromBaseUrl(baseUrl: string): VideoApi | undefined {
  if (/volces\.com|volcengine\.com/i.test(baseUrl)) return 'ark-video'
  if (/minimaxi?\.(com|io|chat)/i.test(baseUrl)) return 'minimax-video'
  return undefined
}

/**
 * v2 → v3 迁移：把「这个 Provider 是干什么的」从模型上的一排能力位推出来。
 *
 * v2 的配置里没有 `kind`，模态信息散在每个模型的 `supportsXxx` 上。这里按
 * **从窄到宽**的顺序判：越特殊的用途越先认，认不出来才落到 chat。
 *
 * 顺序不能乱。举个会出错的例子：豆包实时语音的 Provider 下面挂的模型也可能
 * 带着 `supportsTools`，先判 chat 的话它就永远变不成 realtime，而用户的
 * 「实时语音」角色绑定会在下一步因为 kind 对不上被丢掉 —— 表现是语音功能
 * 升级后**静默失效**，配置还在，界面上却说没配。
 *
 * v3 起 `kind` 是显式写进磁盘的，这个函数只在读到老配置时起作用。
 */
function inferKind(
  source: Record<string, unknown>,
  baseUrl: string,
  models: unknown[]
): ProviderKind {
  const has = (bit: string): boolean =>
    models.some((model) => (model as Record<string, unknown>)?.[bit] === true)
  const anyId = (test: (id: string) => boolean): boolean =>
    models.some((model) => test(str((model as Record<string, unknown>)?.id)))

  if (
    has('supportsRealtimeVoice') ||
    isDoubaoRealtimeBaseUrl(baseUrl) ||
    anyId(isOpenAiRealtimeModelId)
  ) {
    return 'realtime'
  }
  if (has('supportsModel3d') || model3dApiFromBaseUrl(baseUrl)) return 'model3d'
  if (normalizeVideoApi(source.videoApi)) return 'video'
  if (has('supportsImageGeneration')) return 'image'
  if (has('supportsEmbedding')) return 'embedding'
  return 'chat'
}

function normalizeProvider(raw: unknown, legacy: boolean): ProviderConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>

  const id = str(source.id)
  const baseUrl = str(source.baseUrl).replace(/\/+$/, '')
  if (!id || !baseUrl) return null

  const protocol = migrateProtocol(str(source.protocol) as ProviderProtocol, baseUrl)
  if (!VALID_PROTOCOLS.includes(protocol)) return null

  const rawKey = source.apiKey as Record<string, unknown> | undefined
  const kind = str(rawKey?.kind)
  let apiKey: ProviderConfig['apiKey']
  if (kind === 'env' && str(rawKey?.name)) {
    apiKey = { kind: 'env', name: str(rawKey?.name) }
  } else if (kind === 'literal' && str(rawKey?.id)) {
    apiKey = { kind: 'literal', id: str(rawKey?.id) }
  } else if (kind === 'shell' && str(rawKey?.command)) {
    apiKey = { kind: 'shell', command: str(rawKey?.command) }
  } else if (kind === 'oauth' && str(rawKey?.id) && str(rawKey?.provider)) {
    apiKey = { kind: 'oauth', provider: str(rawKey?.provider), id: str(rawKey?.id) }
  } else {
    // 认不出来就按「不需要密钥」处理。这一支只该接住真正非法的输入 ——
    // `ApiKeyRef` 的每一种都必须在上面被显式认出来，漏一种就是**静默丢配置**：
    // oauth 和 shell 曾经都漏在这里，表现是账号登录明明成功了（令牌已经写进
    // 密钥库），provider 上却挂着 kind:'none'，一测连接就报「密钥无效」。
    apiKey = { kind: 'none' }
  }

  const rawModels = Array.isArray(source.models) ? source.models : []
  // v3 起磁盘上直接写着 kind；读到老配置（或用户手写了个不认识的值）才去推
  const declared = PROVIDER_KINDS.find((item) => item === source.kind)
  const providerKind = declared ?? inferKind(source, baseUrl, rawModels)

  const models = rawModels
    .map((model) => normalizeModel(model, id, providerKind, legacy))
    .filter((item): item is ModelConfig => item !== null)

  return {
    id,
    displayName: str(source.displayName) || id,
    kind: providerKind,
    // 形状那两位提到了 Provider 上。v2 的配置把它们写在模型里，所以先从
    // 模型上捞一次，再按域名兜底 —— 两条都空就留空，调用时会明确报「没选」
    model3dApi:
      providerKind === 'model3d'
        ? (normalizeModel3dApi(source.model3dApi) ??
          normalizeModel3dApi(
            rawModels.map((model) => (model as Record<string, unknown>)?.model3dApi).find(Boolean)
          ) ??
          model3dApiFromBaseUrl(baseUrl))
        : undefined,
    musicApi:
      providerKind === 'music' &&
      (source.musicApi === 'elevenlabs-music' ||
        source.musicApi === 'mureka-music' ||
        source.musicApi === 'sunoapi-music')
        ? source.musicApi
        : undefined,
    videoApi:
      providerKind === 'video'
        ? (normalizeVideoApi(source.videoApi) ?? videoApiFromBaseUrl(baseUrl))
        : undefined,
    protocol,
    baseUrl,
    apiKey,
    headers: normalizeHeaders(source.headers),
    imageUploadUrl: str(source.imageUploadUrl) || undefined,
    imageResolutionTiers: source.imageResolutionTiers === true || undefined,
    models
  }
}

function normalizeRoles(raw: unknown, providers: ProviderConfig[]): AiProviderSettings['roles'] {
  const out: AiProviderSettings['roles'] = {}
  if (!raw || typeof raw !== 'object') return out

  const source = raw as Record<string, unknown>
  for (const role of MODEL_ROLES) {
    // v2 以前的「fast」与现在合并后的「summary」是同一种轻量任务。
    // 旧配置只写了 fast 时原样接过来；两项都写过则听原来的 summary，避免替用户猜。
    const binding = (role === 'summary' ? (source.summary ?? source.fast) : source[role]) as
      | Record<string, unknown>
      | undefined
    const providerId = str(binding?.providerId)
    const modelId = str(binding?.modelId)
    if (!providerId || !modelId) continue

    // 指向已删除的 provider 的绑定直接丢弃 —— 留着只会在调用时报一个
    // 「provider 不存在」的费解错误，不如让它表现为「未配置」。
    const provider = providers.find((item) => item.id === providerId)
    if (!provider) {
      console.warn(`[AI 配置] 角色 ${role} 指向不存在的 provider «${providerId}»，已忽略`)
      continue
    }
    out[role as ModelRole] = { providerId, modelId }
  }
  return out
}

export function normalizeSettings(raw: unknown): AiProviderSettings {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_SETTINGS, providers: [], roles: {} }
  const source = raw as Record<string, unknown>

  // 版本号缺失也当 v1 —— 手写的、或者更早期没写版本的配置都归这一档
  const legacy = Number(source.version ?? 1) < REASONING_MIGRATED_VERSION

  const seen = new Set<string>()
  const providers: ProviderConfig[] = []
  if (Array.isArray(source.providers)) {
    for (const item of source.providers) {
      const provider = normalizeProvider(item, legacy)
      if (!provider) continue
      if (seen.has(provider.id)) {
        console.warn(`[AI 配置] provider «${provider.id}» 重复，保留先出现的那个`)
        continue
      }
      seen.add(provider.id)
      providers.push(provider)
    }
  }

  return { version: SETTINGS_VERSION, providers, roles: normalizeRoles(source.roles, providers) }
}

let cache: AiProviderSettings | null = null

export async function readSettings(): Promise<AiProviderSettings> {
  if (cache) return cache

  const path = settingsPath()
  if (!existsSync(path)) {
    cache = { version: 1, providers: [], roles: {} }
    return cache
  }

  try {
    const raw = await fs.readFile(path, 'utf-8')
    cache = normalizeSettings(JSON.parse(raw))
  } catch (error) {
    // 用户手改坏了 JSON 不该让应用起不来，但也不能悄悄覆盖他的文件 ——
    // 内存里按空配置走，磁盘原样保留，让他有机会自己改回来。
    console.error(`[AI 配置] ${path} 解析失败，本次按空配置运行（文件未改动）:`, error)
    cache = { version: 1, providers: [], roles: {} }
  }
  return cache
}

/**
 * 同步版。**只给「造工具时要看一眼配置」这一类场合用**，别拿它替代 `readSettings`。
 *
 * 工具注册是同步的（`buildAllTools()`），而有些工具的入参表取决于用户绑的是哪家
 * 厂商 —— 见 `generate3dModel.ts` 里按厂商决定暴露哪些参数的那一段。异步读在
 * 那里接不上，而「先 await 一次预热再造工具」是**隐式的顺序约定**：注册还有
 * MCP 自启这条入口，谁先跑谁的结果会被全局缓存住，排错时看不出来。同步读一次
 * 几 KB 的 JSON 换掉这个顺序坑，划算。
 *
 * 与异步版**共用同一份缓存**，所以正常情况下它一次盘都不读。
 */
export function readSettingsSync(): AiProviderSettings {
  if (cache) return cache

  const path = settingsPath()
  if (!existsSync(path)) {
    cache = { version: 1, providers: [], roles: {} }
    return cache
  }

  try {
    cache = normalizeSettings(JSON.parse(readFileSync(path, 'utf-8')))
  } catch (error) {
    console.error(`[AI 配置] ${path} 解析失败，本次按空配置运行（文件未改动）:`, error)
    cache = { version: 1, providers: [], roles: {} }
  }
  return cache
}

export async function writeSettings(settings: AiProviderSettings): Promise<AiProviderSettings> {
  const normalized = normalizeSettings(settings)
  const path = settingsPath()
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8')
  cache = normalized
  notifyChanged()
  return normalized
}

/** 让下一次 readSettings 重新读盘。用户在外部编辑过文件后调用 */
export function invalidateSettingsCache(): void {
  cache = null
  notifyChanged()
}

/**
 * 配置变了要跟着重算的东西登记在这里。
 *
 * 目前只有一个订阅者：工具注册表。它按「用户绑的是哪家 3D 厂商」决定
 * `generate_3d_model` 暴露哪些参数，而那份工具表是全局缓存的 —— 不清掉的话，
 * 用户在偏好设置里换完厂商，要重启应用才生效。
 *
 * 反过来做（让 `ai/ipc.ts` 写完配置去调工具注册表）会让底层的配置模块依赖上层的
 * agent 模块，方向是反的。
 */
const changeListeners = new Set<() => void>()

export function onSettingsChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChanged(): void {
  for (const listener of changeListeners) {
    try {
      listener()
    } catch (error) {
      // 订阅者自己的问题不该把「保存配置」这件事带崩
      console.error('[AI 配置] 变更订阅者抛错:', error)
    }
  }
}
