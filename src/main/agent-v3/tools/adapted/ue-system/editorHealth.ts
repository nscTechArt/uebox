/**
 * `ue_editor_health`：编辑器这次运行以来的状况 —— 启动多久、卡不卡、进 PIE 多慢、
 * 本地缓存命中多少、内存还剩多少。和顶栏状态监控面板是同一份数据（services/editorHealth.ts）。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { fetchEditorHealth } from '../../../../services/editorHealth'
import type { EditorHealthItem, EditorHealthItemId } from '../../../../../shared/editorHealth'

export const EDITOR_HEALTH_TOOL_NAME = 'ue_editor_health'

const LABELS: Record<EditorHealthItemId, string> = {
  startup: '打开编辑器',
  assetRegistry: '资产注册表扫描',
  pluginCount: '已启用插件',
  editorHitch: '编辑器卡顿率',
  pieFirstEnter: '首次进入 PIE',
  pieEnter: '最近一次进入 PIE',
  pieHitch: 'PIE 卡顿率',
  localCacheHit: '本地缓存命中',
  cacheDisk: '本地缓存占盘',
  availableMemory: '可用内存'
}

export function formatHealthValue(item: EditorHealthItem): string {
  const v = item.value
  if (v == null) return '—'
  switch (item.unit) {
    case 'seconds':
      return v >= 60 ? `${Math.floor(v / 60)} 分 ${Math.round(v % 60)} 秒` : `${v.toFixed(1)} 秒`
    case 'percent':
      return `${v.toFixed(1)}%`
    case 'gb':
      return `${v.toFixed(1)} GB`
    case 'bytes':
      return `${(v / 1024 ** 3).toFixed(1)} GB`
    default:
      return String(Math.round(v))
  }
}

function formatExpect(item: EditorHealthItem): string {
  if (!item.expect) return ''
  const probe: EditorHealthItem = { ...item, value: item.expect.value }
  return `（预期 ${item.expect.op} ${formatHealthValue(probe)}）`
}

export function createEditorHealthTool(): V2Tool {
  return defineV2Tool({
    description: `读当前编辑器这次运行以来的状况：打开编辑器用了多久、资产注册表扫描、卡顿率、进 PIE 的耗时、本地缓存命中率、可用内存。只读，秒回。

【什么时候用】用户说「打开工程好慢」「编辑器卡」「进 PIE 要等很久」「老在编译着色器」—— 先看这里，再决定要不要用 ue_zen_server 查缓存、用 ue_insights_trace 抓细节。

【读数】
- status=bad 的项才算异常。预期值是 Epic「编辑器诊断」窗口的默认值，不是我们定的
- pending：还没数据（没进过 PIE；卡顿率要编辑器在前台累计 10 秒以上才算数）
- unsupported：本地缓存命中率 5.3 起才有
- 卡顿率只在编辑器窗口有焦点时采样，从启动完成起累计
- 这是编辑器，不是打包后的游戏，报数时说清楚`,

    inputSchema: z.object({}),

    execute: async () => {
      const result = await fetchEditorHealth(getTargetConnectionId())
      if (result.status === 'not_connected')
        return { success: false, error: UE_NOT_CONNECTED_MESSAGE }
      if (result.status === 'plugin_outdated') {
        return {
          success: false,
          error:
            '当前工程里的 UnrealAgentLink 插件版本太旧，还没有状态监控。请用户在盒子里更新插件后重启编辑器。'
        }
      }
      if (result.status === 'error') return { success: false, error: result.error }

      const { items, issueCount } = result.report
      const bad = items.filter((i) => i.status === 'bad')
      const lines = [
        issueCount === 0
          ? '有预期值的项都在预期内。'
          : `${issueCount} 项偏离预期：` +
            bad.map((i) => `${LABELS[i.id]} ${formatHealthValue(i)}${formatExpect(i)}`).join('；') +
            '。'
      ]
      return {
        success: true,
        issue_count: issueCount,
        items: items.map((i) => ({
          id: i.id,
          label: LABELS[i.id],
          value: formatHealthValue(i),
          expect: i.expect
            ? `${i.expect.op} ${formatHealthValue({ ...i, value: i.expect.value })}`
            : null,
          status: i.status
        })),
        message: lines.join('')
      }
    }
  })
}
