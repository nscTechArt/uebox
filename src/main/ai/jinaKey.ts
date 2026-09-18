import { resolveProviderApiKey } from './providerKey'

/** 内置目录里 Jina 的 provider id，见 scripts/sync-provider-catalog.mjs 的「向量化」一组 */
const JINA_PROVIDER_ID = 'jina'

/**
 * 取用户自己的 Jina API Key（BYOK）。
 *
 * 网页读取、网页搜索、深度研究打的是 Jina 的同一套服务
 * （`r.jina.ai` / `s.jina.ai` / `deepsearch.jina.ai`），**共用同一把 Key**。
 * 这个模块存在的理由就是这个：解析逻辑原先是 `sqliteDataBase/ipc/jina.ts` 的
 * 私有函数，深度研究看不见它；这条共享解析让三项能力都能直接使用用户的 Key。
 *
 * 两个来源，顺序有讲究：
 *
 * 1. **用户在 设置 → 模型 里配的 `jina` Provider**（首选）。
 *    Jina 是内置目录里的一个向量化厂商，密钥经 safeStorage 加密存放。
 *    同一把 Key 既做向量化也做搜索/读取/深度研究 —— 对用户来说本来就是一把，
 *    不该让他为了搜网页再去设一个环境变量、再重启一次应用。
 *
 * 2. **`JINA_API_KEY` 环境变量**，且**仅在非打包环境**。
 *    这一条不能放开到打包环境：electron-builder 的 files 白名单没排除
 *    `.env.production`，而 services/config.ts 在 `app.isPackaged` 时会把它
 *    dotenv 进 `process.env` —— 开发者的 Key 可能被打进 asar 并泄露给所有正式用户。
 *
 * 用户自己配置的密钥通过 safeStorage 保存，不存在这个泄露问题。
 */
export async function resolveJinaApiKey(): Promise<string | undefined> {
  return resolveProviderApiKey(JINA_PROVIDER_ID, 'JINA_API_KEY')
}

/**
 * 缺 Key 时给用户的提示。
 *
 * 刻意不写「请先登录」：社区版没有登录这回事，那句话是条死路 —— 用户照着做不了
 * 任何事，只会当成 bug 去提 issue。这里给的是一条真能走通的路。
 */
export const JINA_KEY_MISSING_HINT =
  '需要 Jina API Key。到 https://jina.ai 申请一个（有免费额度），' +
  '在 设置 → 模型 里把它填进 Jina 这个服务商即可。'
