/**
 * 服务端资产库（新后端）主进程入口：懒创建的单例。
 *
 * 不打开资产库、不添加服务器，就不创建、不发任何请求 —— 离线启动零网络。
 */
import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { sendToAppWindows } from '../appWindows'
import { logger } from '../services/logger'
import { CatalogService } from './catalogService'
import { resolveLoreBinary, type LoreBinary } from './loreCli'
import { shadowRootFor } from './shadowRoot'

export const CATALOG_EVENT_CHANNEL = 'catalogLibrary:event'

let service: CatalogService | null = null
let loreCache: Promise<{ binary: LoreBinary | null; problem: string | null }> | null = null

function resourcesRoots(): string[] {
  return app.isPackaged ? [process.resourcesPath] : [join(app.getAppPath(), 'resources')]
}

export function resolveLore(): Promise<{ binary: LoreBinary | null; problem: string | null }> {
  if (!loreCache) {
    loreCache = resolveLoreBinary({
      resourcesRoots: resourcesRoots(),
      envPath: process.env.UNREAL_BOX_LORE_PATH || null
    }).then((result) => {
      // 没找到不缓存：开发时放进去之后不用重启
      if (!result.binary) loreCache = null
      return result
    })
  }
  return loreCache
}

export function getCatalogService(): CatalogService {
  if (service) return service
  const userData = app.getPath('userData')
  service = new CatalogService({
    userDataDir: userData,
    shadowRoot: shadowRootFor(userData),
    codec: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (data) => safeStorage.decryptString(data)
    },
    emit: (event) => {
      // 只记本机日志（不外发）：排查"为什么列表刷新了 / 没刷新"时看得到
      if (event.kind === 'invalidate') {
        const scope = event.scope === 'all' ? 'all' : `${event.scope.paths.length} folder(s)`
        logger.info(
          `[catalog] ${event.key} invalidated (${event.reason}): ${scope}, generation ${event.generation}, epoch ${event.epoch}`
        )
      } else if (
        event.kind === 'job' &&
        (event.job.phase === 'done' || event.job.phase === 'failed')
      ) {
        logger.info(
          `[catalog] ${event.key} ${event.job.type} ${event.job.phase}${event.job.error ? `: ${event.job.error}` : ''}`
        )
      }
      sendToAppWindows(CATALOG_EVENT_CHANNEL, event)
    },
    resolveLore,
    copyPackage: async (sourceSeed, targetSeed) => {
      // 复用工程导入的"整包复制"（.uasset + .uexp/.ubulk 等分片一起，已存在且同大小的跳过）
      const { copyUnrealPackage } = await import('../ipc/projectImport')
      return await copyUnrealPackage(sourceSeed, targetSeed)
    },
    sessionLabel: `Unreal Box on ${process.env.COMPUTERNAME || 'this computer'}`
  })
  return service
}

/** 协议处理器：没创建服务就说明没有服务端库，直接 404 */
export async function handlePreviewRequest(request: Request): Promise<Response> {
  return await getCatalogService().previews.handle(request)
}

export function disposeCatalogService(): void {
  service?.dispose()
  service = null
}
