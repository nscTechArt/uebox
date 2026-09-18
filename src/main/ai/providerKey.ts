import { app } from 'electron'
import { readSettings } from './store'
import { resolveApiKey } from './credentials'

/**
 * 取用户为某个 provider 配的 API Key（BYOK）。
 *
 * 一批「服务端只是代持 Key」的能力靠这个把官方服务端摘掉：网页搜索、深度研究、
 * 视频解析，服务端做的都是拿平台 Key 转发一次加上计费。用户自己配了 Key，
 * 就没有理由再绕那一圈 —— 那是他自己的额度。
 *
 * `envVar` 那条兜底**只在开发环境生效**：`.env.production` 会被 dotenv 读进
 * `process.env` 并随安装包发布，在打包版里认它等于把平台 Key 发给每一个用户。
 */
export async function resolveProviderApiKey(
  providerId: string,
  envVar?: string
): Promise<string | undefined> {
  try {
    const settings = await readSettings()
    const provider = settings.providers.find((item) => item.id === providerId)
    if (provider) {
      const key = await resolveApiKey(provider.apiKey)
      if (key) return key
    }
  } catch {
    // 密钥库读不出来（safeStorage 不可用、取密钥的外部命令失败）不该让调用方整个报错，
    // 落到下面的兜底
  }

  if (!envVar || app.isPackaged) return undefined
  return process.env[envVar] || undefined
}
