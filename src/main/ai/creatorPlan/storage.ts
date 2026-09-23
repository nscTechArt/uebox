/**
 * 套餐连接和对象存储的关系：导入时勾了「对象存储」就换成套餐的存储（`uebox` 预设），断开时还原。
 *
 * 和角色绑定同一个思路：
 * - 清单 `storage.enabled` 为假，导入预览里就没有这一项。
 * - 默认勾不勾：没开对象存储、或者本来就是套餐的，勾；自己配好了桶的，不勾。
 * - 换之前把原来的整份配置记进套餐的状态文件（`planState.storageOriginal`），重新导入不覆盖最初那份。
 *   只换预设、打开开关；桶名、地址这些原样留在配置里，Secret 在安全存储里也不动。
 * - 重新导入时取消勾选、或者断开：还是套餐存储的，照着原来那份还原。
 *   用户自己在设置页换过的（预设已经不是 `uebox`），不动，只把记录丢掉。
 *
 * 都只动本机文件，不发请求。
 */

import type { CreatorPlanManifest, CreatorPlanStoragePreview } from '../../../shared/creatorPlan'
import { PLAN_OBJECT_STORAGE_PRESET, type ObjectStorageConfig } from '../../../shared/objectStorage'
import {
  getObjectStorageView,
  readObjectStorageConfig,
  saveObjectStorageConfig
} from '../../services/objectStorage/objectStorageService'
import { readPlanState, writePlanState } from './planState'

/** 自己的桶配好了没：开着、必填的都有、Secret 存过 */
async function ownStorageInUse(): Promise<{ preset: string; bucket: string } | null> {
  const view = await getObjectStorageView()
  if (!view.enabled || view.preset === PLAN_OBJECT_STORAGE_PRESET) return null
  const complete = view.endpoint && view.region && view.bucket && view.accessKeyId && view.hasSecret
  return complete ? { preset: view.preset, bucket: view.bucket } : null
}

/** 导入预览里「对象存储」那一行。套餐不带存储回 null */
export async function planStoragePreview(
  manifest: CreatorPlanManifest
): Promise<CreatorPlanStoragePreview | null> {
  const spec = manifest.storage
  if (spec?.enabled !== true) return null
  const config = await readObjectStorageConfig()
  const own = await ownStorageInUse()
  const current: CreatorPlanStoragePreview['current'] =
    config.enabled && config.preset === PLAN_OBJECT_STORAGE_PRESET
      ? { kind: 'plan' }
      : own
        ? { kind: 'own', ...own }
        : { kind: 'none' }
  return {
    quotaBytes: spec.quota_bytes,
    maxObjectBytes: spec.max_object_bytes,
    retentionDays: spec.retention_days,
    current,
    defaultSelected: current.kind !== 'own'
  }
}

/**
 * 还原成接管前的配置。已经不是套餐存储的（用户自己换过）不动，只丢记录。
 * 没有记录却还是套餐存储的（状态文件丢了），关掉开关、预设回默认。
 */
export async function restorePlanStorage(): Promise<void> {
  const state = await readPlanState()
  const config = await readObjectStorageConfig()
  if (config.preset === PLAN_OBJECT_STORAGE_PRESET) {
    const original: ObjectStorageConfig = state.storageOriginal ?? {
      ...config,
      enabled: false,
      preset: 'aliyun'
    }
    // 原来那份也可能是 uebox（记录被手改过）：那就同样关掉，免得断开后还指着套餐
    await saveObjectStorageConfig(
      original.preset === PLAN_OBJECT_STORAGE_PRESET
        ? { ...original, enabled: false, preset: 'aliyun' }
        : original
    )
  }
  if (state.storageOriginal) {
    const next = { ...state }
    delete next.storageOriginal
    await writePlanState(next)
  }
}

/**
 * 导入时落实「对象存储」这一项。
 *
 * @param wanted 预览里勾没勾；undefined = 这次导入没带这一项（老的调用方），不动
 */
export async function applyPlanStorage(
  manifest: CreatorPlanManifest,
  wanted: boolean | undefined
): Promise<void> {
  if (wanted === undefined) return
  if (!wanted || manifest.storage?.enabled !== true) {
    await restorePlanStorage()
    return
  }
  const config = await readObjectStorageConfig()
  const state = await readPlanState()
  // 先记原配置再切：反过来的话，切完了记录没写成，断开时就还原不回去了
  if (!state.storageOriginal && config.preset !== PLAN_OBJECT_STORAGE_PRESET) {
    await writePlanState({ ...state, storageOriginal: config })
  }
  await saveObjectStorageConfig({ ...config, enabled: true, preset: PLAN_OBJECT_STORAGE_PRESET })
}
