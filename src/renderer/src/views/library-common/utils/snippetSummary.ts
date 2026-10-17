/**
 * 片段详情页的摘要。
 *
 * payload 的形态判别与读取逻辑由 `src/shared/snippetPayload.ts` 提供，
 * 主进程与渲染进程共用。
 */

import type { SnippetFormPayload } from '@core/shared/snippetPayload'

export interface SnippetSummary {
  nodeCount: number
  connectionCount: number
  openPortCount: number
  /** 用到的节点类型，去重、保持出现顺序 */
  classes: string[]
  sourceBlueprintPath?: string
  sourceGraphName?: string
}

/** 给详情页用的摘要 */
export function summarizeSnippet(payload: SnippetFormPayload): SnippetSummary {
  return {
    nodeCount: payload.meta.nodeCount,
    connectionCount: payload.meta.connectionCount,
    openPortCount: payload.meta.openPorts.length,
    classes: payload.meta.classes,
    sourceBlueprintPath: payload.sourceBlueprintPath,
    sourceGraphName: payload.sourceGraphName
  }
}
