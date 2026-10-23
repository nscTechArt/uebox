/**
 * 分享用的 UEBox 账户。
 *
 * 账户和 Token Plan 是同一套（账户站 uebox.ai，服务在 plan.uebox.ai 背后的同一个进程里）。
 * 盒子要证明「我是哪个账户」只有一种办法：设备授权领到的 API Key。
 *
 * - 已经在「设置 → 模型」里连了 Token Plan：直接用那把 Key，不再要一次授权。
 * - 没连：分享框里点「连接账户」，走同一个设备授权（浏览器打开 uebox.ai/connect），Key 单独存一份。
 *
 * 同一台设备重新授权时服务端会吊销它的旧 Key（见 creatorPlan/deviceId.ts）。所以后来再连 Token Plan，
 * 这里单独存的那把会失效 —— 没关系，有 Token Plan 的 Key 时本来就优先用它。
 */

import { hostname } from 'node:os'
import { app } from 'electron'

import { deleteLiteralKey, resolveApiKey, saveLiteralKey } from '../../ai/credentials'
import { pollForKey, startDeviceAuthorization } from '../../ai/creatorPlan/client'
import { readOrCreateDeviceId } from '../../ai/creatorPlan/deviceId'
import { CREATOR_PLAN_ORIGIN } from '../../ai/creatorPlan/endpoint'
import { planConnection } from '../../ai/creatorPlan/refresh'

/** 安全存储里这把 Key 的名字。只在没连 Token Plan 时用 */
const SHARE_KEY_ID = 'uebox-account'

export async function accountKey(): Promise<string | null> {
  const plan = await planConnection().catch(() => null)
  if (plan?.apiKey) return plan.apiKey
  return resolveApiKey({ kind: 'literal', id: SHARE_KEY_ID }).catch(() => null) || null
}

/** 账户的显示名（技能页上的作者名）。Key 失效或连不上回 null */
export async function accountName(apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${CREATOR_PLAN_ORIGIN}/v1/plan`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { account?: { name?: unknown } }
    return typeof data.account?.name === 'string' ? data.account.name : null
  } catch {
    return null
  }
}

let pending: AbortController | null = null

/**
 * 设备授权：返回校验码和网页地址给界面显示（浏览器由调用方打开），等用户在网页上点「允许」后存下 Key。
 */
export async function connectAccount(
  onPrompt: (prompt: { userCode: string; verificationUri: string }) => void
): Promise<void> {
  pending?.abort()
  const controller = new AbortController()
  pending = controller
  try {
    const start = await startDeviceAuthorization(CREATOR_PLAN_ORIGIN, {
      deviceName: hostname(),
      clientVersion: app.getVersion(),
      deviceId: await readOrCreateDeviceId(app.getPath('userData'))
    })
    onPrompt(start.prompt)
    const issued = await pollForKey(CREATOR_PLAN_ORIGIN, start, controller.signal)
    await saveLiteralKey(SHARE_KEY_ID, issued.apiKey)
  } finally {
    if (pending === controller) pending = null
  }
}

export function cancelConnect(): void {
  pending?.abort()
  pending = null
}

/** Key 被服务端判为无效时丢掉，下次重新授权 */
export async function forgetAccountKey(): Promise<void> {
  await deleteLiteralKey(SHARE_KEY_ID).catch(() => undefined)
}
