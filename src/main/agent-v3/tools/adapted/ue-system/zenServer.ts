/**
 * ZenServer 只读诊断：本地缓存的命中率、占盘，以及它替哪些工程存着东西。
 *
 * ## 为什么不经过插件
 *
 * ZenServer 是引擎拉起来的一个独立本地服务（默认 127.0.0.1:8558），自带 HTTP 接口。
 * 盒子直接去问它就行，插件里没有任何一条命令需要为此新增 —— 少一跳，也不受
 * 插件版本影响。
 *
 * ## 为什么离线时不去扫磁盘
 *
 * Zen 随编辑器起、随编辑器退（实测：关掉编辑器几秒后进程就没了）。它不在的时候，
 * 唯一的办法是去数 `Zen/Data` 下的文件 —— 而 `cas/` 里是海量小文件，实测
 * 一次 `du` 两分钟没跑完。用户同时在这台机器上干活，这种全目录遍历不该由一次
 * 工具调用顺手发起。所以不在就如实说不在，让用户开着编辑器再问。
 *
 * ## 只读
 *
 * Zen 也有清理接口（GC、删掉某个工程的记录），这里一个都不调。
 * 清缓存会让下次打开工程重新编译着色器，是用户该自己拍板的事。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import * as fs from 'fs'
import { getTargetProjectPath } from '../../../core/projectTargetContext'
import {
  formatBytes,
  summarizeCacheStats,
  summarizeProjects,
  type ZenCacheStatsRaw,
  type ZenProjectRaw
} from './zenStats'

export const ZEN_SERVER_TOOL_NAME = 'ue_zen_server'

const DEFAULT_PORT = 8558
const REQUEST_TIMEOUT_MS = 5000

const ZenServerSchema = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe('ZenServer 端口，默认 8558。只有用户说过改了端口才填')
})

class ZenUnreachableError extends Error {}

async function getJson<T>(base: string, path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      // 不带这个头，Zen 回的是二进制 CbObject
      headers: { Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
  } catch (error) {
    throw new ZenUnreachableError(error instanceof Error ? error.message : String(error))
  }
  if (!res.ok) throw new Error(`${path} 返回 HTTP ${res.status}`)
  return (await res.json()) as T
}

export function createZenServerTool(): V2Tool {
  return defineV2Tool({
    description: `查本机 ZenServer（引擎的本地缓存服务）的状态：缓存命中率、占了多少硬盘、替哪些工程存着数据。只读。

【什么时候用】
- 「打开工程/进 PIE 总在编译着色器」「加载特别慢」—— 看命中率。命中率低说明派生数据在反复重算
- 「C 盘被 UE 吃了」「缓存能不能清」—— 看占盘和工程列表
- 工程列表里 project_file_missing=true 的，工程文件已经不在磁盘上，缓存大概率没人再用

【读数要带上下文】
- 命中/未命中是 ZenServer **这次启动以来**的累计，不是历史总账。sample_too_small=true 时次数太少，别下结论
- 刚升级引擎、刚清过缓存、第一次打开某个工程，命中率低是正常的
- 缓存占盘和数据块占盘是两块不同的磁盘占用，都要报

【局限】
- ZenServer 随编辑器启动、随编辑器退出。连不上时先确认编辑器开着；工程也可能根本没用 Zen 做本地缓存
- 本工具不清理任何东西。用户要清缓存，说清影响（下次打开要重新编译着色器），由用户决定`,

    inputSchema: ZenServerSchema,

    execute: async (input, options) => {
      const port = input.port ?? DEFAULT_PORT
      const base = `http://127.0.0.1:${port}`
      const signal = options?.abortSignal

      let cacheRaw: ZenCacheStatsRaw
      try {
        cacheRaw = await getJson<ZenCacheStatsRaw>(base, '/stats/z$', signal)
      } catch (error) {
        if (error instanceof ZenUnreachableError) {
          return {
            success: false,
            error:
              `ZenServer 没在 127.0.0.1:${port} 上响应。它随编辑器启动、随编辑器退出 —— ` +
              '先确认编辑器开着；开着还连不上，说明这个工程没用 Zen 做本地缓存，或者端口改过。'
          }
        }
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }

      // 版本和工程列表是锦上添花，拿不到不影响缓存那部分
      const [info, projectsRaw] = await Promise.all([
        getJson<{ BuildVersion?: string }>(base, '/health/info', signal).catch(() => null),
        getJson<ZenProjectRaw[]>(base, '/prj/', signal).catch(() => null)
      ])

      const cache = summarizeCacheStats(cacheRaw)
      const projects = summarizeProjects(projectsRaw, getTargetProjectPath(), (p) =>
        fs.existsSync(p)
      )
      const missing = projects.filter((p) => p.project_file_missing)
      const version = typeof info?.BuildVersion === 'string' ? info.BuildVersion : null

      const lines: string[] = []
      // 完整串形如 5.8.13-202605190912-windows-x64-release-…，消息里只留版本号
      lines.push(`ZenServer${version ? ` ${version.split('-')[0]}` : ''} 在 127.0.0.1:${port}。`)
      if (cache.hit_ratio_percent != null) {
        const lookups = (cache.hits ?? 0) + (cache.misses ?? 0)
        lines.push(
          `本次启动以来缓存命中率 ${cache.hit_ratio_percent}%（${cache.hits ?? '?'}/${lookups}）` +
            (cache.sample_too_small ? '，次数太少，还说明不了问题。' : '。')
        )
      }
      lines.push(
        `缓存占盘 ${formatBytes(cache.cache_disk_bytes)}，数据块占盘 ${formatBytes(cache.cas_disk_bytes)}。`
      )
      if (projectsRaw) {
        lines.push(
          `登记了 ${projects.length} 个工程` +
            (missing.length > 0 ? `，其中 ${missing.length} 个的工程文件已不在磁盘上。` : '。')
        )
      } else {
        lines.push('工程列表没拿到（/prj/ 没有响应），只报缓存部分。')
      }

      return {
        success: true,
        port,
        zen_version: version,
        cache,
        projects: projectsRaw ? projects : null,
        message: lines.join('')
      }
    }
  })
}
