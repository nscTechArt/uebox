/**
 * 套餐连接的本机状态：`creator-plan.json`，和 models.json 放在同一个目录。
 *
 * 不塞进 models.json：那个文件是用户可见、可手改的公共结构，套餐这点私有账
 * （接管前的原绑定、清单缓存）混进去只会让它更难读。Key 也不在这里，在密钥库。
 *
 *   originals     导入时被套餐接管的角色原来绑的是什么，断开时照着还原
 *   etag          上次清单的 ETag，下次拉带 If-None-Match
 *   manifest      上次拉到的清单。304 时用它；断网时卡片也还有东西可显示
 *   unauthorized  上次拉清单回了 401（Key 被吊销或删掉）
 *
 * 读坏了按空状态处理 —— 丢的只是还原信息和缓存，不该让设置页打不开。
 */

import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import { MODEL_ROLES, type ModelRole } from '../../../shared/aiProvider'
import type { CreatorPlanManifest } from '../../../shared/creatorPlan'
import type { OriginalBindings } from './apply'

const STATE_FILE = 'creator-plan.json'

export interface PlanState {
  originals: OriginalBindings
  etag: string | null
  manifest: CreatorPlanManifest | null
  unauthorized: boolean
}

export const EMPTY_PLAN_STATE: PlanState = Object.freeze({
  originals: {},
  etag: null,
  manifest: null,
  unauthorized: false
}) as PlanState

function statePath(): string {
  return join(app.getPath('userData'), STATE_FILE)
}

function normalizeOriginals(raw: unknown): OriginalBindings {
  if (!raw || typeof raw !== 'object') return {}
  const out: OriginalBindings = {}
  for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!MODEL_ROLES.includes(role as ModelRole)) continue
    const binding = value as { providerId?: unknown; modelId?: unknown } | null
    if (binding === null) {
      out[role as ModelRole] = null
    } else if (typeof binding?.providerId === 'string' && typeof binding.modelId === 'string') {
      out[role as ModelRole] = { providerId: binding.providerId, modelId: binding.modelId }
    }
  }
  return out
}

export function normalizePlanState(raw: unknown): PlanState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PLAN_STATE, originals: {} }
  const source = raw as Record<string, unknown>
  const manifest = source.manifest as CreatorPlanManifest | null | undefined
  return {
    originals: normalizeOriginals(source.originals),
    etag: typeof source.etag === 'string' && source.etag ? source.etag : null,
    manifest:
      manifest && manifest.schema === 1 && manifest.plan && typeof manifest.roles === 'object'
        ? manifest
        : null,
    unauthorized: source.unauthorized === true
  }
}

export async function readPlanState(): Promise<PlanState> {
  try {
    return normalizePlanState(JSON.parse(await fs.readFile(statePath(), 'utf-8')))
  } catch {
    return { ...EMPTY_PLAN_STATE, originals: {} }
  }
}

export async function writePlanState(state: PlanState): Promise<void> {
  const path = statePath()
  await fs.mkdir(dirname(path), { recursive: true })
  // 先写临时文件再改名：写到一半断电不至于把原绑定记录弄成半截 JSON
  const temp = `${path}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  await fs.rename(temp, path)
}

export async function updatePlanState(patch: Partial<PlanState>): Promise<PlanState> {
  const next = { ...(await readPlanState()), ...patch }
  await writePlanState(next)
  return next
}

/** 断开时整份删掉 */
export async function clearPlanState(): Promise<void> {
  await fs.rm(statePath(), { force: true })
}
