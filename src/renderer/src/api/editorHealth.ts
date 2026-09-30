/**
 * 顶栏状态监控的数据。
 *
 * 不用 unwrapResult：主进程回的是带 status 的结果（ok / 插件太旧 / 没连上 / 出错），
 * 每一种界面都要各自显示，不是「拿不到就抛」。这一层只负责桥在不在。
 */

import type { EditorHealthResult } from '@core/shared/editorHealth'

export async function getEditorHealth(projectPath: string): Promise<EditorHealthResult> {
  const bridge = window.api?.ueEditorHealth
  if (!bridge) return { status: 'error', error: 'bridge unavailable' }
  try {
    return await bridge.get({ projectPath })
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
