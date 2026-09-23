/**
 * 创作者 Token Plan 的 IPC。
 *
 *   creator-plan:state       卡片状态。没连接时直接回，**不发请求**
 *   creator-plan:connect     设备授权 → 存 Key → 拉清单 → 回导入预览
 *                            （码通过 creator-plan:device-code 事件推给渲染层）
 *   creator-plan:cancel      取消正在进行的授权
 *   creator-plan:preview     已连接时重新拉清单，回导入预览
 *   creator-plan:apply       按用户勾选的角色落盘
 *   creator-plan:disconnect  删来源、清绑定、删本机 Key
 *
 * 没连接时，这里没有任何代码会发请求：连接这件事只能由用户点按钮发起。
 */

import { hostname } from 'node:os'
import { app, ipcMain, shell } from 'electron'
import type { ModelRole } from '../../../shared/aiProvider'
import type {
  CreatorPlanManifest,
  CreatorPlanPreview,
  CreatorPlanResult,
  CreatorPlanState
} from '../../../shared/creatorPlan'
import {
  EncryptionUnavailableError,
  deleteLiteralKey,
  resolveApiKey,
  saveLiteralKey
} from '../credentials'
import { invalidateSettingsCache, readSettings, writeSettings } from '../store'
import {
  PLAN_KEY_ID,
  applyPlan,
  isPlanProvider,
  managedRoles,
  planRoleChanges,
  planSummary,
  removePlan
} from './apply'
import { CreatorPlanError, fetchManifest, pollForKey, startDeviceAuthorization } from './client'
import { CREATOR_PLAN_ORIGIN } from './endpoint'

/** 正在进行的设备授权，用来取消 */
let pending: AbortController | null = null
/** 预览时拉到的清单，确认导入时直接用，不再拉一次 */
let pendingManifest: CreatorPlanManifest | null = null

function fail(error: unknown): { ok: false; code: CreatorPlanError['code']; error: string } {
  if (error instanceof CreatorPlanError)
    return { ok: false, code: error.code, error: error.message }
  if (error instanceof EncryptionUnavailableError) {
    return { ok: false, code: 'encryption_unavailable', error: error.message }
  }
  return {
    ok: false,
    code: 'unknown',
    error: error instanceof Error ? error.message : String(error)
  }
}

/**
 * 已连接时：套餐来源的地址和 Key。没连接回 null。
 * 来源在、Key 却取不出来（密钥库被清、换了机器）时 apiKey 为 null，按「授权失效」处理。
 */
async function connection(): Promise<{ baseUrl: string; apiKey: string | null } | null> {
  const settings = await readSettings()
  const provider = settings.providers.find((p) => isPlanProvider(p.id))
  if (!provider) return null
  const apiKey = await resolveApiKey(provider.apiKey).catch(() => null)
  return { baseUrl: provider.baseUrl, apiKey: apiKey || null }
}

async function preview(manifest: CreatorPlanManifest): Promise<CreatorPlanPreview> {
  return {
    summary: planSummary(manifest),
    changes: planRoleChanges(await readSettings(), manifest)
  }
}

export function registerCreatorPlanIPC(): void {
  ipcMain.handle('creator-plan:state', async (): Promise<CreatorPlanResult<CreatorPlanState>> => {
    try {
      invalidateSettingsCache()
      const settings = await readSettings()
      const roles = managedRoles(settings)
      const conn = await connection()
      if (!conn) {
        return {
          ok: true,
          data: { connected: false, summary: null, managedRoles: [], error: null }
        }
      }
      if (!conn.apiKey) {
        return {
          ok: true,
          data: { connected: true, summary: null, managedRoles: roles, error: 'unauthorized' }
        }
      }
      try {
        const manifest = await fetchManifest(conn.baseUrl, conn.apiKey)
        return {
          ok: true,
          data: {
            connected: true,
            summary: planSummary(manifest),
            managedRoles: roles,
            error: null
          }
        }
      } catch (error) {
        const code = error instanceof CreatorPlanError ? error.code : 'unknown'
        return {
          ok: true,
          data: { connected: true, summary: null, managedRoles: roles, error: code }
        }
      }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(
    'creator-plan:connect',
    async (event): Promise<CreatorPlanResult<CreatorPlanPreview>> => {
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      try {
        const start = await startDeviceAuthorization(CREATOR_PLAN_ORIGIN, {
          deviceName: hostname(),
          clientVersion: app.getVersion()
        })
        if (!event.sender.isDestroyed()) event.sender.send('creator-plan:device-code', start.prompt)
        if (start.prompt.verificationUri) void shell.openExternal(start.prompt.verificationUri)

        const issued = await pollForKey(CREATOR_PLAN_ORIGIN, start, controller.signal)
        const manifest = await fetchManifest(issued.baseUrl, issued.apiKey)
        // Key 先存进安全存储；来源和绑定等用户在预览里确认后才落盘
        await saveLiteralKey(PLAN_KEY_ID, issued.apiKey)
        pendingManifest = manifest
        return { ok: true, data: await preview(manifest) }
      } catch (error) {
        return fail(error)
      } finally {
        if (pending === controller) pending = null
      }
    }
  )

  ipcMain.handle('creator-plan:cancel', () => {
    pending?.abort()
    pending = null
  })

  ipcMain.handle(
    'creator-plan:preview',
    async (): Promise<CreatorPlanResult<CreatorPlanPreview>> => {
      try {
        const conn = await connection()
        if (!conn) return { ok: false, code: 'not_connected', error: 'Not connected' }
        if (!conn.apiKey) return { ok: false, code: 'unauthorized', error: 'Key missing' }
        const manifest = await fetchManifest(conn.baseUrl, conn.apiKey)
        pendingManifest = manifest
        return { ok: true, data: await preview(manifest) }
      } catch (error) {
        return fail(error)
      }
    }
  )

  ipcMain.handle(
    'creator-plan:apply',
    async (_event, roles: ModelRole[]): Promise<CreatorPlanResult<CreatorPlanState>> => {
      try {
        const manifest = pendingManifest
        if (!manifest) return { ok: false, code: 'not_connected', error: 'Connect first' }
        const settings = applyPlan(
          await readSettings(),
          manifest,
          { kind: 'literal', id: PLAN_KEY_ID },
          Array.isArray(roles) ? roles : []
        )
        const written = await writeSettings(settings)
        pendingManifest = null
        return {
          ok: true,
          data: {
            connected: true,
            summary: planSummary(manifest),
            managedRoles: managedRoles(written),
            error: null
          }
        }
      } catch (error) {
        return fail(error)
      }
    }
  )

  ipcMain.handle('creator-plan:disconnect', async (): Promise<CreatorPlanResult<null>> => {
    try {
      pendingManifest = null
      await writeSettings(removePlan(await readSettings()))
      await deleteLiteralKey(PLAN_KEY_ID)
      return { ok: true, data: null }
    } catch (error) {
      return fail(error)
    }
  })
}
