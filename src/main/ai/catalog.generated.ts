/* eslint-disable */
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

export const GENERATED_CATALOG: readonly CatalogEntry[] = Object.freeze([
  {
    "id": "ollama",
    "displayName": "Ollama",
    "group": "local",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "http://localhost:11434/v1",
    "requiresApiKey": false,
    "hasLogo": true,
    "models": []
  },
  {
    "id": "lmstudio",
    "displayName": "LMStudio",
    "group": "local",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "http://localhost:1234/v1",
    "apiKeyUrl": "https://lmstudio.ai/models",
    "requiresApiKey": false,
    "defaultEnvVar": "LMSTUDIO_API_KEY",
    "hasLogo": true,
    "models": []
  },
  {
    "id": "llamacpp",
    "displayName": "llama.cpp",
    "group": "local",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "http://localhost:8080/v1",
    "requiresApiKey": false,
    "hasLogo": true,
    "models": []
  },
  {
    "id": "chatgpt",
    "displayName": "ChatGPT Plus / Pro",
    "group": "subscription",
    "kind": "chat",
    "protocol": "openai-codex-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "apiKeyUrl": "https://developers.openai.com/codex/auth",
    "requiresApiKey": true,
    "hasLogo": true,
    "supportsOAuth": true,
    "models": [
      {
        "id": "gpt-6-astra",
        "displayName": "GPT-6 Astra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": "max"
        },
        "contextWindow": 272000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6-sol",
        "displayName": "GPT-5.6 Sol",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": "max"
        },
        "contextWindow": 272000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6-terra",
        "displayName": "GPT-5.6 Terra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": "max"
        },
        "contextWindow": 272000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6-luna",
        "displayName": "GPT-5.6 Luna",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": "max"
        },
        "contextWindow": 272000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.5",
        "displayName": "GPT-5.5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": null
        },
        "contextWindow": 272000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.4-mini",
        "displayName": "GPT-5.4 mini",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": null
        },
        "contextWindow": 272000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.4",
        "displayName": "GPT-5.4",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": null
        },
        "contextWindow": 272000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.3-codex-spark",
        "displayName": "GPT-5.3 Codex Spark",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": null
        },
        "contextWindow": 128000,
        "maxOutputTokens": 128000
      }
    ]
  },
  {
    "id": "kimi-code",
    "displayName": "Kimi Code（会员）",
    "group": "subscription",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.kimi.com/coding/v1",
    "apiKeyUrl": "https://www.kimi.com/code/docs/en/kimi-code/models.html",
    "requiresApiKey": true,
    "defaultEnvVar": "KIMI_API_KEY",
    "hasLogo": true,
    "supportsOAuth": true,
    "models": [
      {
        "id": "kimi-for-coding",
        "displayName": "kimi-for-coding",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 32768
      },
      {
        "id": "k3-256k",
        "displayName": "Kimi K3-256K",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 131072
      },
      {
        "id": "k3",
        "displayName": "Kimi K3",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "kimi-for-coding-highspeed",
        "displayName": "Kimi For Coding HighSpeed",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768
      }
    ]
  },
  {
    "id": "openai-image",
    "displayName": "OpenAI GPT Image",
    "group": "image",
    "kind": "image",
    "protocol": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyUrl": "https://platform.openai.com/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "OPENAI_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "gpt-image-2",
        "displayName": "GPT Image 2",
        "imageApi": "gpt-images"
      }
    ]
  },
  {
    "id": "google-image",
    "displayName": "Google Nano Banana",
    "group": "image",
    "kind": "image",
    "protocol": "openai-completions",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "apiKeyUrl": "https://aistudio.google.com/apikey",
    "requiresApiKey": true,
    "defaultEnvVar": "GEMINI_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "gemini-3.1-flash-image",
        "displayName": "Nano Banana 2",
        "imageApi": "gemini-images"
      },
      {
        "id": "gemini-3.1-flash-lite-image",
        "displayName": "Nano Banana 2 Lite（仅 1K）",
        "imageApi": "gemini-images"
      },
      {
        "id": "gemini-3-pro-image",
        "displayName": "Nano Banana Pro",
        "imageApi": "gemini-images"
      }
    ]
  },
  {
    "id": "xai-image",
    "displayName": "xAI Grok Imagine",
    "group": "image",
    "kind": "image",
    "protocol": "openai-completions",
    "baseUrl": "https://api.x.ai/v1",
    "apiKeyUrl": "https://console.x.ai/team/default/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "XAI_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "grok-imagine-image-2.0",
        "displayName": "Grok Imagine Image 2.0",
        "imageApi": "grok-images"
      },
      {
        "id": "grok-imagine-image-quality",
        "displayName": "Grok Imagine Image Quality",
        "imageApi": "grok-images"
      }
    ]
  },
  {
    "id": "ark-seedream",
    "displayName": "火山方舟 Seedream（豆包）",
    "group": "image",
    "kind": "image",
    "protocol": "openai-completions",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKeyUrl": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    "requiresApiKey": true,
    "defaultEnvVar": "ARK_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "doubao-seedream-5-0-260128",
        "displayName": "Seedream 5.0",
        "imageApi": "ark-images"
      },
      {
        "id": "doubao-seedream-4-5-251128",
        "displayName": "Seedream 4.5",
        "imageApi": "ark-images"
      },
      {
        "id": "doubao-seedream-4-0-250828",
        "displayName": "Seedream 4.0",
        "imageApi": "ark-images"
      }
    ]
  },
  {
    "id": "siliconflow-image",
    "displayName": "硅基流动 SiliconFlow（生图）",
    "group": "image",
    "kind": "image",
    "protocol": "openai-completions",
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKeyUrl": "https://cloud.siliconflow.cn/account/ak",
    "requiresApiKey": true,
    "defaultEnvVar": "SILICONFLOW_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "Qwen/Qwen-Image",
        "displayName": "Qwen Image",
        "imageApi": "siliconflow-images"
      },
      {
        "id": "Qwen/Qwen-Image-Edit-2509",
        "displayName": "Qwen Image Edit",
        "imageApi": "siliconflow-images"
      },
      {
        "id": "Kwai-Kolors/Kolors",
        "displayName": "Kolors 可图",
        "imageApi": "siliconflow-images"
      }
    ]
  },
  {
    "id": "zhipuai-image",
    "displayName": "智谱 CogView",
    "group": "image",
    "kind": "image",
    "protocol": "openai-completions",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKeyUrl": "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    "requiresApiKey": true,
    "defaultEnvVar": "ZHIPUAI_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "cogview-4",
        "displayName": "CogView-4",
        "imageApi": "openai-images"
      },
      {
        "id": "cogview-4-250304",
        "displayName": "CogView-4 (250304)",
        "imageApi": "openai-images"
      },
      {
        "id": "cogview-3-flash",
        "displayName": "CogView-3 Flash（免费）",
        "imageApi": "openai-images"
      }
    ]
  },
  {
    "id": "togetherai-image",
    "displayName": "Together AI（FLUX）",
    "group": "image",
    "kind": "image",
    "protocol": "openai-completions",
    "baseUrl": "https://api.together.xyz/v1",
    "apiKeyUrl": "https://api.together.xyz/settings/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "TOGETHER_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "black-forest-labs/FLUX.1-schnell-Free",
        "displayName": "FLUX.1 schnell（免费）",
        "imageApi": "openai-images"
      },
      {
        "id": "black-forest-labs/FLUX.1-schnell",
        "displayName": "FLUX.1 schnell",
        "imageApi": "openai-images"
      },
      {
        "id": "black-forest-labs/FLUX.1-dev",
        "displayName": "FLUX.1 dev",
        "imageApi": "openai-images"
      }
    ]
  },
  {
    "id": "ollama-embedding",
    "displayName": "Ollama（本机向量化）",
    "group": "embedding",
    "kind": "embedding",
    "protocol": "openai-completions",
    "baseUrl": "http://localhost:11434/v1",
    "apiKeyUrl": "https://ollama.com/search?c=embedding",
    "requiresApiKey": false,
    "hasLogo": true,
    "models": [
      {
        "id": "bge-m3",
        "displayName": "BGE-M3（多语言，中文推荐）",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 1024
      },
      {
        "id": "nomic-embed-text",
        "displayName": "nomic-embed-text（英文，最轻）",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 768
      },
      {
        "id": "mxbai-embed-large",
        "displayName": "mxbai-embed-large",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 1024
      },
      {
        "id": "qwen3-embedding",
        "displayName": "Qwen3 Embedding",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 1024
      }
    ]
  },
  {
    "id": "jina",
    "displayName": "Jina AI（向量化）",
    "group": "embedding",
    "kind": "embedding",
    "protocol": "openai-completions",
    "baseUrl": "https://api.jina.ai/v1",
    "apiKeyUrl": "https://jina.ai/api-dashboard/key-manager",
    "requiresApiKey": true,
    "defaultEnvVar": "JINA_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "jina-embeddings-v4",
        "displayName": "Jina Embeddings v4（多模态）",
        "embeddingApi": "jina-embeddings",
        "embeddingDimensions": 2048
      },
      {
        "id": "jina-embeddings-v3",
        "displayName": "Jina Embeddings v3（多语言）",
        "embeddingApi": "jina-embeddings",
        "embeddingDimensions": 1024
      },
      {
        "id": "jina-clip-v2",
        "displayName": "Jina CLIP v2（图文）",
        "embeddingApi": "jina-embeddings",
        "embeddingDimensions": 1024
      }
    ]
  },
  {
    "id": "builtin-browser",
    "displayName": "内置浏览器（免配置）",
    "group": "search",
    "kind": "search",
    "protocol": "openai-completions",
    "baseUrl": "",
    "apiKeyUrl": "https://github.com/unreal-box/unreal-box",
    "requiresApiKey": false,
    "hasLogo": false,
    "models": [
      {
        "id": "duckduckgo",
        "displayName": "DuckDuckGo（推荐）"
      },
      {
        "id": "bing",
        "displayName": "Bing"
      }
    ]
  },
  {
    "id": "searxng",
    "displayName": "SearXNG（自建）",
    "group": "search",
    "kind": "search",
    "protocol": "openai-completions",
    "baseUrl": "",
    "apiKeyUrl": "https://docs.searxng.org/admin/settings/settings_search.html",
    "requiresApiKey": false,
    "hasLogo": false,
    "models": [
      {
        "id": "web-search",
        "displayName": "网页检索（用实例自己的引擎配置）"
      }
    ]
  },
  {
    "id": "jina-search",
    "displayName": "Jina AI（网页检索）",
    "group": "search",
    "kind": "search",
    "protocol": "openai-completions",
    "baseUrl": "https://s.jina.ai",
    "apiKeyUrl": "https://jina.ai/api-dashboard/key-manager",
    "requiresApiKey": true,
    "defaultEnvVar": "JINA_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "s.jina.ai",
        "displayName": "网页搜索（s.jina.ai）"
      }
    ]
  },
  {
    "id": "openai-embedding",
    "displayName": "OpenAI Embeddings",
    "group": "embedding",
    "kind": "embedding",
    "protocol": "openai-completions",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyUrl": "https://platform.openai.com/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "OPENAI_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "text-embedding-3-small",
        "displayName": "text-embedding-3-small（便宜）",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 1536
      },
      {
        "id": "text-embedding-3-large",
        "displayName": "text-embedding-3-large（更准）",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 3072
      }
    ]
  },
  {
    "id": "voyageai",
    "displayName": "Voyage AI（向量化）",
    "group": "embedding",
    "kind": "embedding",
    "protocol": "openai-completions",
    "baseUrl": "https://api.voyageai.com/v1",
    "apiKeyUrl": "https://dashboard.voyageai.com/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "VOYAGE_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "voyage-3.5",
        "displayName": "Voyage 3.5",
        "embeddingApi": "voyage-embeddings",
        "embeddingDimensions": 1024
      },
      {
        "id": "voyage-3.5-lite",
        "displayName": "Voyage 3.5 Lite",
        "embeddingApi": "voyage-embeddings",
        "embeddingDimensions": 1024
      },
      {
        "id": "voyage-code-3",
        "displayName": "Voyage Code 3（代码）",
        "embeddingApi": "voyage-embeddings",
        "embeddingDimensions": 1024
      }
    ]
  },
  {
    "id": "siliconflow-embedding",
    "displayName": "硅基流动 SiliconFlow（向量化）",
    "group": "embedding",
    "kind": "embedding",
    "protocol": "openai-completions",
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKeyUrl": "https://cloud.siliconflow.cn/account/ak",
    "requiresApiKey": true,
    "defaultEnvVar": "SILICONFLOW_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "BAAI/bge-m3",
        "displayName": "BGE-M3（多语言）",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 1024
      },
      {
        "id": "Qwen/Qwen3-Embedding-8B",
        "displayName": "Qwen3 Embedding 8B",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 4096
      },
      {
        "id": "Qwen/Qwen3-Embedding-0.6B",
        "displayName": "Qwen3 Embedding 0.6B（便宜）",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 1024
      }
    ]
  },
  {
    "id": "alibaba-embedding",
    "displayName": "阿里云百炼（向量化）",
    "group": "embedding",
    "kind": "embedding",
    "protocol": "openai-completions",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKeyUrl": "https://bailian.console.aliyun.com/?apiKey=1",
    "requiresApiKey": true,
    "defaultEnvVar": "DASHSCOPE_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "text-embedding-v4",
        "displayName": "text-embedding-v4",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 1024
      },
      {
        "id": "text-embedding-v3",
        "displayName": "text-embedding-v3",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 1024
      }
    ]
  },
  {
    "id": "zhipuai-embedding",
    "displayName": "智谱 Embedding",
    "group": "embedding",
    "kind": "embedding",
    "protocol": "openai-completions",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKeyUrl": "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    "requiresApiKey": true,
    "defaultEnvVar": "ZHIPUAI_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "embedding-3",
        "displayName": "Embedding-3",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 2048
      },
      {
        "id": "embedding-2",
        "displayName": "Embedding-2",
        "embeddingApi": "openai-embeddings",
        "embeddingDimensions": 1024
      }
    ]
  },
  {
    "id": "hyper3d",
    "displayName": "Hyper3D Rodin",
    "group": "model3d",
    "kind": "model3d",
    "model3dApi": "rodin",
    "protocol": "openai-completions",
    "baseUrl": "https://api.hyper3d.com/api/v2",
    "apiKeyUrl": "https://hyper3d.ai/workspace/api-dashboard",
    "requiresApiKey": true,
    "defaultEnvVar": "HYPER3D_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "Gen-2",
        "displayName": "Rodin Gen-2"
      },
      {
        "id": "Gen-2.5-Medium",
        "displayName": "Rodin Gen-2.5 Medium"
      },
      {
        "id": "Gen-2.5-Low",
        "displayName": "Rodin Gen-2.5 Low（便宜）"
      }
    ]
  },
  {
    "id": "tripo",
    "displayName": "Tripo（VAST AI）",
    "group": "model3d",
    "kind": "model3d",
    "model3dApi": "tripo",
    "protocol": "openai-completions",
    "baseUrl": "https://openapi.tripo3d.ai/v3",
    "apiKeyUrl": "https://platform.tripo3d.ai/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "TRIPO_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "v3.1-20260211",
        "displayName": "Tripo v3.1（H 系列 · 高精度）"
      },
      {
        "id": "v3.0-20250812",
        "displayName": "Tripo v3.0（H 系列 · 稳定版）"
      },
      {
        "id": "P1-20260311",
        "displayName": "Tripo P1（P 系列 · 低面数干净拓扑）"
      }
    ]
  },
  {
    "id": "meshy",
    "displayName": "Meshy",
    "group": "model3d",
    "kind": "model3d",
    "model3dApi": "meshy",
    "protocol": "openai-completions",
    "baseUrl": "https://api.meshy.ai",
    "apiKeyUrl": "https://www.meshy.ai/api",
    "requiresApiKey": true,
    "defaultEnvVar": "MESHY_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "latest",
        "displayName": "Meshy 最新版（随官方更新）"
      },
      {
        "id": "meshy-7",
        "displayName": "Meshy 7"
      },
      {
        "id": "meshy-6",
        "displayName": "Meshy 6"
      },
      {
        "id": "meshy-5",
        "displayName": "Meshy 5"
      }
    ]
  },
  {
    "id": "ark-seedance",
    "displayName": "火山方舟 Seedance（即梦）",
    "group": "video",
    "kind": "video",
    "videoApi": "ark-video",
    "protocol": "openai-completions",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKeyUrl": "https://www.volcengine.com/docs/82379/1520757",
    "requiresApiKey": true,
    "defaultEnvVar": "ARK_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "doubao-seedance-2-5-260628",
        "displayName": "Seedance 2.5（最高 1080p，全模态参考）"
      },
      {
        "id": "doubao-seedance-2-0-260128",
        "displayName": "Seedance 2.0"
      }
    ]
  },
  {
    "id": "minimax-video",
    "displayName": "MiniMax 海螺视频",
    "group": "video",
    "kind": "video",
    "videoApi": "minimax-video",
    "protocol": "openai-completions",
    "baseUrl": "https://api.minimaxi.com/v2",
    "apiKeyUrl": "https://platform.minimax.io/docs/api-reference/video-generation-v2-create",
    "requiresApiKey": true,
    "defaultEnvVar": "MINIMAX_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "MiniMax-H3",
        "displayName": "MiniMax H3（768P / 2K，支持参考视频）"
      },
      {
        "id": "MiniMax-H3-Max",
        "displayName": "MiniMax H3 Max（快，480P / 768P）"
      }
    ]
  },
  {
    "id": "openai-realtime",
    "displayName": "OpenAI 实时语音",
    "group": "realtime",
    "kind": "realtime",
    "protocol": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyUrl": "https://platform.openai.com/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "OPENAI_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "gpt-realtime",
        "displayName": "GPT Realtime（稳定别名）",
        "realtimeVoice": "marin"
      },
      {
        "id": "gpt-realtime-2.1",
        "displayName": "GPT Realtime 2.1",
        "realtimeVoice": "marin"
      }
    ]
  },
  {
    "id": "elevenlabs-music",
    "displayName": "ElevenLabs Music",
    "group": "music",
    "kind": "music",
    "musicApi": "elevenlabs-music",
    "protocol": "openai-completions",
    "baseUrl": "https://api.elevenlabs.io/v1",
    "apiKeyUrl": "https://elevenlabs.io/docs/api-reference/music/compose",
    "requiresApiKey": true,
    "defaultEnvVar": "ELEVENLABS_API_KEY",
    "hasLogo": false,
    "models": [
      {
        "id": "music_v2",
        "displayName": "Eleven Music v2"
      }
    ]
  },
  {
    "id": "sunoapi-music",
    "displayName": "SUNO (SunoAPI.org)",
    "group": "music",
    "kind": "music",
    "musicApi": "sunoapi-music",
    "protocol": "openai-completions",
    "baseUrl": "https://api.sunoapi.org/api/v1",
    "apiKeyUrl": "https://docs.sunoapi.org/suno-api/generate-music",
    "requiresApiKey": true,
    "defaultEnvVar": "SUNOAPI_API_KEY",
    "hasLogo": false,
    "models": [
      {
        "id": "V6",
        "displayName": "SUNO V6"
      },
      {
        "id": "V6_WILD",
        "displayName": "SUNO V6 Wild"
      },
      {
        "id": "V6_MINI",
        "displayName": "SUNO V6 Mini"
      }
    ]
  },
  {
    "id": "mureka-music",
    "displayName": "Mureka",
    "group": "music",
    "kind": "music",
    "musicApi": "mureka-music",
    "protocol": "openai-completions",
    "baseUrl": "https://api.mureka.ai/v1",
    "apiKeyUrl": "https://platform.mureka.ai/docs/",
    "requiresApiKey": true,
    "defaultEnvVar": "MUREKA_API_KEY",
    "hasLogo": false,
    "models": [
      {
        "id": "auto",
        "displayName": "Mureka Auto"
      }
    ]
  },
  {
    "id": "doubao-tts",
    "displayName": "豆包语音合成 TTS 2.0",
    "group": "tts",
    "kind": "tts",
    "protocol": "openai-completions",
    "baseUrl": "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse",
    "apiKeyUrl": "https://console.volcengine.com/speech/new/setting/apikeys",
    "requiresApiKey": true,
    "defaultEnvVar": "VOLCENGINE_SPEECH_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "seed-tts-2.0",
        "displayName": "豆包 TTS 2.0",
        "ttsVoice": "zh_female_vv_uranus_bigtts"
      }
    ]
  },
  {
    "id": "alibaba-tts",
    "displayName": "阿里云 Qwen-Audio 3.0 语音合成",
    "group": "tts",
    "kind": "tts",
    "protocol": "openai-completions",
    "baseUrl": "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    "apiKeyUrl": "https://bailian.console.aliyun.com/?apiKey=1",
    "requiresApiKey": true,
    "defaultEnvVar": "DASHSCOPE_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "qwen-audio-3.0-tts-plus",
        "displayName": "Qwen-Audio 3.0 TTS Plus",
        "ttsVoice": "longanlingxin"
      },
      {
        "id": "qwen-audio-3.0-tts-flash",
        "displayName": "Qwen-Audio 3.0 TTS Flash",
        "ttsVoice": "longanfengyue"
      }
    ]
  },
  {
    "id": "doubao-realtime",
    "displayName": "豆包实时语音",
    "group": "realtime",
    "kind": "realtime",
    "protocol": "openai-completions",
    "baseUrl": "https://openspeech.bytedance.com",
    "apiKeyUrl": "https://console.volcengine.com/speech/app",
    "requiresApiKey": true,
    "defaultEnvVar": "VOLCENGINE_SPEECH_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "1.2.6.1",
        "displayName": "豆包 Seeduplex 3.0（全双工）",
        "realtimeVoice": "zh_female_vv_jupiter_bigtts"
      }
    ]
  },
  {
    "id": "litellm",
    "displayName": "LiteLLM（自建网关）",
    "group": "gateway",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "http://localhost:4000/v1",
    "apiKeyUrl": "https://docs.litellm.ai/docs/proxy/virtual_keys",
    "requiresApiKey": true,
    "defaultEnvVar": "LITELLM_API_KEY",
    "hasLogo": true,
    "models": []
  },
  {
    "id": "one-api",
    "displayName": "One API / New API（自建网关）",
    "group": "gateway",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "http://localhost:3000/v1",
    "apiKeyUrl": "https://github.com/songquanpeng/one-api#%E4%BD%BF%E7%94%A8%E6%96%B9%E6%B3%95",
    "requiresApiKey": true,
    "defaultEnvVar": "ONE_API_KEY",
    "hasLogo": true,
    "models": []
  },
  {
    "id": "openrouter",
    "displayName": "OpenRouter",
    "group": "gateway",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKeyUrl": "https://openrouter.ai/keys",
    "requiresApiKey": true,
    "defaultEnvVar": "OPENROUTER_API_KEY",
    "hasLogo": true,
    "supportsOAuth": true,
    "models": [
      {
        "id": "~deepseek/deepseek-pro-latest",
        "displayName": "DeepSeek Pro Latest",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 943718
      },
      {
        "id": "~deepseek/deepseek-flash-latest",
        "displayName": "DeepSeek Flash Latest",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 943718
      },
      {
        "id": "sakana/fugu-max",
        "displayName": "Fugu Max",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "sakana/fugu-ultra-v2",
        "displayName": "Fugu Ultra v2",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "~openai/gpt-terra-latest",
        "displayName": "GPT Terra Latest",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "~openai/gpt-sol-latest",
        "displayName": "GPT Sol Latest",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "~openai/gpt-luna-latest",
        "displayName": "GPT Luna Latest",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "~openai/gpt-astra-latest",
        "displayName": "GPT Astra Latest",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "deepseek/deepseek-v4.1-flash",
        "displayName": "DeepSeek V4.1 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "inclusionai/ling-3.0-flash-vl:free",
        "displayName": "Ling 3.0 Flash VL (free)",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768
      },
      {
        "id": "inclusionai/ling-3.0-flash-vl",
        "displayName": "Ling 3.0 Flash VL",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 131072,
        "maxOutputTokens": 32768
      },
      {
        "id": "nex-agi/nex-n2.5-mini:free",
        "displayName": "Nex-N2.5-Mini (free)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 235929
      }
    ]
  },
  {
    "id": "vercel",
    "displayName": "Vercel AI Gateway",
    "group": "gateway",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://ai-gateway.vercel.sh/v1",
    "apiKeyUrl": "https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fai%2Fapi-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "AI_GATEWAY_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "sakana/fugu-max",
        "displayName": "Fugu Max",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 1000000
      },
      {
        "id": "sakana/fugu-ultra-v2",
        "displayName": "Fugu Ultra v2",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 1000000
      },
      {
        "id": "deepseek/deepseek-v4.1-flash",
        "displayName": "DeepSeek V4.1 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "inception/mercury-2.5",
        "displayName": "Mercury 2.5",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 260000,
        "maxOutputTokens": 65536
      },
      {
        "id": "inclusionai/ling-3.0-flash-vl-free",
        "displayName": "Ling 3.0 Flash VL (Free)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 32000
      },
      {
        "id": "inclusionai/ling-3.0-flash-vl",
        "displayName": "Ling 3.0 Flash VL",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 32000
      },
      {
        "id": "inclusionai/ling-3.0-flash-sante",
        "displayName": "Ling 3.0 Flash Sante",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 32000
      },
      {
        "id": "inclusionai/ling-3.0-flash-sante-free",
        "displayName": "Ling 3.0 Flash Sante (Free)",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 32000
      },
      {
        "id": "openai/gpt-6-astra",
        "displayName": "GPT-6 Astra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "openai/gpt-6-astra-fast",
        "displayName": "GPT-6 Astra (Fast)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "alibaba/qwen3.8-max-0902",
        "displayName": "Qwen3.8 Max 0902",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 991000,
        "maxOutputTokens": 128000
      },
      {
        "id": "google/gemini-3.8-flash",
        "displayName": "Gemini 3.8 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 65536
      }
    ]
  },
  {
    "id": "cloudflare-ai-gateway",
    "displayName": "Cloudflare AI Gateway",
    "group": "gateway",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "",
    "apiKeyUrl": "https://dash.cloudflare.com/profile/api-tokens",
    "requiresApiKey": true,
    "defaultEnvVar": "CLOUDFLARE_API_TOKEN",
    "hasLogo": true,
    "models": [
      {
        "id": "anthropic/claude-fable-5.1",
        "displayName": "Claude Fable 5.1",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "xai/grok-4.6",
        "displayName": "Grok 4.6",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 500000,
        "maxOutputTokens": 500000
      },
      {
        "id": "alibaba/qwen3.8-max",
        "displayName": "Qwen3.8 Max",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "anthropic/claude-opus-5",
        "displayName": "Claude Opus 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "moonshotai/kimi-k3",
        "displayName": "Kimi K3",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "openai/gpt-5.6-sol",
        "displayName": "GPT-5.6 Sol",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "openai/gpt-5.6-luna",
        "displayName": "GPT-5.6 Luna",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "openai/gpt-5.6-terra",
        "displayName": "GPT-5.6 Terra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "xai/grok-4.5",
        "displayName": "Grok 4.5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 500000,
        "maxOutputTokens": 500000
      },
      {
        "id": "anthropic/claude-sonnet-5",
        "displayName": "Claude Sonnet 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "anthropic/claude-fable-5",
        "displayName": "Claude Fable 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "alibaba/qwen3.7-plus",
        "displayName": "Qwen3.7 Plus",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 64000
      }
    ]
  },
  {
    "id": "openai",
    "displayName": "OpenAI",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyUrl": "https://platform.openai.com/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "OPENAI_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "gpt-6-astra",
        "displayName": "GPT-6 Astra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": "max"
        },
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6-sol",
        "displayName": "GPT-5.6 Sol",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6-luna",
        "displayName": "GPT-5.6 Luna",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6",
        "displayName": "GPT-5.6",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "low": "low",
          "medium": "medium",
          "high": "high",
          "xhigh": "xhigh",
          "max": "max"
        },
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6-terra",
        "displayName": "GPT-5.6 Terra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.5-pro",
        "displayName": "GPT-5.5 Pro",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.5",
        "displayName": "GPT-5.5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.4-nano",
        "displayName": "GPT-5.4 nano",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 400000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.4-mini",
        "displayName": "GPT-5.4 mini",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 400000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.4",
        "displayName": "GPT-5.4",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.4-pro",
        "displayName": "GPT-5.4 Pro",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.3-codex-spark",
        "displayName": "GPT-5.3 Codex Spark",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 128000,
        "maxOutputTokens": 32000
      }
    ]
  },
  {
    "id": "anthropic",
    "displayName": "Anthropic",
    "group": "cloud",
    "kind": "chat",
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKeyUrl": "https://console.anthropic.com/settings/keys",
    "requiresApiKey": true,
    "defaultEnvVar": "ANTHROPIC_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "claude-fable-5-1",
        "displayName": "Claude Fable 5.1",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "xhigh": "xhigh",
          "max": "max"
        },
        "adaptiveThinking": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-opus-5",
        "displayName": "Claude Opus 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-sonnet-5",
        "displayName": "Claude Sonnet 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-fable-5",
        "displayName": "Claude Fable 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-opus-4-8",
        "displayName": "Claude Opus 4.8",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-opus-4-7",
        "displayName": "Claude Opus 4.7",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-sonnet-4-6",
        "displayName": "Claude Sonnet 4.6",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-opus-4-6",
        "displayName": "Claude Opus 4.6",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      }
    ]
  },
  {
    "id": "google",
    "displayName": "Google",
    "group": "cloud",
    "kind": "chat",
    "protocol": "google-generative-ai",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "apiKeyUrl": "https://aistudio.google.com/apikey",
    "requiresApiKey": true,
    "defaultEnvVar": "GOOGLE_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "gemini-3.8-flash",
        "displayName": "Gemini 3.8 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-3.7-flash",
        "displayName": "Gemini 3.7 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-flash-latest",
        "displayName": "Gemini Flash Latest",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-3.6-flash",
        "displayName": "Gemini 3.6 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-3.5-flash-lite",
        "displayName": "Gemini 3.5 Flash Lite",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-flash-lite-latest",
        "displayName": "Gemini Flash-Lite Latest",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-3.5-flash",
        "displayName": "Gemini 3.5 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-3.1-flash-lite",
        "displayName": "Gemini 3.1 Flash Lite",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemma-4-26b-a4b-it",
        "displayName": "Gemma 4 26B A4B IT",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768
      },
      {
        "id": "gemma-4-31b-it",
        "displayName": "Gemma 4 31B IT",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768
      },
      {
        "id": "gemini-3.1-pro-preview-customtools",
        "displayName": "Gemini 3.1 Pro Preview Custom Tools",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-3.1-pro-preview",
        "displayName": "Gemini 3.1 Pro Preview",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      }
    ]
  },
  {
    "id": "xai",
    "displayName": "xAI",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.x.ai/v1",
    "apiKeyUrl": "https://console.x.ai/team/default/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "XAI_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "grok-4.6",
        "displayName": "Grok 4.6",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "xhigh": "xhigh",
          "max": null
        },
        "contextWindow": 500000
      },
      {
        "id": "grok-4.5",
        "displayName": "Grok 4.5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 500000,
        "maxOutputTokens": 500000
      },
      {
        "id": "grok-4.3",
        "displayName": "Grok 4.3",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 30000
      },
      {
        "id": "grok-build-0.1",
        "displayName": "Grok Build 0.1",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "grok-4.20-0309-reasoning",
        "displayName": "Grok 4.20 (Reasoning)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 30000
      },
      {
        "id": "grok-4.20-0309-non-reasoning",
        "displayName": "Grok 4.20 (Non-Reasoning)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 1000000,
        "maxOutputTokens": 30000
      },
      {
        "id": "grok-4.20-multi-agent-0309",
        "displayName": "Grok 4.20 Multi-Agent",
        "supportsVision": true,
        "supportsTools": false,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 30000
      }
    ]
  },
  {
    "id": "mistral",
    "displayName": "Mistral",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.mistral.ai/v1",
    "apiKeyUrl": "https://console.mistral.ai/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "MISTRAL_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "zai-glm-5-2",
        "displayName": "GLM-5.2",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "mistral-medium-latest",
        "displayName": "Mistral Medium (latest)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "mistral-medium-2604",
        "displayName": "Mistral Medium 3.5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "mistral-small-latest",
        "displayName": "Mistral Small (latest)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "mistral-small-2603",
        "displayName": "Mistral Small 4",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "voxtral-mini-latest",
        "displayName": "Voxtral Mini (latest)",
        "supportsVision": false,
        "supportsTools": false,
        "supportsReasoning": false
      }
    ]
  },
  {
    "id": "groq",
    "displayName": "Groq",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKeyUrl": "https://console.groq.com/keys",
    "requiresApiKey": true,
    "defaultEnvVar": "GROQ_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "qwen/qwen3.8-27b",
        "displayName": "Qwen3.8 27B",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 131042,
        "maxOutputTokens": 16384
      },
      {
        "id": "qwen/qwen3.6-27b",
        "displayName": "Qwen3.6 27B",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 131072,
        "maxOutputTokens": 16384
      }
    ]
  },
  {
    "id": "cerebras",
    "displayName": "Cerebras",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.cerebras.ai/v1",
    "apiKeyUrl": "https://cloud.cerebras.ai/platform/apikeys",
    "requiresApiKey": true,
    "defaultEnvVar": "CEREBRAS_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "qwen-3.8-27b",
        "displayName": "Qwen3.8 27B",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 65536,
        "maxOutputTokens": 32768
      }
    ]
  },
  {
    "id": "togetherai",
    "displayName": "Together AI",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.together.xyz/v1",
    "apiKeyUrl": "https://api.together.xyz/settings/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "TOGETHER_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash",
        "displayName": "DeepSeek V4.1 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "zai-org/GLM-5.3-Flash",
        "displayName": "GLM-5.3-Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048575,
        "maxOutputTokens": 400000
      },
      {
        "id": "zai-org/GLM-5.3",
        "displayName": "GLM-5.3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 262144
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro-0813",
        "displayName": "DeepSeek V4 Pro 0813",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
        "displayName": "DeepSeek V4 Flash 0731",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "moonshotai/Kimi-K3",
        "displayName": "Kimi K3",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "thinkingmachines/Inkling",
        "displayName": "Inkling",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 524288,
        "maxOutputTokens": 131072
      },
      {
        "id": "zai-org/GLM-5.2",
        "displayName": "GLM-5.2",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 512000,
        "maxOutputTokens": 164000
      },
      {
        "id": "moonshotai/Kimi-K2.7-Code",
        "displayName": "Kimi K2.7 Code",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 131072
      },
      {
        "id": "MiniMaxAI/MiniMax-M3",
        "displayName": "MiniMax-M3",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 524288,
        "maxOutputTokens": 250000
      },
      {
        "id": "nvidia/nemotron-3-ultra-550b-a55b",
        "displayName": "Nemotron 3 Ultra 550B A55B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 512300,
        "maxOutputTokens": 512300
      },
      {
        "id": "Qwen/Qwen3.7-Max",
        "displayName": "Qwen3.7 Max",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 1000000,
        "maxOutputTokens": 500000
      }
    ]
  },
  {
    "id": "fireworks-ai",
    "displayName": "Fireworks AI",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "apiKeyUrl": "https://app.fireworks.ai/settings/users/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "FIREWORKS_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "accounts/fireworks/routers/deepseek-flash-latest",
        "displayName": "DeepSeek Flash Latest",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "accounts/fireworks/models/deepseek-v4p1-flash",
        "displayName": "DeepSeek V4.1 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "accounts/fireworks/routers/glm-fast-latest",
        "displayName": "GLM 5.3 Fast (Latest)",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048572,
        "maxOutputTokens": 262144
      },
      {
        "id": "accounts/fireworks/routers/glm-5p3-fast",
        "displayName": "GLM 5.3 Fast",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048572,
        "maxOutputTokens": 262144
      },
      {
        "id": "accounts/fireworks/routers/glm-flash-latest",
        "displayName": "GLM Flash Latest (GLM 5.3 Flash)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048573,
        "maxOutputTokens": 131072
      },
      {
        "id": "accounts/fireworks/models/glm-5p3-flash",
        "displayName": "GLM 5.3 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048573,
        "maxOutputTokens": 131072
      },
      {
        "id": "accounts/fireworks/models/deepseek-v4-flash-vision-exp",
        "displayName": "DeepSeek V4 Flash Vision Exp",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "accounts/fireworks/routers/glm-latest",
        "displayName": "GLM Latest",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048573,
        "maxOutputTokens": 262144
      },
      {
        "id": "accounts/fireworks/models/glm-5p3",
        "displayName": "GLM 5.3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048573,
        "maxOutputTokens": 262144
      },
      {
        "id": "accounts/fireworks/routers/deepseek-pro-latest",
        "displayName": "DeepSeek Pro Latest",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "accounts/fireworks/models/deepseek-v4-pro-0813",
        "displayName": "DeepSeek V4 Pro 0813",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "accounts/fireworks/models/qwen3p8-2p4t-a95b",
        "displayName": "Qwen3.8 2.4T A95B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 131072
      }
    ]
  },
  {
    "id": "deepinfra",
    "displayName": "Deep Infra",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.deepinfra.com/v1/openai",
    "apiKeyUrl": "https://deepinfra.com/dash/api_keys",
    "requiresApiKey": true,
    "defaultEnvVar": "DEEPINFRA_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash",
        "displayName": "DeepSeek V4.1 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "zai-org/GLM-5.3-Flash",
        "displayName": "GLM-5.3-Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "Qwen/Qwen3.8-Flash",
        "displayName": "Qwen3.8 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
        "displayName": "DeepSeek V4 Flash Vision Exp",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "zai-org/GLM-5.3",
        "displayName": "GLM-5.3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "Qwen/Qwen3.8-27B",
        "displayName": "Qwen3.8 27B",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro-0813",
        "displayName": "DeepSeek V4 Pro 0813",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "Qwen/Qwen3.8-2.4T-A95B",
        "displayName": "Qwen3.8 2.4T A95B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 131072
      },
      {
        "id": "Qwen/Qwen3.8-Max",
        "displayName": "Qwen3.8 Max",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 256000,
        "maxOutputTokens": 131072
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
        "displayName": "DeepSeek V4 Flash 0731",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "thinkingmachines/Inkling-Small",
        "displayName": "Inkling Small",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 524288,
        "maxOutputTokens": 1048576
      },
      {
        "id": "moonshotai/Kimi-K3",
        "displayName": "Kimi K3",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      }
    ]
  },
  {
    "id": "perplexity",
    "displayName": "Perplexity",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.perplexity.ai",
    "apiKeyUrl": "https://www.perplexity.ai/account/api/keys",
    "requiresApiKey": true,
    "defaultEnvVar": "PERPLEXITY_API_KEY",
    "hasLogo": true,
    "models": []
  },
  {
    "id": "cohere",
    "displayName": "Cohere",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.cohere.ai/compatibility/v1",
    "apiKeyUrl": "https://dashboard.cohere.com/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "COHERE_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "north-mini-code-1-0",
        "displayName": "North Mini Code",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 64000
      },
      {
        "id": "command-a-plus-05-2026",
        "displayName": "Command A Plus",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 128000,
        "maxOutputTokens": 64000
      }
    ]
  },
  {
    "id": "huggingface",
    "displayName": "Hugging Face",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://router.huggingface.co/v1",
    "apiKeyUrl": "https://huggingface.co/settings/tokens",
    "requiresApiKey": true,
    "defaultEnvVar": "HF_TOKEN",
    "hasLogo": true,
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash",
        "displayName": "DeepSeek V4.1 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "zai-org/GLM-5.3-Flash",
        "displayName": "GLM-5.3-Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
        "displayName": "DeepSeek V4 Flash Vision Exp",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "zai-org/GLM-5.3",
        "displayName": "GLM-5.3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "Qwen/Qwen3.8-27B",
        "displayName": "Qwen3.8 27B",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro-0813",
        "displayName": "DeepSeek V4 Pro 0813",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "Qwen/Qwen3.8-2.4T-A95B",
        "displayName": "Qwen3.8 2.4T A95B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 131072
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
        "displayName": "DeepSeek V4 Flash 0731",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "thinkingmachines/Inkling-Small",
        "displayName": "Inkling Small",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 524288,
        "maxOutputTokens": 1048576
      },
      {
        "id": "moonshotai/Kimi-K3",
        "displayName": "Kimi K3",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "thinkingmachines/Inkling",
        "displayName": "Inkling",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 1048576
      },
      {
        "id": "tencent/Hy3",
        "displayName": "Hy3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 128000
      }
    ]
  },
  {
    "id": "nebius",
    "displayName": "Nebius Token Factory",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.studio.nebius.ai/v1",
    "apiKeyUrl": "https://console.nebius.com/settings/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "NEBIUS_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "zai-org/GLM-5.3-Flash",
        "displayName": "GLM-5.3-Flash",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1024000,
        "maxOutputTokens": 1024000
      },
      {
        "id": "nvidia/Nemotron-3_5-Lightning",
        "displayName": "Nemotron 3.5 Lightning 30B A3B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 1048576
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
        "displayName": "DeepSeek V4 Flash 0731",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1024000,
        "maxOutputTokens": 1024000
      },
      {
        "id": "moonshotai/Kimi-K3",
        "displayName": "Kimi K3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 8000
      },
      {
        "id": "zai-org/GLM-5.2",
        "displayName": "GLM-5.2",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 1048576
      },
      {
        "id": "moonshotai/Kimi-K2.7-Code",
        "displayName": "Kimi K2.7 Code",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 8000
      },
      {
        "id": "nvidia/Nemotron-3-Ultra-550b-a55b",
        "displayName": "Nemotron 3 Ultra 550B A55B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 1048576
      },
      {
        "id": "MiniMaxAI/MiniMax-M3",
        "displayName": "MiniMax-M3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 1048576
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro",
        "displayName": "DeepSeek V4 Pro",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 1048576
      },
      {
        "id": "nvidia/nemotron-3-super-120b-a12b",
        "displayName": "Nemotron-3-Super-120B-A12B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 32768
      },
      {
        "id": "NousResearch/Hermes-4-405B",
        "displayName": "Hermes-4-405B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 131072,
        "maxOutputTokens": 8192
      },
      {
        "id": "Qwen/Qwen3-30B-A3B-Instruct-2507",
        "displayName": "Qwen3-30B-A3B-Instruct-2507",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 262144,
        "maxOutputTokens": 8192
      }
    ]
  },
  {
    "id": "baseten",
    "displayName": "Baseten",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://inference.baseten.co/v1",
    "apiKeyUrl": "https://app.baseten.co/settings/api_keys",
    "requiresApiKey": true,
    "defaultEnvVar": "BASETEN_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash",
        "displayName": "DeepSeek V4.1 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 32768
      },
      {
        "id": "zai-org/GLM-5.3-Flash",
        "displayName": "GLM 5.3 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "zai-org/GLM-5.3",
        "displayName": "GLM 5.3",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 262144
      },
      {
        "id": "zai-org/GLM-5.3-Fast",
        "displayName": "GLM 5.3 Fast",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 262144
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro-0813",
        "displayName": "DeepSeek V4 Pro 0813",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 262144
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
        "displayName": "DeepSeek V4 Flash 0731",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 384000
      },
      {
        "id": "thinkingmachines/inkling-small",
        "displayName": "Inkling Small",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 32768
      },
      {
        "id": "moonshotai/Kimi-K3",
        "displayName": "Kimi K3",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 262144
      },
      {
        "id": "thinkingmachines/inkling",
        "displayName": "Inkling",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 32768
      },
      {
        "id": "zai-org/GLM-5.2-Fast",
        "displayName": "GLM 5.2 Fast",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 262144
      },
      {
        "id": "zai-org/GLM-5.2",
        "displayName": "GLM 5.2",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 262144
      },
      {
        "id": "moonshotai/Kimi-K2.7-Code",
        "displayName": "Kimi K2.7 Code",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262000,
        "maxOutputTokens": 262000
      }
    ]
  },
  {
    "id": "venice",
    "displayName": "Venice AI",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.venice.ai/api/v1",
    "apiKeyUrl": "https://venice.ai/settings/api",
    "requiresApiKey": true,
    "defaultEnvVar": "VENICE_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "deepseek-v4-1-flash",
        "displayName": "DeepSeek V4.1 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "qwen-3-8-flash",
        "displayName": "Qwen 3.8 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "mercury-2-5",
        "displayName": "Mercury 2.5",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 260000,
        "maxOutputTokens": 65536
      },
      {
        "id": "openai-gpt-6-astra",
        "displayName": "GPT-6 Astra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "openai-gpt-6-astra-pro",
        "displayName": "GPT-6 Astra Pro",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gemini-3-8-flash",
        "displayName": "Gemini 3.8 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 65536
      },
      {
        "id": "claude-fable-5-1",
        "displayName": "Claude Fable 5.1",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "z-ai-glm-5-3-flash",
        "displayName": "GLM 5.3 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "z-ai-glm-5-3",
        "displayName": "GLM 5.3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "qwen-3-8-27b",
        "displayName": "Qwen 3.8 27B",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 65536
      },
      {
        "id": "deepseek-v4-pro-0813",
        "displayName": "DeepSeek V4 Pro 0813",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 32768
      },
      {
        "id": "gemini-3-7-flash",
        "displayName": "Gemini 3.7 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 65536
      }
    ]
  },
  {
    "id": "inference",
    "displayName": "Inference",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.inference.net/v1",
    "apiKeyUrl": "https://inference.net/dashboard/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "INFERENCE_API_KEY",
    "hasLogo": true,
    "models": []
  },
  {
    "id": "amazon-bedrock",
    "displayName": "Amazon Bedrock",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "",
    "apiKeyUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/api-setup.html",
    "requiresApiKey": true,
    "defaultEnvVar": "AWS_ACCESS_KEY_ID",
    "hasLogo": true,
    "models": [
      {
        "id": "us.openai.gpt-6-astra",
        "displayName": "GPT-6 Astra (US)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "openai.gpt-6-astra",
        "displayName": "GPT-6 Astra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "global.openai.gpt-6-astra",
        "displayName": "GPT-6 Astra (Global)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "us.anthropic.claude-fable-5-1",
        "displayName": "Claude Fable 5.1 (US)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "global.anthropic.claude-fable-5-1",
        "displayName": "Claude Fable 5.1 (Global)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "anthropic.claude-fable-5-1",
        "displayName": "Claude Fable 5.1",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "us.xai.grok-4.6",
        "displayName": "Grok 4.6 (US)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 500000,
        "maxOutputTokens": 500000
      },
      {
        "id": "global.xai.grok-4.6",
        "displayName": "Grok 4.6 (Global)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 500000,
        "maxOutputTokens": 500000
      },
      {
        "id": "xai.grok-4.6",
        "displayName": "Grok 4.6",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 500000,
        "maxOutputTokens": 500000
      },
      {
        "id": "us.anthropic.claude-opus-5",
        "displayName": "Claude Opus 5 (US)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "anthropic.claude-opus-5",
        "displayName": "Claude Opus 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "eu.anthropic.claude-opus-5",
        "displayName": "Claude Opus 5 (EU)",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      }
    ]
  },
  {
    "id": "azure",
    "displayName": "Azure",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "",
    "apiKeyUrl": "https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts",
    "requiresApiKey": true,
    "defaultEnvVar": "AZURE_RESOURCE_NAME",
    "hasLogo": true,
    "models": [
      {
        "id": "gpt-6-astra",
        "displayName": "GPT-6 Astra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-fable-5-1",
        "displayName": "Claude Fable 5.1",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "grok-4.6",
        "displayName": "Grok 4.6",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 200000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-opus-5",
        "displayName": "Claude Opus 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6-sol",
        "displayName": "GPT-5.6 Sol",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6-luna",
        "displayName": "GPT-5.6 Luna",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gpt-5.6-terra",
        "displayName": "GPT-5.6 Terra",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1050000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-sonnet-5",
        "displayName": "Claude Sonnet 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "kimi-k2.7-code",
        "displayName": "Kimi K2.7 Code",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "claude-fable-5",
        "displayName": "Claude Fable 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-mythos-5",
        "displayName": "Claude Mythos 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-opus-4-8",
        "displayName": "Claude Opus 4.8",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      }
    ]
  },
  {
    "id": "google-vertex",
    "displayName": "Vertex",
    "group": "cloud",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "",
    "apiKeyUrl": "https://console.cloud.google.com/apis/credentials",
    "requiresApiKey": true,
    "defaultEnvVar": "GOOGLE_VERTEX_PROJECT",
    "hasLogo": true,
    "models": [
      {
        "id": "gemini-3.8-flash",
        "displayName": "Gemini 3.8 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "claude-fable-5-1@default",
        "displayName": "Claude Fable 5.1",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gemini-3.7-flash",
        "displayName": "Gemini 3.7 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-flash-latest",
        "displayName": "Gemini Flash Latest",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "xai/grok-4.6",
        "displayName": "Grok 4.6",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 524288,
        "maxOutputTokens": 500000
      },
      {
        "id": "claude-opus-5@default",
        "displayName": "Claude Opus 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "gemini-3.6-flash",
        "displayName": "Gemini 3.6 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-3.5-flash-lite",
        "displayName": "Gemini 3.5 Flash Lite",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "gemini-flash-lite-latest",
        "displayName": "Gemini Flash-Lite Latest",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 65536
      },
      {
        "id": "claude-sonnet-5@default",
        "displayName": "Claude Sonnet 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-fable-5@default",
        "displayName": "Claude Fable 5",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      },
      {
        "id": "claude-opus-4-8@default",
        "displayName": "Claude Opus 4.8",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 128000
      }
    ]
  },
  {
    "id": "alibaba",
    "displayName": "阿里云百炼（通义千问）",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKeyUrl": "https://bailian.console.aliyun.com/?tab=model#/api-key",
    "requiresApiKey": true,
    "defaultEnvVar": "DASHSCOPE_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "qwen3.8-flash",
        "displayName": "Qwen3.8 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "qwen3.8-max",
        "displayName": "Qwen3.8 Max",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "deepseek-v4-flash-0731",
        "displayName": "DeepSeek V4 Flash 0731",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "glm-5.2",
        "displayName": "GLM-5.2",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "qwen3.7-plus",
        "displayName": "Qwen3.7 Plus",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 65536
      },
      {
        "id": "qwen3.7-max",
        "displayName": "Qwen3.7 Max",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 65536
      },
      {
        "id": "qwen3.6-flash",
        "displayName": "Qwen3.6 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 65536
      },
      {
        "id": "qwen3.6-27b",
        "displayName": "Qwen3.6 27B",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 65536
      },
      {
        "id": "qwen3.6-max-preview",
        "displayName": "Qwen3.6 Max Preview",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 65536
      },
      {
        "id": "qwen3.6-35b-a3b",
        "displayName": "Qwen3.6 35B-A3B",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 65536
      },
      {
        "id": "qwen3.6-plus",
        "displayName": "Qwen3.6 Plus",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 65536
      },
      {
        "id": "qwen3.5-27b",
        "displayName": "Qwen3.5 27B",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 65536
      }
    ]
  },
  {
    "id": "deepseek",
    "displayName": "DeepSeek",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKeyUrl": "https://platform.deepseek.com/api_keys",
    "requiresApiKey": true,
    "defaultEnvVar": "DEEPSEEK_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "deepseek-flash",
        "displayName": "DeepSeek V4.1 Flash",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "low": "low",
          "medium": null,
          "high": "high",
          "xhigh": null,
          "max": "max"
        },
        "contextWindow": 1000000,
        "maxOutputTokens": 393216
      },
      {
        "id": "deepseek-v4-pro",
        "displayName": "DeepSeek V4 Pro",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 393216
      }
    ]
  },
  {
    "id": "moonshotai-cn",
    "displayName": "Moonshot AI (China)",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.moonshot.cn/v1",
    "apiKeyUrl": "https://platform.moonshot.cn/console/api-keys",
    "requiresApiKey": true,
    "defaultEnvVar": "MOONSHOT_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "kimi-k3",
        "displayName": "Kimi K3",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 131072
      },
      {
        "id": "kimi-k2.7-code",
        "displayName": "Kimi K2.7 Code",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "kimi-k2.7-code-highspeed",
        "displayName": "Kimi K2.7 Code HighSpeed",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "kimi-k2.6",
        "displayName": "Kimi K2.6",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      }
    ]
  },
  {
    "id": "zhipuai",
    "displayName": "Zhipu AI",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKeyUrl": "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    "requiresApiKey": true,
    "defaultEnvVar": "ZHIPU_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "glm-5.3-flash",
        "displayName": "GLM-5.3-Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "low": "low",
          "medium": null,
          "high": "high",
          "xhigh": null,
          "max": "max"
        },
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "glm-5.3",
        "displayName": "GLM-5.3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "low": "low",
          "medium": null,
          "high": "high",
          "xhigh": null,
          "max": "max"
        },
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "glm-5.2",
        "displayName": "GLM-5.2",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "minimal": null,
          "low": null,
          "medium": null,
          "high": "high",
          "xhigh": null,
          "max": "max"
        },
        "contextWindow": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "glm-5v-turbo",
        "displayName": "GLM-5V-Turbo",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 200000,
        "maxOutputTokens": 131072
      },
      {
        "id": "glm-5.1",
        "displayName": "GLM-5.1",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 200000,
        "maxOutputTokens": 131072
      },
      {
        "id": "glm-5",
        "displayName": "GLM-5",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 204800,
        "maxOutputTokens": 131072
      },
      {
        "id": "glm-4.7-flash",
        "displayName": "GLM-4.7-Flash",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 200000,
        "maxOutputTokens": 131072
      },
      {
        "id": "glm-4.7-flashx",
        "displayName": "GLM-4.7-FlashX",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 200000,
        "maxOutputTokens": 131072
      }
    ]
  },
  {
    "id": "siliconflow",
    "displayName": "SiliconFlow",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKeyUrl": "https://cloud.siliconflow.cn/account/ak",
    "requiresApiKey": true,
    "defaultEnvVar": "SILICONFLOW_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "zai-org/GLM-5.2",
        "displayName": "GLM-5.2",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1049000,
        "maxOutputTokens": 262000
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "displayName": "DeepSeek V4 Flash",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro",
        "displayName": "DeepSeek V4 Pro",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1000000,
        "maxOutputTokens": 384000
      },
      {
        "id": "Qwen/Qwen3.6-27B",
        "displayName": "Qwen3.6 27B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "moonshotai/Kimi-K2.6",
        "displayName": "moonshotai/Kimi-K2.6",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262000,
        "maxOutputTokens": 262000
      },
      {
        "id": "tencent/Hy3-preview",
        "displayName": "Hy3 preview",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "Qwen/Qwen3.6-35B-A3B",
        "displayName": "Qwen3.6 35B-A3B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "zai-org/GLM-5.1",
        "displayName": "zai-org/GLM-5.1",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 205000,
        "maxOutputTokens": 205000
      },
      {
        "id": "google/gemma-4-31B-it",
        "displayName": "Gemma 4 31B IT",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "google/gemma-4-26B-A4B-it",
        "displayName": "Gemma 4 26B A4B IT",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      },
      {
        "id": "zai-org/GLM-5V-Turbo",
        "displayName": "zai-org/GLM-5V-Turbo",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 200000,
        "maxOutputTokens": 131072
      },
      {
        "id": "Qwen/Qwen3.5-9B",
        "displayName": "Qwen/Qwen3.5-9B",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 262144,
        "maxOutputTokens": 262144
      }
    ]
  },
  {
    "id": "minimax-cn",
    "displayName": "MiniMax (minimaxi.com)",
    "group": "cn",
    "kind": "chat",
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.minimax.chat/v1",
    "apiKeyUrl": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    "requiresApiKey": true,
    "defaultEnvVar": "MINIMAX_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "MiniMax-M3",
        "displayName": "MiniMax-M3",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1048576,
        "maxOutputTokens": 512000
      },
      {
        "id": "MiniMax-M2.7-highspeed",
        "displayName": "MiniMax-M2.7-highspeed",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 204800,
        "maxOutputTokens": 131072
      },
      {
        "id": "MiniMax-M2.7",
        "displayName": "MiniMax-M2.7",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 204800,
        "maxOutputTokens": 131072
      },
      {
        "id": "MiniMax-M2.5-highspeed",
        "displayName": "MiniMax-M2.5-highspeed",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 204800,
        "maxOutputTokens": 131072
      },
      {
        "id": "MiniMax-M2.5",
        "displayName": "MiniMax-M2.5",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 204800,
        "maxOutputTokens": 131072
      }
    ]
  },
  {
    "id": "baidu",
    "displayName": "百度千帆（文心）",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://qianfan.baidubce.com/v2",
    "apiKeyUrl": "https://console.bce.baidu.com/iam/#/iam/apikey",
    "requiresApiKey": true,
    "defaultEnvVar": "QIANFAN_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "ernie-5.1",
        "displayName": "ERNIE 5.1",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": false,
        "contextWindow": 131072,
        "maxOutputTokens": 65536
      },
      {
        "id": "ernie-5.0",
        "displayName": "ERNIE 5.0",
        "supportsVision": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 131072,
        "maxOutputTokens": 65536
      }
    ]
  },
  {
    "id": "tencent",
    "displayName": "腾讯 TokenHub（混元）",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://tokenhub.tencentmaas.com/v1",
    "apiKeyUrl": "https://console.cloud.tencent.com/tokenhub/apikey",
    "requiresApiKey": true,
    "defaultEnvVar": "TENCENT_TOKENHUB_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "hy4-preview",
        "displayName": "Hy4 preview",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 1024000,
        "maxOutputTokens": 64000
      },
      {
        "id": "hy3",
        "displayName": "Hy3",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 128000
      },
      {
        "id": "hy3-preview",
        "displayName": "Hy3 preview",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 64000
      }
    ]
  },
  {
    "id": "bytedance",
    "displayName": "字节火山方舟（豆包）",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKeyUrl": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    "requiresApiKey": true,
    "defaultEnvVar": "ARK_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "doubao-seed-character-260628",
        "displayName": "Seed Character",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "doubao-seed-2-1-pro-260628",
        "displayName": "Seed 2.1 Pro",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "doubao-seed-evolving",
        "displayName": "Seed Evolving",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "doubao-seed-2-1-turbo-260628",
        "displayName": "Seed 2.1 Turbo",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "doubao-seed-2-0-lite-260428",
        "displayName": "Seed 2.0 Lite",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 131072
      },
      {
        "id": "doubao-seed-2-0-mini-260428",
        "displayName": "Seed 2.0 Mini",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 131072
      },
      {
        "id": "doubao-seed-2-0-code-preview-260215",
        "displayName": "Seed 2.0 Code",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "xhigh": null,
          "max": null
        },
        "contextWindow": 262144,
        "maxOutputTokens": 131072
      },
      {
        "id": "doubao-seed-2-0-pro-260215",
        "displayName": "Seed 2.0 Pro",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "thinkingLevelMap": {
          "xhigh": null,
          "max": null
        },
        "contextWindow": 256000,
        "maxOutputTokens": 128000
      }
    ]
  },
  {
    "id": "stepfun",
    "displayName": "StepFun (China)",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://api.stepfun.com/v1",
    "apiKeyUrl": "https://platform.stepfun.com/interface-key",
    "requiresApiKey": true,
    "defaultEnvVar": "STEPFUN_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "step-3.7-flash",
        "displayName": "Step 3.7 Flash",
        "supportsVision": true,
        "supportsVideo": true,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "step-3.5-flash-2603",
        "displayName": "Step 3.5 Flash 2603",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "step-3.5-flash",
        "displayName": "Step 3.5 Flash",
        "supportsVision": false,
        "supportsTools": true,
        "supportsReasoning": true,
        "contextWindow": 256000,
        "maxOutputTokens": 256000
      },
      {
        "id": "stepaudio-2.5-asr",
        "displayName": "StepAudio 2.5 ASR",
        "supportsVision": false,
        "supportsTools": false,
        "supportsReasoning": false
      }
    ]
  },
  {
    "id": "infini",
    "displayName": "无问芯穹 Infini-AI",
    "group": "cn",
    "kind": "chat",
    "protocol": "openai-completions",
    "baseUrl": "https://cloud.infini-ai.com/maas/v1",
    "apiKeyUrl": "https://cloud.infini-ai.com/genstudio/model",
    "requiresApiKey": true,
    "defaultEnvVar": "INFINI_API_KEY",
    "hasLogo": true,
    "models": []
  },
  {
    "id": "typesafe",
    "displayName": "TypeSafe（结构化判定）",
    "group": "judge",
    "kind": "judge",
    "protocol": "openai-completions",
    "baseUrl": "https://api.typesafe.ai/v1",
    "apiKeyUrl": "https://console.typesafe.ai/",
    "requiresApiKey": true,
    "defaultEnvVar": "TYPESAFE_API_KEY",
    "hasLogo": false,
    "models": [
      {
        "id": "jev-latest",
        "displayName": "Jev（最新）"
      },
      {
        "id": "jev-1.13.0",
        "displayName": "Jev 1.13（锁定版本）"
      }
    ]
  },
  {
    "id": "doubao-stt",
    "displayName": "豆包语音识别 STT 2.0",
    "group": "stt",
    "kind": "stt",
    "protocol": "openai-completions",
    "baseUrl": "https://openspeech.bytedance.com/api/v3/sauc/bigmodel",
    "apiKeyUrl": "https://console.volcengine.com/speech/new/setting/apikeys",
    "requiresApiKey": true,
    "defaultEnvVar": "VOLCENGINE_SPEECH_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "volc.seedasr.sauc.duration",
        "displayName": "豆包 STT 2.0（小时版）"
      },
      {
        "id": "volc.seedasr.sauc.concurrent",
        "displayName": "豆包 STT 2.0（并发版）"
      }
    ]
  },
  {
    "id": "alibaba-asr",
    "displayName": "阿里云 Qwen-Audio 语音识别",
    "group": "stt",
    "kind": "stt",
    "protocol": "openai-completions",
    "baseUrl": "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    "apiKeyUrl": "https://bailian.console.aliyun.com/?apiKey=1",
    "requiresApiKey": true,
    "defaultEnvVar": "DASHSCOPE_API_KEY",
    "hasLogo": true,
    "models": [
      {
        "id": "qwen-audio-3.1-asr-flash-streaming",
        "displayName": "Qwen-Audio 3.1 ASR Flash Streaming"
      },
      {
        "id": "qwen-audio-3.0-asr-flash-streaming",
        "displayName": "Qwen-Audio 3.0 ASR Flash Streaming"
      },
      {
        "id": "fun-asr-realtime",
        "displayName": "Fun-ASR Realtime"
      }
    ]
  }
] as CatalogEntry[])
