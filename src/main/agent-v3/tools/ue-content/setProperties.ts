/**
 * ue_content_set_properties —— 改资产自身的设置（细节面板里那些），按路径一次一批。
 *
 * 专家在细节面板里点几下的事：静态网格开关 Nanite、碰撞复杂度、LOD 组；贴图的 sRGB、
 * 压缩设置、最大尺寸、翻转绿通道、不串流。以前技能里只能给 Python 片段 ——
 * 属性名和枚举写法逐版本不同，写错了不报；而且审批和撤销都看不见那段脚本。
 *
 * 引擎侧在 `UAL_AssetPropertyCommands.cpp`：走细节面板同一条通知路
 * （事务 → Modify → PreEditChange → 写 → PostEditChangeChainProperty），
 * 网格因此会重建 Nanite 数据、贴图会重新压缩；写完等后台构建结束再逐条读回。
 * 回执的「实际值」一律是引擎读回来的，不是把请求原样念一遍（AGENTS.md §5 第 14 条）。
 */

import { z } from 'zod'

import { defineUeTool } from '../defineUeTool'
import { describeFailures, partialHeadline, type PartialFailure } from '../partialResult'
import { NAMESPACE } from './namingAudit'

export interface AssetPropertyResult {
  property: string
  requested: unknown
  /** 写之前的值 */
  before?: unknown
  /** 引擎读回来的值 */
  actual?: unknown
  ok: boolean
  /** 本来就是这个值，没动 */
  unchanged?: boolean
  /** not_found | invalid_path | not_editable | read_only | type_mismatch | value_mismatch */
  reason?: string
  error?: string
  /** 写进去了但读不回来（序列化不了的类型） */
  actual_unavailable?: string
}

export interface SetAssetPropertiesResponse {
  ok: boolean
  asset_path: string
  asset_class: string
  results: AssetPropertyResult[]
  succeeded_count: number
  failed_count: number
  changed_count: number
  saved: boolean
  save_error?: string
  dirty: boolean
  reopened_editor?: boolean
  notes?: string[]
  error?: string
}

const SetPropertiesInput = z.object({
  asset_path: z
    .string()
    .min(1)
    .describe('资产路径，如 /Game/Props/SM_Rock、/Game/Textures/T_Rock_ORM'),
  properties: z
    .record(z.string(), z.unknown())
    .refine((value) => Object.keys(value).length > 0, { message: 'properties 至少要有一项' })
    .describe(
      '属性路径 → 值。路径用 C++ 属性名，进结构体或资产自带的子对象用点号（NaniteSettings.bEnabled、' +
        'BodySetup.CollisionTraceFlag）；枚举写引擎里的名字（TC_Masks、TEXTUREGROUP_World、CTF_UseComplexAsSimple）'
    ),
  save: z.boolean().optional().describe('改完立刻存盘，默认 true')
})

/** 网格开 Nanite / 换 LOD 组会同步重建，大网格几十秒；贴图重新压缩也要时间 */
const SET_PROPERTIES_TIMEOUT_MS = 5 * 60 * 1000

function show(value: unknown): string {
  if (value === undefined) return '（无）'
  if (typeof value === 'string') return value === '' ? '""' : value
  return JSON.stringify(value)
}

function assetLabel(response: SetAssetPropertiesResponse): string {
  const path = response.asset_path ?? ''
  const name = path.split('/').pop()?.split('.')[0] || path
  return response.asset_class ? `${name}（${response.asset_class}）` : name
}

/** 成功的一条：要的值 → 引擎实际的值 */
function describeSuccess(result: AssetPropertyResult): string {
  if (result.unchanged)
    return `- ${result.property}：已是 ${show(result.actual ?? result.before)}，没动`
  if (result.actual_unavailable !== undefined) {
    return `- ${result.property}：已写入 ${show(result.requested)}，但读不回来（${result.actual_unavailable}）`
  }
  return `- ${result.property}：要 ${show(result.requested)} → 实际 ${show(result.actual)}`
}

/** 失败的一条：带上要的值、引擎实际留下的值和原因 */
function failureOf(result: AssetPropertyResult): PartialFailure {
  const parts = [`要 ${show(result.requested)}`]
  if (result.actual !== undefined) parts.push(`实际 ${show(result.actual)}`)
  else if (result.before !== undefined) parts.push(`仍是 ${show(result.before)}`)
  const why = [result.reason, result.error].filter(Boolean).join('：')
  return { item: result.property, reason: `${parts.join('，')}；${why || '未给原因'}` }
}

function describeSave(response: SetAssetPropertiesResponse): string {
  if (response.changed_count === 0) return '没有任何属性真正改动，未存盘。'
  if (response.saved) return '已存盘。'
  if (response.save_error) return `没存上：${response.save_error}`
  return '未存盘（save=false），完事用 ue_save 保存。'
}

export function summarizeSetProperties(response: SetAssetPropertiesResponse): string {
  const results = response.results ?? []
  const succeeded = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)

  // 整批失败不写摘要，抛出去 —— 插件那边通常已经回 ok:false 被 defineUeTool 拦下，这里兜底
  if (succeeded.length === 0) {
    const reasons = describeFailures(failed.map(failureOf), '原因')
    throw new Error(
      `${assetLabel(response)} 的 ${failed.length} 个属性一个都没改成。${reasons ? `\n${reasons}` : ''}`
    )
  }

  const changed = succeeded.filter((r) => !r.unchanged).length
  const headline =
    partialHeadline({ succeeded: succeeded.length, failed: failed.length, unit: '个属性' }) ||
    `${assetLabel(response)}：${succeeded.length} 个属性已按要求生效${changed < succeeded.length ? `（其中 ${succeeded.length - changed} 个本来就是这个值）` : ''}。`

  const lines = [headline]
  if (failed.length > 0) lines.push(`资产：${assetLabel(response)}`)
  lines.push(...succeeded.map(describeSuccess))
  const failures = describeFailures(failed.map(failureOf))
  if (failures) lines.push(failures)
  lines.push(describeSave(response))
  if (response.reopened_editor) lines.push('（静态网格编辑器为重建临时关掉又打开了）')
  for (const note of response.notes ?? []) lines.push(`注：${note}`)
  return lines.join('\n')
}

export const setPropertiesTool = defineUeTool<
  typeof SetPropertiesInput,
  SetAssetPropertiesResponse
>({
  name: 'ue_content_set_properties',
  namespace: NAMESPACE,
  method: 'content.set_asset_properties',
  risk: 'mutating',
  concurrency: 'sequential',
  timeoutMs: SET_PROPERTIES_TIMEOUT_MS,
  description: `改资产自身的设置（细节面板里能改的那些），一次一批，改完逐条读回，默认存盘。代替用 Python 改资产属性。

例：
- 静态网格开 Nanite：{"NaniteSettings.bEnabled": true}
- 贴图当遮罩用（ORM / 粗糙度）：{"SRGB": false, "CompressionSettings": "TC_Masks"}
- 限制贴图尺寸：{"MaxTextureSize": 2048}
- 法线贴图翻转绿通道：{"bFlipGreenChannel": true}

路径用 C++ 属性名，进结构体或资产自带的子对象用点号（碰撞复杂度是 BodySetup.CollisionTraceFlag）；
名字写错会回「你是不是想写」。只改细节面板里可编辑的属性 —— 生成 LOD、凸包分解、加碰撞形状不是属性，不归它。
网格改 Nanite / LOD 组 / 碰撞会触发重建，大网格要等一会。整批是撤销栈上的一步。
回执逐条给「要的值 → 引擎实际的值」，被引擎夹紧或拒绝的算失败。`,
  input: SetPropertiesInput,
  toParams: (args) => ({
    asset_path: args.asset_path,
    properties: args.properties,
    ...(args.save !== undefined ? { save: args.save } : {})
  }),
  toOutcome: (response) => ({
    text: summarizeSetProperties(response),
    details: response
  })
})
