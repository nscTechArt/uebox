/**
 * 状态监控的数据：问插件要原始测量，加上 Zen 的缓存占盘，按 Epic 的预期值判好坏。
 *
 * 顶栏的状态监控按钮（IPC `ue:editorHealth:get`）和 AI 工具 `ue_editor_health`
 * 都走这里 —— 同一个工程，面板上和 AI 嘴里的数字必须是同一份。
 */

import { serviceManager } from './index'
import { summarizeCacheStats } from '../agent-v3/tools/adapted/ue-system/zenStats'
import {
  evaluateEditorHealth,
  type EditorHealthRaw,
  type EditorHealthResult
} from '../../shared/editorHealth'

export type { EditorHealthResult }

export const EDITOR_HEALTH_METHOD = 'system.get_editor_health'

const ZEN_TIMEOUT_MS = 2000

/**
 * Zen 本地缓存一共占了多少盘：结构化缓存 + 数据块，两块不重叠。
 * Zen 没在跑（工程没用 Zen 做本地缓存）就是 null，那一行显示「—」。
 */
async function readZenCacheDiskBytes(): Promise<number | null> {
  try {
    const res = await fetch('http://127.0.0.1:8558/stats/z$', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(ZEN_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const cache = summarizeCacheStats(await res.json())
    if (cache.cache_disk_bytes == null && cache.cas_disk_bytes == null) return null
    return (cache.cache_disk_bytes ?? 0) + (cache.cas_disk_bytes ?? 0)
  } catch {
    return null
  }
}

export async function fetchEditorHealth(connectionId?: string): Promise<EditorHealthResult> {
  const ws = serviceManager.getWebSocketService()
  if (!connectionId && ws.getConnectionCount() === 0) return { status: 'not_connected' }

  let raw: EditorHealthRaw & { ok?: boolean; code?: number; error?: string }
  try {
    const [response, cacheDiskBytes] = await Promise.all([
      ws.callRequest<typeof raw>(EDITOR_HEALTH_METHOD, {}, connectionId, 10000),
      readZenCacheDiskBytes()
    ])
    raw = response
    if (raw?.ok === false) {
      if (raw.code === 404) return { status: 'plugin_outdated' }
      return { status: 'error', error: raw.error ?? '插件没有返回状态数据' }
    }
    return { status: 'ok', report: evaluateEditorHealth(raw, { cacheDiskBytes }), raw }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
