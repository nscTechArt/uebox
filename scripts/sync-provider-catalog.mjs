#!/usr/bin/env node
/**
 * 从 models.dev 同步内置 Provider 目录。
 *
 * models.dev 是 opencode 团队维护的开源模型目录（MIT），社区在持续更新
 * 各家的模型清单、能力位与上下文长度。手工维护那份清单必然过期 ——
 * 我们只维护「选哪些厂商」和「它们的 Base URL」，其余交给上游。
 *
 * 为什么是**生成到源码里**而不是运行时拉取：
 * 社区版承诺离线可用，打开「添加 Provider」不该是一次对外请求。所以这里
 * 生成一份快照提交进仓库，发版前跑一次即可。
 *
 * 用法：
 *   node scripts/sync-provider-catalog.mjs          生成
 *   node scripts/sync-provider-catalog.mjs --check  只校验快照是否还能生成（CI 用）
 *   node scripts/sync-provider-catalog.mjs --data=<api.json> --skip-logos  从保存的上游快照复现
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const OUT_FILE = join(ROOT, 'src/main/ai/catalog.generated.ts')
const LOGO_DIR = join(ROOT, 'src/renderer/src/assets/provider-logos')
const API_URL = 'https://models.dev/api.json'
const LOGO_URL = (id) => `https://models.dev/logos/${id}.svg`

/**
 * 借用别家的图标。
 *
 * 订阅套餐在 models.dev 里没有独立条目，直接拉会拿到一个通用占位图。
 * 它们本来就是同一家厂商的另一种售卖方式，用母公司的标更好认。
 */
const LOGO_ALIAS = {
  chatgpt: 'openai',
  'kimi-code': 'moonshotai',

  // 生图条目是同一家厂商的另一个入口（见 CURATED 里的「图片生成」一段），
  // 用母公司的标，免得目录里出现一排没有图标的方块
  'openai-image': 'openai',
  'google-image': 'google',
  'xai-image': 'xai',
  'ark-seedream': 'bytedance',
  'siliconflow-image': 'siliconflow',
  'zhipuai-image': 'zhipuai',
  'togetherai-image': 'togetherai',

  // 网页检索里的 Jina 也是同一家的另一个入口
  'jina-search': 'jina',

  // 向量化条目同理（见 CURATED 里的「向量化」一段）
  'ollama-embedding': 'ollama',
  'openai-embedding': 'openai',
  'siliconflow-embedding': 'siliconflow',
  'alibaba-embedding': 'alibaba',
  'zhipuai-embedding': 'zhipuai',

  // 实时语音条目是同一家厂商的另一个入口，用母公司的标
  'openai-realtime': 'openai',
  'doubao-tts': 'bytedance',
  'alibaba-tts': 'alibaba',
  'doubao-realtime': 'bytedance'

  // 3D 那三家（hyper3d / tripo / meshy）在 models.dev 里没有条目，也没有可借用的
  // 母公司标 —— 它们本来就是独立厂商。目录里显示首字母方块，不影响使用。
}

/** 每个 provider 最多预置多少个模型。其余让用户用「导入模型」按需拉 */
const MAX_MODELS_PER_PROVIDER = 12

/**
 * 只预置 2026 年发布的对话模型。无日期不猜，整家没有符合条件的模型就留空，
 * 用户仍可导入或手填。图片、向量化等专用服务不走对话模型的年份过滤。
 */
const MIN_RELEASE_DATE = '2026-01-01'
const MAX_RELEASE_DATE = '2027-01-01'

/**
 * 预置模型的上下文窗口下限。
 *
 * 光系统提示词加几十个工具的定义就上万 token，窗口比这还小的模型在这个应用里
 * 一轮都跑不完。取 8k 这条线主要是为了挡掉上游混进对话模型里的**分类器**
 * （Llama Prompt Guard 之类，512 token，输出也是文本，靠模态筛不掉）。
 */
const MIN_CONTEXT_WINDOW = 8_192

/** 全部模型都在截止线之前的厂商，生成时提示一次，便于决定要不要从精选清单里摘掉 */
const staleProviders = []

/**
 * 「去哪儿拿密钥」的精确地址。
 *
 * models.dev 的 `doc` 指的是**文档首页或模型列表**，不是密钥页 ——
 * 直接用它，用户点开会落在一篇讲模型能力的文章上，还得自己找控制台。
 * 这里逐家覆盖成真正能创建密钥的那一页；没覆盖的回落到 `doc`。
 *
 * 2026-08 逐一核对过。厂商改版时这里会过期，界面上是个外链，
 * 点开发现不对就来改这一处。
 */
const KEY_PAGE = {
  // ── 海外 ──
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/team/default/api-keys',
  mistral: 'https://console.mistral.ai/api-keys',
  groq: 'https://console.groq.com/keys',
  cerebras: 'https://cloud.cerebras.ai/platform/apikeys',
  togetherai: 'https://api.together.xyz/settings/api-keys',
  'fireworks-ai': 'https://app.fireworks.ai/settings/users/api-keys',
  deepinfra: 'https://deepinfra.com/dash/api_keys',
  perplexity: 'https://www.perplexity.ai/account/api/keys',
  cohere: 'https://dashboard.cohere.com/api-keys',
  huggingface: 'https://huggingface.co/settings/tokens',
  nebius: 'https://console.nebius.com/settings/api-keys',
  baseten: 'https://app.baseten.co/settings/api_keys',
  venice: 'https://venice.ai/settings/api',
  inference: 'https://inference.net/dashboard/api-keys',
  openrouter: 'https://openrouter.ai/keys',

  // 自建网关：密钥在**用户自己那台机器**上签发，没有统一的密钥页，
  // 只能指到「怎么签发」的文档
  litellm: 'https://docs.litellm.ai/docs/proxy/virtual_keys',
  'one-api': 'https://github.com/songquanpeng/one-api#%E4%BD%BF%E7%94%A8%E6%96%B9%E6%B3%95',

  vercel: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fai%2Fapi-keys',
  'cloudflare-ai-gateway': 'https://dash.cloudflare.com/profile/api-tokens',

  // 这三家走云账号的 IAM，没有「一个密钥」这回事，只能指到凭据文档
  'amazon-bedrock': 'https://docs.aws.amazon.com/bedrock/latest/userguide/api-setup.html',
  azure: 'https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts',
  'google-vertex': 'https://console.cloud.google.com/apis/credentials',

  // ── 国内 ──
  alibaba: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
  deepseek: 'https://platform.deepseek.com/api_keys',
  'moonshotai-cn': 'https://platform.moonshot.cn/console/api-keys',
  zhipuai: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  siliconflow: 'https://cloud.siliconflow.cn/account/ak',
  'minimax-cn': 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  baidu: 'https://console.bce.baidu.com/iam/#/iam/apikey',
  tencent: 'https://console.cloud.tencent.com/tokenhub/apikey',
  bytedance: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  stepfun: 'https://platform.stepfun.com/interface-key',
  infini: 'https://cloud.infini-ai.com/genstudio/model',

  // ── 生图（与上面同名厂商共用一个控制台，密钥页也是同一个）──
  'openai-image': 'https://platform.openai.com/api-keys',
  'google-image': 'https://aistudio.google.com/apikey',
  'xai-image': 'https://console.x.ai/team/default/api-keys',
  'ark-seedream': 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  'siliconflow-image': 'https://cloud.siliconflow.cn/account/ak',
  'zhipuai-image': 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  'togetherai-image': 'https://api.together.xyz/settings/api-keys',

  // ── 向量化（同名厂商共用控制台）──
  jina: 'https://jina.ai/api-dashboard/key-manager',
  voyageai: 'https://dashboard.voyageai.com/api-keys',
  'openai-embedding': 'https://platform.openai.com/api-keys',
  'siliconflow-embedding': 'https://cloud.siliconflow.cn/account/ak',
  'alibaba-embedding': 'https://bailian.console.aliyun.com/?apiKey=1',
  'zhipuai-embedding': 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',

  // ── 实时语音（同名厂商共用控制台）──
  'openai-realtime': 'https://platform.openai.com/api-keys',
  // 火山的**语音**控制台，不是方舟那个 —— 两条产品线的凭据互不通用
  'doubao-tts': 'https://console.volcengine.com/speech/new/setting/apikeys',
  'alibaba-tts': 'https://bailian.console.aliyun.com/?apiKey=1',
  'doubao-realtime': 'https://console.volcengine.com/speech/app',

  // ── 3D 生成 ──
  hyper3d: 'https://hyper3d.ai/workspace/api-dashboard',
  tripo: 'https://platform.tripo3d.ai/api-keys',
  meshy: 'https://www.meshy.ai/api'
}

/**
 * 精选清单。
 *
 * models.dev 有 202 家，全量塞进来是 4MB，绝大多数用户一辈子用不到。
 * 这里按「中英文社区实际会用的」挑，分四组显示。
 *
 * `baseUrl` 是**必填**的：models.dev 里有 26 家没有 api 字段（openai、
 * anthropic、google 这些，因为各自的 SDK 内置了默认地址），我们是通过
 * openai-compatible 直连，必须自己给出地址。
 */
export const CURATED = [
  // ── 本机推理 ──
  { id: 'ollama', group: 'local', baseUrl: 'http://localhost:11434/v1', requiresApiKey: false },
  { id: 'lmstudio', group: 'local', baseUrl: 'http://localhost:1234/v1', requiresApiKey: false },
  { id: 'llamacpp', group: 'local', baseUrl: 'http://localhost:8080/v1', requiresApiKey: false },

  // ── 订阅服务 ──
  // 用已有的会员/订阅账号驱动本应用，而不是另外买 API 额度。
  // 授权方式与合规依据逐条记在 src/main/ai/oauth.ts 的注释里。
  {
    id: 'chatgpt',
    group: 'subscription',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    // 不是 openai-responses：这个后端要账号 id、只发流、不落库，
    // 三条差异都写在 src/shared/aiProvider.ts 的协议注释里
    protocol: 'openai-codex-responses',
    displayName: 'ChatGPT Plus / Pro',
    supportsOAuth: true
  },
  {
    id: 'kimi-code',
    sourceId: 'kimi-for-coding',
    group: 'subscription',
    baseUrl: 'https://api.kimi.com/coding/v1',
    protocol: 'openai-completions',
    displayName: 'Kimi Code（会员）',
    supportsOAuth: true
  },

  // ── 图片生成 ──
  //
  // 单独成组，因为这些条目和上下几组**不是一回事**：绑给「生图」角色的模型走的是
  // `/images/generations`，不是 `/chat/completions`。混在对话厂商里的话，用户
  // 添加完 OpenAI 会发现模型清单里一个能画图的都没有 —— 那份清单是按对话模型
  // 筛的，生图模型被 pickModels 主动剔掉了（它们在对话里绑上去只会拿到报错）。
  //
  // 收录标准是硬的，不是「这家有名就放进来」——每一条都要在 imageGeneration.ts 里
  // 有一个**照着这家官方文档写的适配器**（`imageApi` 那一位指的就是它）。端点长什么
  // 样不是门槛（Nano Banana 走的就不是 /images/generations），有没有官方文档才是。
  //   · Fal / Replicate 不在：它们是异步任务接口（先提交拿 id 再轮询），
  //     那要的不只是一个适配器，还要一套轮询，等真有人要再说
  {
    id: 'openai-image',
    group: 'image',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses',
    displayName: 'OpenAI GPT Image'
  },
  {
    id: 'google-image',
    group: 'image',
    // Interactions API 的根，不是 OpenAI 兼容层那个 /v1beta/openai。
    // 适配器往后接的是 /interactions
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    displayName: 'Google Nano Banana'
  },
  {
    id: 'xai-image',
    group: 'image',
    baseUrl: 'https://api.x.ai/v1',
    displayName: 'xAI Grok Imagine'
  },
  {
    id: 'ark-seedream',
    group: 'image',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    displayName: '火山方舟 Seedream（豆包）'
  },
  {
    id: 'siliconflow-image',
    group: 'image',
    baseUrl: 'https://api.siliconflow.cn/v1',
    displayName: '硅基流动 SiliconFlow（生图）'
  },
  {
    id: 'zhipuai-image',
    group: 'image',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    displayName: '智谱 CogView'
  },
  {
    id: 'togetherai-image',
    group: 'image',
    baseUrl: 'https://api.together.xyz/v1',
    displayName: 'Together AI（FLUX）'
  },

  // ── 向量化 ──
  //
  // 单独成组的理由和生图一样：绑给「嵌入」角色的模型走 /embeddings，
  // 返回的是向量不是文本，和上下几组不是一回事。
  //
  // 在这之前目录里**一个向量化模型都没有**（models.dev 只收对话模型），
  // 用户想配知识库检索只能自己手打模型 id —— 而打错不会报错，
  // 只是检索永远搜不到东西。
  //
  // 收录标准同样是硬的：必须是 `/embeddings` 形状、且我们有对应的
  // EmbeddingApi 实现（见 src/shared/aiProvider.ts）。Cohere 的
  // /v2/embed 与 Google 的 :embedContent 都是另一套路径，不在这里 ——
  // 想用 Gemini 的向量化，配它的 OpenAI 兼容地址即可。
  {
    id: 'ollama-embedding',
    group: 'embedding',
    baseUrl: 'http://localhost:11434/v1',
    displayName: 'Ollama（本机向量化）',
    requiresApiKey: false
  },
  {
    id: 'jina',
    group: 'embedding',
    baseUrl: 'https://api.jina.ai/v1',
    displayName: 'Jina AI（向量化）'
  },

  // ── 网页检索 ──
  // 这一组的「模型」不是模型，是**去哪儿搜**。三条各缺一样东西，都是真实情况：
  // 内置浏览器没有地址也没有密钥，SearXNG 只有地址，只有 Jina 三样齐全。
  {
    id: 'builtin-browser',
    group: 'search',
    // 没有地址：它不请求谁的 API，是在本机开一个隐藏的浏览器窗口去看搜索页
    baseUrl: '',
    displayName: '内置浏览器（免配置）',
    requiresApiKey: false
  },
  {
    id: 'searxng',
    group: 'search',
    // 自建实例的地址只有用户自己知道，留空让他填
    baseUrl: '',
    displayName: 'SearXNG（自建）',
    requiresApiKey: false
  },
  {
    id: 'jina-search',
    group: 'search',
    baseUrl: 'https://s.jina.ai',
    displayName: 'Jina AI（网页检索）'
  },
  {
    id: 'openai-embedding',
    group: 'embedding',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'OpenAI Embeddings'
  },
  {
    id: 'voyageai',
    group: 'embedding',
    baseUrl: 'https://api.voyageai.com/v1',
    displayName: 'Voyage AI（向量化）'
  },
  {
    id: 'siliconflow-embedding',
    group: 'embedding',
    baseUrl: 'https://api.siliconflow.cn/v1',
    displayName: '硅基流动 SiliconFlow（向量化）'
  },
  {
    id: 'alibaba-embedding',
    group: 'embedding',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    displayName: '阿里云百炼（向量化）'
  },
  {
    id: 'zhipuai-embedding',
    group: 'embedding',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    displayName: '智谱 Embedding'
  },

  // ── 3D 生成 ──
  //
  // 单独成组的理由和上面几组一样，但差别更大：这一组走的是**异步任务接口**
  // （提交拿任务号 → 轮询 → 取文件），一次几十秒到几分钟。生图那一段注释里
  // 写过「Fal / Replicate 不在，因为异步任务要的不只是一个适配器，还要一套
  // 轮询」—— 那套轮询现在有了，就在 `src/main/ai/model3d.ts`。
  //
  // 收录标准同样是硬的：必须有一个照着这家官方文档写的适配器（`model3dApi`
  // 那一位指的就是它）。因此这几家**暂时不在**：
  //   · 腾讯混元生3D：走腾讯云 API 3.0，要 TC3-HMAC-SHA256 签名，密钥是
  //     SecretId + SecretKey **一对**，而 ApiKeyRef 只有单值的形状，没地方放。
  //     与上面「火山引擎语音要 appid + access token + cluster」是同一类问题
  //   · fal.ai：密钥前缀是 `Key` 不是 `Bearer`（适配器已经留了 authScheme 这一位），
  //     但它的队列接口没能从官方文档确认到端点形状，不照着文档写就不收
  {
    id: 'hyper3d',
    group: 'model3d',
    baseUrl: 'https://api.hyper3d.com/api/v2',
    displayName: 'Hyper3D Rodin',
    model3dApi: 'rodin'
  },
  {
    id: 'tripo',
    group: 'model3d',
    // **V3 的域名**，与 V2 的 api.tripo3d.ai/v2/openapi 不是同一个主机。
    // 适配器写的是 V3 的 /generation/* 与 /tasks/*，指到 V2 上是一片 404
    baseUrl: 'https://openapi.tripo3d.ai/v3',
    displayName: 'Tripo（VAST AI）',
    model3dApi: 'tripo'
  },
  {
    id: 'meshy',
    group: 'model3d',
    // 端点在 /openapi/v1 下按任务类型分叉，所以 Base URL 只到域名
    baseUrl: 'https://api.meshy.ai',
    displayName: 'Meshy',
    model3dApi: 'meshy'
  },

  // ── 视频生成 ──
  //
  // 与 3D 同为异步任务式，但只有两段（提交 → 轮询），地址就在轮询响应里。
  // 收录标准同样是硬的：每一条都要在 video.ts 里有一个照着官方文档写的适配器。
  //
  //   · 可灵：官方更新公告说新 API 已改为单 API Key 鉴权，但老路子是
  //     AccessKey+SecretKey 签 JWT。等确认到新版鉴权的官方原文再收
  //   · Runway / Luma：单 key，形状也不复杂，但还没有人要，先不收
  {
    id: 'ark-seedance',
    group: 'video',
    // 与 Seedream（生图）同一个方舟根地址、同一把密钥，但**是两条记录** ——
    // 一个 Provider 只干一件事，见 ProviderKind 的注释
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    displayName: '火山方舟 Seedance（即梦）',
    videoApi: 'ark-video'
  },
  {
    id: 'minimax-video',
    group: 'video',
    // 国内站是 minimaxi.com，国际站是 minimax.io，两边的 Key 不通用。
    // 默认给国内站，用海外账号的用户自己改地址
    baseUrl: 'https://api.minimaxi.com/v2',
    displayName: 'MiniMax 海螺视频',
    videoApi: 'minimax-video'
  },

  // ── 实时语音 ──
  //
  // 单独成组，因为这两条和别的都不是一回事：它们走的是一条**常驻的 WebSocket
  // 会话**（语音进、语音出、中途调工具），不是 /chat/completions 那种一问一答。
  // 混在对话厂商里的话，用户绑给「对话」会拿到一句厂商报错，
  // 而绑给「实时语音」的模型又要在几十个对话模型里翻。
  //
  // 收录标准：必须在 `src/main/ai/realtime/` 里有一个照着这家官方文档写的适配器。
  {
    id: 'openai-realtime',
    group: 'realtime',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses',
    displayName: 'OpenAI 实时语音'
  },
  {
    id: 'elevenlabs-music',
    group: 'music',
    baseUrl: 'https://api.elevenlabs.io/v1',
    musicApi: 'elevenlabs-music',
    displayName: 'ElevenLabs Music'
  },
  {
    id: 'sunoapi-music',
    group: 'music',
    baseUrl: 'https://api.sunoapi.org/api/v1',
    musicApi: 'sunoapi-music',
    displayName: 'SUNO (SunoAPI.org)'
  },
  {
    id: 'mureka-music',
    group: 'music',
    baseUrl: 'https://api.mureka.ai/v1',
    musicApi: 'mureka-music',
    displayName: 'Mureka'
  },
  {
    id: 'doubao-tts',
    group: 'tts',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
    displayName: '豆包语音合成 TTS 2.0'
  },
  {
    id: 'alibaba-tts',
    group: 'tts',
    baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    displayName: '阿里云 Qwen-Audio 3.0 语音合成'
  },
  {
    id: 'doubao-realtime',
    group: 'realtime',
    // 语音技术那条产品线，不是方舟。适配器往后接的是
    // /api/v3/duplex/realtime/dialogue
    baseUrl: 'https://openspeech.bytedance.com',
    displayName: '豆包实时语音'
  },

  // ── 自建网关 / 聚合层 ──
  // 这几家本身就是「网关路由」：自己部署一个，把所有厂商收在后面，
  // 客户端只配一次。团队场景比逐个填厂商密钥好管得多。
  {
    id: 'litellm',
    group: 'gateway',
    baseUrl: 'http://localhost:4000/v1',
    displayName: 'LiteLLM（自建网关）'
  },
  {
    id: 'one-api',
    group: 'gateway',
    baseUrl: 'http://localhost:3000/v1',
    displayName: 'One API / New API（自建网关）'
  },
  {
    id: 'openrouter',
    group: 'gateway',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai-completions',
    // 官方文档明确支持第三方应用的 PKCE 流程，换回来的是永久 API Key
    supportsOAuth: true
  },
  { id: 'vercel', group: 'gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1' },
  { id: 'cloudflare-ai-gateway', group: 'gateway', baseUrl: '', requiresApiKey: true },

  // ── 云端厂商：国际 ──
  { id: 'openai', group: 'cloud', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', group: 'cloud', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'google', group: 'cloud', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'xai', group: 'cloud', baseUrl: 'https://api.x.ai/v1' },
  { id: 'mistral', group: 'cloud', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'groq', group: 'cloud', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'cerebras', group: 'cloud', baseUrl: 'https://api.cerebras.ai/v1' },
  { id: 'togetherai', group: 'cloud', baseUrl: 'https://api.together.xyz/v1' },
  { id: 'fireworks-ai', group: 'cloud', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { id: 'deepinfra', group: 'cloud', baseUrl: 'https://api.deepinfra.com/v1/openai' },
  { id: 'perplexity', group: 'cloud', baseUrl: 'https://api.perplexity.ai' },
  { id: 'cohere', group: 'cloud', baseUrl: 'https://api.cohere.ai/compatibility/v1' },
  { id: 'huggingface', group: 'cloud', baseUrl: 'https://router.huggingface.co/v1' },
  { id: 'nebius', group: 'cloud', baseUrl: 'https://api.studio.nebius.ai/v1' },
  { id: 'baseten', group: 'cloud', baseUrl: 'https://inference.baseten.co/v1' },
  { id: 'venice', group: 'cloud', baseUrl: 'https://api.venice.ai/api/v1' },
  { id: 'inference', group: 'cloud', baseUrl: 'https://api.inference.net/v1' },
  { id: 'amazon-bedrock', group: 'cloud', baseUrl: '', requiresApiKey: true },
  { id: 'azure', group: 'cloud', baseUrl: '', requiresApiKey: true },
  { id: 'google-vertex', group: 'cloud', baseUrl: '', requiresApiKey: true },

  // ── 云端厂商：国内 ──
  {
    id: 'alibaba',
    group: 'cn',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    displayName: '阿里云百炼（通义千问）'
  },
  { id: 'deepseek', group: 'cn', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshotai-cn', group: 'cn', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipuai', group: 'cn', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'siliconflow', group: 'cn', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'minimax-cn', group: 'cn', baseUrl: 'https://api.minimax.chat/v1' },
  { id: 'baidu', group: 'cn', baseUrl: 'https://qianfan.baidubce.com/v2' },
  {
    id: 'tencent',
    sourceId: 'tencent-tokenhub',
    group: 'cn',
    displayName: '腾讯 TokenHub（混元）',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1'
  },
  {
    id: 'bytedance',
    sourceId: 'volcengine',
    group: 'cn',
    displayName: '字节火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
  },
  { id: 'stepfun', group: 'cn', baseUrl: 'https://api.stepfun.com/v1' },
  { id: 'infini', group: 'cn', baseUrl: 'https://cloud.infini-ai.com/maas/v1' }
]

/** models.dev 的 npm 包 → 我们的协议。默认按 openai-completions 处理 */
const NPM_TO_PROTOCOL = {
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/google': 'google-generative-ai'
}

/**
 * 手写模型条目的简写。
 *
 * `limit` 与上游同名同形（`{ context, output }`），给了才会写进 contextWindow ——
 * 不给就让运行时回落到保守缺省值，而不是在这里瞎猜一个。
 */
/**
 * 实时语音模型的构造函数。
 *
 * 与对话模型分开的理由和生图那几个一样：它不聊天、不调（我们这套的）工具、
 * 也没有上下文窗口这回事。共用 `model()` 只会往清单里写进一堆恒为 false 的字段。
 */
const realtimeModel = (id, name, realtimeVoice = undefined) => ({
  id,
  name,
  modalities: { output: ['audio'] },
  realtimeVoice
})

/** GPT-5.4 之后的订阅模型共用的窗口，写一次省得七处各抄一遍 */
const CODEX_LIMIT = { context: 272_000, output: 128_000 }

const model = (
  id,
  name,
  vision = false,
  tools = true,
  limit = undefined,
  reasoning = false,
  extra = undefined
) => ({
  id,
  name,
  attachment: vision,
  modalities: { input: vision ? ['text', 'image'] : ['text'], output: ['text'] },
  tool_call: tools,
  reasoning,
  ...(limit ? { limit } : {}),
  // 手写条目才用得上：上游给不出「哪几档思考存在」和视频输入这类位，
  // 而它们错了都不报错 —— 见 pickModels 里对应的两行
  ...(extra ?? {})
})

/**
 * 生图模型的简写。
 *
 * 和 `model()` 分开是因为对话模型那几个位在这里**一个都不成立**：生图模型不调
 * 工具、不谈上下文窗口、也没有「思考程度」。共用一个构造函数只会往清单里写进
 * 一堆恒为 false 的字段，看着像「查过了，不支持」，其实是「这个问题不适用」。
 *
 * `api` 说的是**请求长什么样**（字段名、哪些参数不能发），取值与
 * `src/shared/aiProvider.ts` 的 `ImageApi` 一一对应，具体字段见
 * `src/main/ai/imageGeneration.ts` 的 `IMAGE_API_SPECS`。
 * 这一位必须写在这儿而不是让代码去按模型名猜 —— AI SDK 就是靠猜的，
 * 然后 gpt-image-2 一出来就 400。
 */
const imageModel = (id, name, api = 'openai-images') => ({
  id,
  name,
  api,
  modalities: { output: ['image'] }
})

/**
 * 向量化模型的构造函数。
 *
 * 和 imageModel 分开的理由相同：向量化模型不聊天、不调工具、没有上下文窗口，
 * 也没有「思考程度」。共用对话模型那套只会写进一堆恒为 false 的字段。
 *
 * `api` 取值对应 `src/shared/aiProvider.ts` 的 `EmbeddingApi`，
 * 决定要不要多发「这段是文档还是查询」那个参数 —— 漏了不报错，只是搜不准。
 * `dim` 是输出维度：写下来既能显式发 `dimensions`，也能让界面在换模型时
 * 提示旧向量需要重建。
 */
const embedModel = (id, name, dim, api = 'openai-embeddings') => ({
  id,
  name,
  api,
  dim,
  modalities: { output: ['embedding'] }
})

/**
 * 3D 生成模型的构造函数。
 *
 * `api` 取值对应 `src/shared/aiProvider.ts` 的 `Model3dApi`，决定走哪一套
 * 提交/轮询/取文件。这一类**没有缺省值**：三家的三段各不相同，猜一个的结果是
 * 一串 404，看上去像 Base URL 填错了。所以这里的 `api` 是必填参数，不给默认。
 *
 * 这里的 `id` 就是各家的档位名（Rodin 的 `Gen-2`、Tripo 的 `v2.5-20250123`、
 * Meshy 的 `meshy-5`），不是「模型文件名」。
 */
const model3d = (id, name, api) => ({
  id,
  name,
  api,
  modalities: { output: ['model3d'] }
})

/**
 * 上游没收录、但值得给用户一个入口的条目。
 *
 * 两类：
 * 1. **自建网关**（LiteLLM / One API / llama.cpp / 本机 Ollama）—— 它们不是
 *    「厂商」，models.dev 自然不会收，但恰恰是团队部署时最该用的那一档。
 *    模型清单留空，让用户用「导入模型」从自己那台机器上拉。
 * 2. **上游暂缺的国内厂商**（百度、腾讯、字节、无问芯穹）—— 这几家在国内
 *    份额不小，先手写几个主力模型；等 models.dev 收录了就把这里删掉。
 */
const MANUAL_ENTRIES = {
  // ── 视频生成 ──
  // models.dev 只收对话模型，视频条目全部手写。
  'ark-seedance': {
    name: '火山方舟 Seedance（即梦）',
    env: ['ARK_API_KEY'],
    doc: 'https://www.volcengine.com/docs/82379/1520757',
    models: {
      // 型号名取自官方文档的示例代码，不是猜的前缀
      'doubao-seedance-2-5-260628': {
        id: 'doubao-seedance-2-5-260628',
        name: 'Seedance 2.5（最高 1080p，全模态参考）'
      },
      'doubao-seedance-2-0-260128': {
        id: 'doubao-seedance-2-0-260128',
        name: 'Seedance 2.0'
      }
    }
  },
  'minimax-video': {
    name: 'MiniMax 海螺视频',
    env: ['MINIMAX_API_KEY'],
    doc: 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',
    models: {
      'MiniMax-H3': { id: 'MiniMax-H3', name: 'MiniMax H3（768P / 2K，支持参考视频）' },
      'MiniMax-H3-Max': { id: 'MiniMax-H3-Max', name: 'MiniMax H3 Max（快，480P / 768P）' }
    }
  },

  // ── 向量化 ──
  // models.dev 只收对话模型，这几家的向量化条目全部手写。
  // 维度取厂商文档里的默认值；支持降维的（OpenAI v3、Jina v3/v4）写默认档。
  jina: {
    name: 'Jina AI',
    env: ['JINA_API_KEY'],
    doc: 'https://jina.ai/embeddings/',
    // v3/v4 是非对称检索模型：文档与查询用不同的 task 编码，
    // 少发那个参数不会报错，只是召回明显变差 —— 所以走 jina-embeddings 形状。
    models: {
      'jina-embeddings-v4': embedModel(
        'jina-embeddings-v4',
        'Jina Embeddings v4（多模态）',
        2048,
        'jina-embeddings'
      ),
      'jina-embeddings-v3': embedModel(
        'jina-embeddings-v3',
        'Jina Embeddings v3（多语言）',
        1024,
        'jina-embeddings'
      ),
      'jina-clip-v2': embedModel('jina-clip-v2', 'Jina CLIP v2（图文）', 1024, 'jina-embeddings')
    }
  },
  // ── 网页检索 ──
  // models.dev 根本不收这一类，三条全部手写。
  // 这里的「模型」是**去哪儿搜**，不是模型 —— 详见 src/shared/aiProvider.ts 的
  // ProviderKind 注释。
  'builtin-browser': {
    name: '内置浏览器',
    doc: 'https://github.com/unreal-box/unreal-box',
    models: {
      // 两家实测质量相当（6 个用例各命中 5 个），DuckDuckGo 在前是因为它给的是
      // 干净的目标地址，Bing 的链接包在 bing.com/ck/a 跳转壳里
      duckduckgo: { id: 'duckduckgo', name: 'DuckDuckGo（推荐）' },
      bing: { id: 'bing', name: 'Bing' }
    }
  },
  searxng: {
    name: 'SearXNG',
    doc: 'https://docs.searxng.org/admin/settings/settings_search.html',
    models: {
      // 实例把哪些上游引擎打开，是实例自己的配置，这里不该也不能替它决定
      'web-search': { id: 'web-search', name: '网页检索（用实例自己的引擎配置）' }
    }
  },
  'jina-search': {
    name: 'Jina AI',
    env: ['JINA_API_KEY'],
    doc: 'https://jina.ai/api-dashboard/key-manager',
    models: {
      // 只列**真的接了实现**的那条（`services/webSearch.ts` 打的是 s.jina.ai）。
      // 这里曾经还有一条 `deepsearch.jina.ai`「深度搜索（更慢更贵）」——
      // 它从来没有被任何代码读过：`searchViaJina` 根本不看 modelId，选它和选上面
      // 那条跑出来一模一样。而且 DeepSearch 返回的是一份研究报告，不是结果列表，
      // 塞进 `web_search` 的契约里本来就不成立。知识库的深度研究现在跑盒子自己的
      // 研究内核（`agent-v3/core/research/`），更不需要它。
      's.jina.ai': { id: 's.jina.ai', name: '网页搜索（s.jina.ai）' }
    }
  },
  'openai-embedding': {
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    doc: 'https://platform.openai.com/docs/guides/embeddings',
    models: {
      'text-embedding-3-small': embedModel(
        'text-embedding-3-small',
        'text-embedding-3-small（便宜）',
        1536
      ),
      'text-embedding-3-large': embedModel(
        'text-embedding-3-large',
        'text-embedding-3-large（更准）',
        3072
      )
    }
  },
  voyageai: {
    name: 'Voyage AI',
    env: ['VOYAGE_API_KEY'],
    doc: 'https://docs.voyageai.com/docs/embeddings',
    // Voyage 同样是非对称检索，参数名叫 input_type
    models: {
      'voyage-3.5': embedModel('voyage-3.5', 'Voyage 3.5', 1024, 'voyage-embeddings'),
      'voyage-3.5-lite': embedModel(
        'voyage-3.5-lite',
        'Voyage 3.5 Lite',
        1024,
        'voyage-embeddings'
      ),
      'voyage-code-3': embedModel(
        'voyage-code-3',
        'Voyage Code 3（代码）',
        1024,
        'voyage-embeddings'
      )
    }
  },
  'siliconflow-embedding': {
    name: '硅基流动 SiliconFlow',
    env: ['SILICONFLOW_API_KEY'],
    doc: 'https://docs.siliconflow.cn/cn/userguide/capabilities/embedding',
    models: {
      'BAAI/bge-m3': embedModel('BAAI/bge-m3', 'BGE-M3（多语言）', 1024),
      'Qwen/Qwen3-Embedding-8B': embedModel('Qwen/Qwen3-Embedding-8B', 'Qwen3 Embedding 8B', 4096),
      'Qwen/Qwen3-Embedding-0.6B': embedModel(
        'Qwen/Qwen3-Embedding-0.6B',
        'Qwen3 Embedding 0.6B（便宜）',
        1024
      )
    }
  },
  'alibaba-embedding': {
    name: '阿里云百炼',
    env: ['DASHSCOPE_API_KEY'],
    doc: 'https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api',
    models: {
      'text-embedding-v4': embedModel('text-embedding-v4', 'text-embedding-v4', 1024),
      'text-embedding-v3': embedModel('text-embedding-v3', 'text-embedding-v3', 1024)
    }
  },
  'zhipuai-embedding': {
    name: '智谱',
    env: ['ZHIPUAI_API_KEY'],
    doc: 'https://docs.bigmodel.cn/cn/guide/models/vector/embedding-3',
    models: {
      'embedding-3': embedModel('embedding-3', 'Embedding-3', 2048),
      'embedding-2': embedModel('embedding-2', 'Embedding-2', 1024)
    }
  },

  // ── 3D 生成 ──
  // models.dev 完全不收这一类，三家全部手写。
  // 模型 id 就是各家的档位/版本名，2026-09 逐一对着官方文档核对过。
  hyper3d: {
    name: 'Hyper3D',
    env: ['HYPER3D_API_KEY'],
    doc: 'https://docs.hyper3d.ai/en/get-started/quick-start',
    // Rodin 管模型叫 tier，直接发在 `tier` 字段里
    models: {
      'Gen-2': model3d('Gen-2', 'Rodin Gen-2', 'rodin'),
      'Gen-2.5-Medium': model3d('Gen-2.5-Medium', 'Rodin Gen-2.5 Medium', 'rodin'),
      'Gen-2.5-Low': model3d('Gen-2.5-Low', 'Rodin Gen-2.5 Low（便宜）', 'rodin')
    }
  },
  tripo: {
    name: 'Tripo',
    env: ['TRIPO_API_KEY'],
    doc: 'https://developers.tripo3d.ai/en/docs/quick-start',
    /*
     * 这里给的是 **V3** 的版本号（发在 `model` 字段）。V2 的 v2.5-20250123
     * 不列：它的端点 2026-11-01 就关停了，摆在下拉里只会让人选到一条死路。
     *
     * Tripo 分两个系列，**共用同一条端点**、只靠这个 `model` 值区分，
     * 但面数量级差 75 倍（H 到 150 万，P 上限 2 万）。名字里写清是哪一系，
     * 否则用户按名字挑不出区别 —— 而挑错的表现是「精度选了主角档，
     * 拿回来一个两万面的东西」，账照扣。换算见 model3d.ts 的两张表。
     */
    models: {
      'v3.1-20260211': model3d('v3.1-20260211', 'Tripo v3.1（H 系列 · 高精度）', 'tripo'),
      'v3.0-20250812': model3d('v3.0-20250812', 'Tripo v3.0（H 系列 · 稳定版）', 'tripo'),
      'P1-20260311': model3d('P1-20260311', 'Tripo P1（P 系列 · 低面数干净拓扑）', 'tripo')
    }
  },
  meshy: {
    name: 'Meshy',
    env: ['MESHY_API_KEY'],
    doc: 'https://docs.meshy.ai/en/api/image-to-3d',
    // 发在 `ai_model` 字段。`latest` 目前指向 meshy-7，但它是**会漂的**别名 ——
    // 想要可复现的结果就选具体版本号
    models: {
      latest: model3d('latest', 'Meshy 最新版（随官方更新）', 'meshy'),
      'meshy-7': model3d('meshy-7', 'Meshy 7', 'meshy'),
      'meshy-6': model3d('meshy-6', 'Meshy 6', 'meshy'),
      'meshy-5': model3d('meshy-5', 'Meshy 5', 'meshy')
    }
  },

  /**
   * 实时语音两家。
   *
   * 「模型」在这一类里是**会话版本号**而不是模型名：豆包全双工固定 `1.2.6.1`，
   * 官方明确说不要再走 extension 选路。OpenAI 那边才是真的模型名。
   */
  'openai-realtime': {
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    doc: 'https://developers.openai.com/api/docs/guides/realtime',
    models: {
      'gpt-realtime': realtimeModel('gpt-realtime', 'GPT Realtime（稳定别名）', 'marin'),
      'gpt-realtime-2.1': realtimeModel('gpt-realtime-2.1', 'GPT Realtime 2.1', 'marin')
    }
  },
  'elevenlabs-music': {
    name: 'ElevenLabs Music',
    env: ['ELEVENLABS_API_KEY'],
    doc: 'https://elevenlabs.io/docs/api-reference/music/compose',
    models: { music_v2: { id: 'music_v2', name: 'Eleven Music v2' } }
  },
  'mureka-music': {
    name: 'Mureka',
    env: ['MUREKA_API_KEY'],
    doc: 'https://platform.mureka.ai/docs/',
    models: { auto: { id: 'auto', name: 'Mureka Auto' } }
  },
  'sunoapi-music': {
    name: 'SUNO (SunoAPI.org)',
    env: ['SUNOAPI_API_KEY'],
    doc: 'https://docs.sunoapi.org/suno-api/generate-music',
    models: {
      V6: { id: 'V6', name: 'SUNO V6' },
      V6_WILD: { id: 'V6_WILD', name: 'SUNO V6 Wild' },
      V6_MINI: { id: 'V6_MINI', name: 'SUNO V6 Mini' }
    }
  },
  'alibaba-tts': {
    name: '阿里云 Qwen-Audio 3.0 语音合成',
    env: ['DASHSCOPE_API_KEY'],
    doc: 'https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api',
    models: {
      'qwen-audio-3.0-tts-plus': {
        id: 'qwen-audio-3.0-tts-plus',
        name: 'Qwen-Audio 3.0 TTS Plus',
        ttsVoice: 'longanlingxin'
      },
      'qwen-audio-3.0-tts-flash': {
        id: 'qwen-audio-3.0-tts-flash',
        name: 'Qwen-Audio 3.0 TTS Flash',
        ttsVoice: 'longanfengyue'
      }
    }
  },
  'doubao-tts': {
    name: '豆包语音合成 TTS 2.0',
    env: ['VOLCENGINE_SPEECH_KEY'],
    models: {
      'seed-tts-2.0': {
        id: 'seed-tts-2.0',
        name: '豆包 TTS 2.0',
        ttsVoice: 'zh_female_vv_uranus_bigtts'
      }
    }
  },
  'doubao-realtime': {
    name: '豆包实时语音',
    env: ['VOLCENGINE_SPEECH_KEY'],
    doc: 'https://www.volcengine.com/docs/6561/1594356',
    models: {
      '1.2.6.1': {
        ...realtimeModel('1.2.6.1', '豆包 Seeduplex 3.0（全双工）'),
        realtimeVoice: 'zh_female_vv_jupiter_bigtts'
      }
    }
  },

  litellm: { name: 'LiteLLM', env: ['LITELLM_API_KEY'], models: {} },
  'one-api': { name: 'One API', env: ['ONE_API_KEY'], models: {} },
  llamacpp: { name: 'llama.cpp', env: [], models: {} },
  ollama: { name: 'Ollama', env: [], models: {} },
  /**
   * 本机向量化。**完全离线、零成本**的那条路。
   *
   * 与 `ollama` 分成两条，是照着 openai / openai-embedding 的既有约定走：
   * 同一个地址、不同能力各占一条，界面按 group 分区显示，角色下拉里也不会
   * 把对话模型和向量化模型混在一起。
   *
   * 目录里不给这几个名字的话，这条路对用户等于不存在 —— 他得先知道
   * `ollama pull nomic-embed-text` 这件事，再手打模型 id，而打错不报错。
   */
  'ollama-embedding': {
    name: 'Ollama',
    env: [],
    doc: 'https://ollama.com/search?c=embedding',
    models: {
      'bge-m3': embedModel('bge-m3', 'BGE-M3（多语言，中文推荐）', 1024),
      'nomic-embed-text': embedModel('nomic-embed-text', 'nomic-embed-text（英文，最轻）', 768),
      'mxbai-embed-large': embedModel('mxbai-embed-large', 'mxbai-embed-large', 1024),
      'qwen3-embedding': embedModel('qwen3-embedding', 'Qwen3 Embedding', 1024)
    }
  },
  baidu: {
    name: '百度千帆（文心）',
    env: ['QIANFAN_API_KEY'],
    doc: 'https://console.bce.baidu.com/qianfan/',
    models: {
      // Official route capabilities: https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j
      // Function calling: https://cloud.baidu.com/doc/qianfan-docs/s/xm95lyys5
      'ernie-5.1': model(
        'ernie-5.1',
        'ERNIE 5.1',
        false,
        true,
        { context: 131_072, output: 65_536 },
        false,
        { release_date: '2026-05-08' }
      ),
      'ernie-5.0': model(
        'ernie-5.0',
        'ERNIE 5.0',
        true,
        true,
        { context: 131_072, output: 65_536 },
        true,
        { release_date: '2026-01-22' }
      )
    }
  },
  chatgpt: {
    name: 'ChatGPT Plus / Pro',
    env: [],
    doc: 'https://developers.openai.com/codex/auth',
    // Codex 后端**没有** `/models` 接口，「导入模型」在这一家用不了 ——
    // 所以清单不能留空，否则用户登录成功后面对的是一个没有任何模型的
    // Provider，只能去别处翻型号名再手打。清单会随官方节奏过期，
    // 但那时用户仍然可以手填，代价远小于一个空清单。
    // 型号取自 pi-ai 的 openai-codex 目录（同一批订阅模型）。这一家**全是推理
    // 模型**，所以最后那个参数一律为 true —— 少了它输入框里的「思考程度」
    // 对 ChatGPT 订阅完全不起作用。
    models: {
      'gpt-6-astra': model('gpt-6-astra', 'GPT-6 Astra', true, true, CODEX_LIMIT, true, {
        release_date: '2026-09-04'
      }),
      'gpt-5.6-sol': model('gpt-5.6-sol', 'GPT-5.6 Sol', true, true, CODEX_LIMIT, true, {
        release_date: '2026-07-09'
      }),
      'gpt-5.6-terra': model('gpt-5.6-terra', 'GPT-5.6 Terra', true, true, CODEX_LIMIT, true, {
        release_date: '2026-07-09'
      }),
      'gpt-5.6-luna': model('gpt-5.6-luna', 'GPT-5.6 Luna', true, true, CODEX_LIMIT, true, {
        release_date: '2026-07-09'
      }),
      'gpt-5.5': model('gpt-5.5', 'GPT-5.5', true, true, CODEX_LIMIT, true, {
        release_date: '2026-04-23'
      }),
      'gpt-5.4': model('gpt-5.4', 'GPT-5.4', true, true, CODEX_LIMIT, true, {
        release_date: '2026-03-05'
      }),
      'gpt-5.4-mini': model('gpt-5.4-mini', 'GPT-5.4 mini', true, true, CODEX_LIMIT, true, {
        release_date: '2026-03-17'
      }),
      'gpt-5.3-codex-spark': model(
        'gpt-5.3-codex-spark',
        'GPT-5.3 Codex Spark',
        false,
        true,
        { context: 128_000, output: 128_000 },
        true,
        { release_date: '2026-02-12' }
      )
    }
  },
  /**
   * 生图条目一律手写，不从 models.dev 取。
   *
   * 上游对生图的收录既零散又自相矛盾：204 家里只有 openai 和 xai 有像样的条目，
   * 而 openai 那几条的模态位是错的（gpt-image-1.5 被标成「输出文本」，
   * gpt-image-1 又标成「输出图片」，同一系列两种写法）。照它生成会得到一份
   * 一半模型缺失、另一半被当成对话模型的清单 —— 那比没有清单更坏。
   *
   * 下面每一条的接口路径与 model id 都在 2026-08 逐一核对过厂商文档。
   */
  'openai-image': {
    name: 'OpenAI GPT Image',
    env: ['OPENAI_API_KEY'],
    doc: 'https://platform.openai.com/docs/guides/image-generation',
    // 只留当前这一代。1.5 / 1 / 1-mini 都还能调，但预置清单是「开箱推荐」不是
    // 型号大全 —— 摆四个只差版本号的选项，用户唯一能做的判断是「数字大的比较新」。
    // 真要用旧型号，Provider 详情里手填或「导入模型」都拿得到。
    models: {
      'gpt-image-2': imageModel('gpt-image-2', 'GPT Image 2', 'gpt-images')
    }
  },
  'google-image': {
    name: 'Google Nano Banana',
    env: ['GEMINI_API_KEY'],
    doc: 'https://ai.google.dev/gemini-api/docs/image-generation',
    // 走 Interactions API（gemini-images），不是 /images/generations。
    // 只有这一档支持参考图接着改，也只有这一档一次出一张 ——
    // 界面上选的张数在这一家不生效。
    //
    // 型号名全是「Nano Banana」，版本靠 id 区分，所以显示名带上代号，
    // 免得下拉里三条长得一模一样。2.5 那一代（初代 Nano Banana）不预置：
    // 官方已建议迁走，真要用手填 id 即可。
    models: {
      'gemini-3.1-flash-image': imageModel(
        'gemini-3.1-flash-image',
        'Nano Banana 2',
        'gemini-images'
      ),
      'gemini-3.1-flash-lite-image': imageModel(
        'gemini-3.1-flash-lite-image',
        'Nano Banana 2 Lite（仅 1K）',
        'gemini-images'
      ),
      'gemini-3-pro-image': imageModel('gemini-3-pro-image', 'Nano Banana Pro', 'gemini-images')
    }
  },
  'xai-image': {
    name: 'xAI Grok Imagine',
    env: ['XAI_API_KEY'],
    doc: 'https://docs.x.ai/developers/model-capabilities/images/generation',
    // 官方文档用的是带版本号的 id。裸的 `grok-imagine-image` 是 fal / AIML 这类
    // 聚合平台的命名，直接打 api.x.ai 会 404。
    // 另外 xAI 不认 size / quality / style，比例只能用它自己的参数 ——
    // 界面上选的分辨率在这一家不生效，出图是模型的默认尺寸。
    models: {
      'grok-imagine-image-2.0': imageModel(
        'grok-imagine-image-2.0',
        'Grok Imagine Image 2.0',
        'grok-images'
      ),
      'grok-imagine-image-quality': imageModel(
        'grok-imagine-image-quality',
        'Grok Imagine Image Quality',
        'grok-images'
      )
    }
  },
  'ark-seedream': {
    name: '火山方舟 Seedream',
    env: ['ARK_API_KEY'],
    doc: 'https://www.volcengine.com/docs/82379/1541523',
    models: {
      // ark-images 而不是 openai-images：方舟没有 /images/edits，参考图内联在 image 里
      'doubao-seedream-5-0-260128': imageModel(
        'doubao-seedream-5-0-260128',
        'Seedream 5.0',
        'ark-images'
      ),
      'doubao-seedream-4-5-251128': imageModel(
        'doubao-seedream-4-5-251128',
        'Seedream 4.5',
        'ark-images'
      ),
      'doubao-seedream-4-0-250828': imageModel(
        'doubao-seedream-4-0-250828',
        'Seedream 4.0',
        'ark-images'
      )
    }
  },
  'siliconflow-image': {
    name: '硅基流动 SiliconFlow',
    env: ['SILICONFLOW_API_KEY'],
    doc: 'https://docs.siliconflow.cn/cn/userguide/capabilities/images',
    // 这一家的请求体也是自己一套（image_size / batch_size，而不是 size / n），
    // 界面上选的分辨率和张数在这里不生效，出的是模型默认尺寸的单图。
    // 返回体是 `images[].url`，靠 imageGeneration.ts 的响应归一化转成 base64。
    models: {
      'Qwen/Qwen-Image': imageModel('Qwen/Qwen-Image', 'Qwen Image', 'siliconflow-images'),
      'Qwen/Qwen-Image-Edit-2509': imageModel(
        'Qwen/Qwen-Image-Edit-2509',
        'Qwen Image Edit',
        'siliconflow-images'
      ),
      'Kwai-Kolors/Kolors': imageModel('Kwai-Kolors/Kolors', 'Kolors 可图', 'siliconflow-images')
    }
  },
  'zhipuai-image': {
    name: '智谱 CogView',
    env: ['ZHIPUAI_API_KEY'],
    doc: 'https://docs.bigmodel.cn/',
    // 同样返回 `data[].url`，走响应归一化。cogview-3-flash 是免费档，
    // 放在清单里让人可以零成本先试通链路。
    models: {
      'cogview-4': imageModel('cogview-4', 'CogView-4'),
      'cogview-4-250304': imageModel('cogview-4-250304', 'CogView-4 (250304)'),
      'cogview-3-flash': imageModel('cogview-3-flash', 'CogView-3 Flash（免费）')
    }
  },
  'togetherai-image': {
    name: 'Together AI',
    env: ['TOGETHER_API_KEY'],
    doc: 'https://docs.together.ai/docs/images-overview',
    models: {
      'black-forest-labs/FLUX.1-schnell-Free': imageModel(
        'black-forest-labs/FLUX.1-schnell-Free',
        'FLUX.1 schnell（免费）'
      ),
      'black-forest-labs/FLUX.1-schnell': imageModel(
        'black-forest-labs/FLUX.1-schnell',
        'FLUX.1 schnell'
      ),
      'black-forest-labs/FLUX.1-dev': imageModel('black-forest-labs/FLUX.1-dev', 'FLUX.1 dev')
    }
  },
  infini: {
    name: '无问芯穹 Infini-AI',
    env: ['INFINI_API_KEY'],
    doc: 'https://cloud.infini-ai.com/',
    models: {}
  }
}

/** 目录分组 → Provider 用途。按能力分的那几组一一对应，其余都是对话 */
const GROUP_KIND = {
  image: 'image',
  embedding: 'embedding',
  video: 'video',
  model3d: 'model3d',
  realtime: 'realtime',
  tts: 'tts',
  music: 'music',
  search: 'search'
}

const isCheck = process.argv.includes('--check')

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`拉取 ${url} 失败：HTTP ${res.status}`)
  return res.json()
}

/**
 * 生图分组的预置模型。
 *
 * 判据与对话模型**完全不共用**：没有上下文窗口、不调工具，发布日期也不该拿来卡
 * （gpt-image-1 是 2025 年的，至今仍是 OpenAI 生图的主力档）。这些条目全部
 * 手写在 MANUAL_ENTRIES 里，所以这里只做形状转换，不做筛选 ——
 * 该筛的在写清单的时候就筛完了。
 */
function pickImageModels(models) {
  return Object.values(models)
    .slice(0, MAX_MODELS_PER_PROVIDER)
    .map((item) => ({
      id: item.id,
      displayName: item.name || item.id,
      // 形状这一位仍留在模型上：OpenAI 同一个 /v1 下 gpt-image-1 与 dall-e-3
      // 是两种形状，生图是唯一存在这种情况的模态
      imageApi: item.api
    }))
}

/**
 * 向量化分组的预置模型。
 *
 * 与 pickImageModels 同理：全部手写在 MANUAL_ENTRIES 里，这里只做形状转换。
 */
function pickEmbeddingModels(models) {
  return Object.values(models)
    .slice(0, MAX_MODELS_PER_PROVIDER)
    .map((item) => ({
      id: item.id,
      displayName: item.name || item.id,
      embeddingApi: item.api,
      embeddingDimensions: item.dim
    }))
}

/**
 * 3D 分组的预置模型。
 *
 * 与上面三个同理：全部手写在 MANUAL_ENTRIES 里，这里只做形状转换。
 *
 * `model3dApi` 这一位**不能省也不能猜**：三家的提交/轮询/取文件三段各不相同，
 * 漏了的话清单是满的，但那个模型发出去只会得到一串 404 —— 而 404 看上去像
 * Base URL 填错了，用户会去反复改地址。
 */
function pickModel3dModels(models) {
  return Object.values(models)
    .slice(0, MAX_MODELS_PER_PROVIDER)
    .map((item) => ({
      id: item.id,
      displayName: item.name || item.id
    }))
}

/**
 * 检索分组的预置模型。
 *
 * 这一组的「模型」只有 id 和显示名 —— 没有维度、没有接口形状、没有能力位，
 * 因为它表示的是**去哪儿搜**，不是一个会推理的东西。
 * 详见 `src/shared/aiProvider.ts` 里 ProviderKind 的 `search` 注释。
 */
function pickSearchModels(models) {
  return Object.values(models).map((item) => ({ id: item.id, displayName: item.name || item.id }))
}

/**
 * 视频分组的预置模型。
 *
 * 与 3D 同理只做形状转换。`videoApi` 不在这里 —— 它是 **Provider 级**的，
 * 写在 CURATED 条目上（同一家不可能有两种视频接口形状）。
 */
function pickVideoModels(models) {
  return Object.values(models)
    .slice(0, MAX_MODELS_PER_PROVIDER)
    .map((item) => ({
      id: item.id,
      displayName: item.name || item.id
    }))
}

/**
 * 实时语音分组的预置模型。
 *
 * 只做形状转换。能力位必须显式写：角色下拉只认这一位，普通对话模型不会因为
 * “看起来可能支持语音”就被猜进来；反方向也会把实时模型从对话角色里排除。
 */
function pickRealtimeModels(models) {
  return Object.values(models)
    .slice(0, MAX_MODELS_PER_PROVIDER)
    .map((item) => ({
      id: item.id,
      displayName: item.name || item.id,
      ...(item.realtimeVoice ? { realtimeVoice: item.realtimeVoice } : {})
    }))
}

/**
 * 思考档位的逐模型覆盖表 —— 只写「上游和内核都给不对」的那几条。
 *
 * ## 为什么需要它
 *
 * 档位阶梯有两个来源：models.dev（上游，**根本没有这一位**）和 pi 自带目录
 * （随包发的快照，按 `(provider id, model id)` 对齐）。绝大多数模型靠 pi 那份
 * 就够了，不用写在这里 —— 见 `piModel.ts` 的 `thinkingLevelMapFor`。
 *
 * 三种「靠不上」的情况才落到这张表：
 *
 * 1. **pi 快照还没收录的新型号** —— Claude Fable 5.1、不带后缀的 `gpt-5.6`
 * 2. **provider id 对不上** —— ChatGPT 订阅那条我们叫 `chatgpt`，
 *    pi 那份挂在 `openai-codex` 下，按 id 对齐时整家都查不到
 * 3. **pi 压根没收这家** —— 智谱直连（`zhipuai`，bigmodel.cn）；
 *    pi 只有 z.ai 那条国际版
 *
 * 漏一条的表现不是报错，是**最高档静默失效**：`getSupportedThinkingLevels`
 * 对 `xhigh` / `max` 采取白名单制（没写就当不存在），于是这几家的下拉框一律
 * 停在 high，而厂商文档里明明还有更高的档。
 *
 * ## 怎么读这张表
 *
 * `thinking` 就是档位阶梯：键不存在＝没说（按内核缺省列出来），`null` ＝
 * **这一档不存在**，字符串 ＝ 存在，且请求里发这个词。
 * `adaptive` 只对 Anthropic 有意义，见 `ModelConfig.adaptiveThinking`。
 *
 * **不要按型号名推广**。同一代里 `xhigh` 和 `max` 常常只有一半型号有
 * （GPT-5.5 有 xhigh 没有 max；Sonnet 4.6 有 max 没有 xhigh），
 * 猜错的代价是一次来自厂商的 400，而报错看着像模型名写错了。
 *
 * 2026-09-03 逐家照官方文档核对：
 * - OpenAI：https://developers.openai.com/api/docs/models/ 逐个型号页的
 *   「Reasoning.effort supports」一行
 * - Anthropic：https://platform.claude.com/docs/en/build-with-claude/effort
 *   的 Effort levels 表（`max` 与 `xhigh` 的支持清单不是同一份）
 * - 智谱：https://docs.bigmodel.cn/cn/guide/start/concept-param
 */
const THINKING_OVERRIDES = {
  /*
   * OpenAI 直连。带后缀的三个型号 pi 目录里有，这里只补不带后缀的那个。
   * GPT-5.6 全系没有 `minimal` 这一档（官方那行是 none / low / medium /
   * high / xhigh / max），所以显式写成不存在。
   */
  openai: {
    // https://developers.openai.com/api/docs/models/gpt-6-astra (2026-09-16)
    'gpt-6-astra': { thinking: { minimal: null, xhigh: 'xhigh', max: 'max' } },
    'gpt-5.6': {
      thinking: {
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max'
      }
    }
  },

  /*
   * ChatGPT 订阅（Codex 那条 responses 路）。型号与 OpenAI 直连同源，
   * 但 provider id 对不上 pi 的 `openai-codex`，整家拿不到阶梯。
   *
   * `max` 只有 5.6 那一代有；5.5 / 5.4 / codex-spark 到 xhigh 为止 ——
   * 显式写 `null` 而不是省略，是为了让「这一档查过了、确实没有」和
   * 「还没查」在这张表里长得不一样。
   */
  chatgpt: {
    'gpt-6-astra': { thinking: { minimal: null, xhigh: 'xhigh', max: 'max' } },
    'gpt-5.6-sol': { thinking: { minimal: null, xhigh: 'xhigh', max: 'max' } },
    'gpt-5.6-terra': { thinking: { minimal: null, xhigh: 'xhigh', max: 'max' } },
    'gpt-5.6-luna': { thinking: { minimal: null, xhigh: 'xhigh', max: 'max' } },
    'gpt-5.5': { thinking: { minimal: null, xhigh: 'xhigh', max: null } },
    'gpt-5.4': { thinking: { minimal: null, xhigh: 'xhigh', max: null } },
    'gpt-5.4-mini': { thinking: { minimal: null, xhigh: 'xhigh', max: null } },
    'gpt-5.3-codex-spark': { thinking: { minimal: null, xhigh: 'xhigh', max: null } }
  },

  /*
   * Anthropic 直连。4.6 及以后的型号 pi 目录里都有（阶梯和 adaptive 位都对得上
   * 官方那张表），只有 Fable 5.1 比快照新。
   *
   * `adaptive` 与 `thinking` 必须成对写：少了前者请求走老式思考预算，
   * 而那条路把 xhigh 和 max 一起夹成 high —— 档位列出来了，发出去还是 high。
   */
  anthropic: {
    'claude-fable-5-1': { adaptive: true, thinking: { xhigh: 'xhigh', max: 'max' } }
  },

  // 2026-09-16: https://api-docs.deepseek.com/guides/thinking_mode/
  // Flash 4.1 已有独立 low 档；不把旧实验版的档位沿用给新模型。
  deepseek: {
    'deepseek-flash': {
      thinking: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }
    }
  },

  xai: {
    // https://docs.x.ai/developers/grok-4-6
    'grok-4.6': { thinking: { minimal: null, xhigh: 'xhigh', max: null } }
  },

  // Preserve the verified effort constraints when these manual entries move upstream.
  // https://www.volcengine.com/docs/82379/2121998
  bytedance: {
    'doubao-seed-2-0-pro-260215': { thinking: { xhigh: null, max: null } },
    'doubao-seed-2-0-code-preview-260215': { thinking: { xhigh: null, max: null } }
  },

  /*
   * 智谱直连（bigmodel.cn）。pi 只收了 z.ai 那条国际版，id 对不上。
   *
   * 5.3 全系是 low / high / max 三档，中间那两档不存在；5.2 更少，
   * 官方明写 low 和 medium 都会被映射成 high、xhigh 会被映射成 max ——
   * 那就不是独立的档位，列出来只会让人以为调了有用。
   */
  zhipuai: {
    'glm-5.3': {
      thinking: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }
    },
    'glm-5.3-flash': {
      thinking: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }
    },
    'glm-5.2': {
      thinking: { minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' }
    }
  }
}

/** Official corrections apply only to the named provider route (checked 2026-09-16). */
const MODEL_OVERRIDES = {
  deepseek: {
    // https://api-docs.deepseek.com/quick_start/pricing/
    'deepseek-v4-flash': { isCompatibilityAlias: true },
    'deepseek-v4-flash-vision-exp': { isCompatibilityAlias: true },
    // The API reference spells out 384K as 393216, unlike models.dev's 384000.
    // https://api-docs.deepseek.com/api/create-chat-completion/
    'deepseek-flash': {
      name: 'DeepSeek V4.1 Flash',
      limit: { context: 1_000_000, output: 393_216 }
    },
    'deepseek-v4-pro': { limit: { context: 1_000_000, output: 393_216 } }
  },
  xai: {
    // No separate text output ceiling; never copy the context window into this field.
    // https://docs.x.ai/developers/grok-4-6
    'grok-4.6': { limit: { context: 500_000 } }
  }
}

/** Keep stable app provider IDs while reading metadata for the exact configured route. */
export function sourceFor(item, upstream) {
  const source = upstream[item.sourceId || item.id] || MANUAL_ENTRIES[item.id]
  if (!source) return undefined
  if (item.id !== 'bytedance') return source
  return {
    ...source,
    // This entry is the Doubao catalog; third-party Ark routes have their own providers.
    models: Object.fromEntries(
      Object.entries(source.models).filter(([id]) => id.startsWith('doubao-seed-'))
    )
  }
}

/** 挑出要预置的模型：按发布日期倒序，优先保留支持工具调用的 */
export function pickModels(models, providerId) {
  // 只要**能输出文本**的。上游把画图、视频、语音合成和对话模型混在一起
  // （grok-imagine-image、Nano Banana Pro、lyria、*-tts…），它们在这个应用里
  // 一个都用不了 —— 绑上去只会拿到一句厂商的报错。而且它们发布得晚，
  // 按日期排序时会把真正能用的对话模型挤出预置清单。
  // 没有 modalities 字段的留着：判断不了，不该替上游做减法。
  const all = Object.values(models)
    .map((m) => ({
      ...m,
      ...MODEL_OVERRIDES[providerId]?.[m.id]
    }))
    .filter((m) => {
      const output = m.modalities?.output
      // Mixed image/audio output belongs to a dedicated adapter, not a chat provider.
      return !Array.isArray(output) || (output.length === 1 && output[0] === 'text')
    })

  // 窗口小到装不下系统提示词 + 工具定义的，在这个应用里根本跑不起来。
  // 上游把一批**分类器**混在对话模型里（Llama Prompt Guard 是个 512 token 的
  // 注入检测器，输出也是文本，靠模态筛不掉），它们只会让人选错。
  // 没有 limit 的留着 —— 判断不了，不该替上游做减法。
  const usable = all.filter((m) => {
    const context = positiveInt(m.limit?.context)
    return context === undefined || context >= MIN_CONTEXT_WINDOW
  })

  // Unknown dates, retired routes and compatibility aliases must not bypass the year filter.
  const fresh = usable.filter((m) => {
    const date = m.release_date
    return (
      typeof date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      date >= MIN_RELEASE_DATE &&
      date < MAX_RELEASE_DATE &&
      !['deprecated', 'retired'].includes(m.status) &&
      !m.isCompatibilityAlias
    )
  })
  if (fresh.length === 0 && usable.length > 0) staleProviders.push(providerId)

  return fresh
    .sort((a, b) => {
      // 能调工具的排前面 —— Agent 全靠它，纯对话模型预置了也当不了主力
      if (Boolean(a.tool_call) !== Boolean(b.tool_call)) return a.tool_call ? -1 : 1
      return String(b.release_date || '').localeCompare(String(a.release_date || ''))
    })
    .slice(0, MAX_MODELS_PER_PROVIDER)
    .map((model) => ({
      id: model.id,
      displayName: model.name || model.id,
      // Attachment may mean PDF/audio; only explicit image input establishes vision.
      ...(Array.isArray(model.modalities?.input)
        ? { supportsVision: model.modalities.input.includes('image') }
        : {}),
      ...(model.modalities?.input?.includes('video') ? { supportsVideo: true } : {}),
      ...(typeof model.tool_call === 'boolean' ? { supportsTools: model.tool_call } : {}),
      // OpenAI 的通用 Provider 也会从 models.dev 带回这个型号，不能逼用户再加一条
      // 同厂商 Provider 才能语音。只认已经接通过的明确型号，不按前缀猜。
      // 上游的 reasoning 位。带上它，输入框里的「思考程度」才知道对谁有效 ——
      // 漏了的话用户调了档位却毫无变化，也不会有任何提示。
      ...(typeof model.reasoning === 'boolean' ? { supportsReasoning: model.reasoning } : {}),
      /*
       * 档位阶梯。两个来源：手写条目自带的（上游没有这一位），以及
       * THINKING_OVERRIDES 里按 (provider, model) 覆盖的那几条。
       *
       * 缺了它，界面会把内核认识的六档全列出来 —— 而豆包只认
       * minimal/low/medium/high 四档，用户选到 `max` 就是一次 400。
       * `null` 表示「这一档不存在」，与「没写」是两回事，所以原样带过去。
       *
       * 覆盖表排在后面：手写条目和覆盖表撞车时以覆盖表为准，因为那张表
       * 注明了核对日期和文档出处，比散落在各家清单里的字面量更好追。
       */
      ...thinkingBitsFor(providerId, model),
      // 上游的 limit 是各家官方公布的窗口。带上它，Agent 才能按模型真实的
      // 窗口决定何时压缩，而不是所有模型一律按一个写死的缺省值。
      // 上游没给就不写字段（而不是写 0）—— 让运行时明确回落到缺省值。
      ...(positiveInt(model.limit?.context)
        ? { contextWindow: positiveInt(model.limit.context) }
        : {}),
      ...(positiveInt(model.limit?.output)
        ? { maxOutputTokens: positiveInt(model.limit.output) }
        : {})
    }))
}

/**
 * 一条模型该带哪几个「思考」字段。
 *
 * 两个来源合并：手写条目自带的 `thinking`，以及 THINKING_OVERRIDES 里
 * 按 (provider id, model id) 命中的那条。都没有就什么都不写 —— 空对象和
 * 「没写」在 `getSupportedThinkingLevels` 眼里不是一回事。
 */
function thinkingBitsFor(providerId, model) {
  const override = THINKING_OVERRIDES[providerId]?.[model.id]
  const thinking = override?.thinking ?? model.thinking
  return {
    ...(thinking ? { thinkingLevelMap: thinking } : {}),
    ...(override?.adaptive ? { adaptiveThinking: true } : {})
  }
}

/** 上游偶尔把 limit 写成字符串或 0，只认正整数 */
function positiveInt(value) {
  const num = typeof value === 'string' ? Number(value) : value
  return typeof num === 'number' && Number.isFinite(num) && num >= 1 ? Math.floor(num) : undefined
}

/**
 * 压根没有品牌标的条目。
 *
 * 图标站对**认不出的 id 不返回 404，而是回一张通用占位图** —— 照单全收的话，
 * 这几条会各存一份一模一样的 svg，界面上是三家共用同一张脸，而 `hasLogo: true`
 * 还在声称它们有自己的标。内置浏览器和自建 SearXNG 本来就不是厂商，直接说没有。
 */
const NO_LOGO = new Set([
  'elevenlabs-music',
  'mureka-music',
  'sunoapi-music',
  'builtin-browser',
  'searxng'
])

async function downloadLogo(id, aliasOf) {
  if (NO_LOGO.has(id)) return false
  try {
    const res = await fetch(LOGO_URL(aliasOf || id))
    if (!res.ok) return false
    const svg = await res.text()
    // 只收真正的 SVG，站点 404 时可能回一个 HTML 页面
    if (!svg.trimStart().startsWith('<svg')) return false
    writeFileSync(join(LOGO_DIR, `${id}.svg`), svg, 'utf-8')
    return true
  } catch {
    return false
  }
}

async function main() {
  // Update a manual adapter without refreshing unrelated provider snapshots.
  const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7)
  if (only && CURATED.some((item) => item.id === only) && !MANUAL_ENTRIES[only]) {
    throw new Error('--only requires a curated manual provider ID')
  }
  const dataFile = process.argv.find((arg) => arg.startsWith('--data='))?.slice(7)
  const upstream = only
    ? {}
    : dataFile
      ? JSON.parse(readFileSync(dataFile, 'utf-8'))
      : await fetchJson(API_URL)
  const skipLogos = process.argv.includes('--skip-logos')
  if (!existsSync(LOGO_DIR)) mkdirSync(LOGO_DIR, { recursive: true })

  const entries = []
  const missing = []
  const noLogo = []

  for (const item of CURATED.filter((item) => !only || item.id === only)) {
    const source = sourceFor(item, upstream)
    if (!source) {
      missing.push(item.id)
      continue
    }

    const protocol = item.protocol || NPM_TO_PROTOCOL[source.npm] || 'openai-completions'
    const models =
      item.group === 'tts' || item.group === 'music'
        ? Object.values(source.models).map((model) => ({
            id: model.id,
            displayName: model.name,
            ttsVoice: model.ttsVoice
          }))
        : !source.models
          ? []
          : item.group === 'image'
            ? pickImageModels(source.models)
            : item.group === 'embedding'
              ? pickEmbeddingModels(source.models)
              : item.group === 'model3d'
                ? pickModel3dModels(source.models)
                : item.group === 'realtime'
                  ? pickRealtimeModels(source.models)
                  : item.group === 'video'
                    ? pickVideoModels(source.models)
                    : item.group === 'search'
                      ? pickSearchModels(source.models)
                      : pickModels(source.models, item.id)
    const hasLogo = skipLogos
      ? existsSync(join(LOGO_DIR, `${item.id}.svg`))
      : isCheck
        ? true
        : await downloadLogo(item.id, LOGO_ALIAS[item.id])
    if (!hasLogo) noLogo.push(item.id)

    entries.push({
      id: item.id,
      displayName: item.displayName || source.name || item.id,
      group: item.group,
      // 用途。目录里按能力分的那几组（image/embedding/video/model3d/realtime）
      // 与 kind 一一对应；其余几组是按「从哪儿买算力」分的，全是对话
      kind: GROUP_KIND[item.group] || 'chat',
      model3dApi: item.model3dApi,
      videoApi: item.videoApi,
      musicApi: item.musicApi,
      protocol,
      baseUrl: item.baseUrl,
      apiKeyUrl: KEY_PAGE[item.id] || source.doc,
      requiresApiKey: item.requiresApiKey !== false,
      defaultEnvVar: (source.env || [])[0],
      hasLogo,
      supportsOAuth: item.supportsOAuth || undefined,
      models
    })
  }

  if (missing.length > 0) {
    console.error(`✖ 这些 id 在 models.dev 里找不到了，请更新精选清单：${missing.join(', ')}`)
    process.exit(1)
  }

  if (staleProviders.length > 0) {
    console.warn(
      `⚠ 这些厂商没有符合 2026 年筛选条件的模型，预置清单留空（仍可导入或手填）：` +
        staleProviders.join(', ')
    )
  }

  const totalModels = entries.reduce((sum, entry) => sum + entry.models.length, 0)

  if (isCheck) {
    console.log(`目录可生成：${entries.length} 家厂商 / ${totalModels} 个预置模型。`)
    return
  }

  const banner = `/* eslint-disable */
/**
 * 由 scripts/sync-provider-catalog.mjs 从 models.dev 生成，**请勿手改**。
 *
 * 要增删厂商或调整 Base URL，改那个脚本里的 CURATED 清单后重新生成：
 *   node scripts/sync-provider-catalog.mjs
 *
 * 上游：https://models.dev （opencode 团队维护，MIT）
 * 快照时间由 git 记录，不写进文件 —— 否则每次重新生成都会产生无谓的 diff。
 */
import type { CatalogEntry } from '../../shared/aiProvider'

export const GENERATED_CATALOG: readonly CatalogEntry[] = Object.freeze(`

  if (only) {
    const snapshot = readFileSync(OUT_FILE, 'utf-8')
    const saved = JSON.parse(
      snapshot.slice(
        snapshot.indexOf('Object.freeze(') + 14,
        snapshot.lastIndexOf(' as CatalogEntry[]')
      )
    )
    const fresh = entries[0]
    const index = saved.findIndex((entry) => entry.id === only)
    if (!fresh) {
      if (index < 0) throw new Error('--only requires a known provider ID')
      saved.splice(index, 1)
    } else if (index < 0) saved.push(fresh)
    else saved[index] = fresh
    entries.splice(0, entries.length, ...saved)
  }

  writeFileSync(
    OUT_FILE,
    `${banner}${JSON.stringify(entries, null, 2)} as CatalogEntry[])\n`,
    'utf-8'
  )

  console.log(`已生成 ${OUT_FILE}`)
  console.log(`  ${entries.length} 家厂商 / ${totalModels} 个预置模型`)
  console.log(
    `  图标 ${entries.length - noLogo.length} 个${noLogo.length ? `，缺 ${noLogo.join(', ')}` : ''}`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
