/**
 * 本地直连 Provider 的主进程类型定义。
 *
 * 社区版没有官方 AI 网关，模型调用一律由用户自己配置的 Provider 直连厂商。
 * 这里的类型同时是 `models.json` 的磁盘格式 —— 用户可以直接编辑那个文件，
 * 所以字段命名以「人看得懂」为先，不做缩写。
 *
 * 与渲染层共享的那部分词汇（协议、模型、角色）定义在 `src/shared/aiProvider.ts`，
 * 这里只补主进程独有的：密钥引用、磁盘结构、以及选模型时的回落规则。
 */

import type {
  MusicApi,
  Model3dApi,
  ModelConfig,
  ModelRole,
  ProviderKind,
  ProviderProtocol,
  RoleBindings,
  VideoApi
} from '../../shared/aiProvider'

export type {
  ModelBinding,
  ModelConfig,
  ModelRole,
  ProviderProtocol,
  RoleBindings
} from '../../shared/aiProvider'
export { MODEL_ROLES, PROVIDER_KINDS, ROLE_KIND } from '../../shared/aiProvider'
export type {
  ProviderKind,
  Model3dApi,
  StructuredOutputApi,
  VideoApi
} from '../../shared/aiProvider'

/**
 * 密钥引用。
 *
 * `models.json` 里**不存明文密钥**：literal 只存一个 id，密文在旁边那个
 * 由 safeStorage 加密的文件里；env 与 shell 存的是「怎么取」而不是密钥本身，
 * 那两者不是机密，可以明文存、也可以回显给界面。
 */
export type ApiKeyRef =
  | { kind: 'literal'; id: string }
  | { kind: 'env'; name: string }
  /**
   * 执行一条命令取密钥，取 stdout。
   *
   * 给 1Password CLI（`op read op://vault/openai/key`）、`aws sso`、
   * 公司自建密钥服务这类场景用 —— 密钥根本不进本应用的存储，
   * 也不进用户的环境变量。与 git 的 credential helper、AWS 的
   * credential_process 是同一个模式。
   */
  | { kind: 'shell'; command: string }
  /**
   * 账号登录换来的令牌。
   *
   * 与 literal 的区别是**会过期**：密钥库里存的是
   * `{ accessToken, refreshToken, expiresAt }`，取用时按需续期。
   * `provider` 指明用哪家的续期端点（见 oauth.ts 的 OAUTH_PROVIDERS）。
   */
  | { kind: 'oauth'; provider: string; id: string }
  /** 不需要密钥。本地推理（Ollama、LM Studio）属于这一类 */
  | { kind: 'none' }

export interface ProviderConfig {
  /** 用户可见的唯一标识，如 'openai'、'my-gateway' */
  id: string
  displayName: string
  /** 这个 Provider 是用来干什么的。决定它出现在哪些角色的候选里 */
  kind: ProviderKind
  /** 3D / 视频的接口形状。见 shared 里 ProviderView 上同名字段的注释 */
  model3dApi?: Model3dApi
  videoApi?: VideoApi
  musicApi?: MusicApi
  protocol: ProviderProtocol
  /** 厂商 API 根地址，如 'https://api.openai.com/v1' */
  baseUrl: string
  apiKey: ApiKeyRef
  /**
   * 附加请求头。
   *
   * 有些网关会做 bot 检测，需要固定的 User-Agent 之类。
   */
  headers?: Record<string, string>
  /** Optional reference upload endpoint returning data.url. */
  imageUploadUrl?: string
  /** OpenAI-compatible gateways using aspect ratio size plus a resolution tier. */
  imageResolutionTiers?: boolean
  models: ModelConfig[]
}

/** `models.json` 的完整结构 */
export interface AiProviderSettings {
  /**
   * 结构版本。读盘时按它决定要不要跑迁移，见 store.ts 的 `SETTINGS_VERSION`。
   *
   * 写成 number 而不是字面量联合：读到的可能是任何值（用户手改、或者更老的
   * 版本），迁移逻辑要拿它做比较。
   */
  version: number
  providers: ProviderConfig[]
  roles: RoleBindings
}

export const EMPTY_SETTINGS: AiProviderSettings = Object.freeze({
  version: 2,
  providers: [],
  roles: {}
})

/** 后端调用等级。与 `baseSpecialistRuntime` 的 BackendLevel 对齐 */
export type ModelLevel = 'low' | 'medium' | 'high'

export interface ModelRequest {
  /** 显式指定角色。不给则由 level 推导 */
  role?: ModelRole
  /** 官方网关时代的调用等级，用于在没有 role 时推导 */
  level?: ModelLevel
  /** 调用方标识，如 'ue_editor'、'blueprint_layout'。目前仅用于日志与错误提示 */
  agentType?: string
  /**
   * 本次请求是否包含图片。
   *
   * 为真时先看本该用的那个角色绑的模型看不看得懂图 —— 看得懂就用它，
   * 看不懂才换「视觉」角色兜底（见 `resolveRoleForRequest`）。
   */
  hasImages?: boolean
  /**
   * 台架专用：钉死 provider/model，绕过角色绑定。
   *
   * 只从本机调试端点进来（`/api/debug/agent` 的 `model` 字段）。评测要比的是
   * 「同一个模型在两种工具池下的表现」，而用户界面上绑的 agent 模型随时会换 ——
   * 不钉死的话，一批样本跑到一半换了模型，两臂就不再可比。产品路径不传它。
   */
  pin?: { providerId: string; modelId: string }
}

/**
 * level 到角色的回落。
 *
 * 直连模式下 low/medium/high 不再是「服务端替我选个便宜的」，
 * 而是「这件事值不值得用好模型」，所以映射到轻量任务/chat/agent 三档。
 */
export const LEVEL_TO_ROLE: Readonly<Record<ModelLevel, ModelRole>> = Object.freeze({
  low: 'summary',
  medium: 'chat',
  high: 'agent'
})

/**
 * 角色缺配时的回落链。
 *
 * 用户只配了一个 chat 模型也应该能把整个应用跑起来，而不是每个功能各报一次
 * 「未配置」。vision 这一档在链里只有自己 —— 它不能被纯文本模型顶替，
 * 图片丢给纯文本模型只会得到一句「我看不到图片」。
 *
 * 反过来「带图时该不该用 vision」不在这张表里，那要看主模型自己的能力位，
 * 见 `resolveRoleForRequest`。
 */
export const ROLE_FALLBACK: Readonly<Record<ModelRole, readonly ModelRole[]>> = Object.freeze({
  chat: Object.freeze<ModelRole[]>(['chat', 'agent', 'summary']),
  agent: Object.freeze<ModelRole[]>(['agent', 'chat']),
  summary: Object.freeze<ModelRole[]>(['summary', 'chat', 'agent']),
  vision: Object.freeze<ModelRole[]>(['vision']),
  // 嵌入模型不是对话模型，走的是另一套接口、返回的是向量。
  // 把对话模型顶上来只会拿到一句厂商报错，不如直接说缺什么。
  embedding: Object.freeze<ModelRole[]>(['embedding']),
  // 生图同理：另一套接口、返回的是图片字节。同样不回落。
  image: Object.freeze<ModelRole[]>(['image']),
  // 生成 3D 同理：另一套接口（而且是异步三段式）、返回的是网格文件。
  model3d: Object.freeze<ModelRole[]>(['model3d']),
  // 视频同理：异步任务式的另一套接口，返回的是视频地址。
  video: Object.freeze<ModelRole[]>(['video']),
  // 联网检索同理：走的是搜索厂商的接口，不是对话端点。
  search: Object.freeze<ModelRole[]>(['search']),
  /*
   * 实时语音。同样不回落，但理由和上面几个不太一样：
   *
   * 它不是「另一套接口」那么简单 —— 而是**只有极少数模型有**这个能力。
   * 拿一个普通对话模型顶上来，连的是一个根本不存在的 /realtime 端点，
   * 得到的是一句 404，看上去像地址填错了。
   */
  realtime: Object.freeze<ModelRole[]>(['realtime']),
  music: Object.freeze<ModelRole[]>(['music']),
  tts: Object.freeze<ModelRole[]>(['tts'])
})
